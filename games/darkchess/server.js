'use strict';
// 象棋暗战 · 服务端适配（仅主进程加载）：统一数据层 store、游戏私有表（darkchess_matches 完整棋谱）、
// 响应视图、挑战执行（单场制）、试玩等游戏专属路由。
// 注意：本文件含 db 访问，绝不能被 games/registry（runner 子进程也会加载）引用。
const crypto = require('crypto');
const db = require('../../db');
const execpool = require('../../platform/execpool');
const { settleChallenge } = require('../../platform/settle');
const { rankLabel, wldInc } = require('../../platform/scoring');
const manifest = require('./index');
const { runPlay: runPlaySession } = require('./engine/play_session');
const { findBuiltin } = require('./engine/builtins');
const { TRAINING_BOTS } = require('./engine/training_bots');
const { makeBot } = require('./engine/sandbox');

// ---- 统一数据层（P3）：平台通用读写全部来自 gameStore；同 RP 次级排序按创建先后（默认） ----
const core = db.gameStore(manifest.id, {});

// ---- 游戏私有表：darkchess_matches（完整棋谱：开局暗棋真实分布 + 逐步操作序列）----
// 平台层不感知本表；无外键（同其余游戏私有表一致），完整性由本模块在应用层保证。
// 必须先建表再 prepare 引用该表的语句，否则 node:sqlite 会在 prepare 阶段报「no such table」。
db.db.exec(`
CREATE TABLE IF NOT EXISTS darkchess_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_url_id TEXT UNIQUE NOT NULL,
  challenger_player_id INTEGER NOT NULL,
  challenged_player_id INTEGER NOT NULL,
  ch_code_version INTEGER NOT NULL,
  cd_code_version INTEGER NOT NULL,
  ch_code_hash TEXT NOT NULL,
  cd_code_hash TEXT NOT NULL,
  winner TEXT NOT NULL,
  reason TEXT NOT NULL,
  turns INTEGER NOT NULL,
  initial_layout TEXT NOT NULL,
  game_json TEXT NOT NULL,
  seed INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  battle_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_darkchess_matches_challenger ON darkchess_matches(challenger_player_id);
CREATE INDEX IF NOT EXISTS idx_darkchess_matches_challenged ON darkchess_matches(challenged_player_id);
CREATE INDEX IF NOT EXISTS idx_darkchess_matches_battle ON darkchess_matches(battle_id);
`);
const stmtInsertMatch = db.db.prepare(`
  INSERT INTO darkchess_matches(match_url_id,challenger_player_id,challenged_player_id,ch_code_version,cd_code_version,
    ch_code_hash,cd_code_hash,winner,reason,turns,initial_layout,game_json,seed,played_at,battle_id)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const stmtMatchByBattle = db.db.prepare('SELECT match_url_id, winner, reason, turns FROM darkchess_matches WHERE battle_id=?');
const store = {
  ...core,
  listBattles: (playerId, limit) => core.listBattles(playerId, limit).map((b) => {
    const m = stmtMatchByBattle.get(b.id);
    return { ...b, matchUrlId: m ? m.match_url_id : null, reason: m ? m.reason : null, turns: m ? m.turns : null };
  }),
};
const stmtGetMatch = db.db.prepare('SELECT * FROM darkchess_matches WHERE match_url_id=?');
const stmtListPlayerMatches = db.db.prepare(`
  SELECT m.*, cb.name AS challenger_name, cd.name AS challenged_name
  FROM darkchess_matches m
  JOIN players cb ON cb.game_id='darkchess' AND cb.id=m.challenger_player_id
  JOIN players cd ON cd.game_id='darkchess' AND cd.id=m.challenged_player_id
  WHERE m.challenger_player_id=? OR m.challenged_player_id=?
  ORDER BY m.played_at DESC LIMIT ?`);
const stmtListOpponentMatches = db.db.prepare(`
  SELECT m.*, cb.name AS challenger_name, cd.name AS challenged_name
  FROM darkchess_matches m
  JOIN players cb ON cb.game_id='darkchess' AND cb.id=m.challenger_player_id
  JOIN players cd ON cd.game_id='darkchess' AND cd.id=m.challenged_player_id
  WHERE m.challenger_player_id=? OR m.challenged_player_id=?
  ORDER BY m.played_at DESC LIMIT ? OFFSET ?`);
const stmtCountOpponentMatches = db.db.prepare('SELECT COUNT(*) AS cnt FROM darkchess_matches WHERE challenger_player_id=? OR challenged_player_id=?');

function saveMatch({ urlId, challengerPlayerId, challengedPlayerId, chVer, cdVer, chHash, cdHash, winner, reason, turns, initialLayout, gameJson, seed, battleId }) {
  stmtInsertMatch.run(urlId, challengerPlayerId, challengedPlayerId, chVer, cdVer, chHash, cdHash, winner, reason, turns,
    JSON.stringify(initialLayout), JSON.stringify(gameJson), seed, db.now(), battleId ?? null);
}

// ---- 视图 ----
function battleView(b, playerId) {
  const isCh = b.challenger_id === playerId;
  const persp = (winner) => winner === 'draw' ? 'draw' : ((winner === 'challenger') === isCh ? 'win' : 'loss');
  return {
    matchUrlId: b.matchUrlId, playedAt: b.played_at,
    opponentName: isCh ? b.challenged_name : b.challenger_name,
    opponentAvatar: isCh ? b.challenged_avatar : b.challenger_avatar,
    result: persp(b.result), reason: b.reason, turns: b.turns,
    rpDelta: isCh ? b.ch_rp_delta : b.cd_rp_delta,
    scored: b.scored == null ? 1 : b.scored,
  };
}
const battleListView = (rows, viewerId) => rows.map((b) => battleView(b, viewerId));

const leaderboardRow = (p, i) => ({
  rank: i + 1, darkchessId: p.id, name: p.name, avatar: p.avatar,
  nickname: p.nickname, rp: p.rp, rankName: rankLabel(p.rp),
  wins: p.wins, losses: p.losses, draws: p.draws,
  currentVersion: p.current_version,
});

function buildPrompt(p, key, origin) {
  return [
    '你是我的「象棋暗战」Agent。请为我的棋手编写并提交对局脚本。',
    '',
    `【棋手】${p.name}（darkchessId: ${p.id}） · 段位：${rankLabel(p.rp)} · 当前版本：v${p.current_version}${p.current_version === 0 ? '（空脚本）' : ''}`,
    `【棋手密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide-darkchess`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onTurn(me, opponent, game) 签名、翻棋定序阶段与吃子规则（尤其是炮的隔子吃、卒吃帅特例、等级相同同归于尽）。',
    '2. 编写策略脚本（module.exports = function onTurn(me, opponent, game) {...}）。',
    '3. 用以下接口提交（系统先跑 6 局烟雾测试，通过才发布；失败不占用版本号）：',
    `   POST ${origin}/api/games/darkchess/agent/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本字符串>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 若烟雾失败，按返回的失败明细修复后直接重提即可。',
    '5. 通过后，可读天梯榜、侦察对手、发起正式挑战来提升段位。',
  ].join('\n');
}

