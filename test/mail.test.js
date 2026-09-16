'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const mail = require('../platform/mail');

// These tests never use inherited mail credentials, external hosts, or system trust.
const isolatedKeys = Object.keys(process.env).filter((key) => key.startsWith('SMTP_')
  || ['NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key));
const savedEnv = Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]));
for (const key of isolatedKeys) delete process.env[key];
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/mail-tls', name));
const testCA = fixture('ca.pem');
const realTlsConnect = tls.connect;
before(() => {
  // Inject only the test trust root at the transport boundary. Verification stays on.
  tls.connect = (options) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.equal(options.host, '127.0.0.1');
    return realTlsConnect({ ...options, ca: testCA });
  };
});
after(() => {
  tls.connect = realTlsConnect;
  for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_') || key === 'NODE_ENV') delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const message = { to: 'alice@example.com', code: '001234', expiresAt: Date.UTC(2026, 8, 15, 16, 5) };
const baseEnv = { SMTP_HOST: '127.0.0.1', SMTP_USER: 'sender@example.com', SMTP_PASS: 'test-only-password' };

async function serverFor(t, options = {}) {
  const sockets = new Set();
  const commands = [];
  const messages = [];
  let connections = 0;
  const certName = options.wrongHost ? 'wrong-host' : 'localhost';
  const credentials = { key: fixture(`${certName}-key.pem`), cert: fixture(`${certName}-cert.pem`), minVersion: 'TLSv1.2' };
  function track(socket) {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  }
  function handle(socket, encrypted, greeting = true) {
    track(socket);
    let buffer = '', inData = false;
    let authStep = 0;
    const reply = (text) => socket.write(`${text}\r\n`);
    if (greeting) reply('220 local test SMTP');
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          if (options.onBody) options.onBody({ socket, reply });
          else reply('250 accepted');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push({ line, encrypted });
        if (options.onCommand && options.onCommand({ line, socket, reply, encrypted }) === true) continue;
        if (line.startsWith('EHLO ')) {
          if (!encrypted) reply(options.noStarttls ? '250 AUTH LOGIN' : '250-local\r\n250 STARTTLS');
          else reply(options.noAuth ? '250 local' : '250-local\r\n250 AUTH LOGIN');
        } else if (line === 'STARTTLS') {
          reply('220 begin TLS');
          socket.off('data', onData);
          const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(credentials) });
          handle(secure, true, false);
          return;
        } else if (line === 'AUTH LOGIN') {
          authStep = 1;
          reply('334 VXNlcm5hbWU6');
        } else if (authStep === 1) {
          authStep = 2;
          reply('334 UGFzc3dvcmQ6');
        } else if (authStep === 2) {
          authStep = 0;
          reply('235 authenticated');
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) reply('250 OK');
        else if (line === 'DATA') { inData = true; reply('354 send content'); }
        else if (line === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('500 unexpected');
      }
    };
    socket.on('data', onData);
  }
  const server = options.starttls
    ? net.createServer((socket) => { connections++; handle(socket, false); })
    : tls.createServer(credentials, (socket) => handle(socket, true));
  if (!options.starttls) server.on('connection', (socket) => { connections++; track(socket); });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const config = mail.loadConfig({ ...baseEnv, SMTP_PORT: String(server.address().port), SMTP_SECURE: String(!options.starttls) });
  return { config, commands, messages, connections: () => connections };
}

