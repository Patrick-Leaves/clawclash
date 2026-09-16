'use strict';

const crypto = require('crypto');

const PROTOCOL = 'email-code-v1';
const CODE_TTL_MS = 10 * 60 * 1000;
const FLOW_TTL_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const LEASE_MS = 120 * 1000;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const MAIL_STAGES = new Set(['connect', 'greeting', 'ehlo', 'starttls', 'ehlo_tls', 'auth',
  'mail_from', 'rcpt_to', 'data', 'data_result', 'quit', 'prepare', 'config', 'send']);
const MAIL_REASONS = new Set(['smtp_transport_error', 'invalid_message', 'mail_unavailable', 'unexpected_error']);

const ERROR_TEXT = {
  invalid_input: '请求参数不正确',
  client_upgrade_required: '注册流程已更新，请刷新页面后重试',
  registration_busy: '该邮箱的注册操作正在处理中，请稍后重试',
  send_busy: '邮件发送任务较多，请稍后重试',
  pending_missing: '注册信息不存在或已失效，请重新填写资料',
  registration_stale: '注册信息已更新，请重新填写资料',
  expired: '验证码已过期，请重新填写资料',
  exhausted: '验证码错误次数已达上限，请重新填写资料',
  code_incorrect: '验证码不正确',
  mail_unavailable: '注册邮件服务暂不可用，请稍后重试',
  mail_failed: '验证邮件发送失败，请稍后重试',
  mail_status_unknown: '邮件发送结果暂未确认，请稍后重试',
  send_recovering: '上一封验证邮件仍在确认中，请稍后重试',
  registration_storage_error: '注册服务暂时不可用，请稍后重试',
  rate_limited: '请求过于频繁，请稍后重试',
  cooldown: '请等待后再获取验证码',
  email_daily_limit: '该邮箱今日验证码次数已达上限，请明日再试',
  ip_daily_limit: '当前网络今日验证码次数已达上限，请明日再试',
  global_daily_limit: '今日注册名额已满，请明日再试',
  send_reserved: '验证邮件正在发送，请稍后重试',
};

