'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const auth = require('../auth');
const registration = require('../platform/registration');
const RealDatabase = sqlite.DatabaseSync;
const T = Date.parse('2026-09-14T15:59:00Z');
const body = (n = 1) => ({ registrationProtocol: 'email-code-v1', nickname: `player${n}`, email: `p${n}@example.com`, password: ' password exact ' });
const id = (n) => n.toString(16).padStart(32, '0');

function fixture(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-registration-'));
  const filename = path.join(dir, 'test.db');
  const oldPath = process.env.DB_PATH;
  process.env.DB_PATH = filename;
  const handles = [];
  // Capture real SQLite handles so even failed module migrations close on Windows.
  t.mock.method(sqlite, 'DatabaseSync', function (...args) {
    const connection = new RealDatabase(...args);
    handles.push(connection);
    return connection;
  });
  if (seed) {
    const connection = new RealDatabase(filename);
    seed(connection);
    connection.close();
  }
  const reload = () => {
    for (const connection of handles.splice(0)) connection.close();
    delete require.cache[require.resolve('../db')];
    return require('../db');
  };
  t.after(() => {
    for (const connection of handles) connection.close();
    delete require.cache[require.resolve('../db')];
    if (oldPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { reload, filename };
}

function pending(n = 1, changes = {}) {
  return { email: `p${n}@example.com`, registration_id: id(n), nickname: `player${n}`,
    password_hash: 'stored-password-hash', code_hash: 'stored-code-hash', attempts: 0,
    created_at: T, issued_at: T, expires_at: T + 600000, flow_expires_at: T + 1800000, ...changes };
}

function reserve(db, n = 1, changes = {}) {
  return db.reserveRegistrationMail({ id: `mail-${n}`, email: `p${n}@example.com`, sourceIp: `ip-${n}`,
    reservedAt: T, leaseExpiresAt: T + 120000, quotaDay: '2026-09-14', retryAfterSec: 60, ...changes });
}

function activate(db, n = 1, changes = {}, at = T) {
  assert.equal(reserve(db, n).ok, true);
  const row = pending(n, changes);
  assert.equal(db.commitRegistrationMail({ id: `mail-${n}`, email: row.email, acceptedAt: at,
    quotaDay: '2026-09-14', pending: row, now: at }).ok, true);
  return row;
}

function service(t, options = {}) {
  const database = fixture(t).reload();
  let at = T;
  const sent = [], logs = [];
  delete require.cache[require.resolve('../ratelimit')];
  const limiter = require('../ratelimit');
  const mail = { loadConfig: () => ({ mode: 'smtp', dailyMax: 200 }),
    sendVerification: async (message) => { sent.push(message); return { outcome: 'accepted', acceptedAt: at }; }, ...options.mail };
  const api = registration.createRegistrationService({ db: database, auth, rateLimit: limiter,
    mail, clock: () => at, cleanupIntervalMs: 0, logger: { error: (...args) => logs.push(args) }, ...options.service });
  t.after(() => api.close());
  return { db: database, api, sent, logs, setTime: (value) => { at = value; } };
}

test('resend accepted after original code expiry counts mail but cannot revive the flow', (t) => {
  const db = fixture(t).reload();
  const original = activate(db);
  reserve(db, 2, { email: original.email, reservedAt: T + 599000, leaseExpiresAt: T + 719000 });
  const candidate = pending(1, { registration_id: id(99), issued_at: T + 599000, expires_at: T + 1199000 });
  const result = db.commitRegistrationMail({ id: 'mail-2', email: original.email, acceptedAt: T + 600000,
    quotaDay: '2026-09-15', pending: candidate, expectedRegistrationId: original.registration_id, now: T + 600000 });
  assert.deepEqual(result, { ok: false, reason: 'expired' });
  assert.equal(db.getPendingRegistration(original.email), undefined);
  assert.equal(db.getRegistrationCooldown(original.email), T + 600000);
  assert.equal(db.db.prepare("SELECT state FROM registration_mail_attempts WHERE id='mail-2'").get().state, 'sent');
});

test('storage errors are controlled and logs cannot echo sensitive exception data', async (t) => {
  const f = service(t);
  f.db.db.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON pending_registrations BEGIN SELECT RAISE(ABORT, 'secret-password 001234 sx_session=secret'); END");
  const response = await f.api.register(body(), 'ip');
  assert.equal(response.status, 503);
  assert.equal(response.body.reason, 'registration_storage_error');
  assert.doesNotMatch(JSON.stringify([response, f.logs]), /secret-password|001234|sx_session/);
  assert.equal(f.api.lockedEmails.size, 0);
  assert.equal(f.db.db.prepare('SELECT state FROM registration_mail_attempts').get().state, 'reserved');
  const second = await f.api.register(body(), 'ip');
  assert.equal(second.body.reason, 'send_recovering');
  assert.equal(f.sent.length, 1);
});

test('unexpected database reads become controlled storage responses and release locks', async (t) => {
  const f = service(t);
  t.mock.method(f.db, 'getAccountByNickname', () => { throw new Error('private-hash'); });
  const response = await f.api.register(body(), 'ip');
  assert.equal(response.status, 503);
  assert.equal(response.body.reason, 'registration_storage_error');
  assert.equal(f.api.lockedEmails.size, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-hash/);
});

test('successful verification exposes no hashes even in the service account result', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  assert.equal(first.status, 200);
  const response = await f.api.verify({ email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code }, 'ip');
  assert.equal(response.status, 201);
  assert.equal(response.account.email_verified, 1);
  assert.equal(response.account.password_hash, undefined);
  assert.doesNotMatch(JSON.stringify(response), /password|code_hash|registration_id/);
  const account = f.db.getAccountByEmail(body().email);
  assert.equal(await auth.verifyPasswordAsync(' password exact ', account.password_hash), true);
  assert.equal(f.db.getPendingRegistration(body().email), undefined);
  assert.equal((await f.api.verify({ email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code }, 'ip')).status, 404);
});

test('legacy migration rolls back verification changes when marker insertion fails', (t) => {
  const f = fixture(t, (db) => db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,nickname TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO accounts VALUES(7,'old','old@example.com','hash',100);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL);
    CREATE TRIGGER reject_marker BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT,'marker failure'); END;`));
  assert.throws(() => f.reload(), /marker failure/);
  const inspect = new RealDatabase(f.filename);
  try {
    const columns = inspect.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
    if (columns.includes('email_verified')) assert.equal(inspect.prepare('SELECT email_verified FROM accounts').get().email_verified, 0);
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='pending_registrations'").get(), undefined);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
  } finally { inspect.close(); }
});

test('migration preflights canonical collisions and leaves existing records intact', (t) => {
  const f = fixture(t, (db) => db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,nickname TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,email_verified INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    INSERT INTO accounts VALUES(1,'a','Alice@Example.com','one',0,100),(2,'b',' alice@example.com ','two',0,200);`));
  assert.throws(() => f.reload(), /冲突/);
  const inspect = new RealDatabase(f.filename);
  try {
    assert.deepEqual(inspect.prepare('SELECT email_verified FROM accounts ORDER BY id').all().map((r) => r.email_verified), [0, 0]);
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='pending_registrations'").get(), undefined);
  } finally { inspect.close(); }
});