test('configuration validates every supplied value before permitting simulation', () => {
  assert.deepEqual(mail.loadConfig({}), { mode: 'dev', dailyMax: 200 });
  assert.equal(mail.loadConfig({ NODE_ENV: 'production' }).mode, 'unavailable');
  assert.equal(mail.loadConfig(baseEnv).port, 465);
  assert.equal(mail.loadConfig({ ...baseEnv, SMTP_SECURE: 'false' }).port, 587);
  assert.equal(mail.loadConfig({ SMTP_DAILY_MAX: '0' }).dailyMax, 0);
  for (const [key, values] of Object.entries({
    SMTP_HOST: ['', ' ', 'host\r\nEHLO attacker', 3],
    SMTP_SECURE: ['', 'TRUE', '0', true],
    SMTP_PORT: ['', '0', '-1', '65536', '1.1', ' 465', '0465', 465],
    SMTP_DAILY_MAX: ['', '-1', '1.1', 'NaN', '9007199254740992', ' 0', '00', 200],
    SMTP_USER: ['', 'bad\r\nvalue', 1], SMTP_PASS: ['', 'bad\nvalue', 1],
    SMTP_FROM: ['', 'Display <a@example.com>', 'a@example.com\r\nBcc: x@y.com', 'a@b', 1],
  })) for (const value of values) {
    assert.equal(mail.loadConfig({ [key]: value }).mode, 'unavailable', `${key}=${JSON.stringify(value)}`);
  }
  assert.equal(mail.loadConfig({ SMTP_USER: 'not-an-email' }).mode, 'unavailable');
  assert.equal(mail.loadConfig({ SMTP_USER: 'account', SMTP_FROM: 'sender@example.com' }).mode, 'dev');
});

test('invalid message values fail before a connection opens', async (t) => {
  const server = await serverFor(t);
  const bad = [
    { code: 123456 }, { code: ['001234'] }, { code: '001234\r\nQUIT' },
    { to: 'alice@example.com\r\nBcc: eve@example.com' }, { expiresAt: -1 },
    { expiresAt: 1e30 }, { expiresAt: NaN }, { expiresAt: '2026-09-15' },
    { config: { ...server.config, from: 'sender@example.com\r\nX: injected' } },
  ];
  for (const override of bad) {
    const result = await mail.sendVerification({ ...message, config: server.config, ...override });
    assert.equal(result.outcome, 'failed', JSON.stringify(override));
    assert.equal(result.stage, 'prepare', JSON.stringify(override));
  }
  assert.equal(server.connections(), 0);
});

test('message has encoded Chinese subject, CRLF, folded UTF-8 base64, and Beijing expiry', () => {
  const build = mail._internals.buildMessage || mail.buildMessage;
  const text = build({ ...message, from: 'sender@example.com', at: Date.UTC(2026, 8, 15, 15, 55) });
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  const [headers, body] = text.split('\r\n\r\n');
  assert.match(headers, /^From: sender@example.com\r\nTo: alice@example.com\r\nDate: Tue, 15 Sep 2026 15:55:00 GMT\r\n/);
  assert.match(headers, /Message-ID: <[a-f0-9]{32}@example.com>/);
  const subject = headers.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(subject, 'base64').toString(), '【Claw Clash】邮箱验证码');
  assert.match(headers, /MIME-Version: 1.0\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64$/);
  assert.ok(body.split('\r\n').every((line) => line.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(line)));
  const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString();
  assert.match(decoded, /001234/);
  assert.match(decoded, /2026-09-16 00:05:00（北京时间）/);
  assert.match(decoded, /如非本人操作，请忽略此邮件/);
  assert.match(decoded, /Claw Clash 不会向您索取密码/);
});

for (const starttls of [false, true]) test(`${starttls ? 'STARTTLS' : 'implicit TLS'} serializes authenticated delivery and one DATA terminator`, async (t) => {
  const server = await serverFor(t, { starttls });
  const result = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(result.outcome, 'accepted');
  assert.equal(server.connections(), 1);
  assert.equal(server.messages.length, 1);
  const expected = ['EHLO localhost'];
  if (starttls) expected.push('STARTTLS', 'EHLO localhost');
  expected.push('AUTH LOGIN', Buffer.from(baseEnv.SMTP_USER).toString('base64'), Buffer.from(baseEnv.SMTP_PASS).toString('base64'),
    'MAIL FROM:<sender@example.com>', 'RCPT TO:<alice@example.com>', 'DATA', 'QUIT');
  assert.deepEqual(server.commands.map((item) => item.line), expected);
  assert.ok(server.commands.filter((item) => !['EHLO localhost', 'STARTTLS'].includes(item.line)).every((item) => item.encrypted));
  assert.equal(server.messages[0].includes('\r\n.\r\n'), false);
});

