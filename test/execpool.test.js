'use strict';
// 常驻 runner 池（platform/execpool.js）单元测试：真实 fork + 真实引擎（不触 db）。
// 覆盖：warm worker 顺序复用、并发派发、per-owner 上限与释放、未注册任务拒绝、
// 失败任务不污染后续任务（每任务全新 vm 上下文）。
// 超时处决路径依赖 manifest 硬超时（最短 20s），单测不模拟；由 e2e 的真实任务面覆盖池稳定性。
const test = require('node:test');
const assert = require('node:assert');
const execpool = require('../platform/execpool');

const OK_CODE = 'module.exports = function onTurn(me, opp, game){ return game.legalMoves[0]; };';

test('常驻池：顺序任务复用 warm worker，结果正确', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await execpool.run('clawclash', 'smoke', { code: OK_CODE }, 'pool-test:seq');
    assert.equal(r.passed, true, JSON.stringify(r.failures || []));
  }
});

test('并发派发 + per-owner 上限：同 owner 第 3 个并发任务 busy，完成后释放', async () => {
  const owner = 'pool-test:conc';
  const p1 = execpool.run('clawclash', 'smoke', { code: OK_CODE }, owner);
  const p2 = execpool.run('clawclash', 'smoke', { code: OK_CODE }, owner);
  await assert.rejects(
    execpool.run('clawclash', 'smoke', { code: OK_CODE }, owner),
    (e) => e.busy === true,
    '同 owner 超过 MAX_PER_OWNER 应立即 busy',
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.passed, true);
  assert.equal(r2.passed, true);
  // 上限随任务完成释放：再次提交应被接受并正常执行
  const r3 = await execpool.run('clawclash', 'smoke', { code: OK_CODE }, owner);
  assert.equal(r3.passed, true);
});

test('未注册任务：直接拒绝，不占池', async () => {
  await assert.rejects(execpool.run('clawclash', 'nope', {}, 'pool-test:x'), /未注册的执行任务/);
});

test('失败任务不污染池：编译失败正常回报后，同 worker 池继续服务新任务', async () => {
  // 编译失败属于任务的正常返回（smoke 回 passed:false），不触发 worker 换新——
  // 验证点是失败任务留下的沙箱状态绝不影响后续任务（每任务全新 vm 上下文）。
  const bad = await execpool.run('clawclash', 'smoke', { code: 'this is not valid js((' }, 'pool-test:bad');
  assert.equal(bad.passed, false);
  assert.ok(bad.failures.length >= 1);
  const ok = await execpool.run('clawclash', 'smoke', { code: OK_CODE }, 'pool-test:bad');
  assert.equal(ok.passed, true);
});
