'use strict';
// Agent 对战平台 · Node 全栈服务器 v2.1
// 零第三方依赖，使用 Node 内置 http / fs / path / crypto / vm / node:sqlite
//
// P2 架构：本文件只保留「平台层」——HTTP 基建、账号体系、静态资源、前端共享资产；
// 每款游戏的全部 API 由 games/registry.js 驱动、经 platform/routes_game.js 工厂挂载，
// 游戏专属路由（试玩/对手清单等）由各游戏的 games/<id>/server.js#extraRoutes 注入。
// 新增一款游戏 = 新建 games/<id>/ 目录并在注册表登记，本文件无需改动。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const auth = require('./auth');
const rl = require('./ratelimit');
const registry = require('./games/registry');
const { mountGameRoutes } = require('./platform/routes_game');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// 邮箱验证开关：未接入 SMTP 期间默认「关闭」→ 新注册账号直接视为已验证，且启动时把历史未验证账号
// 一次性置为已验证（免正式挑战被 403 拦、免前端「未验证」横幅）。接入 SMTP 后设环境变量
// EMAIL_VERIFICATION=on 即恢复真实验证流程（届时新注册需完成邮箱验证才能发起正式挑战）。
const EMAIL_VERIFICATION = process.env.EMAIL_VERIFICATION === 'on';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');
const MAX_AVATAR_BYTES = 100 * 1024; // 100KB
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256; // 上限防超长密码拖慢 scrypt
fs.mkdirSync(AVATAR_DIR, { recursive: true });
// 验证关闭时：把库里遗留的未验证账号一次性补齐为已验证（幂等，仅影响 email_verified=0 的行）。
if (!EMAIL_VERIFICATION) {
  const n = db.markAllAccountsVerified();
  if (n) console.log(`[邮箱验证已关闭] 已将 ${n} 个历史未验证账号置为已验证`);
}

// ---- 前端共享资产（P4 前端插件化时随 UI 拆到各游戏目录）----
// 前端「本地落子」加载的共享规则核心源码（与服务器重放走同一套规则，见 /game-rules.js 路由）
const RULES_CORE_JS = fs.readFileSync(path.join(__dirname, 'games', 'clawclash', 'engine', 'rules_core.js'), 'utf8');
// 内置试玩对手（流派/训练棋手/囚徒训练）打包给浏览器：试玩本地应手，可信自有代码零网络。
// 依赖链引用 window.GameRules，故须在 /game-rules.js 之后加载；各文件为 UMD IIFE，
// 以 '\n;\n' 相接隔断边界（防前一 IIFE 的 )(...) 与后一 (function 连成函数调用）。
const BUILTIN_BOTS_JS = [
  'clawclash/engine/rules_metered.js', 'clawclash/engine/templates_factory.js',
  'clawclash/engine/training_bots.js', 'clawclash/engine/builtins.js',
  'prisoner/engine/rules.js', 'prisoner/engine/training_bots.js',
].map((f) => fs.readFileSync(path.join(__dirname, 'games', f), 'utf8')).join('\n;\n');
// 象棋暗战专属打包（独立路由，不并入上面的共享包，避免钳王/囚徒白白多下发一份用不到的代码）：
// 规则核心 + 对局引擎 + 训练棋手 + 内置对手查找，供试玩「训练棋手对战 / 双人同屏」在浏览器本地
// 直接推演（零网络，与服务器同一套规则源码，杜绝前后端判定漂移）；玩家上传脚本仍必须服务器沙箱。
const DARKCHESS_BOTS_JS = [
  'darkchess/engine/rules_core.js', 'darkchess/engine/engine.js',
  'darkchess/engine/training_bots.js', 'darkchess/engine/builtins.js',
].map((f) => fs.readFileSync(path.join(__dirname, 'games', f), 'utf8')).join('\n;\n');

// ---- HTTP 工具 ----
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...(extraHeaders || {}) });
  res.end(body);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