function agentMatches(p, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = stmtListPlayerMatches.all(p.id, p.id, limit);
  return { ok: true, matches: rows.map((m) => ({ ...m, game_json: undefined, initial_layout: undefined })) };
}

function opponentMatches(target, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 10));
  const offset = Math.max(0, +url.searchParams.get('offset') || 0);
  const rows = stmtListOpponentMatches.all(target.id, target.id, limit, offset);
  const { cnt } = stmtCountOpponentMatches.get(target.id, target.id);
  return {
    ok: true, darkchessId: target.id, darkchessName: target.name,
    total: cnt, hasMore: offset + rows.length < cnt, limit, offset,
    matches: rows.map((m) => ({
      matchUrlId: m.match_url_id, playedAt: m.played_at,
      challenger: m.challenger_name, challenged: m.challenged_name,
      winner: m.winner, reason: m.reason, turns: m.turns,
      chCodeHash: m.ch_code_hash, cdCodeHash: m.cd_code_hash,
    })),
  };
}

function matchDetail(urlId) {
  const row = stmtGetMatch.get(urlId);
  if (!row) return null;
  const ch = store.getById(row.challenger_player_id);
  const cd = store.getById(row.challenged_player_id);
  return {
    ok: true, ...row,
    game_json: undefined, initial_layout: undefined,
    initialBoard: JSON.parse(row.initial_layout),
    gameData: JSON.parse(row.game_json),
    challengerName: ch?.name, challengedName: cd?.name,
    challengerAvatar: ch?.avatar, challengedAvatar: cd?.avatar,
  };
}

