'use strict';
// API 端到端冒烟测试（P0 保护网）：起真实 server.js + 临时 SQLite 库，
// 走完「注册 → 建 Bot → 提交代码(烟雾) → 正式挑战 → 计分/窗口/并发」全链路。
// 所有 RP 断言都用 platform/scoring 的公式反算——公式与 API 行为绑死，重构后跑同一套测试即可验证行为不变。
//
// 注意：本测试会 fork 真实的 runner 子进程跑对局，整体约 1–3 分钟。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rpDelta } = require('../platform/scoring');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 服务器生命周期 ----
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawclash-e2e-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, 'e2e.db'),
      NODE_ENV: 'test',
      EMAIL_VERIFICATION: '',          // 默认关闭：注册即视为已验证，可直接发起挑战
      SESSION_SECRET: 'e2e-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server 提前退出：\n' + logs);
    try {
      const r = await fetch(base + '/api/templates');
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('server 20s 内未就绪：\n' + logs); }
    await sleep(150);
  }
  return {
    base, child, dir,
    getLogs: () => logs,
    async stop() {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleep(300); } // Windows 下文件句柄释放可能滞后
      }
    },
  };
}

// ---- HTTP 帮手 ----
async function api(base, method, p, { cookie, bearer, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON（如指南页） */ }
  return { status: r.status, json, cookie: setCookie.length ? setCookie[0].split(';')[0] : null };
}

// ---- 测试脚本素材（tag 使各 Bot 代码哈希互不相同，避免哈希对窗口互相污染）----
const chessCode = (tag) => `// ${tag}\nmodule.exports = function onTurn(me, opponent, game) { return game.legalMoves[0]; };`;
const tftCode = (tag) => `// ${tag}\nmodule.exports = function onRound(me, opponent, game) { const h = opponent.history; return h.length && h[h.length - 1] === 'D' ? 'D' : 'C'; };`;
const alldCode = (tag) => `// ${tag}\nmodule.exports = function onRound() { return 'D'; };`;

// 钳王挑战响应的 RP 记账不变量：to 必须等于「锁内重读的 from + 公式增减（夹 0）」；练习赛必须不动分
function checkChessRp(r) {
  const chRes = r.battle.result === 'challenger' ? 'win' : r.battle.result === 'challenged' ? 'loss' : 'draw';
  const cdRes = chRes === 'win' ? 'loss' : chRes === 'loss' ? 'win' : 'draw';
  const ch = r.rpChange.challenger, cd = r.rpChange.challenged;
  if (r.scored) {
    assert.equal(ch.to, Math.max(0, ch.from + rpDelta(chRes, ch.from, cd.from)), 'challenger RP 记账不符公式');
    assert.equal(cd.to, Math.max(0, cd.from + rpDelta(cdRes, cd.from, ch.from)), 'challenged RP 记账不符公式');
  } else {
    assert.equal(ch.to, ch.from, '练习赛不得改 challenger RP');
    assert.equal(cd.to, cd.from, '练习赛不得改 challenged RP');
  }
}