// 协商缓存：内容哈希 ETag。命中 If-None-Match 回 304（不传体），未命中回 200 带 ETag。
function etagOf(data) { return '"' + crypto.createHash('sha1').update(data).digest('base64') + '"'; }
function sendCached(req, res, data, contentType, cacheControl) {
  const etag = etagOf(data);
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(data);
}
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(fp);
    // 代码/页面（html/js/css）走 no-cache：每次校验、部署后即时生效，绝不发旧 app.js（未变仍 304 省体）；
    // 头像等图片短缓存：URL 同名覆盖时 ETag 会变、过期后也走 304，≤5min 的旧图无伤大雅。
    const cacheControl = IMAGE_EXT.has(ext) ? 'public, max-age=300' : 'no-cache';
    sendCached(req, res, data, MIME[ext] || 'application/octet-stream', cacheControl);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      if (settled) return;
      data += c;
      if (data.length > 2e6) { done(reject, Object.assign(new Error('请求体过大'), { tooLarge: true })); req.destroy(); }
    });
    req.on('end', () => done(resolve, data));
    req.on('error', (e) => done(reject, e));
    req.on('close', () => done(reject, new Error('连接已关闭'))); // 防客户端中断时 Promise 悬挂
  });
}
function parseJson(raw) { try { return JSON.parse(raw || '{}'); } catch { return null; } }

// 微缓存响应下发：统一 ETag/304 与 Cache-Control（天梯榜等公开数据；缓存本体在 platform/microcache.js）
function sendMicroCached(req, res, { body, etag }, maxAgeSec) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${maxAgeSec}, stale-while-revalidate=60`,
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(body);
}

// ---- Auth 中间件（人类：签名 Cookie 会话）----
// Agent 的 Bearer Key 鉴权按游戏隔离，在 platform/routes_game.js 工厂内实现。
function requireSession(req) {
  const accountId = auth.sessionAccountId(req);
  if (!accountId) return { account: null, error: '未登录' };
  const account = db.getAccountById(accountId);
  if (!account) return { account: null, error: '会话无效' };
  return { account, error: null };
}

// key 掩码：sk_0ef0...a093
function maskKey(key) {
  if (!key || key.length < 12) return key || '';
  return `${key.slice(0, 8)}••••••${key.slice(-4)}`;
}

// ---- 频控 / 客户端标识 ----
// 生产经同机反代（Nginx → 127.0.0.1:3000）时直连地址恒为回环，频控会把全站塌缩成一个桶。
// 仅当直连来自本机回环（即可信反代）时才采用 X-Forwarded-For，且只取最后一跳——
// 该条目由反代追加、不可伪造；前面的条目均可由客户端自带，绝不采信。
// 公网直连（非回环）时忽略该头，防伪造绕过频控。反代未配 XFF 时自然退回直连地址，行为同旧版。
function clientIp(req) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (/^(?:127\.|::1$|::ffff:127\.)/.test(direct)) {
    const lastHop = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (lastHop) return lastHop;
  }
  return direct;
}
// 命中频控则回 429 并返回 true（调用方应直接 return）
function rateLimited(res, gate) {
  if (gate.ok) return false;
  sendJson(res, 429, { ok: false, error: `请求过于频繁，请 ${gate.retryAfterSec}s 后重试` }, { 'Retry-After': String(gate.retryAfterSec) });
  return true;
}
// 公开访问 origin。生产经 Nginx 反代终止 TLS，到达 Node 的请求本身是明文，
// 直接拼 http:// 会让发给 Agent 的链接是 http（部分 Agent 拒绝访问）。
// 取协议的优先级：① PUBLIC_ORIGIN 钉死（如 https://clawclash.cn）→ ② 反代透传的
// X-Forwarded-Proto → ③ 本机直连是否加密 → ④ 生产环境（非本机）默认 https。
// ④ 兜底是为了反代未配置 X-Forwarded-Proto 的情况，免去改 Nginx / 注入 env。
function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const host = req.headers.host || 'localhost:' + PORT;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isLocal = /^(localhost|127\.|\[?::1\]?)/i.test(host);
  const proto = xfProto
    || ((req.socket && req.socket.encrypted) ? 'https' : '')
    || ((IS_PROD && !isLocal) ? 'https' : 'http');
  return `${proto}://${host}`;
}

