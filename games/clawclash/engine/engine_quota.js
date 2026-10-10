'use strict';
// 对局引擎(按规则 v2.1 §4 与策划案 §7.1 重建)
// - 黑方先行;每手前重置走棋方思考点为 budget
// - 无合法走法由引擎自动 pass(计入 noCaptureMoves),连续互停 → stalemate 按子力裁定
// - illegal / error / runtime(超点)立即判负
const { Rules, makeRules } = require('./rules_metered');
const { initBoard } = require('./rules_core'); // 开局布局：与前端共享同一事实源

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function piecesOf(board, side) {
  const p = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (board[x][y] === side) p.push([x, y]);
  return p;
}

function cloneHistory(history) {
  return history.map((h) => ({
    turn: h.turn, side: h.side,
    from: h.from ? h.from.slice() : null,
    to: h.to ? h.to.slice() : null,
    captured: Array.isArray(h.captured) ? h.captured.map((p) => p.slice()) : [],
    pass: !!h.pass,
  }));
}

// 派生独立随机源：黑/红各一条，互不串扰——一方多调几次 game.random() 无法移动对方的
// 随机序列（排位双方都是用户脚本，共享流构成操纵向量）。参照囚徒困境 engine.js 的 deriveRng。
function deriveRng(seed) {
  return {
    black: mulberry32((seed ^ 0x5E3DA2B5) >>> 0),
    red: mulberry32((seed ^ 0x9C7E11D3) >>> 0),
  };
}

// bots = { black: bot, red: bot }
// 双方计算时间独立计费；任务总耗时由父进程限制。显式 maxMatchMs 仅中止任务，不判某方负。
function playMatch(bots, seed, budget, maxMatchMs = Infinity, options = {}) {
  const now = options.now || Date.now;
  const perSideBudgetMs = options.perSideBudgetMs ?? 10000;
  const rng = deriveRng(seed);
  let board = initBoard();
  let side = 'black', turn = 1, ncm = 0, lastPass = false;
  const history = [];
  const remaining = { black: perSideBudgetMs, red: perSideBudgetMs };
  const deadline = now() + maxMatchMs;

  const fin = (winner, reason) => ({
    winner, reason, history: cloneHistory(history), turns: history.length, finalPieces: Rules._counts(board),
  });

  while (true) {
    if (now() > deadline) {
      const error = new Error('Match wall-clock limit exceeded');
      error.code = 'MATCH_TIMEOUT';
      throw error;
    }
    const moves = Rules.legalMoves(board, side);

    if (moves.length === 0) { // 停一手:引擎自动 pass,不调用 onTurn
      history.push({ turn, side, from: null, to: null, captured: [], pass: true });
      ncm++;
      if (lastPass) { // 双方连续互停 → 按子力裁定(规则四.5)
        const c = Rules._counts(board);
        if (c.black === c.red) return fin('draw', 'draw');
        return fin(c.black > c.red ? 'black' : 'red', 'stalemate');
      }
      lastPass = true;
      const v = Rules.judge(board, ncm); // pass 计入 20 手计数
      if (v) return fin(v.winner, v.reason);
      turn++; side = Rules.other(side);
      continue;
    }

    lastPass = false;
    const oppSide = Rules.other(side);
    const myPieces = piecesOf(board, side), opPieces = piecesOf(board, oppSide);
    const me = { side, pieces: myPieces, capturedCount: 6 - myPieces.length };
    const opponent = { side: oppSide, pieces: opPieces, capturedCount: 6 - opPieces.length };
    const game = {
      board: Rules.clone(board),
      turnNumber: turn,
      noCaptureMoves: ncm,
      legalMoves: moves.map((m) => ({ from: m.from.slice(), to: m.to.slice() })),
      history: cloneHistory(history),
      random: rng[side], // 每座位独立随机流（见 deriveRng）
      rules: makeRules(budget), // 本手计量实例(交给棋手)
    };

    let mv;
    const startedAt = now();
    try {
      mv = bots[side].onTurn(me, opponent, game, Math.min(3000, remaining[side]));
    } catch (e) {
      remaining[side] -= Math.max(0, now() - startedAt);
      return fin(oppSide, e && e.quota ? 'runtime' : 'error');
    }
    remaining[side] -= Math.max(0, now() - startedAt);
    if (remaining[side] <= 0) return fin(oppSide, 'runtime');
    const selected = mv && moves.find((m) =>
      m.from[0] === mv.from[0] && m.from[1] === mv.from[1] &&
      m.to[0] === mv.to[0] && m.to[1] === mv.to[1]);
    if (!selected) return fin(oppSide, 'illegal');

    const r = Rules._rawApply(board, side, selected); // 引擎结算不占脚本预算
    board = r.board;
    ncm = r.captured.length > 0 ? 0 : ncm + 1;
    history.push({ turn, side, from: selected.from.slice(), to: selected.to.slice(), captured: r.captured.map((p) => p.slice()), pass: false });
    turn++;
    const v = Rules.judge(board, ncm);
    if (v) return fin(v.winner, v.reason);
    side = oppSide;
    if (turn > 2000) return fin('draw', 'draw'); // 理论不可达的安全阀
  }
}

module.exports = { playMatch, initBoard, mulberry32, piecesOf };
