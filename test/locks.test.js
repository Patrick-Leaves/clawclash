'use strict';
// per-key 串行锁特征测试：钉住 platform/locks.js 的并发语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withLock, withTwoLocks } = require('../platform/locks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('withLock：同 key 严格串行，异 key 可并行', async () => {
  const order = [];
  let inside = 0, maxInside = 0;
  const job = (tag, ms) => async () => {
    inside++; maxInside = Math.max(maxInside, inside);
    order.push(tag + ':in');
    await sleep(ms);
    order.push(tag + ':out');
    inside--;
  };
  // 同 key 三个任务并发提交 → 必须一个跑完再跑下一个
  await Promise.all([
    withLock('k1', job('a', 30)),
    withLock('k1', job('b', 10)),
    withLock('k1', job('c', 5)),
  ]);
  assert.deepEqual(order, ['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  assert.equal(maxInside, 1);

  // 异 key 并行：两个 20ms 任务总耗时应远小于串行的 40ms（放宽判定防抖动）
  const t0 = Date.now();
  await Promise.all([withLock('kx', () => sleep(20)), withLock('ky', () => sleep(20))]);
  assert.ok(Date.now() - t0 < 38, '异 key 未并行');
});

test('withLock：前一环异常不阻塞后续，且异常正确抛给各自调用方', async () => {
  const seen = [];
  const p1 = withLock('k2', async () => { await sleep(5); throw new Error('boom'); });
  const p2 = withLock('k2', async () => { seen.push('second-ran'); return 'ok'; });
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, 'ok');
  assert.deepEqual(seen, ['second-ran']);
});

test('withLock：返回值透传', async () => {
  assert.equal(await withLock('k3', () => 42), 42);
  assert.equal(await withLock('k3', async () => 'v'), 'v');
});

test('withTwoLocks：A/B 与 B/A 并发不死锁，临界区互斥', async () => {
  let inside = 0, maxInside = 0;
  const crit = () => async () => {
    inside++; maxInside = Math.max(maxInside, inside);
    await sleep(15);
    inside--;
  };
  await Promise.all([
    withTwoLocks('bot:1', 'bot:2', crit()),
    withTwoLocks('bot:2', 'bot:1', crit()), // 反序取锁：字符串排序保证不死锁
    withTwoLocks('bot:1', 'bot:2', crit()),
  ]);
  assert.equal(maxInside, 1, '两把锁下临界区必须互斥');
});

test('withTwoLocks：与单把锁互斥（持有 bot:1 时双锁临界区不得进入）', async () => {
  const order = [];
  const p1 = withLock('bot:1', async () => { order.push('single-in'); await sleep(20); order.push('single-out'); });
  await sleep(1); // 确保单锁先入队
  const p2 = withTwoLocks('bot:1', 'bot:2', () => { order.push('double-in'); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['single-in', 'single-out', 'double-in']);
});

test('withTwoLocks：同 key 退化为单锁不挂起', async () => {
  assert.equal(await withTwoLocks('same', 'same', () => 'ok'), 'ok');
});
