'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const STEP_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 60000;

function validEmail(email) {
  if (typeof email !== 'string' || !email || /[\r\n]/.test(email) || !/^[\x00-\x7f]+$/.test(email)) return false;
  if (Buffer.byteLength(email, 'ascii') > 254) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at), labels = email.slice(at + 1).split('.');
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)) return false;
  return labels.length >= 2 && labels.every((label) => label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function unavailable(error, dailyMax = 200) {
  return { mode: 'unavailable', dailyMax, error };
}

function loadConfig(env = process.env) {
  const dailyRaw = env.SMTP_DAILY_MAX;
  if (dailyRaw !== undefined && (typeof dailyRaw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(dailyRaw))) {
    return unavailable('invalid_daily_max');
  }
  const dailyMax = dailyRaw === undefined ? 200 : Number(dailyRaw);
  if (!Number.isSafeInteger(dailyMax) || dailyMax < 0) return unavailable('invalid_daily_max');

  const secureRaw = env.SMTP_SECURE;
  if (secureRaw !== undefined && secureRaw !== 'true' && secureRaw !== 'false') return unavailable('invalid_secure', dailyMax);
  const secure = secureRaw === undefined ? true : secureRaw === 'true';
  const portRaw = env.SMTP_PORT;
  if (portRaw !== undefined && (typeof portRaw !== 'string' || !/^[1-9]\d*$/.test(portRaw))) {
    return unavailable('invalid_port', dailyMax);
  }
  const port = portRaw === undefined ? (secure ? 465 : 587) : Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return unavailable('invalid_port', dailyMax);

  const hostRaw = env.SMTP_HOST;
  if (hostRaw !== undefined && (typeof hostRaw !== 'string' || !hostRaw || /\s|[\r\n]/.test(hostRaw))) {
    return unavailable('invalid_host', dailyMax);
  }
  const host = hostRaw === undefined ? '' : hostRaw;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.SMTP_FROM === undefined ? user : env.SMTP_FROM;
  if (env.SMTP_FROM !== undefined && !validEmail(env.SMTP_FROM)) return unavailable('invalid_from', dailyMax);
  if (env.SMTP_USER !== undefined && (typeof user !== 'string' || !user || /[\r\n]/.test(user))) return unavailable('invalid_user', dailyMax);
  if (env.SMTP_PASS !== undefined && (typeof pass !== 'string' || !pass || /[\r\n]/.test(pass))) return unavailable('invalid_password', dailyMax);
  if (env.SMTP_FROM === undefined && env.SMTP_USER !== undefined && !validEmail(user)) {
    return unavailable('invalid_from', dailyMax);
  }

  if (!host) {
    if (env.NODE_ENV === 'production') return unavailable('missing_host', dailyMax);
    return { mode: 'dev', dailyMax };
  }
  if (typeof user !== 'string' || !user || typeof pass !== 'string' || !pass || !validEmail(from)) {
    return unavailable('missing_credentials', dailyMax);
  }
  return { mode: 'smtp', dailyMax, host, port, secure, user, pass, from };
}

function shanghaiTime(timestamp) {
  const iso = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}（北京时间）`;
}

function foldBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
}

function buildMessage({ from, to, code, expiresAt, at = Date.now() }) {
  if (!validEmail(from) || !validEmail(to) || !/^\d{6}$/.test(code)) throw new Error('invalid mail content');
  const subject = '【Claw Clash】邮箱验证码';
  const body = [
    `您的邮箱验证码是：${code}`,
    '',
    `验证码有效至 ${shanghaiTime(expiresAt)}。`,
    '如非本人操作，请忽略此邮件。Claw Clash 不会向您索取密码。',
  ].join('\r\n');
  const domain = from.slice(from.indexOf('@') + 1);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(body),
  ].join('\r\n');
}

class SmtpError extends Error {
  constructor(message, { explicit = false, code = null } = {}) {
    super(message);
    this.explicit = explicit;
    this.smtpCode = code;
  }
}

function socketError(error) {
  return error instanceof SmtpError ? error : new SmtpError('smtp transport failed');
}

function createReader(socket) {
  let buffer = '';
  const lines = [];
  const waiters = [];
  let endedError = null;

  const deliver = () => {
    while (lines.length && waiters.length) waiters.shift().resolve(lines.shift());
    if (endedError) while (waiters.length) waiters.shift().reject(endedError);
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const pos = buffer.indexOf('\r\n');
      if (pos < 0) break;
      lines.push(buffer.slice(0, pos));
      buffer = buffer.slice(pos + 2);
    }
    deliver();
  };
  const onError = () => { endedError = new SmtpError('smtp connection error'); deliver(); };
  const onClose = () => { endedError = new SmtpError('smtp connection closed'); deliver(); };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    line() {
      if (lines.length) return Promise.resolve(lines.shift());
      if (endedError) return Promise.reject(endedError);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    dispose() {
      if (!endedError) endedError = new SmtpError('smtp reader disposed');
      deliver();
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

function stepDeadline(totalDeadline) {
  return Math.min(totalDeadline, Date.now() + STEP_TIMEOUT_MS);
}

function withDeadline(promise, deadline, socket) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    promise.catch(() => {});
    socket.destroy();
    return Promise.reject(new SmtpError('smtp timeout'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError('smtp timeout'));
    }, remaining);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function readResponse(reader, socket, totalDeadline, fixedDeadline = stepDeadline(totalDeadline)) {
  const first = await withDeadline(reader.line(), fixedDeadline, socket);
  const match = /^(\d{3})(?:([ -])(.*))?$/.exec(first);
  if (!match) throw new SmtpError('malformed smtp response');
  const code = Number(match[1]);
  const lines = [match[3] ?? ''];
  if (match[2] === '-') {
    for (;;) {
      const line = await withDeadline(reader.line(), fixedDeadline, socket);
      const next = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!next || next[1] !== match[1]) throw new SmtpError('malformed smtp multiline response');
      lines.push(next[3] ?? '');
      if (next[2] !== '-') break;
    }
  }
  return { code, lines, text: lines.join('\n') };
}

function write(socket, data, totalDeadline, fixedDeadline = stepDeadline(totalDeadline)) {
  return withDeadline(new Promise((resolve, reject) => {
    socket.write(data, (error) => error ? reject(socketError(error)) : resolve());
  }), fixedDeadline, socket);
}

async function command(socket, reader, totalDeadline, text) {
  const fixedDeadline = stepDeadline(totalDeadline);
  await write(socket, `${text}\r\n`, totalDeadline, fixedDeadline);
  return readResponse(reader, socket, totalDeadline, fixedDeadline);
}

function expect(response, allowed) {
  if (!allowed.includes(response.code)) throw new SmtpError('smtp command rejected', { explicit: true, code: response.code });
  return response;
}

function waitFor(socket, event, deadline) {
  return withDeadline(new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new SmtpError('smtp connection failed')); };
    const onClose = () => { cleanup(); reject(new SmtpError('smtp connection closed')); };
    const cleanup = () => {
      socket.off(event, onReady); socket.off('error', onError); socket.off('close', onClose);
    };
    socket.once(event, onReady); socket.once('error', onError); socket.once('close', onClose);
  }), stepDeadline(deadline), socket);
}

function tlsOptions(config, extra = {}) {
  return {
    host: config.host,
    port: config.port,
    servername: net.isIP(config.host) ? undefined : config.host,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...extra,
  };
}

function dataPayload(message) {
  const stuffed = message.split('\r\n').map((line) => line.startsWith('.') ? `.${line}` : line).join('\r\n');
  return `${stuffed}\r\n.\r\n`;
}

async function smtpSend({ config, to, code, expiresAt, now }) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let socket;
  let reader;
  let stage = 'connect';
  let dataWritten = false;
  try {
    if (config.secure) {
      socket = tls.connect(tlsOptions(config));
      await waitFor(socket, 'secureConnect', deadline);
    } else {
      socket = net.connect({ host: config.host, port: config.port });
      await waitFor(socket, 'connect', deadline);
    }
    reader = createReader(socket);
    stage = 'greeting';
    expect(await readResponse(reader, socket, deadline), [220]);

    stage = 'ehlo';
    let ehlo = expect(await command(socket, reader, deadline, 'EHLO localhost'), [250]);
    if (!config.secure) {
      if (!ehlo.lines.some((line) => /^STARTTLS(?:\s|$)/i.test(line))) throw new SmtpError('STARTTLS unavailable', { explicit: true });
      stage = 'starttls';
      expect(await command(socket, reader, deadline, 'STARTTLS'), [220]);
      reader.dispose();
      const plainSocket = socket;
      socket = tls.connect(tlsOptions(config, { socket: plainSocket }));
      await waitFor(socket, 'secureConnect', deadline);
      reader = createReader(socket);
      stage = 'ehlo_tls';
      ehlo = expect(await command(socket, reader, deadline, 'EHLO localhost'), [250]);
    }
    if (!ehlo.lines.some((line) => /^AUTH(?:\s|=).*\bLOGIN\b/i.test(line))) {
      throw new SmtpError('AUTH LOGIN unavailable', { explicit: true });
    }

    stage = 'auth';
    expect(await command(socket, reader, deadline, 'AUTH LOGIN'), [334]);
    expect(await command(socket, reader, deadline, Buffer.from(config.user).toString('base64')), [334]);
    expect(await command(socket, reader, deadline, Buffer.from(config.pass).toString('base64')), [235]);
    stage = 'mail_from';
    expect(await command(socket, reader, deadline, `MAIL FROM:<${config.from}>`), [250]);
    stage = 'rcpt_to';
    expect(await command(socket, reader, deadline, `RCPT TO:<${to}>`), [250, 251]);
    stage = 'data';
    expect(await command(socket, reader, deadline, 'DATA'), [354]);
    const message = buildMessage({ from: config.from, to, code, expiresAt, at: now() });
    stage = 'data_result';
    const fixedDeadline = stepDeadline(deadline);
    await write(socket, dataPayload(message), deadline, fixedDeadline);
    dataWritten = true;
    const accepted = expect(await readResponse(reader, socket, deadline, fixedDeadline), [250]);
    const acceptedAt = now();
    stage = 'quit';
    try { expect(await command(socket, reader, deadline, 'QUIT'), [221]); } catch {}
    socket.destroy();
    return { outcome: 'accepted', acceptedAt, reason: `smtp_${accepted.code}`, stage: 'accepted' };
  } catch (error) {
    if (socket) socket.destroy();
    const smtpError = socketError(error);
    return {
      outcome: dataWritten && !smtpError.explicit ? 'unknown' : 'failed',
      reason: smtpError.smtpCode ? `smtp_${smtpError.smtpCode}` : 'smtp_transport_error',
      stage,
    };
  } finally {
    if (reader) reader.dispose();
  }
}

async function sendVerification({ to, code, expiresAt, config = loadConfig(), now = Date.now }) {
  if (!validEmail(to) || typeof code !== 'string' || !/^\d{6}$/.test(code)
      || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
      || expiresAt < 0 || expiresAt > 8640000000000000
      || !config || typeof config !== 'object') {
    return { outcome: 'failed', reason: 'invalid_message', stage: 'prepare' };
  }
  if (config.mode === 'unavailable') return { outcome: 'failed', reason: 'mail_unavailable', stage: 'config' };
  if (config.mode === 'dev') {
    if (process.env.NODE_ENV === 'production') {
      return { outcome: 'failed', reason: 'mail_unavailable', stage: 'config' };
    }
    const acceptedAt = now();
    console.log(`[开发验证码] ${to.slice(0, 1)}***${to.slice(to.indexOf('@'))} code=${code}`);
    return { outcome: 'accepted', acceptedAt, devCode: code, reason: 'dev_accepted', stage: 'accepted' };
  }
  if (config.mode !== 'smtp' || !validEmail(config.from)) {
    return { outcome: 'failed', reason: 'invalid_message', stage: 'prepare' };
  }
  return smtpSend({ config, to, code, expiresAt, now });
}

module.exports = {
  loadConfig,
  sendVerification,
  _internals: { buildMessage, command, createReader, dataPayload, readResponse, shanghaiTime, foldBase64, validEmail },
};
