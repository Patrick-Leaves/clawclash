'use strict';
// 囚徒困境 · 服务端适配（仅主进程加载）：统一数据层 store、选择序列编解码（游戏私有）、
// 响应视图、挑战执行、试玩等游戏专属路由。
// 注意：本文件含 db 访问，绝不能被 games/registry（runner 子进程也会加载）引用。
const crypto = require('crypto');
const db = require('../../db');
const execpool = require('../../platform/execpool');
const { settleChallenge } = require('../../platform/settle');
const { rankLabel, wldInc } = require('../../platform/scoring');
const manifest = require('./index');
const { TRAINING_BOTS: PD_TRAINING } = require('./engine/training_bots');
const { normalizeChoice: pdNorm, PAYOFF: PD_PAYOFF } = require('./engine/rules');

// ---- 统一数据层（P3）----
// 同 RP 次级排序按创建先后（id）；战报的游戏专属标量放 battles.ext(JSON)、选择序列放 battles.blob。
const store = db.gameStore(manifest.id, { rankTiebreak: 'id' });

// ---- 选择序列编解码（游戏私有；每回合 2 bit：高位 a 的选择，低位 b 的选择；C=0、D=1）----
function encodeMoves(history) {
  const N = history.length;
  const bytes = new Uint8Array(Math.ceil(N / 4));
  for (let i = 0; i < N; i++) {
    const a = history[i].a === 'D' ? 1 : 0;
    const b = history[i].b === 'D' ? 1 : 0;
    const code = (a << 1) | b; // 0..3
    const byteIdx = i >> 2;
    const shift = (3 - (i & 3)) * 2; // 高 -> 低
    bytes[byteIdx] |= (code & 0x3) << shift;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function decodeMoves(buf, totalRounds) {
  const u = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  // 防御性夹取：绝不越过 blob 实际编码的容量（每字节 4 回合）读到未写入的尾部，
  // 否则会解出假的 CC。调用方应传「真实进行回合数」；这里再兜一层上限。
  const N = Math.max(0, Math.min(totalRounds | 0, u.length * 4));
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const byteIdx = i >> 2;
    const shift = (3 - (i & 3)) * 2;
    const code = (u[byteIdx] >> shift) & 0x3;
    out[i] = { a: (code & 0x2) ? 'D' : 'C', b: (code & 0x1) ? 'D' : 'C' };
  }
  return out;
}

// battles.ext（JSON 字符串）→ 对象；{actualRounds, failure}
const extOf = (b) => {
  if (!b.ext) return {};
  try { return JSON.parse(b.ext); } catch { return {}; }
};

// ---- 视图 ----
// 战绩视图（指定囚徒视角）
function prisonerBattleView(b, prisonerId) {
  const ext = extOf(b);
  const isCh = b.challenger_id === prisonerId;
  const persp = (winner) => winner === 'draw' ? 'draw' : ((winner === 'challenger') === isCh ? 'win' : 'loss');
  return {
    matchUrlId: b.url_id, playedAt: b.played_at,
    opponentName: isCh ? b.challenged_name : b.challenger_name,
    opponentAvatar: isCh ? b.challenged_avatar : b.challenger_avatar,
    result: persp(b.result), reason: b.reason,
    actualRounds: ext.actualRounds,
    myScore: isCh ? b.ch_score : b.cd_score,
    oppScore: isCh ? b.cd_score : b.ch_score,
    rpDelta: isCh ? b.ch_rp_delta : b.cd_rp_delta,
    scored: b.scored == null ? 1 : b.scored,
  };
}
const battleListView = (rows, viewerId) => rows.map((b) => prisonerBattleView(b, viewerId));

const leaderboardRow = (p, i) => ({
  rank: i + 1, prisonerId: p.id, name: p.name, avatar: p.avatar,
  nickname: p.nickname, rp: p.rp, rankName: rankLabel(p.rp),
  wins: p.wins, losses: p.losses, draws: p.draws,
  currentVersion: p.current_version,
});

// ---- 一键复制 Prompt（含完整 key）----
function buildPrompt(p, key, origin) {
  return [
    '你是我的「囚徒困境」Agent。请为我的囚徒编写并提交对局脚本。',
    '',
    `【囚徒】${p.name}（prisonerId: ${p.id}） · 段位：${rankLabel(p.rp)} · 当前版本：v${p.current_version}${p.current_version === 0 ? '（空脚本）' : ''}`,
    `【囚徒密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide-prisoner`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onRound(me, opponent, game) 签名与回合数隐藏机制。',
    '2. 编写策略脚本（module.exports = function onRound(me, opponent, game) {...}，返回 \'C\' 或 \'D\'）。',
    '3. 用以下接口提交（系统先跑 6 场烟雾测试，通过才发布；失败不占用版本号）：',
    `   POST ${origin}/api/agent/prisoner/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 烟雾失败按响应明细修复后重提即可。',
    '5. 通过后即可读榜、侦察、发起正式挑战。',
  ].join('\n');
}

// ---- Agent 数据视图（囚徒形态：按「场」列 battles）----
function agentMatches(p, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = store.listBattles(p.id, limit);
  return { ok: true, battles: rows.map((b) => prisonerBattleView(b, p.id)) };
}

// 对手侦察：近期战报摘要
function opponentMatches(target, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 10));
  const rows = store.listBattles(target.id, limit);
  return {
    ok: true, prisonerId: target.id, prisonerName: target.name,
    matches: rows.map((b) => ({
      matchUrlId: b.url_id, playedAt: b.played_at,
      challenger: b.challenger_name, challenged: b.challenged_name,
      result: b.result, reason: b.reason,
      actualRounds: extOf(b).actualRounds,
      chScore: b.ch_score, cdScore: b.cd_score,
      chCodeHash: b.ch_code_hash, cdCodeHash: b.cd_code_hash,
    })),
  };
}

// 对局详情 + 决策时间带（解码 blob 选择序列）
function matchDetail(urlId) {
  const row = store.getBattleByUrlId(urlId);
  if (!row) return null;
  const ext = extOf(row);
  const ch = store.getById(row.challenger_id);
  const cd = store.getById(row.challenged_id);
  const failure = ext.failure || null;
  // 真实进行的回合数：completed 时 = actualRounds；中途判负时 = failure.round − 1
  // （引擎在失败回合把选择 push 进 history 之前就返回，故 history 只含此前完成的回合）。
  // blob 按 history.length 编码——必须按同一长度解码，否则会把 blob 里没写过的尾部
  // 读成假的 CC（明明是背叛/超时判负，回放却显示成一路互相合作）。
  const playedRounds = row.reason === 'completed'
    ? ext.actualRounds
    : (failure && Number.isInteger(failure.round) ? Math.max(0, failure.round - 1) : ext.actualRounds);
  const moves = decodeMoves(row.blob, playedRounds);
  return { ok: true, match: {
    matchUrlId: row.url_id, playedAt: row.played_at,
    challenger: { id: ch?.id, name: ch?.name, avatar: ch?.avatar },
    challenged: { id: cd?.id, name: cd?.name, avatar: cd?.avatar },
    result: row.result, reason: row.reason,
    actualRounds: ext.actualRounds,
    chScore: row.ch_score, cdScore: row.cd_score,
    chRpDelta: row.ch_rp_delta, cdRpDelta: row.cd_rp_delta,
    scored: row.scored, seed: row.seed,
    failure,
    moves, // [{a:'C'|'D', b:'C'|'D'}, ...]（长度 = 真实进行回合数）
  } };
}

// ---- 正式挑战：单场制（N∈[minRounds,maxRounds] 区间随机回合数）----
const challenge = {
  bodyIdField: 'targetPrisonerId',
  async execute({ challenger, challenged, chCode, cdCode, ownerKey }) {
    const matchUrlId = db.urlId();
    const seed = crypto.randomInt(0, 1 << 30);

    let outcome;
    try {
      outcome = await execpool.run('prisoner', 'challenge', { aCode: chCode.code, bCode: cdCode.code, seed }, ownerKey);
      if (outcome && outcome.loadFailed) return { status: 500, json: { ok: false, error: '囚徒代码加载失败' } };
    } catch (e) {
      return { status: e && e.busy ? 503 : 500, json: { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败' } };
    }

    // 引擎视角：a=挑战者，b=被挑战者
    const { actualRounds, scoreA: chScore, scoreB: cdScore, result: engineResult, reason, history, failure } = outcome;
    const battleResult = engineResult === 'a' ? 'challenger' : engineResult === 'b' ? 'challenged' : 'draw';
    const chResult = battleResult === 'challenger' ? 'win' : battleResult === 'challenged' ? 'loss' : 'draw';

    // 结算走平台统一核心（platform/settle.js）；这里只注入囚徒专属部分——战绩写库与战报落库形态。
    const settlement = await settleChallenge({
      ns: manifest.id, challenger, challenged,
      chHash: chCode.code_hash, cdHash: cdCode.code_hash,
      chResult, scoredLimit: manifest.scoredLimit,
      store: {
        getFresh: (id) => store.getById(id),
        getHashPair: (id, my, opp) => store.getHashPair(id, my, opp),
        recordHashPair: (id, my, opp) => store.recordHashPair(id, my, opp),
        applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult, cdResult }) {
          store.updateStats(chFresh.id, null, newChRp, ...wldInc(chResult));
          store.updateStats(cdFresh.id, null, newCdRp, ...wldInc(cdResult));
        },
        persist({ chFresh, cdFresh, newChRp, newCdRp, scored }) {
          store.createBattle({
            urlId: matchUrlId,
            challengerId: chFresh.id, challengedId: cdFresh.id,
            result: battleResult, reason,
            chScore, cdScore,
            chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
            scored, seed,
            chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash,
            ext: { actualRounds, failure: failure || null },
            blob: encodeMoves(history || []),
          });
        },
      },
    });

    return { status: 200, json: {
      ok: true,
      matchUrlId,
      result: battleResult, reason,
      actualRounds, chScore, cdScore,
      rpChange: {
        challenger: { from: settlement.fromChRp, to: settlement.newChRp, delta: settlement.chRpDelta, rank: rankLabel(settlement.newChRp) },
        challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, delta: settlement.cdRpDelta, rank: rankLabel(settlement.newCdRp) },
      },
      scored: settlement.scored,
      failure: failure || null,
      scoringNote: settlement.scored
        ? `本场计入段位/战绩。该哈希对（双方当前版本）还可计分 ${Math.max(0, manifest.scoredLimit - (settlement.priorCount + 1))} 场（共 ${manifest.scoredLimit} 场）；之后为练习赛不计分。`
        : `本场为练习赛不计分：该哈希对已用满 ${manifest.scoredLimit} 场计分资格。`,
    } };
  },
};

// ---- legacy 路径别名（已发布给 Agent/前端的稳定契约，长期保留）----
const aliases = {
  create: ['/api/prisoner/create'],
  nameCheck: ['/api/prisoner/name-check'],
  avatarUpload: ['/api/prisoner/me/avatar'],
  avatarPreset: ['/api/prisoner/me/avatar/preset'],
  me: ['/api/prisoner/me'],
  prompt: ['/api/prisoner/me/prompt'],
  rotateKey: ['/api/prisoner/me/rotate-key'],
  meVersions: ['/api/prisoner/me/versions'],
  meVersion: [/^\/api\/prisoner\/me\/version\/(\d+)$/],
  meMatches: ['/api/prisoner/me/matches'],
  agentInfo: ['/api/agent/prisoner/info'],
  codeSubmit: ['/api/agent/prisoner/code/submit'],
  codeRevert: ['/api/agent/prisoner/code/revert'],
  codeVersions: ['/api/agent/prisoner/code/versions'],
  challenge: ['/api/agent/prisoner/challenge'],
  agentMatches: ['/api/agent/prisoner/matches'],
  opponentMatches: [/^\/api\/agent\/prisoner-opponents\/(\d+)\/matches$/],
  leaderboard: ['/api/leaderboard/prisoner'],
  playerPublic: [/^\/api\/prisoners\/(\d+)\/public$/],
  playerMatchesPublic: [/^\/api\/prisoners\/(\d+)\/matches\/public$/],
  matchDetail: [/^\/api\/match\/prisoner\/([a-z0-9]+)$/],
  guide: ['/agent-guide-prisoner'],
};

// ---- 游戏专属附加路由：meta / 对手清单 / 试玩单回合 ----
function extraRoutes({ route, sendJson, rl, rateLimited, clientIp }) {
  route('GET', '/api/prisoner/meta', (req, res) => {
    sendJson(res, 200, { ok: true, minRounds: manifest.minRounds, maxRounds: manifest.maxRounds, scoredLimit: manifest.scoredLimit });
  });

  // 对手清单：训练囚徒 + 公开榜单前 20
  route('GET', '/api/prisoner/opponents', (req, res) => {
    const training = PD_TRAINING.map(({ make }) => {
      const b = make();
      return { kind: 'training', id: b.id, name: b.name, summary: b.summary };
    });
    const players = store.leaderboardRows()
      .filter((p) => p.current_version > 0)
      .slice(0, 20)
      .map((p) => ({
        kind: 'prisoner', prisonerId: p.id, name: p.name, avatar: p.avatar,
        ownerNickname: p.nickname, rp: p.rp, rank: rankLabel(p.rp),
      }));
    sendJson(res, 200, { ok: true, training, players });
  });

  // 试玩单回合推进（无状态：客户端维持完整 history，服务器只跑 bot 1 次给出本回合选择）
  // body: { opponent: {kind:'training',id} | {kind:'prisoner',prisonerId},
  //         history: [{me:'C'|'D', opp:'C'|'D'}, ...], myMove: 'C'|'D' }
  // 不计分、不入库、不影响段位
  route('POST', '/api/prisoner/play', async (req, res, _m, body) => {
    if (rateLimited(res, rl.allow('pd-play:' + clientIp(req), 600, 60 * 1000))) return;
    const myMove = pdNorm(body.myMove);
    if (!myMove) return sendJson(res, 400, { ok: false, error: 'myMove 须为 C 或 D' });
    const rawHist = Array.isArray(body.history) ? body.history : [];
    if (rawHist.length > 100000) return sendJson(res, 400, { ok: false, error: '历史过长' });
    // 归一化历史并校验
    const myHistory = [], oppHistory = [];
    let myScoreCum = 0, oppScoreCum = 0;
    for (let i = 0; i < rawHist.length; i++) {
      const h = rawHist[i] || {};
      const a = pdNorm(h.me), b = pdNorm(h.opp);
      if (!a || !b) return sendJson(res, 400, { ok: false, error: `历史第 ${i + 1} 项非法` });
      myHistory.push(a); oppHistory.push(b);
      myScoreCum += PD_PAYOFF[a][b];
      oppScoreCum += PD_PAYOFF[b][a];
    }
    const opp = body.opponent || {};
    const roundNumber = rawHist.length + 1;

    // 解析对手 → 决定执行路径
    let oppMove, oppName;
    if (opp.kind === 'training') {
      const def = PD_TRAINING.find((t) => t.id === opp.id);
      if (!def) return sendJson(res, 400, { ok: false, error: '未知训练囚徒' });
      const t = def.make();
      oppName = t.name;
      // 主进程内跑可信代码
      const me = { score: oppScoreCum, history: oppHistory.slice() };
      const op = { score: myScoreCum, history: myHistory.slice() };
      Object.freeze(me.history); Object.freeze(op.history);
      // 训练 bot 不依赖 random 复用同一种子 — 这里随机源每次新建即可（试玩不要求可复现）
      let rndState = (roundNumber * 2654435761) >>> 0;
      const game = { roundNumber, random: () => {
        rndState = (rndState + 0x6D2B79F5) | 0;
        let r = Math.imul(rndState ^ (rndState >>> 15), 1 | rndState);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      } };
      let raw;
      try { raw = t.onRound(me, op, game); }
      catch (e) { return sendJson(res, 500, { ok: false, error: '训练囚徒异常：' + (e?.message || e) }); }
      oppMove = pdNorm(raw);
      if (!oppMove) return sendJson(res, 500, { ok: false, error: '训练囚徒返回非法选择' });
    } else if (opp.kind === 'prisoner') {
      const target = store.getById(+opp.prisonerId);
      if (!target) return sendJson(res, 404, { ok: false, error: '囚徒不存在' });
      const codeRow = store.latestPassed(target.id);
      if (!codeRow) return sendJson(res, 422, { ok: false, error: `「${target.name}」尚未发布可用脚本` });
      oppName = target.name;
      let out;
      try {
        out = await execpool.run('prisoner', 'play-one', {
          code: codeRow.code,
          myHistory, botHistory: oppHistory, myScore: myScoreCum, botScore: oppScoreCum,
          roundNumber,
        }, 'ip:' + clientIp(req));
      } catch (e) {
        return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '试玩执行繁忙，请稍后重试' : '试玩执行失败' });
      }
      if (out.loadFailed) return sendJson(res, 500, { ok: false, error: '囚徒代码加载失败' });
      if (out.failure) {
        // bot 失败：试玩中提示用户，但不判负、不计分；仅本回合不推进
        return sendJson(res, 200, {
          ok: true, over: true, botFailure: out.failure, opponentName: oppName,
        });
      }
      oppMove = out.move;
    } else {
      return sendJson(res, 400, { ok: false, error: '缺少有效 opponent' });
    }

    // 结算本回合
    const myGain = PD_PAYOFF[myMove][oppMove];
    const oppGain = PD_PAYOFF[oppMove][myMove];
    sendJson(res, 200, {
      ok: true, opponentName: oppName,
      opponentMove: oppMove, myMove,
      myGain, oppGain,
      myScore: myScoreCum + myGain, oppScore: oppScoreCum + oppGain,
      roundNumber,
    });
  });
}

module.exports = {
  store, battleListView, leaderboardRow, buildPrompt,
  agentMatches, opponentMatches, matchDetail,
  challenge, aliases, extraRoutes,
};