// ---- 正式挑战：单场制（暗棋规则本身就是单局定胜负，不设多局合计）----
const challenge = {
  bodyIdField: 'challengedDarkchessId',
  async execute({ challenger, challenged, chCode, cdCode, ownerKey }) {
    const matchUrlId = db.urlId();
    // 每场用全新随机种子：决定开局暗棋分布与先手方，对局非确定性（防可复现刷分，也更具观赏性）。
    const seed = crypto.randomInt(0, 1 << 30);

    let result;
    try {
      result = await execpool.run('darkchess', 'challenge', { aCode: chCode.code, bCode: cdCode.code, seed }, ownerKey);
      if (result && result.loadFailed) return { status: 500, json: { ok: false, error: '棋手代码加载失败' } };
    } catch (e) {
      return { status: e && e.busy ? 503 : 500, json: { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败，请重试' } };
    }

    // 引擎视角：座位 a=挑战者，b=被挑战者
    const battleResult = result.winner === 'a' ? 'challenger' : result.winner === 'b' ? 'challenged' : 'draw';
    const chResult = battleResult === 'challenger' ? 'win' : battleResult === 'challenged' ? 'loss' : 'draw';

    const settlement = await settleChallenge({
      ns: manifest.id, challenger, challenged,
      chHash: chCode.code_hash, cdHash: cdCode.code_hash,
      chResult, scoredLimit: manifest.scoredLimit,
      store: {
        getFresh: (id) => store.getById(id),
        getHashPair: (id, my, opp) => store.getHashPair(id, my, opp),
        recordHashPair: (id, my, opp) => store.recordHashPair(id, my, opp),
        applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult: cr, cdResult }) {
          store.updateStats(chFresh.id, null, newChRp, ...wldInc(cr));
          store.updateStats(cdFresh.id, null, newCdRp, ...wldInc(cdResult));
        },
        persist({ chFresh, cdFresh, newChRp, newCdRp, scored }) {
          const battleId = store.createBattle({
            urlId: matchUrlId, challengerId: chFresh.id, challengedId: cdFresh.id,
            result: battleResult, reason: result.reason,
            chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
            scored: scored ? 1 : 0, seed,
            chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash,
          });
          saveMatch({
            urlId: matchUrlId, challengerPlayerId: chFresh.id, challengedPlayerId: cdFresh.id,
            chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash,
            winner: result.winner, reason: result.reason, turns: result.turns,
            initialLayout: result.initialBoard, gameJson: { history: result.history },
            seed, battleId,
          });
        },
      },
    });

    return { status: 200, json: {
      ok: true, matchUrlId,
      result: battleResult, reason: result.reason, turns: result.turns,
      finalCounts: result.finalCounts, finalValues: result.finalValues,
      rpChange: {
        challenger: { from: settlement.fromChRp, to: settlement.newChRp, rank: rankLabel(settlement.newChRp) },
        challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, rank: rankLabel(settlement.newCdRp) },
      },
      scored: settlement.scored,
      scoringNote: settlement.scored
        ? `本场计入段位/战绩。该哈希对（双方当前版本）还可计分 ${Math.max(0, manifest.scoredLimit - (settlement.priorCount + 1))} 场（共 ${manifest.scoredLimit} 场）；之后为练习赛不计分。`
        : `本场为练习赛不计分：该哈希对已用满 ${manifest.scoredLimit} 场计分资格。`,
    } };
  },
};