test('API 端到端冒烟（真实 server + 临时库）', { timeout: 480000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const B = srv.base;

  // 三个账号；每账号 1 名棋手（A/B/C），账号 1/2 另建囚徒
  const accts = [];
  const bots = [];   // { botId, key, cookie }

  await t.test('注册 ×3 + 登录态', async () => {
    for (const [nick, email] of [['艾丽丝', 'alice@test.dev'], ['鲍勃', 'bob@test.dev'], ['卡罗', 'carol@test.dev']]) {
      const r = await api(B, 'POST', '/api/account/register', { body: { nickname: nick, email, password: 'password123' } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.emailVerified, true, '验证关闭时新账号应直接已验证');
      assert.ok(r.cookie, '注册应下发会话 Cookie');
      accts.push({ nick, cookie: r.cookie });
    }
    const me = await api(B, 'GET', '/api/me', { cookie: accts[0].cookie });
    assert.equal(me.json.account.nickname, '艾丽丝');
    // /api/me 已收敛为账号-only；「是否已建棋手」改由钳王自己的 /me 端点判定（未建回 404）
    const botMe = await api(B, 'GET', '/api/bot/me', { cookie: accts[0].cookie });
    assert.equal(botMe.status, 404, '尚未建棋手时钳王 /me 应 404');
  });

  await t.test('建棋手 ×3 + 唯一性约束 + 取密钥', async () => {
    for (let i = 0; i < 3; i++) {
      const name = ['棋手甲', '棋手乙', '棋手丙'][i];
      const r = await api(B, 'POST', '/api/bot/create', { cookie: accts[i].cookie, body: { name, avatar: 'preset:2' } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const prompt = await api(B, 'GET', '/api/bot/me/prompt', { cookie: accts[i].cookie });
      const key = (prompt.json.prompt.match(/sk_[A-Za-z0-9_-]+/) || [])[0];
      assert.ok(key, 'prompt 中应含完整棋手密钥');
      bots.push({ botId: r.json.botId, key, cookie: accts[i].cookie });
    }
    // 同账号第二名棋手 → 409；重名 → 409；name-check 反映占用
    assert.equal((await api(B, 'POST', '/api/bot/create', { cookie: accts[0].cookie, body: { name: '另一个' } })).status, 409);
    assert.equal((await api(B, 'POST', '/api/bot/create', { cookie: accts[1].cookie, body: { name: '棋手甲' } })).status, 409);
    const nc = await api(B, 'GET', '/api/bot/name-check?name=' + encodeURIComponent('棋手甲'));
    assert.equal(nc.json.available, false);
  });

  await t.test('提交代码：未过烟雾不占版本号、通过后发布 v1', async () => {
    // 必崩脚本：烟雾失败，不入库
    const bad = await api(B, 'POST', '/api/agent/bot/code/submit', {
      bearer: bots[0].key, body: { code: 'module.exports = function onTurn(){ throw new Error("x"); };', submittedBy: 'e2e' },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.smokeStatus, 'failed');
    assert.ok(Array.isArray(bad.json.failures) && bad.json.failures.length > 0, '应返回失败明细');
    // 好脚本 ×3：各发布 v1
    for (let i = 0; i < 3; i++) {
      const r = await api(B, 'POST', '/api/agent/bot/code/submit', {
        bearer: bots[i].key, body: { code: chessCode('bot-' + i), notes: '首版', submittedBy: 'e2e' },
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.version, 1, '失败提交不得占用版本号');
      assert.equal(r.json.smokeStatus, 'passed');
    }
  });

  await t.test('正式挑战 甲→乙：记账不变量 + 战报落库', async () => {
    const r = await api(B, 'POST', '/api/agent/challenge', { bearer: bots[0].key, body: { challengedBotId: bots[1].botId } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(['challenger', 'challenged', 'draw'].includes(r.json.battle.result));
    assert.equal(r.json.scored, true, '首场必然在计分窗口内');
    assert.equal(r.json.games.length, 2, '双局制');
    checkChessRp(r.json);
    // 单局回放可取
    const m = await api(B, 'GET', '/api/match/' + r.json.games[0].matchUrlId);
    assert.equal(m.status, 200);
    assert.ok(Array.isArray(m.json.gameData.history), '回放应含逐手棋谱');
    // 公开 rp 与响应一致
    const pubA = await api(B, 'GET', `/api/bots/${bots[0].botId}/public`);
    assert.equal(pubA.json.bot.rp, r.json.rpChange.challenger.to);
    // 我的对战记录含本场
    const list = await api(B, 'GET', '/api/bot/me/matches', { cookie: bots[0].cookie });
    assert.equal(list.json.battles[0].battleUrlId, r.json.battle.battleUrlId);
  });

  await t.test('并发结算回归：甲→丙 与 乙→丙 同时打，丙的分不丢不覆盖', async () => {
    const before = (await api(B, 'GET', `/api/bots/${bots[2].botId}/public`)).json.bot.rp;
    assert.equal(before, 0);
    const [r1, r2] = await Promise.all([
      api(B, 'POST', '/api/agent/challenge', { bearer: bots[0].key, body: { challengedBotId: bots[2].botId } }),
      api(B, 'POST', '/api/agent/challenge', { bearer: bots[1].key, body: { challengedBotId: bots[2].botId } }),
    ]);
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    checkChessRp(r1.json); checkChessRp(r2.json);
    const d1 = r1.json.rpChange.challenged.to - r1.json.rpChange.challenged.from;
    const d2 = r2.json.rpChange.challenged.to - r2.json.rpChange.challenged.from;
    // 两场的 from/to 必须串成链（后一场基于前一场的最新值），而非都从 0 出发互相覆盖
    const froms = [r1.json.rpChange.challenged.from, r2.json.rpChange.challenged.from].sort((a, b) => a - b);
    const tos = [r1.json.rpChange.challenged.to, r2.json.rpChange.challenged.to];
    assert.equal(froms[0], 0, '必有一场从初始 0 出发');
    assert.ok(tos.includes(froms[1]), '另一场的 from 必须等于前一场的 to（锁内重读）');
    const after = (await api(B, 'GET', `/api/bots/${bots[2].botId}/public`)).json.bot.rp;
    assert.equal(after, d1 + d2, '最终分必须等于两场增减之和（无覆盖丢失）');
    const pub = (await api(B, 'GET', `/api/bots/${bots[2].botId}/public`)).json.bot;
    assert.equal(pub.wins + pub.losses + pub.draws, 2, '两场战绩都要入账');
  });

  await t.test('哈希对计分窗口：同对代码前 10 场计分，第 11 场转练习赛', async () => {
    // 「甲→乙」已消耗 1 场；再打 10 场：第 2..10 场计分，第 11 场 scored=false
    for (let n = 2; n <= 11; n++) {
      const r = await api(B, 'POST', '/api/agent/challenge', { bearer: bots[0].key, body: { challengedBotId: bots[1].botId } });
      assert.equal(r.status, 200, `第 ${n} 场失败: ` + JSON.stringify(r.json));
      checkChessRp(r.json);
      assert.equal(r.json.scored, n <= 10, `第 ${n} 场 scored 应为 ${n <= 10}`);
    }
    // 练习赛在战报里标记 scored=0
    const list = await api(B, 'GET', '/api/bot/me/matches', { cookie: bots[0].cookie });
    assert.equal(list.json.battles[0].scored, 0, '最新一场（第 11 场）应为练习赛');
    assert.equal(list.json.battles[1].scored, 1);
  });

  await t.test('版本历史 + 回滚（新版本号、哈希不变）', async () => {
    const v2 = await api(B, 'POST', '/api/agent/bot/code/submit', {
      bearer: bots[0].key, body: { code: chessCode('bot-0-v2'), notes: '二版', submittedBy: 'e2e' },
    });
    assert.equal(v2.json.version, 2);
    const rv = await api(B, 'POST', '/api/agent/bot/code/revert', { bearer: bots[0].key, body: { toVersion: 1, submittedBy: 'e2e' } });
    assert.equal(rv.status, 200, JSON.stringify(rv.json));
    assert.equal(rv.json.version, 3);
    assert.equal(rv.json.revertedToVersion, 1);
    const vs = (await api(B, 'GET', '/api/agent/bot/code/versions', { bearer: bots[0].key })).json.versions;
    const hashOf = (v) => vs.find((x) => x.version === v).code_hash;
    assert.equal(hashOf(3), hashOf(1), '回滚版本哈希应与目标版本一致');
    // 回滚到与当前内容相同的版本 → 400
    assert.equal((await api(B, 'POST', '/api/agent/bot/code/revert', { bearer: bots[0].key, body: { toVersion: 1, submittedBy: 'e2e' } })).status, 400);
  });

  // ---- 囚徒困境 ----
  const prisoners = []; // { id, key }
  await t.test('囚徒：建 ×2 + 提交（TFT / AllD）', async () => {
    for (const [i, name] of [[0, '囚徒甲'], [1, '囚徒乙']]) {
      const r = await api(B, 'POST', '/api/prisoner/create', { cookie: accts[i].cookie, body: { name } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const prompt = await api(B, 'GET', '/api/prisoner/me/prompt', { cookie: accts[i].cookie });
      const key = (prompt.json.prompt.match(/sk_[A-Za-z0-9_-]+/) || [])[0];
      assert.ok(key);
      prisoners.push({ id: r.json.prisonerId, key });
    }
    const s1 = await api(B, 'POST', '/api/agent/prisoner/code/submit', { bearer: prisoners[0].key, body: { code: tftCode('pd-0'), submittedBy: 'e2e' } });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    const s2 = await api(B, 'POST', '/api/agent/prisoner/code/submit', { bearer: prisoners[1].key, body: { code: alldCode('pd-1'), submittedBy: 'e2e' } });
    assert.equal(s2.status, 200, JSON.stringify(s2.json));
  });

  await t.test('囚徒挑战：TFT vs AllD 结果确定，记账与回放正确', async () => {
    const r = await api(B, 'POST', '/api/agent/prisoner/challenge', { bearer: prisoners[0].key, body: { targetPrisonerId: prisoners[1].id } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const j = r.json;
    assert.equal(j.result, 'challenged', 'AllD 必胜 TFT（首回合剥削 +5）');
    assert.equal(j.reason, 'completed');
    assert.ok(j.actualRounds >= 900 && j.actualRounds <= 1100, '回合数须在公示区间');
    assert.equal(j.cdScore - j.chScore, 5, 'AllD 恰好净赚首回合 5 分');
    assert.equal(j.scored, true);
    // RP：双方 0 分同段，败方 0−15 夹 0、胜方 +25
    assert.equal(j.rpChange.challenger.from, 0);
    assert.equal(j.rpChange.challenger.to, 0);
    assert.equal(j.rpChange.challenged.to, 25);
    // 回放：真实回合数解码，首回合 C/D，之后 TFT 跟进 D
    const m = await api(B, 'GET', '/api/match/prisoner/' + j.matchUrlId);
    assert.equal(m.status, 200);
    assert.equal(m.json.match.moves.length, j.actualRounds);
    assert.deepEqual(m.json.match.moves[0], { a: 'C', b: 'D' });
    assert.deepEqual(m.json.match.moves[1], { a: 'D', b: 'D' });
  });

  await t.test('试玩与公共接口（游戏专属路由特征）', async () => {
    // 钳王：对手清单（4 流派 + 3 训练棋手）
    const tpl = await api(B, 'GET', '/api/templates');
    assert.equal(tpl.json.templates.length, 7);
    // 钳王：双人同屏重放（空历史 → 返回黑方合法着法）
    const local = await api(B, 'POST', '/api/play', { body: { mode: 'local', history: [] } });
    assert.equal(local.status, 200, JSON.stringify(local.json));
    assert.equal(local.json.toMove, 'black');
    assert.ok(local.json.legalMoves.length > 0);
    // 钳王：内置对手应手（人类黑方走一手 → 红方训练棋手回一手）
    const play = await api(B, 'POST', '/api/play', {
      body: { template: '牧童', humanSide: 'black', history: [{ side: 'black', from: [0, 2], to: [1, 2] }] },
    });
    assert.equal(play.status, 200, JSON.stringify(play.json));
    assert.ok(play.json.history.length >= 2, '机器人应已应手');
    // 钳王：搜索棋手
    const sr = await api(B, 'GET', '/api/bots/search?q=' + encodeURIComponent('棋手'));
    assert.equal(sr.json.bots.length, 3);
    // 囚徒：meta 与对手清单
    const meta = await api(B, 'GET', '/api/prisoner/meta');
    assert.ok(meta.json.minRounds >= 1 && meta.json.minRounds <= meta.json.maxRounds);
    const opp = await api(B, 'GET', '/api/prisoner/opponents');
    assert.ok(opp.json.training.length >= 3);
    // 囚徒：试玩单回合（对训练囚徒）
    const pdPlay = await api(B, 'POST', '/api/prisoner/play', {
      body: { opponent: { kind: 'training', id: opp.json.training[0].id }, history: [], myMove: 'C' },
    });
    assert.equal(pdPlay.status, 200, JSON.stringify(pdPlay.json));
    assert.ok(['C', 'D'].includes(pdPlay.json.opponentMove));
    assert.equal(pdPlay.json.roundNumber, 1);
    // 钳王：试玩挑战玩家棋手（不可信脚本 → 隔离子进程执行）
    const playBot = await api(B, 'POST', '/api/play', {
      body: { botId: bots[1].botId, humanSide: 'black', history: [{ side: 'black', from: [0, 2], to: [1, 2] }] },
    });
    assert.equal(playBot.status, 200, JSON.stringify(playBot.json));
    assert.ok(playBot.json.history.length >= 2, '玩家棋手应已在子进程内应手');
    // 囚徒：试玩挑战玩家囚徒（play-one 子进程任务）
    const pdVs = await api(B, 'POST', '/api/prisoner/play', {
      body: { opponent: { kind: 'prisoner', prisonerId: prisoners[1].id }, history: [], myMove: 'C' },
    });
    assert.equal(pdVs.status, 200, JSON.stringify(pdVs.json));
    assert.equal(pdVs.json.opponentMove, 'D', 'AllD 囚徒必出 D');
  });

  await t.test('P2 规范路径（/api/games/<id>/…）与 legacy 别名等价', async () => {
    // 天梯：规范路径与 legacy 路径共用同一份微缓存 body
    const lb1 = await api(B, 'GET', '/api/games/clawclash/leaderboard');
    const lb2 = await api(B, 'GET', '/api/leaderboard');
    assert.equal(lb1.status, 200);
    assert.deepEqual(lb1.json, lb2.json);
    // Agent 接口规范路径（同一 Bearer Key）
    const info = await api(B, 'GET', '/api/games/clawclash/agent/info', { bearer: bots[0].key });
    assert.equal(info.status, 200, JSON.stringify(info.json));
    assert.equal(info.json.bot.id, bots[0].botId);
    // 人类接口规范路径（同一 Cookie）
    const pme = await api(B, 'GET', '/api/games/prisoner/me', { cookie: accts[0].cookie });
    assert.equal(pme.status, 200, JSON.stringify(pme.json));
    assert.equal(pme.json.prisoner.id, prisoners[0].id);
    // 公开详情：规范 = legacy
    const pub1 = await api(B, 'GET', `/api/games/clawclash/players/${bots[0].botId}/public`);
    const pub2 = await api(B, 'GET', `/api/bots/${bots[0].botId}/public`);
    assert.deepEqual(pub1.json, pub2.json);
    // 规范指南路径
    const g = await fetch(B + '/games/prisoner/agent-guide');
    assert.equal(g.status, 200);
    assert.ok((await g.text()).includes('Agent 指南'));
  });

  await t.test('频控按真实客户端分桶：回环直连信任 X-Forwarded-For 最后一跳', async () => {
    // 登录频控 10 次/5 分钟（server.js）。用不存在的邮箱：不触发 scrypt，稳定 401。
    // e2e 直连 127.0.0.1（回环）→ clientIp() 应采信 XFF 最后一跳作为频控 key。
    const hit = async (xff) => {
      const r = await fetch(B + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
        body: JSON.stringify({ email: 'nobody@test.dev', password: 'password' }),
      });
      return r.status;
    };
    for (let i = 0; i < 10; i++) assert.equal(await hit('203.0.113.7'), 401, `第 ${i + 1} 次应在限额内`);
    assert.equal(await hit('203.0.113.7'), 429, '同一 XFF 客户端超限应 429');
    assert.equal(await hit('9.9.9.9, 203.0.113.7'), 429, '多跳 XFF 只认最后一跳（伪造前缀不换桶）');
    assert.equal(await hit('198.51.100.9'), 401, '不同 XFF 客户端应有独立频控桶');
  });

  await t.test('天梯榜与指南', async () => {
    const lb = await api(B, 'GET', '/api/leaderboard');
    assert.equal(lb.json.leaderboard.length, 3);
    // 榜单 rp 与公开详情一致（榜单此刻首次构建，微缓存内容即最新）
    for (const row of lb.json.leaderboard) {
      const pub = await api(B, 'GET', `/api/bots/${row.botId}/public`);
      assert.equal(row.rp, pub.json.bot.rp, `榜单 ${row.name} 的 rp 与详情不一致`);
    }
    // 榜单按 rp 降序
    for (let i = 1; i < lb.json.leaderboard.length; i++) {
      assert.ok(lb.json.leaderboard[i - 1].rp >= lb.json.leaderboard[i].rp);
    }
    const plb = await api(B, 'GET', '/api/leaderboard/prisoner');
    assert.equal(plb.json.leaderboard.length, 2);
    assert.equal(plb.json.leaderboard[0].rp, 25);
    // 指南可抓取
    const g1 = await fetch(B + '/agent-guide');
    assert.ok((await g1.text()).includes('Agent 指南'));
    const g2 = await fetch(B + '/agent-guide-prisoner');
    assert.ok((await g2.text()).includes('Agent 指南'));
  });
});
