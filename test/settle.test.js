'use strict';
// 挑战结算核心（platform/settle.js）单元测试：用内存 store 钉住
// 计分窗口、RP 计算/夹取、双向哈希记录、锁内重读（并发丢更新回归）等语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settleChallenge } = require('../platform/settle');
const { rpDelta } = require('../platform/scoring');

// 内存 store：行为对齐 db.js（getFresh 每次返回行的最新快照副本，如同一次 SELECT）
function makeMemStore() {
  const rows = new Map();   // id -> { id, rp, wins, losses, draws }
  const pairs = new Map();  // `${id}|${my}|${opp}` -> used_count
  const calls = { applyScored: 0, persist: [] };
  const store = {
    getFresh: (id) => (rows.has(id) ? { ...rows.get(id) } : undefined),
    getHashPair(id, my, opp) {
      const c = pairs.get(`${id}|${my}|${opp}`);
      return c === undefined ? undefined : { used_count: c };
    },
    recordHashPair(id, my, opp) {
      const k = `${id}|${my}|${opp}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    },
    applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult, cdResult }) {
      calls.applyScored++;
      const bump = (row, r, rp) => { row.rp = rp; row[r === 'win' ? 'wins' : r === 'loss' ? 'losses' : 'draws']++; };
      bump(rows.get(chFresh.id), chResult, newChRp);
      bump(rows.get(cdFresh.id), cdResult, newCdRp);
    },
    persist(args) { calls.persist.push({ ...args }); return { mark: calls.persist.length }; },
  };
  return {
    rows, pairs, calls, store,
    add(id, rp = 0) { rows.set(id, { id, rp, wins: 0, losses: 0, draws: 0 }); return rows.get(id); },
  };
}
const args = (m, over = {}) => ({
  ns: over.ns || 't' + Math.random().toString(36).slice(2, 8), // 每用例独立锁命名空间
  challenger: over.challenger, challenged: over.challenged,
  chHash: over.chHash || 'h-ch', cdHash: over.cdHash || 'h-cd',
  chResult: over.chResult || 'win', scoredLimit: over.scoredLimit ?? 10,
  store: m.store,
});

test('基础计分：胜 +25 / 败方夹 0，战绩入账，结果字段齐全', async () => {
  const m = makeMemStore();
  const A = m.add('A', 0), B = m.add('B', 0);
  const r = await settleChallenge(args(m, { challenger: A, challenged: B, chResult: 'win' }));
  assert.equal(r.scored, true);
  assert.equal(r.priorCount, 0);
  assert.deepEqual([r.fromChRp, r.newChRp, r.chRpDelta], [0, 25, 25]);
  assert.deepEqual([r.fromCdRp, r.newCdRp, r.cdRpDelta], [0, 0, 0]); // 0−15 夹到 0
  assert.equal(m.rows.get('A').rp, 25);
  assert.equal(m.rows.get('A').wins, 1);
  assert.equal(m.rows.get('B').losses, 1);
  assert.equal(r.mark, 1, 'persist 返回值须并入结算结果');
});

test('平局：双方 +10；跨段修正走 scoring 公式', async () => {
  const m = makeMemStore();
  const A = m.add('A', 0), B = m.add('B', 350); // B 白银（大段 1）
  const r = await settleChallenge(args(m, { challenger: A, challenged: B, chResult: 'draw' }));
  assert.equal(r.chRpDelta, rpDelta('draw', 0, 350));  // 10+4 = 14
  assert.equal(r.cdRpDelta, rpDelta('draw', 350, 0));  // 10−4 = 6
});

test('RP 下限：低分方败不跌破 0', async () => {
  const m = makeMemStore();
  const A = m.add('A', 5), B = m.add('B', 0);
  const r = await settleChallenge(args(m, { challenger: A, challenged: B, chResult: 'loss' }));
  assert.equal(r.newChRp, 0);
  assert.equal(m.rows.get('A').rp, 0);
});

test('哈希对窗口：前 N 场计分，第 N+1 场练习赛（applyScored 不再调用、RP 不动）', async () => {
  const m = makeMemStore();
  const A = m.add('A', 0), B = m.add('B', 0);
  const LIMIT = 10;
  for (let n = 1; n <= LIMIT + 2; n++) {
    const r = await settleChallenge(args(m, { ns: 'w', challenger: A, challenged: B, chResult: 'win', scoredLimit: LIMIT }));
    assert.equal(r.priorCount, n - 1, `第 ${n} 场 priorCount`);
    assert.equal(r.scored, n <= LIMIT, `第 ${n} 场 scored`);
    if (n > LIMIT) {
      assert.equal(r.chRpDelta, 0, '练习赛不得改分');
      assert.equal(r.cdRpDelta, 0);
    }
  }
  assert.equal(m.calls.applyScored, LIMIT, '只有计分场写战绩');
  assert.equal(m.calls.persist.length, LIMIT + 2, '练习赛战报也要落库');
  assert.equal(m.calls.persist.at(-1).scored, false);
  assert.equal(m.rows.get('A').wins, LIMIT);
});

test('哈希对双向记录：挑战者与被挑战者各记一条（方向互换）', async () => {
  const m = makeMemStore();
  const A = m.add('A'), B = m.add('B');
  await settleChallenge(args(m, { challenger: A, challenged: B, chHash: 'x', cdHash: 'y' }));
  assert.equal(m.pairs.get('A|x|y'), 1);
  assert.equal(m.pairs.get('B|y|x'), 1);
  assert.equal(m.pairs.size, 2);
});

test('窗口按哈希判定而非对手：换新哈希即重获资格', async () => {
  const m = makeMemStore();
  const A = m.add('A'), B = m.add('B');
  const base = { ns: 'h', challenger: A, challenged: B, chResult: 'draw', scoredLimit: 1 };
  const r1 = await settleChallenge(args(m, { ...base, chHash: 'v1', cdHash: 'o1' }));
  const r2 = await settleChallenge(args(m, { ...base, chHash: 'v1', cdHash: 'o1' }));
  assert.equal(r1.scored, true);
  assert.equal(r2.scored, false, '同哈希对第 2 场超窗');
  const r3 = await settleChallenge(args(m, { ...base, chHash: 'v2', cdHash: 'o1' }));
  assert.equal(r3.scored, true, '挑战者改代码（新哈希）应重获资格');
});

test('并发丢更新回归：两场并发挑战携带同一过期快照，结算必须锁内重读', async () => {
  const m = makeMemStore();
  m.add('A', 0); m.add('C', 0); m.add('B', 0);
  // 模拟事故场景：两个 handler 在 await 对局期间都持有 B 的旧快照（rp=0）
  const staleB1 = { id: 'B', rp: 0 };
  const staleB2 = { id: 'B', rp: 0 };
  const [r1, r2] = await Promise.all([
    settleChallenge(args(m, { ns: 'cc', challenger: m.rows.get('A'), challenged: staleB1, chResult: 'loss', chHash: 'a', cdHash: 'b' })),
    settleChallenge(args(m, { ns: 'cc', challenger: m.rows.get('C'), challenged: staleB2, chResult: 'loss', chHash: 'c', cdHash: 'b' })),
  ]);
  // B 两连胜：若基于旧快照绝对赋值会互相覆盖成 25；锁内重读则是 25 → 50
  assert.equal(m.rows.get('B').rp, 50, '最终分 = 两场增减之和（不丢分）');
  assert.equal(m.rows.get('B').wins, 2);
  const froms = [r1.fromCdRp, r2.fromCdRp].sort((a, b) => a - b);
  assert.deepEqual(froms, [0, 25], '后一场必须从前一场的结果出发（锁内重读生效）');
});

test('反向锁序并发（A→B 与 B→A）不死锁', async () => {
  const m = makeMemStore();
  const A = m.add('A'), B = m.add('B');
  await Promise.all([
    settleChallenge(args(m, { ns: 'dl', challenger: A, challenged: B, chHash: '1', cdHash: '2' })),
    settleChallenge(args(m, { ns: 'dl', challenger: B, challenged: A, chHash: '2', cdHash: '1' })),
  ]); // 若锁序不一致会互等挂死，node:test 超时兜底
  assert.equal(m.calls.persist.length, 2);
});

test('getFresh 查无此行时回退到调用方快照（兜底路径）', async () => {
  const m = makeMemStore();
  m.add('A', 0); m.add('B', 0);
  const ghost = { id: 'G', rp: 120 };
  let persisted;
  m.store.applyScored = () => {};
  m.store.persist = (a) => { persisted = a; };
  const r = await settleChallenge(args(m, { challenger: ghost, challenged: m.rows.get('B'), chResult: 'win' }));
  assert.equal(r.fromChRp, 120, '重读不到时用传入快照');
  assert.equal(persisted.chFresh.id, 'G');
});