test('migration marker is idempotent and preserves account and game data', (t) => {
  const f = fixture(t);
  let db = f.reload();
  const account = db.createAccount('history', 'history@example.com', 'hash');
  db.db.prepare("INSERT INTO players(game_id,id,account_id,name,created_at) VALUES('clawclash',42,?,'player',123)").run(account.id);
  db.db.exec("DELETE FROM schema_migrations WHERE name='email_code_registration_v1_1'; UPDATE accounts SET email_verified=0");
  db = f.reload();
  assert.equal(db.getAccountById(account.id).email_verified, 1);
  db.db.exec('UPDATE accounts SET email_verified=0');
  db = f.reload();
  assert.equal(db.getAccountById(account.id).email_verified, 0);
  assert.equal(db.db.prepare('SELECT id FROM players').get().id, 42);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='email_code_registration_v1_1'").get().n, 1);
  assert.equal(db.createAccount('new', 'new@example.com', 'hash').email_verified, 1);
});

test('fifth wrong code deletes the row and stale requests never consume attempts', (t) => {
  const db = fixture(t).reload();
  const row = activate(db);
  assert.deepEqual(db.recordIncorrectRegistrationCode({ email: row.email, registrationId: id(999), now: T }), { reason: 'stale' });
  for (const remaining of [4, 3, 2, 1]) {
    assert.deepEqual(db.recordIncorrectRegistrationCode({ email: row.email, registrationId: row.registration_id, now: T }), { reason: 'incorrect', remaining });
    assert.equal(db.getPendingRegistration(row.email).attempts, 5 - remaining);
  }
  assert.deepEqual(db.recordIncorrectRegistrationCode({ email: row.email, registrationId: row.registration_id, now: T }), { reason: 'exhausted', remaining: 0 });
  assert.equal(db.getPendingRegistration(row.email), undefined);
  assert.equal(db.consumePendingRegistration({ email: row.email, registrationId: row.registration_id, now: T }).reason, 'missing');
});

