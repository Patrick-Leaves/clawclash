'use strict';
// P3 数据迁移端到端测试：按「迁移前的旧 schema」（bots/prisoner_* 双表族，2026-07 生产基线）
// 造一个带完整数据的库 → 起真实 server（触发启动迁移）→ 经 API 验证：
//   公开 id / 密钥 / 版本历史 / 段位与战绩 / 战报与棋谱回放 / 囚徒选择序列(blob) / 哈希对计分窗口
// 全部原样保留；并验证二次启动不重复迁移（幂等）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../auth');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 与生产同款的工具（复刻旧实现，钉住兼容性）----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const codeHash = (code) => sha256(code.trim()).slice(0, 16);
// 旧版 move_blob 编码：每回合 2 bit（高位 a、低位 b；C=0、D=1），按位打包
function encodeMoves(history) {
  const bytes = new Uint8Array(Math.ceil(history.length / 4));
  history.forEach((h, i) => {
    const code = ((h.a === 'D' ? 1 : 0) << 1) | (h.b === 'D' ? 1 : 0);
    bytes[i >> 2] |= code << ((3 - (i & 3)) * 2);
  });
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---- 固定资料 ----
const KEY_A = 'sk_migA_' + 'a'.repeat(24);
const KEY_B = 'sk_migB_' + 'b'.repeat(24);
const KEY_P1 = 'sk_migP1_' + 'c'.repeat(24);
const KEY_P2 = 'sk_migP2_' + 'd'.repeat(24);
const CODE_A1 = '// mig-a-v1\nmodule.exports = function onTurn(me, opponent, game) { return game.legalMoves[0]; };';
const CODE_A2 = '// mig-a-v2\nmodule.exports = function onTurn(me, opponent, game) { return game.legalMoves[0]; };';
const CODE_B1 = '// mig-b-v1\nmodule.exports = function onTurn(me, opponent, game) { return game.legalMoves[0]; };';
const CODE_P1 = "// mig-p1\nmodule.exports = function onRound(me, opponent) { const h = opponent.history; return h.length && h[h.length - 1] === 'D' ? 'D' : 'C'; };";
const CODE_P2 = '// mig-p2\nmodule.exports = function onRound() { return "D"; };';
const BATTLE_URL = 'aabbccdd11223344';
const PD_URL_OK = 'ffee001122334455';
const PD_URL_FAIL = 'ffee998877665544';

// ---- 旧 schema DDL（迁移前 db.js 的原样拷贝；matches 的 battle_id/game_no 为历史增量后的形态）----
const LEGACY_DDL = `
PRAGMA journal_mode=WAL;
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER UNIQUE NOT NULL, name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'preset:1', current_version INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 1200, rp INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL, key_plain TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE code_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, version INTEGER NOT NULL,
  code TEXT NOT NULL, code_hash TEXT NOT NULL, notes TEXT, submitted_by TEXT,
  smoke_status TEXT NOT NULL DEFAULT 'pending', smoke_detail TEXT, created_at INTEGER NOT NULL,
  UNIQUE(bot_id, version));
CREATE TABLE battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, battle_url_id TEXT UNIQUE NOT NULL,
  challenger_bot_id INTEGER NOT NULL, challenged_bot_id INTEGER NOT NULL, result TEXT NOT NULL,
  ch_rp_delta INTEGER, cd_rp_delta INTEGER, scored INTEGER NOT NULL DEFAULT 1, played_at INTEGER NOT NULL);
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_url_id TEXT UNIQUE NOT NULL,
  challenger_bot_id INTEGER NOT NULL, challenged_bot_id INTEGER NOT NULL,
  ch_code_version INTEGER NOT NULL, cd_code_version INTEGER NOT NULL,
  ch_code_hash TEXT NOT NULL, cd_code_hash TEXT NOT NULL,
  winner TEXT NOT NULL, reason TEXT NOT NULL, turns INTEGER NOT NULL,
  final_challenger_pieces INTEGER NOT NULL, final_challenged_pieces INTEGER NOT NULL,
  game_json TEXT NOT NULL, challenger_side TEXT NOT NULL, seed INTEGER NOT NULL,
  played_at INTEGER NOT NULL, battle_id INTEGER, game_no INTEGER);
CREATE TABLE hash_pair_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, my_hash TEXT NOT NULL,
  opp_hash TEXT NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, UNIQUE(bot_id, my_hash, opp_hash));
CREATE TABLE prisoner_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER UNIQUE NOT NULL, name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'preset:1', current_version INTEGER NOT NULL DEFAULT 0,
  rp INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE prisoner_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prisoner_id INTEGER NOT NULL, key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL, key_plain TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE prisoner_code_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prisoner_id INTEGER NOT NULL, version INTEGER NOT NULL,
  code TEXT NOT NULL, code_hash TEXT NOT NULL, notes TEXT, submitted_by TEXT,
  smoke_status TEXT NOT NULL DEFAULT 'pending', smoke_detail TEXT, created_at INTEGER NOT NULL,
  UNIQUE(prisoner_id, version));
CREATE TABLE prisoner_battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_url_id TEXT UNIQUE NOT NULL,
  challenger_prisoner_id INTEGER NOT NULL, challenged_prisoner_id INTEGER NOT NULL,
  ch_code_version INTEGER NOT NULL, cd_code_version INTEGER NOT NULL,
  ch_code_hash TEXT NOT NULL, cd_code_hash TEXT NOT NULL,
  result TEXT NOT NULL, reason TEXT NOT NULL, actual_rounds INTEGER NOT NULL,
  ch_score INTEGER NOT NULL, cd_score INTEGER NOT NULL, ch_rp_delta INTEGER, cd_rp_delta INTEGER,
  scored INTEGER NOT NULL DEFAULT 1, seed INTEGER NOT NULL, move_blob BLOB NOT NULL,
  failure_detail TEXT, played_at INTEGER NOT NULL);
CREATE TABLE prisoner_hash_pair_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prisoner_id INTEGER NOT NULL, my_hash TEXT NOT NULL,
  opp_hash TEXT NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, UNIQUE(prisoner_id, my_hash, opp_hash));
`;

function buildLegacyDb(file) {
  const d = new DatabaseSync(file);
  d.exec(LEGACY_DDL);
  const t = Date.now();
  const ins = (sql, ...args) => d.prepare(sql).run(...args);
  // 账号（已验证）
  ins('INSERT INTO accounts(id,nickname,email,password_hash,email_verified,created_at) VALUES(?,?,?,?,?,?)',
    1, '阿甲', 'jia@mig.dev', auth.hashPassword('password123'), 1, t);
  ins('INSERT INTO accounts(id,nickname,email,password_hash,email_verified,created_at) VALUES(?,?,?,?,?,?)',
    2, '阿乙', 'yi@mig.dev', auth.hashPassword('password123'), 0, t);
  // 钳王棋手：老甲(rp275, ELO1234, 10胜2负1平, v2 在用)、老乙(rp40)
  ins('INSERT INTO bots(id,account_id,name,avatar,current_version,rating,rp,wins,losses,draws,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    1, 1, '老甲', 'preset:3', 2, 1234, 275, 10, 2, 1, t);
  ins('INSERT INTO bots(id,account_id,name,avatar,current_version,rating,rp,wins,losses,draws,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    2, 2, '老乙', 'preset:1', 1, 1100, 40, 1, 5, 0, t);
  ins('INSERT INTO api_keys(bot_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?)', 1, sha256(KEY_A), KEY_A.slice(0, 8), KEY_A, t);
  ins('INSERT INTO api_keys(bot_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?)', 2, sha256(KEY_B), KEY_B.slice(0, 8), KEY_B, t);
  const insVer = 'INSERT INTO code_versions(bot_id,version,code,code_hash,notes,submitted_by,smoke_status,created_at) VALUES(?,?,?,?,?,?,?,?)';
  ins(insVer, 1, 1, CODE_A1, codeHash(CODE_A1), '首版', 'e2e', 'passed', t);
  ins(insVer, 1, 2, CODE_A2, codeHash(CODE_A2), '二版', 'e2e', 'passed', t);
  ins(insVer, 2, 1, CODE_B1, codeHash(CODE_B1), '首版', 'e2e', 'passed', t);
  // 一场历史战报（老甲胜，+25/0）+ 两局棋谱
  ins('INSERT INTO battles(id,battle_url_id,challenger_bot_id,challenged_bot_id,result,ch_rp_delta,cd_rp_delta,scored,played_at) VALUES(?,?,?,?,?,?,?,?,?)',
    1, BATTLE_URL, 1, 2, 'challenger', 25, 0, 1, t);
  const insMatch = `INSERT INTO matches(match_url_id,challenger_bot_id,challenged_bot_id,ch_code_version,cd_code_version,
    ch_code_hash,cd_code_hash,winner,reason,turns,final_challenger_pieces,final_challenged_pieces,
    game_json,challenger_side,seed,played_at,battle_id,game_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  ins(insMatch, BATTLE_URL + 'a', 1, 2, 2, 1, codeHash(CODE_A2), codeHash(CODE_B1), 'challenger', 'eliminated', 18, 5, 1, '{"initialBoard":null,"history":[]}', 'black', 7001, t, 1, 1);
  ins(insMatch, BATTLE_URL + 'b', 1, 2, 2, 1, codeHash(CODE_A2), codeHash(CODE_B1), 'draw', 'material', 40, 3, 3, '{"initialBoard":null,"history":[]}', 'red', 7002, t, 1, 2);
  // 哈希对：当前版本对已用满 10 场 → 迁移后第一场就该是练习赛
  ins('INSERT INTO hash_pair_scores(bot_id,my_hash,opp_hash,used_count) VALUES(?,?,?,?)', 1, codeHash(CODE_A2), codeHash(CODE_B1), 10);
  ins('INSERT INTO hash_pair_scores(bot_id,my_hash,opp_hash,used_count) VALUES(?,?,?,?)', 2, codeHash(CODE_B1), codeHash(CODE_A2), 10);

  // 囚徒：囚甲(rp165, TFT)、囚乙(rp25, AllD)
  ins('INSERT INTO prisoner_bots(id,account_id,name,avatar,current_version,rp,wins,losses,draws,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    1, 1, '囚甲', 'preset:5', 1, 165, 3, 1, 0, t);
  ins('INSERT INTO prisoner_bots(id,account_id,name,avatar,current_version,rp,wins,losses,draws,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    2, 2, '囚乙', 'preset:2', 1, 25, 1, 0, 0, t);
  ins('INSERT INTO prisoner_api_keys(prisoner_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?)', 1, sha256(KEY_P1), KEY_P1.slice(0, 8), KEY_P1, t);
  ins('INSERT INTO prisoner_api_keys(prisoner_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?)', 2, sha256(KEY_P2), KEY_P2.slice(0, 8), KEY_P2, t);
  const insPVer = 'INSERT INTO prisoner_code_versions(prisoner_id,version,code,code_hash,notes,submitted_by,smoke_status,created_at) VALUES(?,?,?,?,?,?,?,?)';
  ins(insPVer, 1, 1, CODE_P1, codeHash(CODE_P1), '首版', 'e2e', 'passed', t);
  ins(insPVer, 2, 1, CODE_P2, codeHash(CODE_P2), '首版', 'e2e', 'passed', t);
  const insPB = `INSERT INTO prisoner_battles(match_url_id,challenger_prisoner_id,challenged_prisoner_id,
    ch_code_version,cd_code_version,ch_code_hash,cd_code_hash,result,reason,actual_rounds,
    ch_score,cd_score,ch_rp_delta,cd_rp_delta,scored,seed,move_blob,failure_detail,played_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  // 完整对局：3 回合 [CD, DD, DD] → 2:7 囚乙胜
  ins(insPB, PD_URL_OK, 1, 2, 1, 1, codeHash(CODE_P1), codeHash(CODE_P2), 'challenged', 'completed', 3,
    2, 7, -15, 25, 1, 42, encodeMoves([{ a: 'C', b: 'D' }, { a: 'D', b: 'D' }, { a: 'D', b: 'D' }]), null, t);
  // 中途判负对局：failure.round=3 → 真实进行 2 回合 [CC, CD]
  ins(insPB, PD_URL_FAIL, 1, 2, 1, 1, codeHash(CODE_P1), codeHash(CODE_P2), 'challenged', 'runtime', 950,
    3, 8, -15, 25, 1, 43, encodeMoves([{ a: 'C', b: 'C' }, { a: 'C', b: 'D' }]), '{"kind":"runtime","round":3,"prisoner":"challenger"}', t);
  ins('INSERT INTO prisoner_hash_pair_scores(prisoner_id,my_hash,opp_hash,used_count) VALUES(?,?,?,?)', 1, codeHash(CODE_P1), codeHash(CODE_P2), 3);
  ins('INSERT INTO prisoner_hash_pair_scores(prisoner_id,my_hash,opp_hash,used_count) VALUES(?,?,?,?)', 2, codeHash(CODE_P2), codeHash(CODE_P1), 3);
  d.close();
}

// ---- server 生命周期 / HTTP 帮手（与 api.e2e 同款）----
async function startServer(dbFile) {
  const port = 3900 + Math.floor(Math.random() * 400);
  const env = { ...process.env };
  for (const key of ['SMTP_HOST', 'SMTP_SECURE', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'SMTP_DAILY_MAX', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'EMAIL_VERIFICATION']) delete env[key];
  Object.assign(env, { PORT: String(port), DB_PATH: dbFile, NODE_ENV: 'test', SESSION_SECRET: 'mig-test-secret' });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  let lastErr = null;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server 提前退出：\n' + logs);
    try { const r = await fetch(base + '/api/templates'); if (r.ok) break; lastErr = 'HTTP ' + r.status; } catch (e) { lastErr = e?.cause?.code || e?.message || String(e); }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server 45s 内未就绪（最后错误: ${lastErr}）：\n` + logs); }
    await sleep(150);
  }
  return { base, child, getLogs: () => logs, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
async function api(base, method, p, { cookie, bearer, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json, cookie: setCookie.length ? setCookie[0].split(';')[0] : null };
}

test('P3 迁移：旧双表族库 → 统一表族，数据经 API 全量验证', { timeout: 240000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawclash-mig-'));
  const dbFile = path.join(dir, 'legacy.db');
  buildLegacyDb(dbFile);

  let srv = await startServer(dbFile);
  t.after(async () => { await srv.stop(); for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); } } });

  await t.test('启动即迁移（旧表留底 legacy_*）', () => {
    assert.ok(srv.getLogs().includes('[P3 迁移] 完成'), srv.getLogs());
    const inspect = new DatabaseSync(dbFile);
    try {
      assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='email_code_registration_v1_1'").get().n, 1);
      assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('pending_registrations','registration_mail_attempts')").get().n, 2);
      assert.equal(inspect.prepare('SELECT email_verified FROM accounts WHERE id=2').get().email_verified, 1,
        '首次 v1.1 迁移应放行历史未验证账号');
    } finally { inspect.close(); }
  });

  let cookieA;
  await t.test('账号与登录态原样：密码可登录、资产归属正确', async () => {
    const login = await api(srv.base, 'POST', '/api/auth/login', { body: { email: 'jia@mig.dev', password: 'password123' } });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    cookieA = login.cookie;
    const me = await api(srv.base, 'GET', '/api/me', { cookie: cookieA });
    assert.equal(me.json.account.nickname != null, true);
    // /api/me 通用结构：迁移后的选手概要应出现在 players（公开 id 原样保留）
    assert.equal(me.json.players.clawclash.id, 1, '公开 botId 必须原样保留');
    assert.equal(me.json.players.clawclash.rp, 275);
    // 选手详情仍由钳王自己的 /me 端点返回
    const botMe = await api(srv.base, 'GET', '/api/bot/me', { cookie: cookieA });
    assert.equal(botMe.json.bot.id, 1);
    assert.equal(botMe.json.bot.rp, 275);
  });

  await t.test('天梯榜：两款游戏的分数/战绩/排序原样', async () => {
    const lb = (await api(srv.base, 'GET', '/api/leaderboard')).json.leaderboard;
    assert.deepEqual(lb.map((r) => [r.botId, r.name, r.rp, r.wins, r.losses, r.draws]),
      [[1, '老甲', 275, 10, 2, 1], [2, '老乙', 40, 1, 5, 0]]);
    assert.equal(lb[0].rankName, '青铜 I');
    const plb = (await api(srv.base, 'GET', '/api/leaderboard/prisoner')).json.leaderboard;
    assert.deepEqual(plb.map((r) => [r.prisonerId, r.name, r.rp]), [[1, '囚甲', 165], [2, '囚乙', 25]]);
  });

  await t.test('密钥与版本历史原样：旧 Bearer Key 直接可用', async () => {
    const info = await api(srv.base, 'GET', '/api/agent/bot/info', { bearer: KEY_A });
    assert.equal(info.status, 200, JSON.stringify(info.json));
    assert.equal(info.json.bot.id, 1);
    assert.equal(info.json.bot.currentVersion, 2);
    assert.equal(info.json.bot.rankPosition, 1);
    const vs = (await api(srv.base, 'GET', '/api/agent/bot/code/versions', { bearer: KEY_A })).json.versions;
    assert.deepEqual(vs.map((v) => v.version), [2, 1]);
    const v1 = (await api(srv.base, 'GET', '/api/bot/me/version/1', { cookie: cookieA })).json.version;
    assert.equal(v1.code, CODE_A1, '历史版本代码逐字节一致');
    const meBot = (await api(srv.base, 'GET', '/api/bot/me', { cookie: cookieA })).json.bot;
    assert.ok(meBot.maskedKey.startsWith(KEY_A.slice(0, 8)), '掩码 key 应来自迁移后的明文 key');
  });

  await t.test('钳王战报与棋谱：battle→matches 链接原样、回放可取', async () => {
    const battles = (await api(srv.base, 'GET', '/api/bot/me/matches', { cookie: cookieA })).json.battles;
    assert.equal(battles.length, 1);
    assert.equal(battles[0].battleUrlId, BATTLE_URL);
    assert.equal(battles[0].result, 'win');
    assert.equal(battles[0].rpDelta, 25);
    assert.equal(battles[0].games.length, 2, '两局明细必须跟着场走（battle_id 链接保留）');
    assert.deepEqual(battles[0].games.map((g) => g.result), ['win', 'draw']);
    const m = await api(srv.base, 'GET', '/api/match/' + BATTLE_URL + 'a');
    assert.equal(m.status, 200);
    assert.equal(m.json.winner, 'challenger');
    assert.equal(m.json.challengerName, '老甲');
    assert.ok(Array.isArray(m.json.gameData.history));
    for (const field of ['seed', 'battle_id', 'challenger_player_id', 'challenged_player_id', 'ch_code_hash', 'cd_code_hash', 'game_json', 'initial_layout']) {
      assert.equal(Object.prototype.hasOwnProperty.call(m.json, field), false, `迁移后的公开回放不应暴露 ${field}`);
    }
  });

  await t.test('囚徒战报：blob 选择序列逐位一致（含中途判负的截断解码）', async () => {
    const ok = (await api(srv.base, 'GET', '/api/match/prisoner/' + PD_URL_OK)).json.match;
    assert.equal(ok.actualRounds, 3);
    assert.deepEqual([ok.chScore, ok.cdScore], [2, 7]);
    assert.deepEqual(ok.moves, [{ a: 'C', b: 'D' }, { a: 'D', b: 'D' }, { a: 'D', b: 'D' }]);
    const fail = (await api(srv.base, 'GET', '/api/match/prisoner/' + PD_URL_FAIL)).json.match;
    assert.equal(fail.reason, 'runtime');
    assert.deepEqual(fail.failure, { kind: 'runtime', round: 3, prisoner: 'challenger' });
    assert.deepEqual(fail.moves, [{ a: 'C', b: 'C' }, { a: 'C', b: 'D' }], '判负场按 failure.round−1 截断解码');
  });

  await t.test('哈希对计分窗口跨迁移保留：用满 10 场的钳王对第一场即练习赛', async () => {
    const r = await api(srv.base, 'POST', '/api/agent/challenge', { bearer: KEY_A, body: { challengedBotId: 2 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.scored, false, '迁移后窗口余量必须为 0');
    assert.equal(r.json.rpChange.challenger.from, 275);
    assert.equal(r.json.rpChange.challenger.to, 275, '练习赛不得改分');
    const pub = (await api(srv.base, 'GET', '/api/bots/1/public')).json.bot;
    assert.deepEqual([pub.rp, pub.wins, pub.losses, pub.draws], [275, 10, 2, 1], '练习赛不入战绩');
  });

  await t.test('囚徒挑战：窗口余量（已用 3）继续计分，RP 从迁移值出发', async () => {
    const r = await api(srv.base, 'POST', '/api/agent/prisoner/challenge', { bearer: KEY_P1, body: { targetPrisonerId: 2 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.result, 'challenged', 'AllD 必胜 TFT');
    assert.equal(r.json.scored, true);
    assert.deepEqual([r.json.rpChange.challenger.from, r.json.rpChange.challenger.to], [165, 150]);
    assert.deepEqual([r.json.rpChange.challenged.from, r.json.rpChange.challenged.to], [25, 50]);
    assert.ok(r.json.scoringNote.includes('还可计分 6 场'), '窗口已用 3 + 本场 1 → 余 6：' + r.json.scoringNote);
  });

  await t.test('二次启动幂等：不重复迁移，数据保持', async () => {
    const inspect = new DatabaseSync(dbFile);
    inspect.prepare('UPDATE accounts SET email_verified=0 WHERE id=2').run();
    inspect.close();
    await srv.stop();
    srv = await startServer(dbFile);
    assert.ok(!srv.getLogs().includes('[P3 迁移]'), '二次启动不得再触发迁移：\n' + srv.getLogs());
    const afterRestart = new DatabaseSync(dbFile);
    try {
      assert.equal(afterRestart.prepare('SELECT email_verified FROM accounts WHERE id=2').get().email_verified, 0,
        '迁移标记存在时不得重复批量修改历史账号');
    } finally { afterRestart.close(); }
    const pub = (await api(srv.base, 'GET', '/api/bots/1/public')).json.bot;
    assert.equal(pub.rp, 275);
    const p1 = (await api(srv.base, 'GET', '/api/prisoners/1/public')).json.prisoner;
    assert.equal(p1.rp, 150, '重启后保留挑战后的最新分');
  });
});