// ---- 游戏专属附加路由：对手清单 / 试玩 / 棋手搜索 ----
function extraRoutes({ route, sendJson, rl, rateLimited, clientIp }) {
  // 对手清单：训练棋手 + 公开榜单前 20
  route('GET', '/api/games/darkchess/opponents', (req, res) => {
    const training = TRAINING_BOTS.map(({ id, name }) => ({ kind: 'training', id, name }));
    const players = store.leaderboardRows()
      .filter((p) => p.current_version > 0)
      .slice(0, 20)
      .map((p) => ({ kind: 'player', darkchessId: p.id, name: p.name, avatar: p.avatar, ownerNickname: p.nickname, rp: p.rp, rank: rankLabel(p.rp) }));
    sendJson(res, 200, { ok: true, training, players });
  });

  // 人机试玩（无状态：每次重放完整历史）。不入库、不计分。
  // body: { mode, humanSeat, seed, history: [{seat,action,pass?}], training? | darkchessId? }
  route('POST', '/api/games/darkchess/play', async (req, res, _m, body) => {
    if (rateLimited(res, rl.allow('darkchess-play:' + clientIp(req), 120, 60 * 1000))) return;
    const local = body.mode === 'local';
    let opponent = null;
    if (!local) {
      if (body.humanSeat !== 'a' && body.humanSeat !== 'b')
        return sendJson(res, 400, { ok: false, error: 'humanSeat 须为 a/b' });
      if (body.darkchessId != null) {
        const target = store.getById(+body.darkchessId);
        if (!target) return sendJson(res, 404, { ok: false, error: '棋手不存在' });
        const code = store.latestPassed(target.id);
        if (!code) return sendJson(res, 422, { ok: false, error: `「${target.name}」尚未发布可用脚本，暂不能对战` });
        opponent = { kind: 'bot', code: code.code, name: target.name };
      } else {
        const def = TRAINING_BOTS.find((t) => t.id === body.training);
        if (!def) return sendJson(res, 400, { ok: false, error: '对手非法' });
        opponent = { kind: 'builtin', id: def.id };
      }
    }
    const spec = { mode: body.mode, humanSeat: body.humanSeat, seed: body.seed, history: body.history, opponent };
    // 信任分流：仅「玩家上传脚本」是不可信代码，须 fork 隔离子进程；内置训练棋手/双人同屏为可信代码，主进程内直接推进。
    const untrusted = !!opponent && opponent.kind === 'bot';
    let r;
    try {
      if (untrusted) {
        r = await execpool.run('darkchess', 'play', { spec }, 'ip:' + clientIp(req));
      } else {
        r = runPlaySession(spec, { findBuiltin, makeBot() { throw new Error('in-process play path must not load user scripts'); } });
      }
    } catch (e) {
      return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '试玩执行繁忙，请稍后重试' : '试玩执行失败' });
    }
    if (!r.ok) return sendJson(res, r.status || 400, { ok: false, error: r.error });
    sendJson(res, 200, r.payload);
  });

  // 搜索玩家棋手（试玩挑战用，公开）
  route('GET', '/api/games/darkchess/players/search', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { ok: true, players: [] });
    const rows = store.searchByName(q);
    sendJson(res, 200, { ok: true, players: rows.map((p) => ({
      darkchessId: p.id, name: p.name, avatar: p.avatar,
      ownerNickname: p.nickname, rp: p.rp, rank: rankLabel(p.rp),
      playable: p.current_version > 0,
    })) });
  });
}

// manifest.guidePath 承诺的短链接，实际内容与规范路径 /games/darkchess/agent-guide 完全一致
// （routes_game.js 的 reg() 会给同一个 handler 同时挂规范路径与这里登记的别名）。
const aliases = {
  guide: ['/agent-guide-darkchess'],
};

module.exports = {
  store, battleListView, leaderboardRow, buildPrompt,
  agentMatches, opponentMatches, matchDetail,
  challenge, aliases, extraRoutes,
};
