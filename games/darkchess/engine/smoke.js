'use strict';
// 发布烟雾测试：三名训练棋手各扮演座位 a/b 各 1 局，共 6 局，固定种子集。
// 任何一局以 illegal/runtime/error 终局（且输家是用户方）→ 发布失败。
const { playMatch } = require('./engine');
const { getTrainingBot } = require('./training_bots');
const { makeBot } = require('./sandbox');

const SMOKE_PLAN = [
  { trainerId: 'suishou', trainerName: '随手', userSeat: 'a', seed: 10101 },
  { trainerId: 'suishou', trainerName: '随手', userSeat: 'b', seed: 10102 },
  { trainerId: 'tanchi', trainerName: '贪吃', userSeat: 'a', seed: 20201 },
  { trainerId: 'tanchi', trainerName: '贪吃', userSeat: 'b', seed: 20202 },
  { trainerId: 'tuiyan', trainerName: '推演', userSeat: 'a', seed: 30301 },
  { trainerId: 'tuiyan', trainerName: '推演', userSeat: 'b', seed: 30302 },
];

const FAIL_REASONS = new Set(['illegal', 'runtime', 'error']);

// 返回 { passed, failures }；failures: [{ opponent, side, seed, reason, turn, detail }]
function runSmokeTests(code) {
  const { bot: userBot, error: compileError } = makeBot(code);
  if (compileError) {
    return {
      passed: false,
      failures: [{ opponent: '—', side: '—', seed: 0, reason: 'error', turn: 0, detail: `编译失败: ${compileError.message}` }],
    };
  }

  const failures = [];
  for (const plan of SMOKE_PLAN) {
    const trainer = getTrainingBot(plan.trainerId);
    const bots = plan.userSeat === 'a' ? { a: userBot, b: trainer } : { a: trainer, b: userBot };
    const result = playMatch(bots, plan.seed);
    if (FAIL_REASONS.has(result.reason) && result.winner !== plan.userSeat) {
      const lastTurn = result.history[result.history.length - 1];
      failures.push({
        opponent: plan.trainerName, side: plan.userSeat, seed: plan.seed,
        reason: result.reason, turn: lastTurn ? lastTurn.turn : 0,
        detail: `终局原因: ${result.reason}`,
      });
    }
  }
  return { passed: failures.length === 0, failures };
}

module.exports = { runSmokeTests, SMOKE_PLAN };