// 发送邮箱验证链接。生产须接入 SMTP（部署侧）；当前实现仅记录到日志，
// 非生产环境额外把链接随响应返回，便于演示。返回 { verifyUrl, devExposed }。
function sendVerificationEmail(req, account) {
  const token = auth.makeVerifyToken(account.id);
  const verifyUrl = `${originOf(req)}/api/account/verify?token=${encodeURIComponent(token)}`;
  // TODO(部署): 接入 SMTP 真正投递到 account.email；勿在生产把链接回传前端。
  console.log(`[邮箱验证] ${account.email} -> ${verifyUrl}`);
  return { verifyUrl, devExposed: !IS_PROD };
}

// ---- 头像 dataURL 校验：类型 PNG/JPEG、≤100KB、1:1 正方形 ----
function pngSize(buf) {
  // 签名 + IHDR：宽高为大端 32 位，偏移 16/20
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  // 扫描 SOF 标记取宽高
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}
function validateAvatarDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return { error: '仅支持 PNG / JPG 图片' };
  const type = m[1];
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return { error: '图片数据无法解析' }; }
  if (buf.length === 0) return { error: '图片为空' };
  if (buf.length > MAX_AVATAR_BYTES) return { error: `图片需 ≤ 100KB（当前 ${Math.round(buf.length / 1024)}KB）` };
  const size = type === 'png' ? pngSize(buf) : jpegSize(buf);
  if (!size || !size.w || !size.h) return { error: '无法识别图片尺寸' };
  if (size.w !== size.h) return { error: `图片必须为正方形 1:1（当前 ${size.w}×${size.h}）` };
  return { type, buf, ext: type === 'png' ? 'png' : 'jpg' };
}
// 保存头像文件：清掉旧扩展名文件后写入。文件名 = <游戏前缀><玩家id>.<ext>（前缀防跨游戏 id 撞名互覆盖）
function saveAvatarFile(prefix, id, v) {
  for (const ext of ['png', 'jpg']) {
    const old = path.join(AVATAR_DIR, `${prefix}${id}.${ext}`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const fileName = `${prefix}${id}.${v.ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, fileName), v.buf);
  return fileName;
}

// ---- 路由表 ----
// 格式: [method, path_or_regex, handler(req, res, match, body)]
const routes = [];
function route(method, pattern, fn) { routes.push({ method, pattern, fn }); }
async function dispatch(req, res) {
  for (const r of routes) {
    if (r.method !== req.method && r.method !== '*') continue;
    let match;
    if (typeof r.pattern === 'string') {
      if (req.url.split('?')[0] !== r.pattern) continue;
      match = [];
    } else {
      match = req.url.split('?')[0].match(r.pattern);
      if (!match) continue;
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw;
      try { raw = await readBody(req); }
      catch (e) { return sendJson(res, e && e.tooLarge ? 413 : 400, { ok: false, error: e && e.tooLarge ? '请求体过大' : '读取请求体失败' }); }
      body = parseJson(raw);
      if (body === null) return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
    }
    await r.fn(req, res, match, body);
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('Not Found');
}

// ============================================================
// § 账号注册（第 1 步，不建游戏资产）
// POST /api/account/register  body: { nickname, email, password }
// 昵称/邮箱冲突分别返回 409 { field }
// ============================================================
route('POST', '/api/account/register', (req, res, _m, body) => {
  if (rateLimited(res, rl.allow('reg:' + clientIp(req), 5, 10 * 60 * 1000))) return;
  const nickname = (body.nickname || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!nickname || !email || !password)
    return sendJson(res, 400, { ok: false, error: '昵称、邮箱、密码均为必填' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN)
    return sendJson(res, 400, { ok: false, error: `密码需 ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} 位` });
  if (db.getAccountByNickname(nickname))
    return sendJson(res, 409, { ok: false, field: 'nickname', error: '昵称已被占用' });
  if (db.getAccountByEmail(email))
    return sendJson(res, 409, { ok: false, field: 'email', error: '该邮箱已注册' });
  const account = db.createAccount(nickname, email, auth.hashPassword(password));
  let verifyUrl;
  if (EMAIL_VERIFICATION) {
    const mail = sendVerificationEmail(req, account);
    // 仅非生产环境回传验证链接，便于演示（生产由邮件投递）
    verifyUrl = mail.devExposed ? mail.verifyUrl : undefined;
  } else {
    // 验证关闭：直接置为已验证，跳过邮箱验证流程
    db.setEmailVerified(account.id);
  }
  sendJson(res, 201, {
    ok: true, accountId: account.id, nickname: account.nickname,
    emailVerified: !EMAIL_VERIFICATION,
    verifyUrl,
  }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

// ============================================================
// § 登录 / 登出
// ============================================================
route('POST', '/api/auth/login', (req, res, _m, body) => {
  if (rateLimited(res, rl.allow('login:' + clientIp(req), 10, 5 * 60 * 1000))) return;
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const account = db.getAccountByEmail(email);
  // password.length 短路在 verifyPassword 之前：超长密码不可能匹配（注册已限长），直接挡掉 scrypt 开销
  if (!account || password.length > MAX_PASSWORD_LEN || !auth.verifyPassword(password, account.password_hash))
    return sendJson(res, 401, { ok: false, error: '邮箱或密码错误' });
  sendJson(res, 200, { ok: true, accountId: account.id, nickname: account.nickname }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

route('POST', '/api/auth/logout', (req, res) => {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
});

// ============================================================
// § 邮箱验证：点击邮件链接 / 站内重新发送
// ============================================================
route('GET', '/api/account/verify', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const accountId = auth.verifyVerifyToken(url.searchParams.get('token') || '');
  const page = (title, msg) => {
    res.writeHead(accountId ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:80px auto;text-align:center;color:#274"><h2>${title}</h2><p>${msg}</p><p><a href="/">返回首页</a></p></body>`);
  };
  if (!accountId) return page('验证链接无效或已过期', '请重新登录后在「我的棋手」里重新发送验证邮件。');
  if (!db.getAccountById(accountId)) return page('账号不存在', '该账号可能已被删除。');
  db.setEmailVerified(accountId);
  page('邮箱验证成功 ✓', '现在可以发起正式挑战、参与天梯排位了。');
});

