'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../games/darkchess/engine/rules_core');
const { publicDarkBoard, publicDarkHistory } = require('../platform/public_replay');

const source = fs.readFileSync(path.join(__dirname, '../games/darkchess/public/app.js'), 'utf8');
const start = source.indexOf('function dqBuildReplayFrames(');
const end = source.indexOf('function dqPhaseAtFrame(', start);
assert.ok(start >= 0 && end > start, 'production replay function must exist');
const context = vm.createContext({ window: { DarkchessRules: core } });
vm.runInContext(source.slice(start, end), context, { filename: 'darkchess-replay.js' });
const buildFrames = context.dqBuildReplayFrames;
const plain = (value) => JSON.parse(JSON.stringify(value));
function emptyBoard() { return Array.from({ length: core.WIDTH }, () => Array(core.HEIGHT).fill(null)); }
function piece(side, kind, hidden = false) { return { side, kind, power: core.KIND_POWER[kind], hidden }; }

for (const [name, kind, targetKind, hidden, targetSide, from, to, screen] of [
  ['ordinary higher-power capture', 'chariot', 'horse', false, 'red', [6, 0], [7, 0]],
  ['soldier captures general', 'soldier', 'general', false, 'red', [6, 0], [7, 0]],
  ['equal pieces mutually capture', 'horse', 'horse', false, 'red', [6, 0], [7, 0]],
  ['cannon captures revealed piece', 'cannon', 'soldier', false, 'red', [0, 0], [3, 0], [1, 0]],
  ['cannon captures cannon without mutual destruction', 'cannon', 'cannon', false, 'red', [0, 0], [3, 0], [1, 0]],
  ['cannon captures hidden enemy', 'cannon', 'general', true, 'red', [4, 0], [7, 0], [5, 0]],
  ['cannon captures hidden friendly', 'cannon', 'general', true, 'black', [4, 0], [7, 0], [5, 0]],
  ['vertical cannon capture', 'cannon', 'horse', false, 'red', [7, 0], [7, 3], [7, 1]],
]) {
  test(`darkchess replay agrees with rules after ${name}`, () => {
    const board = emptyBoard();
    board[from[0]][from[1]] = piece('black', kind);
    board[to[0]][to[1]] = piece(targetSide, targetKind, hidden);
    if (screen) board[screen[0]][screen[1]] = piece('black', 'soldier');
    const move = { from, to };
    const result = core.applyMove(board, 'black', move);
    const initialBoard = publicDarkBoard(board);
    const initialSnapshot = plain(initialBoard);
    const history = publicDarkHistory([{ turn: 1, seat: 'a', action: { action: 'move', ...move },
      captured: result.captured, revealed: null, pass: false }]);
    const historySnapshot = plain(history);
    const frames = buildFrames(initialBoard, history);
    assert.deepEqual(plain(frames[1].board), publicDarkBoard(result.board));
    assert.deepEqual(plain(frames[0].board), initialSnapshot);
    assert.deepEqual(initialBoard, initialSnapshot);
    assert.deepEqual(history, historySnapshot);
    assert.notEqual(frames[0].board, frames[1].board);
    assert.notEqual(frames[0].board[0], frames[1].board[0]);
  });
}

test('darkchess replay preserves flip, empty-square move and pass frames', () => {
  const board = emptyBoard();
  board[7][3] = piece('black', 'soldier', true);
  const flipped = core.applyFlip(board, [7, 3]);
  const moved = core.applyMove(flipped.board, 'black', { from: [7, 3], to: [6, 3] });
  const history = publicDarkHistory([
    { turn: 1, seat: 'a', action: { action: 'flip', at: [7, 3] }, captured: [], revealed: flipped.revealed },
    { turn: 2, seat: 'b', action: null, captured: [], pass: true },
    { turn: 3, seat: 'a', action: { action: 'move', from: [7, 3], to: [6, 3] }, captured: [] },
  ]);
  const frames = buildFrames(publicDarkBoard(board), history);
  assert.equal(frames.length, 4);
  assert.deepEqual(plain(frames[0].board), publicDarkBoard(board));
  assert.deepEqual(plain(frames[1].board), publicDarkBoard(flipped.board));
  assert.deepEqual(plain(frames[2].board), publicDarkBoard(flipped.board));
  assert.deepEqual(plain(frames[3].board), publicDarkBoard(moved.board));
});
