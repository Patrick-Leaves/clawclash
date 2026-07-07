'use strict';
// 规则核心（按《暗棋规则_v1.0》）——纯函数，无副作用，操作的是「真实棋盘」（暗棋也带真实身份）。
// 子进程安全：不 require db/auth。信息遮罩（暗棋对 Agent 隐藏身份）由 engine.js 的 buildView 负责，
// 本文件只管真实规则结算，不关心谁能看见什么。
// UMD：Node 下挂到 module.exports；浏览器下挂到 window.DarkchessRules（经 /darkchess-bots.js 加载，
// 供试玩里「训练棋手对战 / 双人同屏」两种可信代码路径在浏览器本地直接推演，零网络）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DarkchessRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
const WIDTH = 8;   // x: 0..7
const HEIGHT = 4;  // y: 0..3

// 等级权重（大吃小 + 终局子力价值，规则 §3）
const KIND_POWER = { general: 7, advisor: 6, elephant: 5, chariot: 4, horse: 3, cannon: 2, soldier: 1 };
const KIND_COUNT = { soldier: 5, cannon: 2, chariot: 2, horse: 2, elephant: 2, advisor: 2, general: 1 };
const LABELS = {
  black: { general: '将', advisor: '士', elephant: '象', chariot: '車', horse: '馬', cannon: '炮', soldier: '卒' },
  red: { general: '帅', advisor: '仕', elephant: '相', chariot: '車', horse: '馬', cannon: '炮', soldier: '兵' },
};
const NO_CAPTURE_LIMIT = 40; // 规则 §10：连续 40 回合无吃子按子力价值裁定
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function other(side) { return side === 'black' ? 'red' : 'black'; }
function cloneBoard(board) { return board.map((col) => col.slice()); }
function inBounds(x, y) { return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT; }

// 开局摆放（规则 §4）：32 颗棋子随机打乱、背面朝上摆满全部 32 格。rng() 须返回 [0,1) 的随机数。
function initBoard(rng) {
  const pieces = [];
  for (const side of ['black', 'red']) {
    for (const kind of Object.keys(KIND_COUNT)) {
      for (let i = 0; i < KIND_COUNT[kind]; i++) pieces.push({ side, kind, power: KIND_POWER[kind] });
    }
  }
  // Fisher-Yates 洗牌
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  const board = Array.from({ length: WIDTH }, () => Array(HEIGHT).fill(null));
  let idx = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    board[x][y] = { ...pieces[idx], hidden: true };
    idx++;
  }
  return board;
}

function hiddenCells(board) {
  const out = [];
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    if (board[x][y] && board[x][y].hidden) out.push([x, y]);
  }
  return out;
}
function countHidden(board) { return hiddenCells(board).length; }

// 翻棋（规则 §5/§6a）：翻开一个尚未翻开的格子，公示其身份。
function applyFlip(board, at) {
  const [x, y] = at;
  const cell = board[x][y];
  if (!cell || !cell.hidden) throw new Error('该格不是可翻开的暗棋');
  const nb = cloneBoard(board);
  nb[x][y] = { ...cell, hidden: false };
  return { board: nb, revealed: { x, y, side: cell.side, kind: cell.kind, power: cell.power } };
}

// 某一方的全部合法「移动/吃子」（规则 §7/§8）：基础移动、基础吃子（含同归于尽、卒吃帅特例）、炮隔子吃。
function legalMoves(board, side) {
  const moves = [];
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    const piece = board[x][y];
    if (!piece || piece.hidden || piece.side !== side) continue;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const target = board[nx][ny];
      if (target === null) { moves.push({ from: [x, y], to: [nx, ny] }); continue; }
      if (piece.kind === 'cannon') continue;           // 炮不能基础吃子（§8.2）
      if (target.hidden) continue;                      // 基础吃子只能吃已翻开的棋子
      if (target.side === side) continue;                // 不能吃己方棋子
      if (piece.kind === 'general' && target.kind === 'soldier') continue; // 帅/将不能吃卒/兵
      if (piece.kind === 'soldier' && target.kind === 'general') { moves.push({ from: [x, y], to: [nx, ny] }); continue; } // 特例：卒/兵吃帅/将
      if (piece.power >= target.power) moves.push({ from: [x, y], to: [nx, ny] }); // 大吃小 + 等级相同同归于尽
    }

    if (piece.kind === 'cannon') {
      for (const [dx, dy] of DIRS) {
        let nx = x + dx, ny = y + dy, screenFound = false;
        while (inBounds(nx, ny)) {
          const cell = board[nx][ny];
          if (cell !== null) {
            if (!screenFound) { screenFound = true; }
            else {
              if (cell.hidden || cell.side !== side) moves.push({ from: [x, y], to: [nx, ny] });
              break;
            }
          }
          nx += dx; ny += dy;
        }
      }
    }
  }
  return moves;
}