test('account insert and pending deletion roll back together on unexpected SQL failure', (t) => {
  const db = fixture(t).reload();
  const row = activate(db);
  db.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON pending_registrations BEGIN SELECT RAISE(ABORT,'delete failure'); END");
  assert.throws(() => db.consumePendingRegistration({ email: row.email, registrationId: row.registration_id, now: T }), /delete failure/);
  assert.equal(db.getAccountByEmail(row.email), undefined);
  assert.equal(db.getPendingRegistration(row.email).registration_id, row.registration_id);
  db.db.exec('DROP TRIGGER reject_delete');
  const consumed = db.consumePendingRegistration({ email: row.email, registrationId: row.registration_id, now: T });
  assert.equal(consumed.account.email_verified, 1);
});

test('nickname conflict commits pending deletion without affecting the winning account', (t) => {
  const db = fixture(t).reload();
  const row = activate(db);
  const winner = db.createAccount(row.nickname, 'winner@example.com', 'winner');
  assert.deepEqual(db.consumePendingRegistration({ email: row.email, registrationId: row.registration_id, now: T }), { ok: false, reason: 'conflict', field: 'nickname' });
  assert.equal(db.getPendingRegistration(row.email), undefined);
  assert.equal(db.getAccountById(winner.id).email, 'winner@example.com');
});

test('quotas are atomic and reservations count across Shanghai midnight', (t) => {
  const db = fixture(t).reload();
  assert.equal(reserve(db, 1, { globalLimit: 1 }).ok, true);
  assert.deepEqual(reserve(db, 2, { globalLimit: 1, reservedAt: T + 60000, quotaDay: '2026-09-15' }), { ok: false, reason: 'send_reserved', retryAfterSec: 2 });
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM registration_mail_attempts').get().n, 1);
  db.commitRegistrationMail({ id: 'mail-1', email: 'p1@example.com', acceptedAt: T + 60000, quotaDay: '2026-09-15', pending: pending(), now: T + 60000 });
  assert.equal(reserve(db, 2, { globalLimit: 1, reservedAt: T + 60001, quotaDay: '2026-09-15' }).reason, 'global_quota');
  assert.equal(registration.quotaDay(T + 59999), '2026-09-14');
  assert.equal(registration.quotaDay(T + 60000), '2026-09-15');
  assert.equal(registration.secondsToShanghaiMidnight(T + 59999), 1);
});

test('global zero retains email and IP daily quotas with email priority', (t) => {
  const db = fixture(t).reload();
  for (let n = 1; n <= 10; n++) {
    const email = n <= 3 ? 'target@example.com' : `other${n}@example.com`;
    assert.equal(reserve(db, n, { email, sourceIp: 'shared', globalLimit: 0 }).ok, true);
    db.commitRegistrationMail({ id: `mail-${n}`, email, acceptedAt: T, quotaDay: '2026-09-14', pending: pending(n, { email }), now: T });
  }
  assert.equal(reserve(db, 11, { email: 'target@example.com', sourceIp: 'shared', globalLimit: 0 }).reason, 'email_quota');
  assert.equal(reserve(db, 11, { sourceIp: 'shared', globalLimit: 0 }).reason, 'ip_quota');
  assert.equal(reserve(db, 11, { globalLimit: 0 }).ok, true);
});

