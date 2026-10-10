'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const darkEngine = require('../games/darkchess/engine/engine');
const darkRules = require('../games/darkchess/engine/rules_core');

test('darkchess opening RNG is separate from each exposed seat RNG', () => {
  const state = darkEngine.initMatchState(123456);
  assert.notEqual(state.rng, state.rngOf.a);
  assert.notEqual(state.rng, state.rngOf.b);
  assert.notEqual(state.rngOf.a, state.rngOf.b);
  const a1 = state.rngOf.a();
  const b1 = state.rngOf.b();
  state.rngOf.a();
  assert.notEqual(state.rngOf.b(), b1);
  assert.equal(typeof a1, 'number');
});

test('masked darkchess judge does not infer hidden pieces as red', () => {
  const board = darkRules.initBoard(() => 0.5);
  const masked = darkEngine.fogBoard(board);
  const result = darkRules.judge(masked, 0);
  assert.equal(result, null);
});
const { publicClawHistory, publicDarkBoard, publicDarkHistory } = require('../platform/public_replay');

test('public darkchess board masks hidden identity', () => {
  const board = [[{ hidden: true, side: 'red', kind: 'general', power: 7 }, null]];
  assert.deepEqual(publicDarkBoard(board), [[{ hidden: true }, null]]);
});

test('public replay history keeps only replay fields', () => {
  const h = [{ turn: 1, seat: 'a', action: { action: 'flip', at: [1, 2], secret: 'x' }, captured: [], revealed: { x: 1, y: 2, side: 'red', kind: 'soldier', power: 1 }, pass: false, secret: 'x' }];
  const out = publicDarkHistory(h);
  assert.deepEqual(out, [{ turn: 1, seat: 'a', action: { action: 'flip', at: [1, 2] }, captured: [], revealed: { x: 1, y: 2, side: 'red', kind: 'soldier', power: 1 }, pass: false }]);
});

test('public claw replay history drops unknown fields and clones coordinates', () => {
  const h = [{ turn: 1, side: 'black', from: [0, 1], to: [1, 1], captured: [[2, 1]], pass: false, secret: 'x' }];
  const out = publicClawHistory(h);
  assert.deepEqual(out, [{ turn: 1, side: 'black', from: [0, 1], to: [1, 1], captured: [[2, 1]], pass: false }]);
  assert.notEqual(out[0].from, h[0].from);
});

test('runner child environment excludes application secrets', () => {
  const { _internals } = require('../platform/execpool');
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'should-not-cross';
  const env = _internals.childEnv();
  if (old === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = old;
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.SMTP_HOST, undefined);
});
