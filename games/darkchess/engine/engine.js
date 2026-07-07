'use strict';
// 对局引擎（按规则 v1.0 §5-§12 重建）：翻棋定序阶段状态机 + 行棋阶段三选一 + 停一手/无吃子裁决。
// 与 rules_core 的边界：rules_core 只认「颜色」，不认「座位」；本文件维护「座位(a/b) ↔ 颜色」的
// 映射（定序阶段的核心复杂度），并负责向棋手隐藏暗棋身份（fog of war）后再调用其 onTurn。
//
// 对外暴露一组可复用的「单步」原语（initMatchState/stepPass/stepAction/...），
// Node 端的 playMatch（子进程内 bot-vs-bot 整场对局）与 play_session.js（无状态重放试玩）
// 都基于这组原语实现，避免同一套推进/判定逻辑写两份；浏览器端本地对局（训练棋手/双人同屏，
// 见 games/darkchess/public/app.js）经 /darkchess-bots.js 直接复用同一份编译产物，逐步推进。
// UMD：Node 下 require rules_core；浏览器下复用 window.DarkchessRules（/darkchess-bots.js）。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./rules_core'));
  else root.DarkchessEngine = factory(root.DarkchessRules);
})(typeof self !== 'undefined' ? self : this, function (core) {

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function otherSeat(seat) { return seat === 'a' ? 'b' : 'a'; }
function seatOfColor(matchState, color) { return matchState.colorOf.a === color ? 'a' : 'b'; }

function actionsEqual(a, b) {
  if (!a || !b || a.action !== b.action) return false;
  if (a.action === 'flip') return Array.isArray(a.at) && Array.isArray(b.at) && a.at[0] === b.at[0] && a.at[1] === b.at[1];
  return a.from && b.from && a.to && b.to &&
    a.from[0] === b.from[0] && a.from[1] === b.from[1] && a.to[0] === b.to[0] && a.to[1] === b.to[1];
}

// 座位当前可选动作：定序阶段只有翻棋；行棋阶段 = 翻棋（若还有暗棋）+ 移动/吃子。
function legalActionsForSeat(matchState, seat) {
  const flips = core.hiddenCells(matchState.board).map(([x, y]) => ({ action: 'flip', at: [x, y] }));
  if (matchState.phase === 'determining') return flips;
  const side = matchState.colorOf[seat];
  const moves = core.legalMoves(matchState.board, side).map((m) => ({ action: 'move', from: m.from.slice(), to: m.to.slice() }));
  return flips.concat(moves);
}

// 遮罩棋盘：暗棋只显示「这里有暗棋」，不泄露归属/兵种/等级（§6a 信息边界）
function fogBoard(board) {
  return board.map((col) => col.map((cell) => {
    if (!cell) return null;
    if (cell.hidden) return { hidden: true };
    return { hidden: false, side: cell.side, kind: cell.kind, power: cell.power, label: core.LABELS[cell.side][cell.kind] };
  }));
}
function revealedPiecesOf(board, side) {
  if (!side) return null;
  const list = [];
  for (let x = 0; x < core.WIDTH; x++) for (let y = 0; y < core.HEIGHT; y++) {
    const c = board[x][y];
    if (c && !c.hidden && c.side === side) list.push([x, y]);
  }
  return list;
}

// 执行一个动作（变更 matchState），返回 { captured, revealed }。仅供 stepAction 内部调用。
function applyActionMutating(matchState, seat, action) {
  if (action.action === 'flip') {
    const { board: nb, revealed } = core.applyFlip(matchState.board, action.at);
    matchState.board = nb;
    if (matchState.phase === 'determining') {
      matchState.pendingFlips.push({ seat, side: revealed.side });
      if (matchState.pendingFlips.length === 2) {
        const [f1, f2] = matchState.pendingFlips;
        if (f1.side !== f2.side) {
          matchState.colorOf[f1.seat] = f1.side;
          matchState.colorOf[f2.seat] = f2.side;
          matchState.phase = 'playing';
        }
        matchState.pendingFlips = [];
      }
      // 兜底（规则 §5 第 5 条）：全部翻开仍未分出颜色 → 系统随机分配
      if (matchState.phase === 'determining' && core.countHidden(matchState.board) === 0) {
        const firstColor = matchState.rng() < 0.5 ? 'black' : 'red';
        matchState.colorOf[seat] = firstColor;
        matchState.colorOf[otherSeat(seat)] = core.other(firstColor);
        matchState.phase = 'playing';
        matchState.pendingFlips = [];
      }
    }
    return { captured: [], revealed };
  }
  const side = matchState.colorOf[seat];
  const r = core.applyMove(matchState.board, side, action);
  matchState.board = r.board;
  return { captured: r.captured, revealed: null };
}

// 构造喂给棋手代码的视图（me/opponent/game），已按信息边界遮罩。
function buildView(matchState, seat) {
  const mySide = matchState.colorOf[seat] || null;
  const oppSide = mySide ? core.other(mySide) : null;
  const c = core.counts(matchState.board);
  const me = mySide
    ? { side: mySide, remaining: c[mySide], capturedCount: 16 - c[mySide], revealedPieces: revealedPiecesOf(matchState.board, mySide) }
    : { side: null, remaining: null, capturedCount: null, revealedPieces: null };
  const opponent = oppSide
    ? { side: oppSide, remaining: c[oppSide], capturedCount: 16 - c[oppSide], revealedPieces: revealedPiecesOf(matchState.board, oppSide) }
    : { side: null, remaining: null, capturedCount: null, revealedPieces: null };
  const game = {
    phase: matchState.phase,
    board: fogBoard(matchState.board),
    turnNumber: matchState.turnNumber,
    noCaptureCount: matchState.noCaptureCount,
    legalActions: legalActionsForSeat(matchState, seat),
    history: matchState.history,
    random: matchState.rng,
    rules: {
      legalMoves: core.legalMoves,
      apply: (board, side2, action) => core.applyMove(board, side2, { from: action.from, to: action.to }),
      judge: core.judge,
      clone: core.cloneBoard,
      other: core.other,
      pieceValue: (kind) => core.KIND_POWER[kind],
    },
  };
  return { me, opponent, game };
}

// 新建一局的初始状态：随机开局摆放 + 随机先手座位。
function initMatchState(seed) {
  const rng = mulberry32(seed);
  const initialBoard = core.initBoard(rng);
  const firstSeat = rng() < 0.5 ? 'a' : 'b';
  return {
    board: core.cloneBoard(initialBoard), phase: 'determining', colorOf: {}, pendingFlips: [],
    turnSeat: firstSeat, turnNumber: 1, noCaptureCount: 0, rng, history: [], lastWasPass: false,
    initialBoard,
  };
}

// 推进一次「停一手」：返回 null 表示对局继续；否则 { over:true, winner:'a'|'b'|'draw', reason }。
function stepPass(matchState) {
  matchState.history.push({ turn: matchState.turnNumber, seat: matchState.turnSeat, action: null, captured: [], revealed: null, pass: true });
  matchState.noCaptureCount++;
  let result = null;
  if (matchState.lastWasPass) { // 双方连续互停 → 按子力价值裁定（§9）
    const v = core.judgeByValue(matchState.board);
    result = { over: true, winner: v.winner === 'draw' ? 'draw' : seatOfColor(matchState, v.winner), reason: 'stalemate' };
  } else {
    matchState.lastWasPass = true;
    if (matchState.phase === 'playing') {
      const v = core.judge(matchState.board, matchState.noCaptureCount);
      if (v) result = { over: true, winner: v.winner === 'draw' ? 'draw' : seatOfColor(matchState, v.winner), reason: v.reason };
    }
  }
  if (!result) { matchState.turnNumber++; matchState.turnSeat = otherSeat(matchState.turnSeat); }
  return result;
}

// 推进一次真实动作（翻棋/移动/吃子）：返回 null 表示对局继续；否则同 stepPass 的终局对象。
function stepAction(matchState, seat, action) {
  const { captured, revealed } = applyActionMutating(matchState, seat, action);
  matchState.history.push({ turn: matchState.turnNumber, seat, action, captured, revealed, pass: false });
  matchState.noCaptureCount = captured.length > 0 ? 0 : matchState.noCaptureCount + 1;
  matchState.lastWasPass = false;
  let result = null;
  if (matchState.phase === 'playing') {
    const v = core.judge(matchState.board, matchState.noCaptureCount);
    if (v) result = { over: true, winner: v.winner === 'draw' ? 'draw' : seatOfColor(matchState, v.winner), reason: v.reason };
  }
  if (!result) { matchState.turnNumber++; matchState.turnSeat = otherSeat(matchState.turnSeat); }
  return result;
}

function finFrom(matchState, winner, reason) {
  return {
    winner, reason, turns: matchState.history.length, history: matchState.history, initialBoard: matchState.initialBoard,
    finalCounts: core.counts(matchState.board), finalValues: core.pieceValueSum(matchState.board),
  };
}

// bots = { a: {onTurn}, b: {onTurn} }
// 单场挂钟上限（安全阀，防「每手不超时但整体长拖」）。超时则中止，由该走方判 runtime 负。
function playMatch(bots, seed, maxMatchMs = 15000) {
  const matchState = initMatchState(seed);
  const deadline = Date.now() + maxMatchMs;

  while (true) {
    if (Date.now() > deadline) return finFrom(matchState, otherSeat(matchState.turnSeat), 'runtime');
    const seat = matchState.turnSeat;
    const actions = legalActionsForSeat(matchState, seat);

    if (actions.length === 0) { // 停一手：引擎自动 pass，不调用 onTurn
      const r = stepPass(matchState);
      if (r) return finFrom(matchState, r.winner, r.reason);
      continue;
    }

    const view = buildView(matchState, seat);
    let action;
    try {
      action = bots[seat].onTurn(view.me, view.opponent, view.game);
    } catch (e) {
      return finFrom(matchState, otherSeat(seat), e && e.timeout ? 'runtime' : 'error');
    }
    const ok = actions.some((a) => actionsEqual(a, action));
    if (!ok) return finFrom(matchState, otherSeat(seat), 'illegal');

    const r = stepAction(matchState, seat, action);
    if (r) return finFrom(matchState, r.winner, r.reason);
    if (matchState.turnNumber > 4000) return finFrom(matchState, 'draw', 'draw'); // 理论不可达的安全阀
  }
}

return {
  playMatch, mulberry32, otherSeat, seatOfColor, actionsEqual,
  legalActionsForSeat, buildView, fogBoard,
  initMatchState, stepPass, stepAction,
};
});
