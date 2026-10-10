'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const clawEngine = require('../games/clawclash/engine/engine_quota');
const clawSandbox = require('../games/clawclash/engine/sandbox');
const darkEngine = require('../games/darkchess/engine/engine');
const darkSandbox = require('../games/darkchess/engine/sandbox');

test('clawclash sandbox canonicalizes a getter-backed move inside the VM', () => {
  const { bot, error } = clawSandbox.makeBot(`
    module.exports = function () {
      const move = {};
      Object.defineProperty(move, 'from', { get() { return [0, 2]; } });
      Object.defineProperty(move, 'to', { get() { return [1, 2]; } });
      move[Symbol.iterator] = function* () { yield { from: [3, 3], to: [0, 0] }; };
      return move;
    };
  `);
  assert.equal(error, null);
  const result = bot.onTurn({}, {}, {});
  assert.deepEqual(result, { from: [0, 2], to: [1, 2] });
  assert.equal(Object.getPrototypeOf(result), Object.getPrototypeOf({}));
});

test('darkchess sandbox canonicalizes flip and move actions', () => {
  const flip = darkSandbox.makeBot(`module.exports = () => ({ action: 'flip', at: [1, 2] });`);
  assert.equal(flip.error, null);
  assert.deepEqual(flip.bot.onTurn({}, {}, {}), { action: 'flip', at: [1, 2] });

  const move = darkSandbox.makeBot(`module.exports = () => ({ action: 'move', from: [0, 0], to: [0, 1] });`);
  assert.equal(move.error, null);
  assert.deepEqual(move.bot.onTurn({}, {}, {}), { action: 'move', from: [0, 0], to: [0, 1] });
});

test('sandbox getter loops are contained by the VM timeout', () => {
  const { bot, error } = clawSandbox.makeBot(`
    module.exports = function () {
      const move = {};
      Object.defineProperty(move, 'from', { get() { while (true) {} } });
      return move;
    };
  `);
  assert.equal(error, null);
  assert.throws(() => bot.onTurn({}, {}, {}), /挂钟超时|timed out/i);
});

test('clawclash history is not mutable through the bot view', () => {
  const bot = {
    onTurn(_me, _opponent, game) {
      if (game.history.length === 0) {
        game.history.push({ injected: true });
      } else {
        game.history[0].from[0] = 99;
      }
      return game.legalMoves[0];
    },
  };
  const result = clawEngine.playMatch({ black: bot, red: bot }, 1, 100, 1000, { now: Date.now });
  assert.ok(result.history.every((entry) => !entry.injected));
  assert.ok(result.history.every((entry) => !entry.from || entry.from[0] !== 99));
});

test('darkchess history is not mutable through the bot view', () => {
  const bot = {
    onTurn(_me, _opponent, game) {
      if (game.history.length === 0) game.history.push({ injected: true });
      else if (game.history[0].action?.at) game.history[0].action.at[0] = 99;
      return game.legalActions[0];
    },
  };
  const result = darkEngine.playMatch({ a: bot, b: bot }, 1, 1000, { now: Date.now });
  assert.ok(result.history.every((entry) => !entry.injected));
  assert.ok(result.history.every((entry) => !entry.action?.at || entry.action.at[0] !== 99));
});

test('clawclash charges elapsed time to the side that ran', () => {
  let now = 0;
  const slow = {
    onTurn(_me, _opponent, game) {
      now += 2600;
      return game.legalMoves[0];
    },
  };
  const fast = { onTurn(_me, _opponent, game) { now += 5; return game.legalMoves[0]; } };
  const result = clawEngine.playMatch({ black: slow, red: fast }, 1, 100, 60000, { now: () => now, perSideBudgetMs: 10000 });
  assert.equal(result.winner, 'red');
  assert.equal(result.reason, 'runtime');
});