route('POST', '/api/account/resend-verification', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('verify:' + account.id, 3, 10 * 60 * 1000))) return;
  if (account.email_verified) return sendJson(res, 200, { ok: true, emailVerified: true, message: '邮箱已验证' });
  const mail = sendVerificationEmail(req, account);
  sendJson(res, 200, { ok: true, emailVerified: false, verifyUrl: mail.devExposed ? mail.verifyUrl : undefined });
});

// ============================================================
// § 当前登录态（游戏无关的通用结构）
// GET /api/me  (需 Cookie)
// 账号信息 + 该账号在各游戏的选手概要（遍历注册表：players.<gid> = 概要 | null）。
// 新增游戏自动出现在 players 里，本文件与前端壳均无需改动（账号总览零改壳）。
// 选手详情（密钥/版本/战绩等）仍由各游戏自己的 /me 端点返回。
// ============================================================
const gameWebs = {}; // gid → games/<gid>/server 适配模块（挂载循环填充）
route('GET', '/api/me', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const players = {};
  for (const gid of registry.ids) {
    const p = gameWebs[gid] && gameWebs[gid].store.getByAccount(account.id);
    players[gid] = p
      ? { id: p.id, name: p.name, avatar: p.avatar, rp: p.rp, currentVersion: p.current_version }
      : null;
  }
  sendJson(res, 200, {
    ok: true,
    account: { id: account.id, nickname: account.nickname, email: account.email },
    emailVerified: !!account.email_verified,
    players,
  });
});

