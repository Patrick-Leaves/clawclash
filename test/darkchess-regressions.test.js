'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../games/darkchess/engine/rules_core');
const engine = require('../games/darkchess/engine/engine');
const sandbox = require('../games/darkchess/engine/sandbox');
const darkchess = require('../games/darkchess');

function emptyBoard() {
  return Array.from({ length: core.WIDTH }, () => Array(core.HEIGHT).fill(null));
}
function piece(side, kind, hidden = false) {
  return { side, kind, power: core.KIND_POWER[kind], hidden };
}
function playingState(board, noCaptureCount = 39) {
  return { ...engine.initMatchState(1), board, phase: 'playing', colorOf: { a: 'black', b: 'red' },
    turnSeat: 'a', noCaptureCount };
}

for (const action of [
  { action: 'flip', at: [4, 0] },
  { action: 'flip', at: [7, 3] },
  { action: 'move', from: [3, 0], to: [4, 0] },
  { action: 'move', from: [6, 3], to: [7, 3] },
  { action: 'move', from: [7, 0], to: [6, 0] },
]) {
  test(`darkchess sandbox preserves valid right-half action ${JSON.stringify(action)}`, () => {
    const { bot, error } = sandbox.makeBot(`module.exports = () => (${JSON.stringify(action)});`);
    assert.equal(error, null);
    assert.deepEqual(bot.onTurn({}, {}, {}), action);
  });
}

for (const at of [[8, 0], [0, 4], [-1, 0], [0, -1], [1.5, 0], ['7', 0], [7, '3']]) {
  test(`darkchess sandbox rejects out-of-board coordinates ${JSON.stringify(at)}`, () => {
    for (const action of [{ action: 'flip', at },
      { action: 'move', from: at, to: [7, 3] }, { action: 'move', from: [7, 3], to: at }]) {
      const { bot } = sandbox.makeBot(`module.exports = () => (${JSON.stringify(action)});`);
      assert.equal(bot.onTurn({}, {}, {}), null);
    }
  });
}

const RIGHTMOST_BOT = 'module.exports = (_me, _opp, game) => game.legalActions[game.legalActions.length - 1];';
test('darkchess challenge accepts the rightmost legal action from sandboxed players', () => {
  const result = darkchess.tasks.challenge({ aCode: RIGHTMOST_BOT, bCode: RIGHTMOST_BOT, seed: 1 });
  assert.notEqual(result.reason, 'illegal');
  assert.notEqual(result.reason, 'error');
  assert.deepEqual(result.history[0].action, { action: 'flip', at: [7, 3] });
});
test('darkchess six-game smoke accepts right-half actions', () => {
  assert.deepEqual(darkchess.tasks.smoke({ code: RIGHTMOST_BOT }), { passed: true, failures: [] });
});
test('darkchess play accepts a sandboxed right-half flip and keeps identities masked', () => {
  const seed = 1;
  const humanSeat = engine.otherSeat(engine.initMatchState(seed).turnSeat);
  const result = darkchess.tasks.play({ spec: { mode: 'vs', humanSeat, seed, history: [],
    opponent: { kind: 'bot', code: RIGHTMOST_BOT } } });
  assert.equal(result.ok, true);
  assert.equal(result.payload.status.over, false);
  assert.deepEqual(result.payload.history[0].action, { action: 'flip', at: [7, 3] });
  for (const cell of result.payload.board.flat().filter((cell) => cell?.hidden)) {
    assert.deepEqual(cell, { hidden: true });
  }
});

test('darkchess real hidden board can reach a balanced 40-step value draw', () => {
  const board = core.initBoard(() => 0.5);
  assert.equal(core.judge(board, 39), null);
  assert.deepEqual(core.judge(board, 40), { winner: 'draw', reason: 'noCapture' });
});
test('darkchess real hidden material counts toward value and elimination takes precedence', () => {
  const board = emptyBoard();
  board[0][0] = piece('black', 'general', true);
  board[7][3] = piece('red', 'soldier', true);
  assert.deepEqual(core.judge(board, 40), { winner: 'black', reason: 'noCapture' });
  board[7][3] = null;
  assert.deepEqual(core.judge(board, 0), { winner: 'black', reason: 'eliminated' });
  assert.deepEqual(core.judge(board, 40), { winner: 'black', reason: 'eliminated' });
});
test('darkchess masked all-hidden and mixed boards remain inconclusive', () => {
  const board = core.initBoard(() => 0.5);
  for (const ncm of [0, 40]) assert.equal(core.judge(engine.fogBoard(board), ncm), null);
  board[0][0] = { ...board[0][0], hidden: false };
  assert.equal(core.judge(engine.fogBoard(board), 40), null);
});
test('darkchess bot judge remains conservative even if a bot invents hidden identities', () => {
  const state = playingState(core.initBoard(() => 0.5));
  const { game } = engine.buildView(state, 'a');
  assert.equal(game.rules.judge(game.board, 40), null);
  assert.equal(game.rules.judge(state.board, 40), null);
  const revealed = state.board.map((col) => col.map((cell) => ({ ...cell, hidden: false })));
  assert.deepEqual(game.rules.judge(revealed, 40), { winner: 'draw', reason: 'noCapture' });
});
test('darkchess stepAction settles 40 non-capture steps with hidden pieces remaining', () => {
  const board = emptyBoard();
  board[0][0] = piece('black', 'general');
  board[7][3] = piece('red', 'soldier', true);
  const state = playingState(board);
  assert.deepEqual(engine.stepAction(state, 'a', { action: 'move', from: [0, 0], to: [1, 0] }),
    { over: true, winner: 'a', reason: 'noCapture' });
});
test('darkchess stepAction settles elimination even when the winning side has hidden pieces', () => {
  const board = emptyBoard();
  board[0][0] = piece('black', 'general');
  board[1][0] = piece('red', 'chariot');
  board[7][3] = piece('black', 'soldier', true);
  const state = playingState(board);
  assert.deepEqual(engine.stepAction(state, 'a', { action: 'move', from: [0, 0], to: [1, 0] }),
    { over: true, winner: 'a', reason: 'eliminated' });
  assert.equal(state.noCaptureCount, 0);
});
test('darkchess stepPass uses the same real-board judge', () => {
  const state = playingState(emptyBoard());
  state.board[0][0] = piece('black', 'general', true);
  state.board[7][3] = piece('red', 'soldier', true);
  assert.deepEqual(engine.stepPass(state), { over: true, winner: 'a', reason: 'noCapture' });
});
test('darkchess browser UMD uses the real-board judge and conservative bot helper', () => {
  const context = vm.createContext({});
  for (const file of ['rules_core.js', 'engine.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../games/darkchess/engine', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  const state = context.DarkchessEngine.initMatchState(1);
  const result = context.DarkchessRules.judge(state.board, 40);
  assert.equal(result?.winner, 'draw');
  assert.equal(result?.reason, 'noCapture');
  assert.equal(context.DarkchessEngine.buildView(state, state.turnSeat).game.rules.judge(state.board, 40), null);
});