test('failed releases immediately; unknown and restart reservations protect until exact lease expiry', (t) => {
  const f = fixture(t);
  let db = f.reload();
  reserve(db);
  assert.deepEqual(db.finishRegistrationMail('mail-1', 'failed', T + 1), { updated: true });
  assert.deepEqual(db.finishRegistrationMail('mail-1', 'unknown', T + 2), { updated: false });
  assert.equal(reserve(db, 2, { email: 'p1@example.com' }).ok, true);
  db = f.reload();
  db.recoverRegistrationMailLeases(T + 1000);
  assert.equal(db.db.prepare("SELECT state FROM registration_mail_attempts WHERE id='mail-2'").get().state, 'unknown');
  assert.deepEqual(reserve(db, 3, { email: 'p1@example.com', reservedAt: T + 119001 }), { ok: false, reason: 'send_recovering', retryAfterSec: 1 });
  assert.equal(reserve(db, 3, { email: 'p1@example.com', reservedAt: T + 120000 }).ok, true);
  assert.equal(db.getRegistrationCooldown('p1@example.com'), null);
});

test('cleanup skips locked pending and retains terminal mail for 48 hours from acceptance', (t) => {
  const db = fixture(t).reload();
  const row = activate(db);
  db.cleanupRegistrationData(T + 600000, [row.email]);
  assert.ok(db.getPendingRegistration(row.email));
  db.cleanupRegistrationData(T + 600000);
  assert.equal(db.getPendingRegistration(row.email), undefined);
  const accepted = T + 119000;
  db.db.prepare('UPDATE registration_mail_attempts SET accepted_at=?').run(accepted);
  db.cleanupRegistrationData(accepted + 48 * 3600000 - 1);
  assert.equal(db.getRegistrationCooldown(row.email), accepted);
  db.cleanupRegistrationData(accepted + 48 * 3600000);
  assert.equal(db.getRegistrationCooldown(row.email), null);
});

test('allowAll refuses both buckets without charging the unconstrained bucket', () => {
  delete require.cache[require.resolve('../ratelimit')];
  const rate = require('../ratelimit');
  assert.equal(rate.allow('full', 1, 600000).ok, true);
  assert.equal(rate.allowAll([{ key: 'empty', max: 1, windowMs: 600000 }, { key: 'full', max: 1, windowMs: 600000 }]).ok, false);
  assert.equal(rate.allow('empty', 1, 600000).ok, true);
  assert.equal(rate.allowAll([{ key: 'a', max: 1, windowMs: 600000 }, { key: 'b', max: 1, windowMs: 600000 }]).ok, true);
  assert.equal(rate.allow('a', 1, 600000).ok, false);
  assert.equal(rate.allow('b', 1, 600000).ok, false);
});

test('input validation preserves Unicode nicknames, exact passwords and leading zero codes', () => {
  for (const invalid of [null, [], 1, 'text']) assert.equal(registration.validateRegisterBody(invalid).status, 400);
  for (const field of ['nickname', 'email', 'password']) for (const invalid of [null, [], 1, {}]) {
    assert.equal(registration.validateRegisterBody({ ...body(), [field]: invalid }).status, 400);
  }
  assert.equal(registration.validateRegisterBody({ ...body(), registrationProtocol: undefined }).status, 409);
  assert.equal(registration.validateRegisterBody({ ...body(), nickname: '😀'.repeat(64) }).nickname, '😀'.repeat(64));
  for (const nickname of ['😀'.repeat(65), 'x\u200by', 'x\ny', ' ']) assert.equal(registration.validateRegisterBody({ ...body(), nickname }).status, 400);
  for (const email of ['a..b@c.com', '.a@c.com', 'a.@c.com', 'a@-c.com', 'a@c', '我@c.com', 'a b@c.com', 'a@c..com', 'a'.repeat(65) + '@c.com']) assert.equal(registration.validEmail(email), false, email);
  assert.equal(registration.validateRegisterBody({ ...body(), email: ' A+B@Example.COM ' }).email, 'a+b@example.com');
  assert.equal(registration.validateRegisterBody(body()).password, ' password exact ');
  const round = { email: body().email, registrationId: id(1), code: '001234' };
  assert.equal(registration.validateRoundBody(round, true).code, '001234');
  for (const code of [1234, '１２３４５６', '12345', '123456\n']) assert.equal(registration.validateRoundBody({ ...round, code }, true).status, 400);
});

