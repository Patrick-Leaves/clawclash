'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../auth');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SMTP_ENV = [
  'SMTP_HOST', 'SMTP_SECURE', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'SMTP_DAILY_MAX', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'EMAIL_VERIFICATION',
];

async function startServer(t, { nodeEnv = 'test', seed } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-registration-api-'));
  const dbFile = path.join(dir, 'test.db');
  if (seed) seed(dbFile);
  const env = { ...process.env };
  for (const key of SMTP_ENV) delete env[key];
  Object.assign(env, {
    PORT: String(4300 + Math.floor(Math.random() * 500)),
    DB_PATH: dbFile,
    NODE_ENV: nodeEnv,
    SESSION_SECRET: 'registration-api-test-secret',
    RUNNER_POOL_SIZE: '1',
    CHILD_PERMISSION: 'off',
    EMAIL_VERIFICATION: 'on', // obsolete setting must have no effect
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${env.PORT}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs}`);
    try {
      const response = await fetch(`${base}/api/games`);
      if (response.ok) break;
    } catch {}
    if (Date.now() >= deadline) {
      child.kill();
      throw new Error(`server did not become ready:\n${logs}`);
    }
    await sleep(100);
  }
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
    }
    for (let n = 0; n < 5; n++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch { await sleep(200); }
    }
  });
  return { base, dbFile, getLogs: () => logs };
}

async function request(base, method, urlPath, { body, rawBody, cookie } = {}) {
  const headers = {};
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(base + urlPath, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch {}
  return {
    status: response.status,
    json,
    cacheControl: response.headers.get('cache-control'),
    retryAfter: response.headers.get('retry-after'),
    setCookie: response.headers.get('set-cookie'),
  };
}

async function sendJsonAndDropResponse(base, urlPath, body) {
  const target = new URL(urlPath, base);
  const data = Buffer.from(JSON.stringify(body));
  await new Promise((resolve) => {
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length) },
    });
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    req.on('error', done);
    req.on('close', done);
    req.end(data, () => setTimeout(() => req.destroy(), 5));
  });
}

test('HTTP registration is two-step, no-store, and signs a session only after verify', { timeout: 120000 }, async (t) => {
  const server = await startServer(t);
  const anonymousMe = await request(server.base, 'GET', '/api/me');
  assert.equal(anonymousMe.status, 401);
  assert.equal(anonymousMe.cacheControl, 'no-store');

  const malformed = await request(server.base, 'POST', '/api/account/register', { rawBody: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.reason, 'invalid_input');
  assert.equal(malformed.cacheControl, 'no-store');

  const registrationBody = {
    nickname: '测试选手', email: ' User+tag@Example.COM ', password: 'password123',
  };
  const legacy = await request(server.base, 'POST', '/api/account/register', { body: registrationBody });
  assert.equal(legacy.status, 409);
  assert.equal(legacy.json.reason, 'client_upgrade_required');
  assert.equal(legacy.setCookie, null);
  const inspect = new DatabaseSync(server.dbFile);
  t.after(() => inspect.close());
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 0);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM registration_mail_attempts').get().n, 0);

  const sent = await request(server.base, 'POST', '/api/account/register', {
    body: { registrationProtocol: 'email-code-v1', ...registrationBody },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.cacheControl, 'no-store');
  assert.equal(sent.setCookie, null);
  assert.match(sent.json.registrationId, /^[0-9a-f]{32}$/);
  assert.match(sent.json.devCode, /^\d{6}$/);
  assert.equal(sent.json.emailMasked, 'u***@example.com');
  assert.equal(Object.hasOwn(sent.json, 'accountId'), false);

  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 1);
  assert.equal(inspect.prepare("SELECT state FROM registration_mail_attempts").get().state, 'sent');

  const cooldown = await request(server.base, 'POST', '/api/account/resend-code', {
    body: { email: 'user+tag@example.com', registrationId: sent.json.registrationId },
  });
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.json.reason, 'cooldown');
  assert.equal(cooldown.retryAfter, String(cooldown.json.retryAfterSec));
  assert.equal(cooldown.cacheControl, 'no-store');
  assert.equal(cooldown.setCookie, null);

  const stale = await request(server.base, 'POST', '/api/account/verify-code', {
    body: { email: 'user+tag@example.com', registrationId: 'f'.repeat(32), code: sent.json.devCode },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.reason, 'registration_stale');
  assert.equal(stale.setCookie, null);

  const verified = await request(server.base, 'POST', '/api/account/verify-code', {
    body: { email: 'user+tag@example.com', registrationId: sent.json.registrationId, code: sent.json.devCode },
  });
  assert.equal(verified.status, 201, JSON.stringify(verified.json));
  assert.equal(verified.cacheControl, 'no-store');
  assert.equal(verified.json.emailVerified, true);
  assert.match(verified.setCookie, /^sx_session=/);
  assert.match(verified.setCookie, /Max-Age=604800/);
  const cookie = verified.setCookie.split(';')[0];
  assert.equal(inspect.prepare('SELECT email_verified FROM accounts').get().email_verified, 1);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM pending_registrations').get().n, 0);

  const me = await request(server.base, 'GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.cacheControl, 'no-store');
  assert.equal(me.json.account.email, 'user+tag@example.com');
  assert.equal(me.json.emailVerified, true);

  const replay = await request(server.base, 'POST', '/api/account/verify-code', {
    body: { email: 'user+tag@example.com', registrationId: sent.json.registrationId, code: sent.json.devCode },
  });
  assert.equal(replay.status, 404);
  assert.equal(replay.json.reason, 'pending_missing');
  assert.equal(replay.setCookie, null);

  const wrongRound = await request(server.base, 'POST', '/api/account/register', {
    body: {
      registrationProtocol: 'email-code-v1', nickname: '错码轮次',
      email: 'wrong@example.com', password: 'password123',
    },
  });
  assert.equal(wrongRound.status, 200, JSON.stringify(wrongRound.json));
  const wrongCode = wrongRound.json.devCode === '999999' ? '000000' : '999999';
  for (const remaining of [4, 3, 2, 1]) {
    const incorrect = await request(server.base, 'POST', '/api/account/verify-code', {
      body: { email: 'wrong@example.com', registrationId: wrongRound.json.registrationId, code: wrongCode },
    });
    assert.equal(incorrect.status, 400);
    assert.equal(incorrect.json.reason, 'code_incorrect');
    assert.equal(incorrect.json.remaining, remaining);
    assert.equal(incorrect.setCookie, null);
  }
  const exhausted = await request(server.base, 'POST', '/api/account/verify-code', {
    body: { email: 'wrong@example.com', registrationId: wrongRound.json.registrationId, code: wrongCode },
  });
  assert.equal(exhausted.status, 410);
  assert.equal(exhausted.json.reason, 'exhausted');
  assert.equal(exhausted.json.remaining, 0);
  assert.equal(exhausted.setCookie, null);
  assert.equal(inspect.prepare("SELECT 1 FROM pending_registrations WHERE email='wrong@example.com'").get(), undefined);

  const lost = await request(server.base, 'POST', '/api/account/register', {
    body: {
      registrationProtocol: 'email-code-v1', nickname: '响应丢失',
      email: 'lost@example.com', password: 'password123',
    },
  });
  assert.equal(lost.status, 200, JSON.stringify(lost.json));
  await sendJsonAndDropResponse(server.base, '/api/account/verify-code', {
    email: 'lost@example.com', registrationId: lost.json.registrationId, code: lost.json.devCode,
  });
  const committedDeadline = Date.now() + 5000;
  while (!inspect.prepare("SELECT 1 FROM accounts WHERE email='lost@example.com'").get()) {
    assert.ok(Date.now() < committedDeadline, 'response loss must not cancel committed account creation');
    await sleep(25);
  }
  const recoveredLogin = await request(server.base, 'POST', '/api/auth/login', {
    body: { email: 'lost@example.com', password: 'password123' },
  });
  assert.equal(recoveredLogin.status, 200);
  assert.match(recoveredLogin.setCookie, /^sx_session=/);

  const badLogin = await request(server.base, 'POST', '/api/auth/login', {
    body: { email: ['user+tag@example.com'], password: 123 },
  });
  assert.equal(badLogin.status, 400);
  assert.equal(badLogin.json.reason, 'invalid_input');
  assert.equal(badLogin.cacheControl, 'no-store');

  const login = await request(server.base, 'POST', '/api/auth/login', {
    body: { email: ' USER+TAG@example.com ', password: 'password123' },
  });
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /^sx_session=/);
  assert.equal(login.cacheControl, 'no-store');

  const logout = await request(server.base, 'POST', '/api/auth/logout', { cookie });
  assert.equal(logout.status, 200);
  assert.equal(logout.cacheControl, 'no-store');
  assert.match(logout.setCookie, /Max-Age=0/);

  assert.equal((await request(server.base, 'GET', '/api/account/verify?token=old')).status, 404);
  assert.equal((await request(server.base, 'POST', '/api/account/resend-verification', { body: {} })).status, 404);
});

test('production without SMTP rejects only sending and can verify an existing pending round', { timeout: 120000 }, async (t) => {
  const registrationId = 'a'.repeat(32);
  const passwordHash = auth.hashPassword('existing-password');
  const codeHash = auth.hashPassword('001234');
  const now = Date.now();
  const server = await startServer(t, {
    nodeEnv: 'production',
    seed(dbFile) {
      const db = new DatabaseSync(dbFile);
      db.exec(`CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      db.prepare('INSERT INTO accounts(nickname,email,password_hash,email_verified,created_at) VALUES(?,?,?,?,?)')
        .run('历史账号', 'history@example.com', passwordHash, 0, now);
      db.close();
    },
  });

  const unavailable = await request(server.base, 'POST', '/api/account/register', {
    body: { registrationProtocol: 'email-code-v1', nickname: '新账号', email: 'new@example.com', password: 'password123' },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.reason, 'mail_unavailable');
  assert.equal(unavailable.cacheControl, 'no-store');
  assert.equal(unavailable.setCookie, null);
  assert.equal(Object.hasOwn(unavailable.json, 'devCode'), false);

  const login = await request(server.base, 'POST', '/api/auth/login', {
    body: { email: 'history@example.com', password: 'existing-password' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.cacheControl, 'no-store');

  const db = new DatabaseSync(server.dbFile);
  t.after(() => db.close());
  db.prepare(`INSERT INTO pending_registrations
    (email,registration_id,nickname,password_hash,code_hash,attempts,created_at,issued_at,expires_at,flow_expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'new@example.com', registrationId, '新账号', auth.hashPassword('password123'), codeHash,
    0, now, now, now + 600000, now + 1800000,
  );
  const verified = await request(server.base, 'POST', '/api/account/verify-code', {
    body: { email: 'new@example.com', registrationId, code: '001234' },
  });
  assert.equal(verified.status, 201, JSON.stringify(verified.json));
  assert.match(verified.setCookie, /^sx_session=/);
  assert.match(verified.setCookie, /; Secure/);
  assert.doesNotMatch(server.getLogs(), /001234|devCode|password123|existing-password/);
});
