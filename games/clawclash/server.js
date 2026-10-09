'use strict';
// 钳王争霸 · 服务端适配（仅主进程加载）：统一数据层 store、游戏私有表（matches 逐局棋谱）、
// 响应视图、挑战执行、试玩等游戏专属路由。
// 注意：本文件含 db 访问，绝不能被 games/registry（runner 子进程也会加载）引用。
const crypto = require('crypto');
const db = require('../../db');
const execpool = require('../../platform/execpool');
const { settleChallenge } = require('../../platform/settle');
const { rankLabel, wldInc } = require('../../platform/scoring');
const manifest = require('./index');
const { initBoard } = require('./engine/engine_quota');
const { runPlay: runPlaySession } = require('./engine/play_session');
const { findBuiltin } = require('./engine/builtins');
const { publicClawHistory } = require('../../platform/public_replay');

// ---- 统一数据层（P3）：平台通用读写全部来自 gameStore ----
// 同 RP 次级排序用内部 ELO（rating）——钳王独有；listBattles 额外附挂每场的两局明细。
const core = db.gameStore(manifest.id, { rankTiebreak: 'rating' });
const store = {
  ...core,
  listBattles: (playerId, limit) =>
    core.listBattles(playerId, limit).map((b) => ({ ...b, games: stmtBattleGames.all(b.id) })),
};