test('TLS hostname mismatch fails without authentication or retry', async (t) => {
  const server = await serverFor(t, { wrongHost: true });
  const result = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.stage, 'connect');
  assert.equal(server.commands.length, 0);
  assert.equal(server.connections(), 1);
});

test('untrusted certificate chain fails while verification remains enabled', async (t) => {
  const server = await serverFor(t);
  tls.connect = (options) => realTlsConnect({ ...options, ca: [] });
  t.after(() => { tls.connect = (options) => realTlsConnect({ ...options, ca: testCA }); });
  assert.equal((await mail.sendVerification({ ...message, config: server.config })).outcome, 'failed');
  assert.equal(server.commands.length, 0);
});

for (const options of [{ starttls: true, noStarttls: true }, { noAuth: true }]) test(`required capability absence fails without credentials: ${JSON.stringify(options)}`, async (t) => {
  const server = await serverFor(t, options);
  assert.equal((await mail.sendVerification({ ...message, config: server.config })).outcome, 'failed');
  assert.ok(server.commands.every(({ line }) => line === 'EHLO localhost'));
});

for (const rejectAt of ['AUTH LOGIN', 'RCPT TO:<alice@example.com>', 'DATA']) test(`explicit rejection at ${rejectAt} is sanitized and never retries`, async (t) => {
  const server = await serverFor(t, { onCommand({ line, reply }) {
    if (line !== rejectAt) return false;
    reply('550 secret-server-text test-only-password 001234');
    return true;
  } });
  const result = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'smtp_550');
  assert.doesNotMatch(JSON.stringify(result), /secret-server|test-only|001234|127\.0\.0\.1/);
  assert.equal(server.connections(), 1);
  assert.equal(server.messages.length, 0);
});

for (const action of ['close', 'reject']) test(`DATA final ${action} distinguishes unknown from failed`, async (t) => {
  const server = await serverFor(t, { onBody({ socket, reply }) {
    if (action === 'close') socket.destroy(); else reply('550 rejected');
  } });
  const result = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(result.outcome, action === 'close' ? 'unknown' : 'failed');
  assert.equal(result.stage, 'data_result');
  assert.equal(server.messages.length, 1);
  assert.equal(server.connections(), 1);
});

for (const [code, outcome] of [[250, 'accepted'], [550, 'failed']]) test(`bare DATA final ${code} is ${outcome}`, async (t) => {
  const server = await serverFor(t, { onBody({ reply }) { reply(String(code)); } });
  const result = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(result.outcome, outcome);
  assert.equal(result.reason, `smtp_${code}`);
  assert.equal(result.stage, outcome === 'accepted' ? 'accepted' : 'data_result');
});

for (const action of ['close', 'reject']) test(`QUIT ${action} preserves final acceptance and its timestamp`, async (t) => {
  let now = 1000;
  const server = await serverFor(t, { onCommand({ line, socket, reply }) {
    if (line !== 'QUIT') return false;
    now = 5000;
    if (action === 'close') socket.destroy(); else reply('500 quit rejected');
    return true;
  } });
  const result = await mail.sendVerification({ ...message, config: server.config, now: () => now });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.acceptedAt, 1000);
  assert.equal(server.connections(), 1);
});

test('production cannot use an injected development config or disclose a code', async (t) => {
  process.env.NODE_ENV = 'production';
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = log; delete process.env.NODE_ENV; });
  const result = await mail.sendVerification({ ...message, config: { mode: 'dev', dailyMax: 200 } });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.devCode, undefined);
  assert.equal(logs.length, 0);
});