function isAdjacent(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1; }

// 执行一次移动/吃子（规则 §8）。返回 { board, captured }，captured 为完整身份的数组（含隔子吃暗棋时的公示身份）。
function applyMove(board, side, move) {
  const nb = cloneBoard(board);
  const [fx, fy] = move.from, [tx, ty] = move.to;
  const piece = nb[fx][fy];
  if (!piece || piece.hidden || piece.side !== side) throw new Error('起点不是己方已翻开的棋子');
  const target = nb[tx][ty];
  const captured = [];

  if (isAdjacent(move.from, move.to)) {
    if (target === null) {
      nb[tx][ty] = piece; nb[fx][fy] = null;
    } else {
      if (piece.kind === 'cannon') throw new Error('炮不能通过基础移动吃子，必须隔子吃');
      if (target.hidden) throw new Error('基础吃子只能吃已翻开的棋子');
      if (target.side === side) throw new Error('不能吃己方棋子');
      if (piece.kind === 'soldier' && target.kind === 'general') {
        captured.push({ x: tx, y: ty, side: target.side, kind: target.kind, power: target.power });
        nb[tx][ty] = piece; nb[fx][fy] = null;
      } else if (piece.kind === 'general' && target.kind === 'soldier') {
        throw new Error('帅/将不能吃卒/兵');
      } else if (piece.power === target.power) {
        captured.push({ x: tx, y: ty, side: target.side, kind: target.kind, power: target.power });
        captured.push({ x: fx, y: fy, side: piece.side, kind: piece.kind, power: piece.power });
        nb[tx][ty] = null; nb[fx][fy] = null; // 等级相同：同归于尽
      } else if (piece.power > target.power) {
        captured.push({ x: tx, y: ty, side: target.side, kind: target.kind, power: target.power });
        nb[tx][ty] = piece; nb[fx][fy] = null;
      } else {
        throw new Error('等级不足，无法吃子');
      }
    }
  } else {
    // 炮隔子吃（§8.2）：必须同行或同列，中间恰好 1 子（炮架，明暗不限）
    if (piece.kind !== 'cannon') throw new Error('非相邻移动仅炮的隔子吃可用');
    if (fx !== tx && fy !== ty) throw new Error('炮只能沿横线或竖线吃子');
    const dx = Math.sign(tx - fx), dy = Math.sign(ty - fy);
    let x = fx + dx, y = fy + dy, screenFound = false;
    while (x !== tx || y !== ty) {
      if (nb[x][y] !== null) {
        if (screenFound) throw new Error('炮架与目标之间不能再有棋子');
        screenFound = true;
      }
      x += dx; y += dy;
    }
    if (!screenFound) throw new Error('炮吃子必须恰好隔一子（炮架）');
    if (target === null) throw new Error('目标格为空，无法隔子吃');
    if (!target.hidden && target.side === side) throw new Error('不能吃己方棋子');
    // 炮吃炮不同归于尽：单向吃子，攻击方炮本身不受影响，移动到目标格（§8.2）
    captured.push({ x: tx, y: ty, side: target.side, kind: target.kind, power: target.power });
    nb[tx][ty] = { side, kind: 'cannon', power: KIND_POWER.cannon, hidden: false };
    nb[fx][fy] = null;
  }
  return { board: nb, captured };
}

function counts(board) {
  let black = 0, red = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    const c = board[x][y];
    if (!c) continue;
    if (c.side === 'black') black++; else red++;
  }
  return { black, red };
}
// 终局子力价值总和（规则 §11）：含尚未翻开的暗棋，按其真实归属颜色计入。
function pieceValueSum(board) {
  let black = 0, red = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    const c = board[x][y];
    if (!c) continue;
    if (c.side === 'black') black += c.power; else red += c.power;
  }
  return { black, red };
}
function judgeByValue(board) {
  const v = pieceValueSum(board);
  if (v.black === v.red) return { winner: 'draw' };
  return { winner: v.black > v.red ? 'black' : 'red' };
}
// 终局裁定（规则 §12）：吃光判负优先；连续 ncm 回合无吃子达阈值按子力价值判定（不是直接判和）。
function judge(board, ncm) {
  const c = counts(board);
  if (c.black === 0) return { winner: 'red', reason: 'eliminated' };
  if (c.red === 0) return { winner: 'black', reason: 'eliminated' };
  if (ncm >= NO_CAPTURE_LIMIT) {
    const v = judgeByValue(board);
    return { winner: v.winner, reason: 'noCapture' };
  }
  return null;
}

return {
  WIDTH, HEIGHT, KIND_POWER, KIND_COUNT, LABELS, NO_CAPTURE_LIMIT,
  other, cloneBoard, initBoard, hiddenCells, countHidden,
  applyFlip, legalMoves, applyMove, counts, pieceValueSum, judgeByValue, judge,
};
});