test('async salted scrypt preserves leading zeros and permits the event loop to run', async (t) => {
  const sync = t.mock.method(crypto, 'scryptSync', () => { throw new Error('async registration must not run synchronous scrypt'); });
  let yielded = false;
  const turn = new Promise((resolve) => setImmediate(() => { yielded = true; resolve(); }));
  const hashing = auth.hashPasswordAsync('001234');
  await turn;
  assert.equal(yielded, true);
  const first = await hashing;
  assert.notEqual(first, await auth.hashPasswordAsync('001234'));
  assert.equal(await auth.verifyPasswordAsync('001234', first), true);
  assert.equal(await auth.verifyPasswordAsync('1234', first), false);
  sync.mock.restore();
  assert.equal(auth.verifyPassword('001234', first), true);
});

test('four concurrent sends are bounded and same-email register/resend/verify fail fast', async (t) => {
  const releases = [];
  const f = service(t, { mail: { sendVerification: () => new Promise((resolve) => releases.push(resolve)) } });
  const requests = [1, 2, 3, 4].map((n) => f.api.register(body(n), `ip-${n}`));
  while (releases.length < 4) await new Promise((resolve) => setImmediate(resolve));
  for (const request of [() => f.api.register(body(), 'other'), () => f.api.resend({ email: body().email, registrationId: id(1) }, 'other'), () => f.api.verify({ email: body().email, registrationId: id(1), code: '001234' }, 'other')]) {
    const result = await request();
    assert.equal(result.body.reason, 'registration_busy');
    assert.equal(result.headers['Retry-After'], '2');
  }
  assert.equal((await f.api.register(body(5), 'ip-5')).body.reason, 'send_busy');
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM registration_mail_attempts').get().n, 4);
  for (const release of releases) release({ outcome: 'failed' });
  assert.deepEqual((await Promise.all(requests)).map((r) => r.status), [502, 502, 502, 502]);
  assert.equal(f.api.lockedEmails.size, 0);
});

test('resend failure and unknown preserve existing registration and allow verification', async (t) => {
  let outcome = 'accepted';
  const f = service(t, { mail: { sendVerification: async (message) => {
    f.sent.push(message);
    return { outcome, acceptedAt: T };
  } } });
  const first = await f.api.register(body(), 'ip');
  const original = f.db.getPendingRegistration(body().email);
  f.db.recordIncorrectRegistrationCode({ email: body().email, registrationId: first.body.registrationId, now: T });
  const before = f.db.getPendingRegistration(body().email);
  f.setTime(T + 60000);
  const round = { email: body().email, registrationId: first.body.registrationId };
  outcome = 'failed';
  assert.equal((await f.api.resend(round, 'ip')).body.reason, 'mail_failed');
  assert.deepEqual(f.db.getPendingRegistration(body().email), before);
  outcome = 'unknown';
  assert.equal((await f.api.resend(round, 'ip')).body.reason, 'mail_status_unknown');
  assert.deepEqual(f.db.getPendingRegistration(body().email), before);
  assert.equal((await f.api.resend(round, 'ip')).body.reason, 'send_recovering');
  assert.equal((await f.api.verify({ ...round, code: f.sent[0].code }, 'ip')).status, 201);
  assert.equal(f.db.getRegistrationCooldown(body().email), original.issued_at);
});