// ============================================================
// § 前端共享资产
// ============================================================
// 共享规则核心（前端「本地落子」用）。源文件在 games/clawclash/engine/rules_core.js，启动时读入。
// 与服务器重放/裁定同一套规则——前后端规则必须一致，故走 no-cache 协商缓存：
// 一旦部署改了规则即时生效，杜绝「旧 game-rules.js 与新服务器规则不一致」导致的本地落子分歧。
route('GET', '/game-rules.js', (req, res) => {
  sendCached(req, res, RULES_CORE_JS, 'text/javascript; charset=utf-8', 'no-cache');
});
// 内置对手打包脚本（前端试玩本地应手用）。同 /game-rules.js：no-cache 协商缓存，改动即时生效，
// 杜绝旧脚本与服务器规则漂移。玩家上传脚本(不可信)绝不下发，仍由服务器沙箱执行。
route('GET', '/builtin-bots.js', (req, res) => {
  sendCached(req, res, BUILTIN_BOTS_JS, 'text/javascript; charset=utf-8', 'no-cache');
});
// 象棋暗战专属打包（同上：no-cache 协商缓存，改动即时生效，杜绝旧脚本与服务器规则漂移）
route('GET', '/darkchess-bots.js', (req, res) => {
  sendCached(req, res, DARKCHESS_BOTS_JS, 'text/javascript; charset=utf-8', 'no-cache');
});

// 游戏清单（P4 前端插件化）：前端壳按此动态生成主导航、注入各游戏面板并按序加载脚本
route('GET', '/api/games', (req, res) => {
  sendJson(res, 200, { ok: true, games: registry.ids.map((id) => {
    const m = registry.manifests[id];
    return { id, name: m.name, scripts: (m.client && m.client.scripts) || [] };
  }) });
});
// 游戏前端资产：games/<id>/public/ 下的面板片段与插件脚本（no-cache 协商缓存，部署即生效）
route('GET', /^\/games\/([a-z0-9_-]+)\/(app\.js|panel\.html)$/, (req, res, m) => {
  if (!registry.manifests[m[1]]) { res.writeHead(404); return res.end('Not Found'); }
  const fp = path.join(__dirname, 'games', m[1], 'public', m[2]);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    sendCached(req, res, data, m[2].endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'no-cache');
  });
});

// ============================================================
// § 游戏路由挂载（注册表驱动）
// 平台通用路由（创建/头像/我的/Agent/挑战/天梯/回放/指南）由 platform/routes_game.js 工厂生成：
// 每条同时注册规范路径（/api/games/<id>/...）与 legacy 别名（旧路径，已发布契约长期保留）。
// 游戏专属路由（试玩/对手清单等）由各游戏的 extraRoutes 注入。
// ============================================================
const helpers = {
  sendJson, rl, rateLimited, clientIp, requireSession,
  getAccountById: (id) => db.getAccountById(id),
  validateAvatarDataUrl, saveAvatarFile, maskKey, originOf, sendMicroCached,
};
for (const gid of registry.ids) {
  const game = registry.manifests[gid];
  const web = require('./games/' + gid + '/server'); // 服务端适配（含 db 访问；runner 子进程绝不加载）
  gameWebs[gid] = web; // /api/me 的各游戏选手概要据此读取
  mountGameRoutes({ route, game, web, helpers });
  if (web.extraRoutes) web.extraRoutes({ route, ...helpers });
}

// ============================================================
// 启动
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  try { await dispatch(req, res); }
  catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message || e) }); }
});
// 长连接调优（方案 C）：保持 HTTP keep-alive，避免试玩每步走子都重建 TCP/TLS。
// keepAliveTimeout 略大于反代（Nginx 默认 upstream keepalive 60s），headersTimeout 再大一档，
// 防止「反代复用的连接被 Node 先行关闭」导致偶发 502/重连。
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// 进程级兜底：单进程部署下，一个漏网的 Promise 拒绝（Node ≥15 默认会终止进程）或
// 未捕获异常不应拖垮整个服务。请求级错误已在 http handler 的 try/catch 里兜住，这里只兜
// 极少数逃逸情形——记日志后继续服务，把「是否重启」交给 PM2（真·致命崩溃它仍会拉起）。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

server.listen(PORT, () => {
  console.log(`Agent 对战平台已启动: http://localhost:${PORT}`);
  console.log(`已挂载游戏: ${registry.ids.map((id) => registry.manifests[id].name).join('、')}`);
});
