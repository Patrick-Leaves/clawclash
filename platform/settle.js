'use strict';
// 唯一一份「正式挑战结算核心」：串行锁 → 锁内重读最新分 → 哈希对计分窗口 → RP 结算 → 落库。
// 所有游戏的挑战路由都调用这里；游戏差异（ELO、战报形态、表族）通过 store 回调注入。
//
// 并发正确性背景（GameDesign/并发计分覆盖问题复盘_v1.0.md）：挑战路由在 await 子进程对局期间
// 让出事件循环，若基于 await 之前的旧快照「绝对赋值」rp，两场并发挑战会互相覆盖丢分。
// 因此结算段必须持 per-key 串行锁，并在锁内重读最新值后再计算。
// 该性质由 test/settle.test.js（单元）与 test/api.e2e.test.js「并发结算回归」（端到端）双重钉住。
const { withTwoLocks } = require('./locks');
const { rpDelta } = require('./scoring');

// 参数：
//   ns          锁命名空间（'bot' / 'pd' / …）：锁 key = `${ns}:${id}`，隔离各游戏的 id 空间
//   challenger / challenged   auth 阶段读到的行快照（可能已过期；仅作锁内重读失败的兜底）
//   chHash / cdHash           双方当前代码哈希（计分窗口按「哈希对」判定，与对手身份无关）
//   chResult    挑战者视角本场结果 'win' | 'loss' | 'draw'
//   scoredLimit 同一哈希对计入段位/战绩的场数上限，超出转练习赛
//   store       数据访问回调（全部在锁内同步调用）：
//     getFresh(id)                       → 最新行（须含 rp）
//     getHashPair(id, myHash, oppHash)   → { used_count } | undefined
//     recordHashPair(id, myHash, oppHash)  记一次使用（双向各一条）
//     applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult, cdResult })
//                                          计分场写库：战绩 / RP / 游戏自有内部分（如钳王 ELO）
//     persist({ chFresh, cdFresh, newChRp, newCdRp, scored, priorCount }) → extra
//                                          存战报（计分与否都存）；返回值并入结算结果
// 返回：{ fromChRp, fromCdRp, newChRp, newCdRp, chRpDelta, cdRpDelta, scored, priorCount, ...extra }
async function settleChallenge({ ns, challenger, challenged, chHash, cdHash, chResult, scoredLimit, store }) {
  const cdResult = chResult === 'win' ? 'loss' : chResult === 'loss' ? 'win' : 'draw';
  return withTwoLocks(`${ns}:${challenger.id}`, `${ns}:${challenged.id}`, () => {
    const chFresh = store.getFresh(challenger.id) || challenger;
    const cdFresh = store.getFresh(challenged.id) || challenged;
    // 反刷分：同一对代码哈希之间，前 scoredLimit 场计入段位/战绩，之后为练习赛不计分。
    // 回滚因哈希不变不重置已消耗资格；改脚本（哈希变化）重获资格。
    const prior = store.getHashPair(chFresh.id, chHash, cdHash);
    const priorCount = prior ? prior.used_count : 0;
    const scored = priorCount < scoredLimit;

    let newChRp = chFresh.rp, newCdRp = cdFresh.rp;
    if (scored) {
      newChRp = Math.max(0, chFresh.rp + rpDelta(chResult, chFresh.rp, cdFresh.rp));
      newCdRp = Math.max(0, cdFresh.rp + rpDelta(cdResult, cdFresh.rp, chFresh.rp));
      store.applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult, cdResult });
    }
    store.recordHashPair(chFresh.id, chHash, cdHash);
    store.recordHashPair(cdFresh.id, cdHash, chHash);

    const extra = store.persist({ chFresh, cdFresh, newChRp, newCdRp, scored, priorCount }) || {};
    return {
      fromChRp: chFresh.rp, fromCdRp: cdFresh.rp,
      newChRp, newCdRp,
      chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
      scored, priorCount,
      ...extra,
    };
  });
}

module.exports = { settleChallenge };
