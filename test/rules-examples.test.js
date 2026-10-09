'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rules } = require('../games/clawclash/engine/rules_metered');
const darkRules = require('../games/darkchess/engine/rules_core');

function emptyBoard() { return Array.from({ length: 4 }, () => Array(4).fill(null)); }
function put(board, cells, side) { for (const [x, y] of cells) board[x][y] = side; }

test('clawclash guide vector: landing line captures opponent tail', () => {
  const board = emptyBoard();
  put(board, [[0, 1], [1, 2]], 'black');
  put(board, [[2, 1]], 'red');
  const result = Rules._rawApply(board, 'black', { from: [1, 2], to: [1, 1] });
  assert.deepEqual(result.captured, [[2, 1]]);
});

test('clawclash guide vector: double-line capture is simultaneous', () => {
  const board = emptyBoard();
  put(board, [[1, 0], [0, 1], [1, 2]], 'red');
  put(board, [[2, 1], [1, 3]], 'black');
  const result = Rules._rawApply(board, 'red', { from: [1, 0], to: [1, 1] });
  assert.deepEqual(result.captured.sort(), [[1, 3], [2, 1]].sort());
});

test('clawclash guide vector: 20 non-capture steps use material result', () => {
  const board = emptyBoard();
  put(board, [[0, 0], [2, 2], [3, 3]], 'black');
  put(board, [[0, 3], [3, 0]], 'red');
  assert.deepEqual(Rules.judge(board, 20), { winner: 'black', reason: 'material' });
});

test('darkchess guide vector: masked judge is inconclusive', () => {
  const board = darkRules.initBoard(() => 0.5);
  assert.equal(darkRules.judge(board, 0), null);
});
