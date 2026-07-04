'use strict';
// 通用按 key 串行锁（防并发结算脏读）。自 server.js 原样迁出，行为不变。
// 背景（GameDesign/并发计分覆盖问题复盘_v1.0.md）：挑战路由在 await execpool 期间会让出事件循环；
// 若同一选手两场挑战几乎同时到达，两个 handler 都持有 auth 阶段读到的旧 rp/rating，
// 各自基于旧值算 newRp 并「绝对赋值」，会互相覆盖 → 累积计分丢失。
// 把「读最新 → 计算 → 写库 → 存战报」这段临界区用 per-key Promise 链串起来即可。
// key 用命名空间前缀（'bot:'/'pd:'/'pub:bot:'…）隔离不同游戏与不同用途的 id 空间。
const settleLocks = new Map(); // key -> tail Promise

async function withLock(key, fn) {
  const prev = settleLocks.get(key) || Promise.resolve();
  const cur = prev.then(fn, fn); // 前一环失败也不阻塞后续
  const tail = cur.catch(() => {});
  settleLocks.set(key, tail);
  try { return await cur; }
  finally { if (settleLocks.get(key) === tail) settleLocks.delete(key); }
}

// 同时锁两个 key（按字符串序取锁，保证一致的加锁顺序 → 防死锁）
function withTwoLocks(keyA, keyB, fn) {
  const [lo, hi] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  if (lo === hi) return withLock(lo, fn); // 理论不会出现（不能挑战自己），保险处理
  return withLock(lo, () => withLock(hi, fn));
}

module.exports = { withLock, withTwoLocks };