test('resend success changes code and ID, resets errors and retains original data and deadline', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  const original = f.db.getPendingRegistration(body().email);
  f.db.recordIncorrectRegistrationCode({ email: body().email, registrationId: first.body.registrationId, now: T });
  f.setTime(T + 60000);
  const round = { email: body().email, registrationId: first.body.registrationId };
  const resent = await f.api.resend({ ...round, password: 'intruder', nickname: 'intruder' }, 'ip');
  assert.equal(resent.status, 200);
  const current = f.db.getPendingRegistration(body().email);
  for (const key of ['created_at', 'flow_expires_at', 'password_hash', 'nickname']) assert.equal(current[key], original[key]);
  assert.notEqual(current.registration_id, original.registration_id);
  assert.notEqual(f.sent[0].code, f.sent[1].code);
  assert.equal(current.attempts, 0);
  assert.equal((await f.api.verify({ ...round, code: f.sent[1].code }, 'ip')).body.reason, 'registration_stale');
  assert.equal(f.db.getPendingRegistration(body().email).attempts, 0);
});

test('every quota check recovers expired leases without resetting successful records', (t) => {
  const db = fixture(t).reload();
  activate(db, 1);
  reserve(db, 2);
  db.finishRegistrationMail('mail-2', 'unknown', T + 1);
  assert.equal(reserve(db, 3, { reservedAt: T + 120000 }).ok, true);
  assert.equal(db.db.prepare("SELECT state FROM registration_mail_attempts WHERE id='mail-2'").get().state, 'failed');
  assert.equal(db.getRegistrationCooldown('p1@example.com'), T);
});

test('historical email lookup uses the same JavaScript trim and lowercase canonical key', (t) => {
  const db = fixture(t).reload();
  db.db.prepare('INSERT INTO accounts(nickname,email,password_hash,email_verified,created_at) VALUES(?,?,?,1,?)')
    .run('historical', '\u00a0K@Example.COM\u00a0', 'hash', T);
  assert.equal(db.getAccountByEmail('k@example.com')?.nickname, 'historical');
  assert.equal(db.db.prepare("SELECT email FROM accounts WHERE nickname='historical'").get().email, '\u00a0K@Example.COM\u00a0');
});

test('SMTP mode never forwards a dev code in a successful client response', async (t) => {
  const f = service(t, { mail: { sendVerification: async () => ({ outcome: 'accepted', acceptedAt: T, devCode: '001234' }) } });
  const result = await f.api.register(body(), 'ip');
  assert.equal(result.status, 200);
  assert.equal(result.body.devCode, undefined);
});

test('default global quota is 200 confirmed mails and rejected reservations make no writes', (t) => {
  const db = fixture(t).reload();
  for (let n = 1; n <= 200; n++) activate(db, n);
  assert.equal(reserve(db, 201).reason, 'global_quota');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM registration_mail_attempts').get().n, 200);
});

test('accepted mail remains counted for conflicting accounts and duplicate callbacks', (t) => {
  const db = fixture(t).reload();
  reserve(db);
  db.createAccount('player1', 'winner@example.com', 'hash');
  const commit = () => db.commitRegistrationMail({ id: 'mail-1', email: 'p1@example.com', acceptedAt: T,
    quotaDay: '2026-09-14', pending: pending(), now: T });
  assert.deepEqual(commit(), { ok: false, reason: 'conflict', field: 'nickname' });
  assert.throws(commit, /reservation/);
  assert.equal(db.finishRegistrationMail('mail-1', 'failed', T + 1).updated, false);
  assert.equal(db.getPendingRegistration('p1@example.com'), undefined);
  assert.equal(db.getRegistrationCooldown('p1@example.com'), T);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM registration_mail_attempts WHERE state='sent'").get().n, 1);
});

test('cooldown survives pending deletion and restart and allows sending at exactly 60 seconds', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  f.db.deletePendingRegistration(body().email, first.body.registrationId);
  f.api.close();
  const restarted = registration.createRegistrationService({ db: f.db, auth, rateLimit: require('../ratelimit'),
    mail: { loadConfig: () => ({ mode: 'smtp', dailyMax: 200 }), sendVerification: async () => ({ outcome: 'accepted', acceptedAt: T + 60000 }) },
    clock: () => T + 59000, cleanupIntervalMs: 0 });
  t.after(() => restarted.close());
  const denied = await restarted.register(body(), 'ip');
  assert.equal(denied.body.reason, 'cooldown');
  assert.equal(denied.headers['Retry-After'], '1');
  f.setTime(T + 60000);
  assert.equal((await f.api.register(body(), 'ip')).status, 200);
});