test('development simulation returns its code but real SMTP failure never downgrades', async (t) => {
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = log; });
  const result = await mail.sendVerification(message);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.devCode, '001234');
  assert.match(logs[0], /开发验证码/);
  const server = await serverFor(t, { noAuth: true });
  const failure = await mail.sendVerification({ ...message, config: server.config });
  assert.equal(failure.outcome, 'failed');
  assert.equal(failure.devCode, undefined);
  assert.equal(logs.length, 1);
});

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = (_data, done) => done();
  return socket;
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('an already-expired response deadline observes the abandoned reader rejection', async () => {
  const socket = fakeSocket();
  const reader = mail._internals.createReader(socket);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(mail._internals.readResponse(reader, socket, Date.now() - 1), /smtp timeout/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    reader.dispose();
  }
});

test('response parser handles arbitrary fragmentation, coalescing, and consistent multiline codes', async () => {
  const socket = fakeSocket();
  const reader = mail._internals.createReader(socket);
  const first = mail._internals.readResponse(reader, socket, Date.now() + 60000);
  for (const part of ['2', '50-fi', 'rst\r', '\n250-second\r\n250', '\r\n220 next\r\n']) socket.emit('data', Buffer.from(part));
  assert.deepEqual((await first).lines, ['first', 'second', '']);
  assert.equal((await mail._internals.readResponse(reader, socket, Date.now() + 60000)).code, 220);
  const malformed = mail._internals.readResponse(reader, socket, Date.now() + 60000);
  socket.emit('data', Buffer.from('250-first\r\n550 wrong code\r\n'));
  await assert.rejects(malformed);
  reader.dispose();
});

test('a multiline response has one fixed 15-second deadline despite incremental complete lines', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const socket = fakeSocket();
  const reader = mail._internals.createReader(socket);
  let result;
  const pending = mail._internals.readResponse(reader, socket, 61000).then(() => { result = 'accepted'; }, () => { result = 'failed'; });
  socket.emit('data', Buffer.from('250-first\r\n'));
  await flush();
  t.mock.timers.tick(10000);
  socket.emit('data', Buffer.from('250-more\r\n'));
  await flush();
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(result, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result, 'failed');
  assert.equal(socket.destroyed, true);
  await pending;
  reader.dispose();
});

test('reader disposal settles pending readers and removes socket listeners', async () => {
  const socket = fakeSocket();
  const reader = mail._internals.createReader(socket);
  let settled = false;
  reader.line().catch(() => { settled = true; });
  reader.dispose();
  await flush();
  assert.equal(settled, true);
  assert.equal(socket.listenerCount('data') + socket.listenerCount('error') + socket.listenerCount('close'), 0);
});

test('DATA dot-stuffing preserves leading dots and appends exactly one terminator', () => {
  assert.equal(mail._internals.dataPayload('Header: value\r\n\r\n.first\r\n..second'), 'Header: value\r\n\r\n..first\r\n...second\r\n.\r\n');
});

test('command deadline includes writing and reading and total deadline wins across steps', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const socket = fakeSocket();
  const reader = mail._internals.createReader(socket);
  socket.write = (_data, done) => setTimeout(done, 9000);
  let result;
  const pending = mail._internals.command(socket, reader, 61000, 'EHLO localhost').catch(() => { result = 'failed'; });
  t.mock.timers.tick(9000);
  await flush();
  t.mock.timers.tick(6000);
  await flush();
  assert.equal(result, 'failed');
  await pending;
  reader.dispose();

  const second = fakeSocket();
  const secondReader = mail._internals.createReader(second);
  const total = Date.now() + 60000;
  for (let i = 0; i < 4; i++) {
    const step = mail._internals.command(second, secondReader, total, 'NOOP');
    await flush();
    t.mock.timers.tick(14000);
    second.emit('data', Buffer.from('250 OK\r\n'));
    await step;
  }
  let totalFailed = false;
  const last = mail._internals.command(second, secondReader, total, 'NOOP').catch(() => { totalFailed = true; });
  await flush();
  t.mock.timers.tick(3999);
  await flush();
  assert.equal(totalFailed, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(totalFailed, true);
  assert.equal(second.destroyed, true);
  await last;
  secondReader.dispose();
});