// ---- 游戏私有表：matches（逐局棋谱；一场 battle = 两局 match）----
// 平台层不感知本表；无外键（迁移期重建去 FK），完整性由本模块在应用层保证。
db.db.exec(`
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_url_id TEXT UNIQUE NOT NULL,
  challenger_bot_id INTEGER NOT NULL,
  challenged_bot_id INTEGER NOT NULL,
  ch_code_version INTEGER NOT NULL,
  cd_code_version INTEGER NOT NULL,
  ch_code_hash TEXT NOT NULL,
  cd_code_hash TEXT NOT NULL,
  winner TEXT NOT NULL,
  reason TEXT NOT NULL,
  turns INTEGER NOT NULL,
  final_challenger_pieces INTEGER NOT NULL,
  final_challenged_pieces INTEGER NOT NULL,
  game_json TEXT NOT NULL,
  challenger_side TEXT NOT NULL,
  seed INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  battle_id INTEGER,
  game_no INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matches_challenger ON matches(challenger_bot_id);
CREATE INDEX IF NOT EXISTS idx_matches_challenged ON matches(challenged_bot_id);
CREATE INDEX IF NOT EXISTS idx_matches_battle ON matches(battle_id);
`);
const stmtInsertMatch = db.db.prepare(`
  INSERT INTO matches(match_url_id,challenger_bot_id,challenged_bot_id,ch_code_version,cd_code_version,
    ch_code_hash,cd_code_hash,winner,reason,turns,final_challenger_pieces,final_challenged_pieces,
    game_json,challenger_side,seed,played_at,battle_id,game_no)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const stmtGetMatch = db.db.prepare('SELECT * FROM matches WHERE match_url_id=?');
const stmtBattleGames = db.db.prepare('SELECT game_no,match_url_id,winner,reason,turns,challenger_side FROM matches WHERE battle_id=? ORDER BY game_no');
const stmtListBotMatches = db.db.prepare(`
  SELECT m.*, cb.name AS challenger_name, cd.name AS challenged_name
  FROM matches m
  JOIN players cb ON cb.game_id='clawclash' AND cb.id=m.challenger_bot_id
  JOIN players cd ON cd.game_id='clawclash' AND cd.id=m.challenged_bot_id
  WHERE m.challenger_bot_id=? OR m.challenged_bot_id=?
  ORDER BY m.played_at DESC LIMIT ?`);
const stmtListOpponentMatches = db.db.prepare(`
  SELECT m.*, cb.name AS challenger_name, cd.name AS challenged_name
  FROM matches m
  JOIN players cb ON cb.game_id='clawclash' AND cb.id=m.challenger_bot_id
  JOIN players cd ON cd.game_id='clawclash' AND cd.id=m.challenged_bot_id
  WHERE m.challenger_bot_id=? OR m.challenged_bot_id=?
  ORDER BY m.played_at DESC LIMIT ? OFFSET ?`);
const stmtCountOpponentMatches = db.db.prepare('SELECT COUNT(*) AS cnt FROM matches WHERE challenger_bot_id=? OR challenged_bot_id=?');

function saveMatch({ urlId, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, gameJson, challengerSide, seed, battleId, gameNo }) {
  stmtInsertMatch.run(urlId, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, JSON.stringify(gameJson), challengerSide, seed, db.now(), battleId ?? null, gameNo ?? null);
}

// ---- ELO（内部实力分，仅钳王维护，用于同 RP 次级排序）----
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function eloUpdate(rA, rB, scoreA, K = 32) {
  return Math.round(rA + K * (scoreA - eloExpected(rA, rB)));
}

// ---- 视图 ----
// 场记录 → 指定棋手视角（本场结果 / 对方名 / 本方 RP 增减 / 两局明细）
function battleView(b, botId) {
  const isCh = b.challenger_id === botId;
  const persp = (winner) => winner === 'draw' ? 'draw' : ((winner === 'challenger') === isCh ? 'win' : 'loss');
  return {
    battleUrlId: b.url_id, playedAt: b.played_at,
    opponentName: isCh ? b.challenged_name : b.challenger_name,
    opponentAvatar: isCh ? b.challenged_avatar : b.challenger_avatar,
    result: persp(b.result),
    rpDelta: isCh ? b.ch_rp_delta : b.cd_rp_delta,
    scored: b.scored == null ? 1 : b.scored,
    games: b.games.map((g) => ({
      gameNo: g.game_no, matchUrlId: g.match_url_id,
      result: persp(g.winner),
      mySide: isCh ? g.challenger_side : (g.challenger_side === 'black' ? 'red' : 'black'),
      reason: g.reason, turns: g.turns,
    })),
  };
}
const battleListView = (rows, viewerId) => rows.map((b) => battleView(b, viewerId));

const leaderboardRow = (b, i) => ({
  rank: i + 1, botId: b.id, name: b.name, avatar: b.avatar,
  nickname: b.nickname, rp: b.rp, rankName: rankLabel(b.rp),
  wins: b.wins, losses: b.losses, draws: b.draws,
  currentVersion: b.current_version,
});

// ---- 一键复制 Prompt（含完整 key）----
function buildPrompt(bot, key, origin) {
  return [
    '你是我的钳王争霸 Agent。请为我的棋手编写并提交对弈脚本。',
    '',
    `【棋手】${bot.name}（botId: ${bot.id}） · 段位：${rankLabel(bot.rp)} · 当前版本：v${bot.current_version}${bot.current_version === 0 ? '（空脚本）' : ''}`,
    `【棋手密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onTurn(me, opponent, game) 签名、Rules API 与计费点数规则。',
    '2. 编写评估脚本（module.exports = function onTurn(me, opponent, game) {...}）。',
    '3. 用下面的接口提交（系统先跑 6 局烟雾测试，通过才分配版本号并发布；失败不占用版本号）：',
    `   POST ${origin}/api/agent/bot/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本字符串>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 若烟雾失败，按返回的失败明细修复后直接重提即可。',
    '5. 通过后，可读天梯榜、侦察对手、发起正式挑战来提升段位。',
  ].join('\n');
}

// ---- Agent 数据视图（钳王独有形态：按「局」列 matches）----
function agentMatches(bot, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = stmtListBotMatches.all(bot.id, bot.id, limit);
  return { ok: true, matches: rows.map((m) => ({ ...m, game_json: undefined })) };
}

// 对手侦察（§6.6a）：近期棋谱摘要（分页）
function opponentMatches(target, url) {
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 10));
  const offset = Math.max(0, +url.searchParams.get('offset') || 0);
  const rows = stmtListOpponentMatches.all(target.id, target.id, limit, offset);
  const { cnt } = stmtCountOpponentMatches.get(target.id, target.id);
  return {
    ok: true, botId: target.id, botName: target.name,
    total: cnt, hasMore: offset + rows.length < cnt, limit, offset,
    matches: rows.map((m) => ({
      matchUrlId: m.match_url_id, played_at: m.played_at,
      challenger: m.challenger_name, challenged: m.challenged_name,
      winner: m.winner, reason: m.reason, turns: m.turns,
      challengerSide: m.challenger_side,
      chCodeHash: m.ch_code_hash, cdCodeHash: m.cd_code_hash,
    })),
  };
}

// 对局回放详情（公开）：显式构造 DTO，不把数据库整行暴露给客户端。
function matchDetail(urlId) {
  const row = stmtGetMatch.get(urlId);
  if (!row) return null;
  const gameJson = JSON.parse(row.game_json);
  const chBot = store.getById(row.challenger_bot_id);
  const cdBot = store.getById(row.challenged_bot_id);
  return {
    ok: true,
    matchUrlId: row.match_url_id,
    winner: row.winner,
    reason: row.reason,
    turns: row.turns,
    finalChallengerPieces: row.final_challenger_pieces,
    finalChallengedPieces: row.final_challenged_pieces,
    challengerSide: row.challenger_side,
    gameNo: row.game_no,
    gameData: { initialBoard: gameJson.initialBoard, history: publicClawHistory(gameJson.history) },
    challengerName: chBot?.name,
    challengedName: cdBot?.name,
    challengerAvatar: chBot?.avatar,
    challengedAvatar: cdBot?.avatar,
  };
}

// ---- 正式挑战（§7/§8）：双局制（执黑/执红各 1），双局合计定胜负 ----
const challenge = {
  bodyIdField: 'challengedBotId',
  async execute({ challenger, challenged, chCode, cdCode, ownerKey }) {
    const baseUrlId = db.urlId();
    // 每场用全新随机种子：对局非确定性，相同两套脚本多次对战过程可不同（防"可复现刷分"，也更具观赏性）。
    const baseSeed = crypto.randomInt(0, 1 << 30);

    // 双局在隔离子进程执行：第 1 局 challenger=black，第 2 局 challenger=red
    let game1, game2;
    try {
      const out = await execpool.run('clawclash', 'challenge', {
        chCode: chCode.code, cdCode: cdCode.code, seed: baseSeed, budget: manifest.matchBudget,
      }, ownerKey);
      if (out && out.loadFailed) return { status: 500, json: { ok: false, error: '棋手代码加载失败' } };
      ({ game1, game2 } = out);
    } catch (e) {
      return { status: e && e.busy ? 503 : 500, json: { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败，请重试' } };
    }

    // 从引擎视角换算为挑战者视角的胜负
    const challengerWinner = (result, challengerSide) =>
      result.winner === 'draw' ? 'draw' : (result.winner === challengerSide ? 'challenger' : 'challenged');
    const w1 = challengerWinner(game1, 'black');
    const w2 = challengerWinner(game2, 'red');

    // 合计：挑战者得分（2=胜, 1=平, 0=负）
    let chScore = 0, cdScore = 0;
    for (const w of [w1, w2]) {
      if (w === 'challenger') chScore += 2;
      else if (w === 'challenged') cdScore += 2;
      else { chScore += 1; cdScore += 1; }
    }
    const chResult = chScore > cdScore ? 'win' : chScore < cdScore ? 'loss' : 'draw';
    const battleResult = chResult === 'win' ? 'challenger' : chResult === 'loss' ? 'challenged' : 'draw';

    // 结算走平台统一核心（platform/settle.js：串行锁 + 锁内重读 + 哈希对窗口 + RP 计算）；
    // 这里只注入钳王专属部分——ELO 内部分、战绩写库、本场与两局战报的落库形态。
    const settlement = await settleChallenge({
      ns: manifest.id, challenger, challenged,
      chHash: chCode.code_hash, cdHash: cdCode.code_hash,
      chResult, scoredLimit: manifest.scoredLimit,
      store: {
        getFresh: (id) => store.getById(id),
        getHashPair: (id, my, opp) => store.getHashPair(id, my, opp),
        recordHashPair: (id, my, opp) => store.recordHashPair(id, my, opp),
        applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult, cdResult }) {
          const chFrac = chScore / 4; // 挑战者在 4 分满分中的占比
          const newChRating = eloUpdate(chFresh.rating, cdFresh.rating, chFrac);
          const newCdRating = eloUpdate(cdFresh.rating, chFresh.rating, 1 - chFrac);
          store.updateStats(chFresh.id, newChRating, newChRp, ...wldInc(chResult));
          store.updateStats(cdFresh.id, newCdRating, newCdRp, ...wldInc(cdResult));
        },
        persist({ chFresh, cdFresh, newChRp, newCdRp, scored }) {
          // 存储本场（统一战报核心）与两局对局（游戏私有 matches 表）
          const battleId = store.createBattle({
            urlId: baseUrlId, challengerId: chFresh.id, challengedId: cdFresh.id,
            result: battleResult, chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
            scored: scored ? 1 : 0,
          });
          const matchUrlId1 = baseUrlId + 'a';
          const matchUrlId2 = baseUrlId + 'b';
          saveMatch({ urlId: matchUrlId1, challengerBotId: chFresh.id, challengedBotId: cdFresh.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w1, reason: game1.reason, turns: game1.turns, finalCh: game1.finalPieces.black, finalCd: game1.finalPieces.red, gameJson: { initialBoard: initBoard(), history: game1.history }, challengerSide: 'black', seed: baseSeed, battleId, gameNo: 1 });
          saveMatch({ urlId: matchUrlId2, challengerBotId: chFresh.id, challengedBotId: cdFresh.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w2, reason: game2.reason, turns: game2.turns, finalCh: game2.finalPieces.red, finalCd: game2.finalPieces.black, gameJson: { initialBoard: initBoard(), history: game2.history }, challengerSide: 'red', seed: baseSeed + 1, battleId, gameNo: 2 });
          return { matchUrlId1, matchUrlId2 };
        },
      },
    });

    return { status: 200, json: {
      ok: true,
      battle: { battleUrlId: baseUrlId, result: battleResult },
      summary: { challengerScore: chScore, challengedScore: cdScore },
      games: [
        { matchUrlId: settlement.matchUrlId1, challengerSide: 'black', winner: w1, reason: game1.reason, turns: game1.turns },
        { matchUrlId: settlement.matchUrlId2, challengerSide: 'red', winner: w2, reason: game2.reason, turns: game2.turns },
      ],
      scored: settlement.scored,
      rpChange: {
        challenger: { from: settlement.fromChRp, to: settlement.newChRp, rank: rankLabel(settlement.newChRp) },
        challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, rank: rankLabel(settlement.newCdRp) },
      },
      scoringNote: settlement.scored
        ? `本场计入段位/战绩/ELO。该哈希对（双方当前版本）还可计分 ${Math.max(0, manifest.scoredLimit - (settlement.priorCount + 1))} 场（共 ${manifest.scoredLimit} 场），之后为练习赛不计分（回滚不重置，§6.2a）；改进脚本（哈希变化）可重获资格。`
        : `本场为练习赛不计分：该哈希对（双方当前版本）已用满 ${manifest.scoredLimit} 场计分资格。改进并发布新版本（哈希变化）即可重新计分。`,
    } };
  },
};

// ---- legacy 路径别名（已发布给 Agent/前端的稳定契约，长期保留）----
const aliases = {
  create: ['/api/bot/create'],
  nameCheck: ['/api/bot/name-check'],
  avatarUpload: ['/api/bot/me/avatar'],
  avatarPreset: ['/api/bot/me/avatar/preset'],
  me: ['/api/bot/me'],
  prompt: ['/api/bot/me/prompt'],
  rotateKey: ['/api/bot/me/rotate-key'],
  meVersions: ['/api/bot/me/versions'],
  meVersion: [/^\/api\/bot\/me\/version\/(\d+)$/],
  meMatches: ['/api/bot/me/matches'],
  agentInfo: ['/api/agent/bot/info'],
  codeSubmit: ['/api/agent/bot/code/submit'],
  codeRevert: ['/api/agent/bot/code/revert'],
  codeVersions: ['/api/agent/bot/code/versions'],
  challenge: ['/api/agent/challenge'],
  agentMatches: ['/api/agent/bot/matches'],
  opponentMatches: [/^\/api\/agent\/opponents\/(\d+)\/matches$/],
  leaderboard: ['/api/leaderboard'],
  playerPublic: [/^\/api\/bots\/(\d+)\/public$/],
  playerMatchesPublic: [/^\/api\/bots\/(\d+)\/matches\/public$/],
  matchDetail: [/^\/api\/match\/([a-z0-9]+)$/],
  guide: ['/agent-guide'],
};

// ---- 游戏专属附加路由：试玩 / 对手清单 / 棋手搜索 ----
const TEMPLATE_META = [
  { name: '子力派', summary: '以子力差为主，辅以机动与中心；直接吃子换子。', kind: 'template' },
  { name: '封锁派', summary: '压制对方机动数，把对手逼到无路可走。', kind: 'template' },
  { name: '裁定派', summary: '棋子凝聚 + 规避被吃；领先时拖到 20 手按子力判胜。', kind: 'template' },
  { name: '抢中派', summary: '抢中心 + 威胁导向；领先时持续吃子打 eliminated。', kind: 'template' },
];
// 三名训练棋手也开放试玩（烟雾测试同款）
const TRAINING_META = [
  { name: '牧童', summary: '随机走子，熟悉规则的入门对手。', kind: 'training' },
  { name: '石郎', summary: '有吃必吃，其余随机。', kind: 'training' },
  { name: '棋圣', summary: '两层子力搜索，稳健难缠。', kind: 'training' },
];
const OPPONENT_META = [...TEMPLATE_META, ...TRAINING_META];
const OPPONENT_NAMES = OPPONENT_META.map((t) => t.name);

function extraRoutes({ route, sendJson, rl, rateLimited, clientIp }) {
  // 试玩对手清单
  route('GET', '/api/templates', (req, res) => {
    sendJson(res, 200, { templates: OPPONENT_META });
  });

  // 人机对弈试玩（无状态：每次重放完整历史）。不入库、不计分。
  // body: { template?, botId?, mode?, humanSide, history: [{side,from,to,pass?}] }
  route('POST', '/api/play', async (req, res, _m, body) => {
    // 试玩无需登录：按 IP 限速，避免匿名刷请求占满隔离子进程池
    if (rateLimited(res, rl.allow('play:' + clientIp(req), 120, 60 * 1000))) return;
    const local = body.mode === 'local';
    let opponent = null;
    if (!local) {
      if (body.humanSide !== 'black' && body.humanSide !== 'red')
        return sendJson(res, 400, { ok: false, error: 'humanSide 须为 black/red' });
      if (body.botId != null) {
        const target = store.getById(+body.botId);
        if (!target) return sendJson(res, 404, { ok: false, error: '棋手不存在' });
        const code = store.latestPassed(target.id);
        if (!code) return sendJson(res, 422, { ok: false, error: `「${target.name}」尚未发布可用脚本，暂不能对战` });
        opponent = { kind: 'bot', code: code.code, name: target.name };
      } else {
        if (!OPPONENT_NAMES.includes(body.template)) return sendJson(res, 400, { ok: false, error: '对手非法' });
        opponent = { kind: 'builtin', name: body.template };
      }
    }
    const spec = { mode: body.mode, humanSide: body.humanSide, history: body.history, opponent };
    // 信任分流：仅「玩家上传脚本(botId)」是不可信代码，须 fork 隔离子进程；
    // 「内置流派/训练棋手/双人同屏」全为本仓库可信代码，主进程内直接推进，省掉每步 fork 冷启动。
    const untrusted = !!opponent && opponent.kind === 'bot';
    let r;
    try {
      if (untrusted) {
        r = await execpool.run('clawclash', 'play', { spec }, 'ip:' + clientIp(req));
      } else {
        // makeBot 仅在 opp.kind==='bot' 时被调用——此分支不会触达，置守卫确保绝不在主进程载入用户脚本
        r = runPlaySession(spec, { findBuiltin, makeBot() { throw new Error('in-process play path must not load user scripts'); } });
      }
    } catch (e) {
      return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '试玩执行繁忙，请稍后重试' : '试玩执行失败' });
    }
    if (!r.ok) return sendJson(res, r.status || 400, { ok: false, error: r.error });
    sendJson(res, 200, r.payload);
  });

  // 搜索玩家棋手（试玩挑战用，公开）
  route('GET', '/api/bots/search', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { ok: true, bots: [] });
    const rows = store.searchByName(q);
    sendJson(res, 200, { ok: true, bots: rows.map((b) => ({
      botId: b.id, name: b.name, avatar: b.avatar,
      ownerNickname: b.nickname, rp: b.rp, rank: rankLabel(b.rp),
      playable: b.current_version > 0,
    })) });
  });
}

module.exports = {
  store, battleListView, leaderboardRow, buildPrompt,
  agentMatches, opponentMatches, matchDetail,
  challenge, aliases, extraRoutes,
};