test('verify rechecks expiry after asynchronous hash comparison and unlocks on error', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  const round = { email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code };
  const realVerify = auth.verifyPasswordAsync;
  t.mock.method(auth, 'verifyPasswordAsync', async (...args) => { const correct = await realVerify(...args); f.setTime(T + 600000); return correct; });
  assert.equal((await f.api.verify(round, 'ip')).body.reason, 'expired');
  assert.equal(f.db.getAccountByEmail(body().email), undefined);
  assert.equal(f.db.getPendingRegistration(body().email), undefined);
  assert.equal(f.api.lockedEmails.size, 0);
});

test('fifth wrong code is 410 then verify and resend are 404', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  const round = { email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code === '000000' ? '000001' : '000000' };
  for (const remaining of [4, 3, 2, 1]) {
    const result = await f.api.verify(round, 'ip');
    assert.equal(result.status, 400);
    assert.equal(result.body.remaining, remaining);
  }
  const exhausted = await f.api.verify(round, 'ip');
  assert.equal(exhausted.status, 410);
  assert.equal(exhausted.body.reason, 'exhausted');
  assert.equal((await f.api.verify(round, 'ip')).status, 404);
  assert.equal((await f.api.resend(round, 'ip')).status, 404);
});

test('unavailable mail blocks sending but already issued codes remain usable', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  const api = registration.createRegistrationService({ db: f.db, auth, rateLimit: require('../ratelimit'),
    mail: { loadConfig: () => ({ mode: 'unavailable', dailyMax: 200 }), sendVerification: () => { throw new Error('must not send'); } },
    clock: () => T, cleanupIntervalMs: 0 });
  t.after(() => api.close());
  assert.equal((await api.register(body(2), 'ip')).body.reason, 'mail_unavailable');
  assert.equal((await api.verify({ email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code }, 'ip')).status, 201);
});

test('service exposes configuration status without SMTP credentials', (t) => {
  const f = service(t, { mail: { loadConfig: () => ({ mode: 'smtp', dailyMax: 200, user: 'private-user', pass: 'private-password', host: 'private-host' }) } });
  assert.deepEqual(f.api.config, { mode: 'smtp', dailyMax: 200 });
});

test('mail failures emit bounded diagnostic stages without arbitrary provider text', async (t) => {
  const f = service(t, { mail: { sendVerification: async () => ({ outcome: 'failed', reason: 'smtp_535', stage: 'auth', message: 'password=do-not-log' }) } });
  assert.equal((await f.api.register(body(), 'ip')).status, 502);
  assert.match(JSON.stringify(f.logs), /smtp_535/);
  assert.match(JSON.stringify(f.logs), /auth/);
  assert.doesNotMatch(JSON.stringify(f.logs), /do-not-log/);
});

test('minute cleanup and startup cleanup delete expired pending', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = service(t, { service: { cleanupIntervalMs: 60000 } });
  await f.api.register(body(), 'ip');
  f.setTime(T + 600000);
  t.mock.timers.tick(60000);
  assert.equal(f.db.getPendingRegistration(body().email), undefined);
  activate(f.db, 2);
  const restart = registration.createRegistrationService({ db: f.db, auth, rateLimit: require('../ratelimit'),
    mail: { loadConfig: () => ({ mode: 'smtp', dailyMax: 200 }) }, clock: () => T + 600000, cleanupIntervalMs: 0 });
  t.after(() => restart.close());
  assert.equal(f.db.getPendingRegistration('p2@example.com'), undefined);
  assert.equal(f.db.getRegistrationCooldown('p2@example.com'), T);
});

test('simultaneous correct verification creates exactly one account and one successful response', async (t) => {
  const f = service(t);
  const first = await f.api.register(body(), 'ip');
  const round = { email: body().email, registrationId: first.body.registrationId, code: f.sent[0].code };
  const [accepted, busy] = await Promise.all([f.api.verify(round, 'ip'), f.api.verify(round, 'other-ip')]);
  assert.equal(accepted.status, 201);
  assert.equal(busy.body.reason, 'registration_busy');
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal(f.api.lockedEmails.size, 0);
});
