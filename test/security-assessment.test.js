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
  const masked = darkRules.cloneBoard(board);
  const result = darkRules.judge(masked, 0);
  assert.equal(result, null);
});
