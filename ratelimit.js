'use strict';
// 进程内接口频控（滑动窗口计数）。零依赖、单实例适用；
// 多实例部署时应换成共享存储（Redis 等）——见 SECURITY.md。
const buckets = new Map(); // key -> number[]（升序时间戳 ms）

// 在 windowMs 窗口内最多放行 max 次。返回 { ok, retryAfterSec }。
function allow(key, max, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift(); // 丢弃过期
  if (arr.length >= max) {
    const retryMs = arr[0] + windowMs - now;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  arr.push(now);
  return { ok: true };
}

// 多桶原子检查：全部桶均可放行时才一起记入，避免前一桶已扣数而后一桶拒绝。
// entries: [{ key, max, windowMs }]
function allowAll(entries) {
  const at = Date.now();
  const checked = [];
  for (const { key, max, windowMs } of entries) {
    let arr = buckets.get(key);
    if (!arr) arr = [];
    else while (arr.length && arr[0] <= at - windowMs) arr.shift();
    if (arr.length >= max) {
      const retryMs = arr[0] + windowMs - at;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    checked.push({ key, arr });
  }
  for (const { key, arr } of checked) {
    if (!buckets.has(key)) buckets.set(key, arr);
    arr.push(at);
  }
  return { ok: true };
}

// 定期清理空桶，防止 Map 无限增长（不阻止进程退出）
const timer = setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length === 0) buckets.delete(k);
  }
}, 600000);
if (timer.unref) timer.unref();

module.exports = { allow, allowAll };
