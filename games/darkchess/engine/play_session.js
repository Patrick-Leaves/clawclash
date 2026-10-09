'use strict';
// 试玩对局核心（无状态重放 + 推进到人类可走）。由子进程 runner 调用，与 Web/DB 进程隔离。
// 重放校验完全由本端重算（不信任客户端附带的翻棋/吃子字段）。不入库、不计分。
//
// 与钳王的关键差异：本游戏开局是随机摆放的（规则 §4），「无状态重放」必须靠同一个 seed
// 才能在每次请求里重新推导出同一个初始暗棋分布——首次请求由服务器生成 seed 并随 payload
// 回传，客户端后续请求原样带回。试玩响应里的棋盘永远是「遮罩后」的视图，绝不下发暗棋真实身份
// （哪怕是本地双人模式——现实里两个人共享一块暗棋棋盘，翻开前谁也不知道底下是什么）。
//
// 注意：本接口只服务「挑战已发布的玩家棋手」这一不可信代码路径（必须服务器沙箱结算）。
// 「训练棋手对战」与「双人同屏」两种可信代码路径已改为浏览器本地直接跑 engine.js 的同一套
// step 原语（见 games/darkchess/public/app.js + /darkchess-bots.js），不再经过这里；
// 本接口仍保留对 local/training 的支持，作为通用 API 兜底（例如非浏览器客户端调用）。
const core = require('./rules_core');
const {
  otherSeat, actionsEqual,
  legalActionsForSeat, buildView, fogBoard,
  initMatchState, stepPass, stepAction,
} = require('./engine');

// spec: { mode, humanSeat, seed, history }
//   opponent: { kind:'bot', code, name } | { kind:'builtin', id } | null(local)
// deps:  { makeBot, findBuiltin }
function runPlay(spec, { makeBot, findBuiltin }) {
  const local = spec.mode === 'local';
  let humanSeat = null, botSeat = null, bot = null, oppName = null;
  if (!local) {
    humanSeat = spec.humanSeat;
    if (humanSeat !== 'a' && humanSeat !== 'b') return { ok: false, status: 400, error: 'humanSeat 须为 a/b' };
    botSeat = otherSeat(humanSeat);
    const opp = spec.opponent || {};
    if (opp.kind === 'bot') {
      const made = makeBot(opp.code);
      if (!made.bot) return { ok: false, status: 500, error: '棋手脚本加载失败' };
      bot = made.bot; oppName = opp.name || '玩家棋手';
    } else if (opp.kind === 'builtin') {
      bot = findBuiltin(opp.id);
      if (!bot) return { ok: false, status: 400, error: '对手非法' };
      oppName = bot.name;
    } else {
      return { ok: false, status: 400, error: '缺少对手' };
    }
  }
  const seed = Number.isInteger(spec.seed) ? spec.seed : ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
  const rawHistory = Array.isArray(spec.history) ? spec.history : [];
  if (rawHistory.length > 4000) return { ok: false, status: 400, error: '历史过长' };

  const matchState = initMatchState(seed);
  let status = null;

  for (const h of rawHistory) {
    if (status) return { ok: false, status: 400, error: '历史在终局后仍有动作' };
    if (!h || h.seat !== matchState.turnSeat) return { ok: false, status: 400, error: `第 ${matchState.turnNumber} 手行动方不符` };
    const actions = legalActionsForSeat(matchState, matchState.turnSeat);
    if (h.pass) {
      if (actions.length > 0) return { ok: false, status: 400, error: `第 ${matchState.turnNumber} 手有合法动作，不能停一手` };
      status = stepPass(matchState);
    } else {
      const ok = h.action && actions.some((a) => actionsEqual(a, h.action));
      if (!ok) return { ok: false, status: 400, error: `第 ${matchState.turnNumber} 手动作非法` };
      status = stepAction(matchState, matchState.turnSeat, actions.find((a) => actionsEqual(a, h.action)));
    }
  }

  // 推进到人类可走为止：机器人应手 / 双方无动作可行自动 pass
  while (!status) {
    const actions = legalActionsForSeat(matchState, matchState.turnSeat);
    if (actions.length === 0) { status = stepPass(matchState); continue; }
    if (local || matchState.turnSeat === humanSeat) break;
    const view = buildView(matchState, matchState.turnSeat);
    let action;
    try { action = bot.onTurn(view.me, view.opponent, view.game); }
    catch { status = { over: true, winner: humanSeat, reason: 'error' }; break; }
    const ok = action && actions.some((a) => actionsEqual(a, action));
    if (!ok) { status = { over: true, winner: humanSeat, reason: 'illegal' }; break; }
    status = stepAction(matchState, matchState.turnSeat, actions.find((a) => actionsEqual(a, action)));
  }

  const toMoveSeat = status ? null : (local ? matchState.turnSeat : humanSeat);
  const legalActions = status ? [] : legalActionsForSeat(matchState, matchState.turnSeat);
  return {
    ok: true,
    payload: {
      ok: true, mode: local ? 'local' : 'vs', opponent: oppName, seed,
      humanSeat, botSeat, toMoveSeat, phase: matchState.phase, colorOf: matchState.colorOf,
      board: fogBoard(matchState.board), history: matchState.history.map((h) => ({
        ...h,
        action: h.action ? (h.action.action === 'flip' ? { action: 'flip', at: h.action.at.slice() } : { action: 'move', from: h.action.from.slice(), to: h.action.to.slice() }) : null,
        captured: h.captured.map((c) => ({ ...c })),
        revealed: h.revealed ? { ...h.revealed } : null,
      })),
      counts: core.counts(matchState.board), noCaptureCount: matchState.noCaptureCount,
      legalActions,
      status: status ? { over: true, winner: status.winner, reason: status.reason, turns: matchState.history.length } : { over: false, turns: matchState.history.length },
    },
  };
}

module.exports = { runPlay };