function result(status, reason, extra = {}, retryAfterSec) {
  const body = status < 400
    ? { ok: true, ...extra }
    : { ok: false, reason, error: ERROR_TEXT[reason] || '请求失败', ...extra };
  const headers = retryAfterSec == null ? undefined : { 'Retry-After': String(retryAfterSec) };
  if (retryAfterSec != null) body.retryAfterSec = retryAfterSec;
  return { status, body, headers };
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function validEmail(email) {
  if (!email || !/^[\x00-\x7f]+$/.test(email) || Buffer.byteLength(email, 'ascii') > 254) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (Buffer.byteLength(local, 'ascii') > 64 || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => label.length >= 1 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validNickname(nickname) {
  const length = [...nickname].length;
  return length >= 1 && length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(nickname);
}

function validateRegisterBody(body) {
  if (!isObject(body)) return result(400, 'invalid_input');
  if (body.registrationProtocol !== PROTOCOL) return result(409, 'client_upgrade_required');
  if (typeof body.nickname !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return result(400, 'invalid_input');
  }
  const nickname = body.nickname.trim();
  const email = normalizeEmail(body.email);
  if (!validNickname(nickname)) return result(400, 'invalid_input', { field: 'nickname' });
  if (!validEmail(email)) return result(400, 'invalid_input', { field: 'email' });
  if (body.password.length < 8 || body.password.length > 256) return result(400, 'invalid_input', { field: 'password' });
  return { nickname, email, password: body.password };
}

function validateRoundBody(body, withCode) {
  if (!isObject(body) || typeof body.email !== 'string' || typeof body.registrationId !== 'string') {
    return result(400, 'invalid_input');
  }
  const email = normalizeEmail(body.email);
  if (!validEmail(email) || !/^[0-9a-f]{32}$/.test(body.registrationId)) return result(400, 'invalid_input');
  if (withCode && (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code))) return result(400, 'invalid_input');
  return { email, registrationId: body.registrationId, code: body.code };
}

function quotaDay(timestamp) {
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function secondsToShanghaiMidnight(timestamp) {
  const shifted = timestamp + 8 * 60 * 60 * 1000;
  const day = Math.floor(shifted / 86400000);
  return Math.max(1, Math.ceil(((day + 1) * 86400000 - shifted) / 1000));
}

function secondsUntil(deadline, now) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function maskEmail(email) {
  const at = email.indexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function mapQuotaFailure(gate) {
  const reasons = {
    email_quota: 'email_daily_limit',
    ip_quota: 'ip_daily_limit',
    global_quota: 'global_daily_limit',
  };
  const reason = reasons[gate.reason] || gate.reason;
  const status = reason === 'send_recovering' ? 503 : 429;
  return result(status, reason, {}, gate.retryAfterSec || 2);
}

function createRegistrationService({ db, auth, rateLimit, mail, clock = Date.now, logger = console, cleanupIntervalMs = 60000 }) {
  const locks = new Set();
  let sendsInFlight = 0;
  const config = mail.loadConfig();

  // Exception text may contain SQL values or request secrets. Log only fixed stages.
  function storageError(stage) {
    logger.error('[注册存储失败]', stage);
    return result(503, 'registration_storage_error', {}, 2);
  }

  function cleanup() {
    const at = clock();
    return db.cleanupRegistrationData(at, [...locks]);
  }

  db.recoverRegistrationMailLeases(clock());
  cleanup();
  const cleanupTimer = cleanupIntervalMs > 0 ? setInterval(() => {
    try { cleanup(); } catch { storageError('cleanup'); }
  }, cleanupIntervalMs) : null;
  if (cleanupTimer && cleanupTimer.unref) cleanupTimer.unref();

  function unavailable() {
    if (config.mode !== 'unavailable') return null;
    return result(503, 'mail_unavailable');
  }

  function tryLock(email) {
    if (locks.has(email)) return false;
    locks.add(email);
    return true;
  }

  function release(email) {
    locks.delete(email);
    try { cleanup(); } catch { storageError('cleanup'); }
  }

  function acquireSendSlot() {
    if (sendsInFlight >= 4) return false;
    sendsInFlight++;
    return true;
  }

  function checkCooldown(email, at) {
    const acceptedAt = db.getRegistrationCooldown(email);
    if (acceptedAt == null || at - acceptedAt >= COOLDOWN_MS) return null;
    return result(429, 'cooldown', {}, secondsUntil(acceptedAt + COOLDOWN_MS, at));
  }

  async function freshCode(existing) {
    for (;;) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!existing || !(await auth.verifyPasswordAsync(code, existing.code_hash))) return code;
    }
  }

  async function deliver({ email, sourceIp, candidate, expectedRegistrationId, code }) {
    if (!acquireSendSlot()) return result(503, 'send_busy', {}, 2);
    const reservedAt = clock();
    const attemptId = crypto.randomBytes(16).toString('hex');
    const leaseExpiresAt = reservedAt + LEASE_MS;
    try {
      let gate;
      try {
        gate = db.reserveRegistrationMail({
          id: attemptId,
          email,
          sourceIp,
          reservedAt,
          leaseExpiresAt,
          quotaDay: quotaDay(reservedAt),
          emailLimit: 3,
          ipLimit: 10,
          globalLimit: config.dailyMax,
          retryAfterSec: secondsToShanghaiMidnight(reservedAt),
        });
      } catch (error) {
        return storageError('reserve');
      }
      if (!gate.ok) return mapQuotaFailure(gate);

      let delivery;
      try {
        delivery = await mail.sendVerification({ to: email, code, expiresAt: candidate.expires_at, config, now: clock });
      } catch (error) {
        delivery = { outcome: 'unknown', reason: 'unexpected_error', stage: 'send' };
      }

      if (delivery.outcome === 'accepted') {
        const acceptedAt = delivery.acceptedAt == null ? clock() : delivery.acceptedAt;
        let committed;
        try {
          committed = db.commitRegistrationMail({
            id: attemptId,
            email,
            acceptedAt,
            quotaDay: quotaDay(acceptedAt),
            pending: candidate,
            expectedRegistrationId,
            now: clock(),
          });
        } catch (error) {
          storageError('activate');
          return result(503, 'registration_storage_error', {}, secondsUntil(leaseExpiresAt, clock()));
        }
        if (!committed.ok) {
          if (committed.reason === 'conflict') return result(409, 'conflict', { field: committed.field });
          if (committed.reason === 'registration_stale') return result(409, 'registration_stale');
          return result(410, 'expired');
        }
        const at = clock();
        return result(200, null, {
          registrationId: candidate.registration_id,
          emailMasked: maskEmail(email),
          expiresInSec: secondsUntil(candidate.expires_at, at),
          resendAfterSec: secondsUntil(acceptedAt + COOLDOWN_MS, at),
          ...(config.mode === 'dev' && delivery.devCode ? { devCode: delivery.devCode } : {}),
        });
      }

      const state = delivery.outcome === 'unknown' ? 'unknown' : 'failed';
      logger.error('[注册邮件发送失败]', {
        outcome: state,
        stage: MAIL_STAGES.has(delivery.stage) ? delivery.stage : 'send',
        reason: MAIL_REASONS.has(delivery.reason) || /^smtp_[245][0-9]{2}$/.test(delivery.reason)
          ? delivery.reason : 'smtp_transport_error',
      });
      try { db.finishRegistrationMail(attemptId, state, clock()); }
      catch (error) {
        storageError('finish');
        return result(503, 'registration_storage_error', {}, secondsUntil(leaseExpiresAt, clock()));
      }
      if (state === 'unknown') return result(502, 'mail_status_unknown', {}, secondsUntil(leaseExpiresAt, clock()));
      return result(502, 'mail_failed');
    } finally {
      sendsInFlight--;
    }
  }

  async function register(body, sourceIp) {
    const input = validateRegisterBody(body);
    if (input.status) return input;
    const frequency = rateLimit.allow(`reg:${sourceIp}`, 5, SEND_WINDOW_MS);
    if (!frequency.ok) return result(429, 'rate_limited', {}, frequency.retryAfterSec);
    const mailError = unavailable();
    if (mailError) return mailError;
    if (!tryLock(input.email)) return result(409, 'registration_busy', {}, 2);
    try {
      if (db.getAccountByNickname(input.nickname)) return result(409, 'conflict', { field: 'nickname', error: '昵称已被占用' });
      if (db.getAccountByEmail(input.email)) return result(409, 'conflict', { field: 'email', error: '该邮箱已注册' });
      const at = clock();
      const cooldown = checkCooldown(input.email, at);
      if (cooldown) return cooldown;
      const existing = db.getPendingRegistration(input.email);
      const code = await freshCode(existing);
      const [passwordHash, codeHash] = await Promise.all([
        auth.hashPasswordAsync(input.password),
        auth.hashPasswordAsync(code),
      ]);
      const candidate = {
        email: input.email,
        registration_id: crypto.randomBytes(16).toString('hex'),
        nickname: input.nickname,
        password_hash: passwordHash,
        code_hash: codeHash,
        attempts: 0,
        created_at: at,
        issued_at: at,
        expires_at: at + CODE_TTL_MS,
        flow_expires_at: at + FLOW_TTL_MS,
      };
      return await deliver({ email: input.email, sourceIp, candidate, code });
    } catch {
      return storageError('register');
    } finally {
      release(input.email);
    }
  }

  async function resend(body, sourceIp) {
    const input = validateRoundBody(body, false);
    if (input.status) return input;
    const frequency = rateLimit.allow(`reg:${sourceIp}`, 5, SEND_WINDOW_MS);
    if (!frequency.ok) return result(429, 'rate_limited', {}, frequency.retryAfterSec);
    const mailError = unavailable();
    if (mailError) return mailError;
    if (!tryLock(input.email)) return result(409, 'registration_busy', {}, 2);
    try {
      const pending = db.getPendingRegistration(input.email);
      if (!pending) return result(404, 'pending_missing');
      if (pending.registration_id !== input.registrationId) return result(409, 'registration_stale');
      const at = clock();
      if (at >= pending.expires_at || at >= pending.flow_expires_at) {
        db.deletePendingRegistration(input.email, input.registrationId);
        return result(410, 'expired');
      }
      if (db.getAccountByEmail(input.email)) {
        db.deletePendingRegistration(input.email, input.registrationId);
        return result(409, 'conflict', { field: 'email', error: '该邮箱已注册' });
      }
      const cooldown = checkCooldown(input.email, at);
      if (cooldown) return cooldown;
      const code = await freshCode(pending);
      const codeHash = await auth.hashPasswordAsync(code);
      const candidate = {
        ...pending,
        registration_id: crypto.randomBytes(16).toString('hex'),
        code_hash: codeHash,
        attempts: 0,
        issued_at: at,
        expires_at: Math.min(at + CODE_TTL_MS, pending.flow_expires_at),
      };
      return await deliver({
        email: input.email,
        sourceIp,
        candidate,
        expectedRegistrationId: input.registrationId,
        code,
      });
    } catch {
      return storageError('resend');
    } finally {
      release(input.email);
    }
  }

  async function verify(body, sourceIp) {
    const input = validateRoundBody(body, true);
    if (input.status) return input;
    const frequency = rateLimit.allowAll([
      { key: `verify-email:${input.email}`, max: 10, windowMs: VERIFY_WINDOW_MS },
      { key: `verify-ip:${sourceIp}`, max: 10, windowMs: VERIFY_WINDOW_MS },
    ]);
    if (!frequency.ok) return result(429, 'rate_limited', {}, frequency.retryAfterSec);
    if (!tryLock(input.email)) return result(409, 'registration_busy', {}, 2);
    try {
      const pending = db.getPendingRegistration(input.email);
      if (!pending) return result(404, 'pending_missing');
      if (pending.registration_id !== input.registrationId) return result(409, 'registration_stale');
      const at = clock();
      if (at >= pending.expires_at || at >= pending.flow_expires_at) {
        db.deletePendingRegistration(input.email, input.registrationId);
        return result(410, 'expired');
      }
      const correct = await auth.verifyPasswordAsync(input.code, pending.code_hash);
      if (!correct) {
        const wrong = db.recordIncorrectRegistrationCode({ email: input.email, registrationId: input.registrationId, now: clock() });
        if (wrong.reason === 'missing') return result(404, 'pending_missing');
        if (wrong.reason === 'stale') return result(409, 'registration_stale');
        if (wrong.reason === 'expired') return result(410, 'expired');
        if (wrong.reason === 'exhausted') return result(410, 'exhausted', { remaining: 0 });
        return result(400, 'code_incorrect', { remaining: wrong.remaining });
      }
      let consumed;
      try {
        consumed = db.consumePendingRegistration({ email: input.email, registrationId: input.registrationId, now: clock() });
      } catch (error) {
        return storageError('consume');
      }
      if (!consumed.ok) {
        if (consumed.reason === 'missing') return result(404, 'pending_missing');
        if (consumed.reason === 'stale') return result(409, 'registration_stale');
        if (consumed.reason === 'expired') return result(410, 'expired');
        return result(409, 'conflict', { field: consumed.field, error: consumed.field === 'email' ? '该邮箱已注册' : '昵称已被占用' });
      }
      return {
        ...result(201, null, {
          accountId: consumed.account.id,
          nickname: consumed.account.nickname,
          emailVerified: true,
        }),
        account: {
          id: consumed.account.id,
          nickname: consumed.account.nickname,
          email: consumed.account.email,
          email_verified: consumed.account.email_verified,
          created_at: consumed.account.created_at,
        },
      };
    } catch {
      return storageError('verify');
    } finally {
      release(input.email);
    }
  }

  function close() {
    if (cleanupTimer) clearInterval(cleanupTimer);
  }

  return { register, resend, verify, cleanup, close,
    config: { mode: config.mode, dailyMax: config.dailyMax, ...(config.error ? { error: config.error } : {}) },
    lockedEmails: locks };
}

module.exports = {
  createRegistrationService,
  normalizeEmail,
  validEmail,
  validNickname,
  validateRegisterBody,
  validateRoundBody,
  quotaDay,
  secondsToShanghaiMidnight,
  maskEmail,
};