test('darkchess charges elapsed time to the side that ran', () => {
  let now = 0;
  const slow = { onTurn(_me, _opponent, game) { now += 2600; return game.legalActions[0]; } };
  const fast = { onTurn(_me, _opponent, game) { now += 5; return game.legalActions[0]; } };
  const result = darkEngine.playMatch({ a: slow, b: fast }, 1, 60000, { now: () => now, perSideBudgetMs: 10000 });
  assert.equal(result.winner, 'b');
  assert.equal(result.reason, 'runtime');
});

for (const [name, seats, actionKey, play, sandbox] of [
  ['clawclash', ['black', 'red'], 'legalMoves',
    (bots, limit, options) => clawEngine.playMatch(bots, 1, 100, limit, options), clawSandbox],
  ['darkchess', ['a', 'b'], 'legalActions',
    (bots, limit, options) => darkEngine.playMatch(bots, 1, limit, options), darkSandbox],
]) {
  test(`${name} default match deadline cannot spend the other side's clock`, () => {
    let now = 0;
    const spent = Object.fromEntries(seats.map((seat) => [seat, 0]));
    const durations = name === 'clawclash' ? [2000, 1000] : [2200, 1800];
    const bots = Object.fromEntries(seats.map((seat, i) => [seat, {
      onTurn(_me, _opponent, game) {
        now += durations[i];
        spent[seat] += durations[i];
        return game[actionKey][0];
      },
    }]));
    const result = play(bots, undefined, { now: () => now });
    assert.equal(result.reason, 'runtime');
    assert.equal(result.winner, seats[1]);
    assert.ok(spent[seats[0]] >= 10000, JSON.stringify(spent));
    assert.ok(spent[seats[1]] < 10000, JSON.stringify(spent));
  });

  test(`${name} explicit whole-match guard aborts without awarding a player win`, () => {
    let now = 0;
    const bot = { onTurn(_me, _opponent, game) { now += 2; return game[actionKey][0]; } };
    const bots = Object.fromEntries(seats.map((seat) => [seat, bot]));
    assert.throws(() => play(bots, 1, { now: () => now }), { code: 'MATCH_TIMEOUT' });
  });

  test(`${name} supplies the lesser of the single-turn limit and remaining side budget`, () => {
    let now = 0;
    const limits = [];
    const slow = {
      onTurn(_me, _opponent, game, timeoutMs) {
        limits.push(timeoutMs);
        now += 2600;
        return game[actionKey][0];
      },
    };
    const fast = { onTurn(_me, _opponent, game) { now += 5; return game[actionKey][0]; } };
    const result = play({ [seats[0]]: slow, [seats[1]]: fast }, undefined, { now: () => now });
    assert.deepEqual(limits, [3000, 3000, 3000, 2200]);
    assert.equal(result.winner, seats[1]);
    assert.equal(result.reason, 'runtime');
  });

  test(`${name} sandbox applies a short remaining budget to action extraction`, () => {
    const property = name === 'clawclash' ? 'from' : 'at';
    const { bot, error } = sandbox.makeBot(`
      module.exports = function () {
        const result = { action: 'flip' };
        Object.defineProperty(result, '${property}', { get() { while (true) {} } });
        return result;
      };
    `);
    assert.equal(error, null);
    const startedAt = Date.now();
    assert.throws(() => bot.onTurn({}, {}, {}, 20), (error) =>
      name === 'clawclash' ? error.quota === true : error.timeout === true);
    assert.ok(Date.now() - startedAt < 1500, 'VM ignored the remaining 20ms budget');
  });

  test(`${name} guide documents the actual independent-clock invocation limit`, () => {
    const { buildGuide } = require(`../games/${name}/guide`);
    const guide = buildGuide({ scoredLimit: 10 });
    assert.ok(guide.includes('单手实际时限取 3 秒与本方剩余预算的较小值'));
    assert.ok(!guide.includes('后者包含双方计算与对局推进耗时'));
  });
}
