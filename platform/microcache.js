'use strict';
// JSON 微缓存（天梯榜等「只在对局结束后变化、可容忍数秒陈旧」的公开数据）：
// 缓存「序列化后的 JSON + ETag」，TTL 内复用——省去查库/序列化，配合 Cache-Control
// 让浏览器/反代短缓存或走 304，后端偶发卡顿时仍能即时响应。
const crypto = require('crypto');

// produce() 返回待序列化对象；get() 返回 { body, etag }（TTL 内为同一份）
function makeJsonMicroCache(ttlMs, produce) {
  let cache = null; // { body, etag, expires }
  return function get() {
    const now = Date.now();
    if (cache && cache.expires > now) return cache;
    const body = JSON.stringify(produce());
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';
    cache = { body, etag, expires: now + ttlMs };
    return cache;
  };
}

module.exports = { makeJsonMicroCache };
