'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the complete classic browser script. Only the DOM, clock and HTTP boundary
// are replaced; auth handlers, refreshMe, modal cleanup and routing remain real.
function harness(gid = 'darkchess') {
  const nodes = new Map(), timers = new Map(), requests = [], tabs = [];
  let now = 1000000, timerId = 0;
  function node(id, tag = 'div') {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(), listeners = {};
    const el = { id, tagName: tag.toUpperCase(), value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {},
      classList: { add: (...cs) => cs.forEach(c => classes.add(c)), remove: (...cs) => cs.forEach(c => classes.delete(c)), contains: c => classes.has(c), toggle(c, force) { const yes = force === undefined ? !classes.has(c) : force; yes ? classes.add(c) : classes.delete(c); return yes; } },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      async emit(type, props = {}) { await Promise.all((listeners[type] || []).map(fn => fn({ target: el, preventDefault() {}, ...props }))); },
      click() { if (el.tagName === 'BUTTON' && el.disabled) return Promise.resolve(); return el.emit('click'); },
      focus() { if (!el.disabled) document.activeElement = el; }, setAttribute(k, v) { el[k] = String(v); }, removeAttribute(k) { delete el[k]; },
      querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, getContext() { return {}; }
    };
    nodes.set(id, el); return el;
  }
  const html = fs.readFileSync(path.join(__dirname, '../public/fragments/shared_modals.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el = node(m[3], m[1]);
    for (const c of (m[2].match(/class="([^"]*)"/)?.[1] || '').split(/\s+/)) if (c) el.classList.add(c);
    el.disabled = /\bdisabled\b/.test(m[2]);
  }
  const close = node('auth-close', 'button'); close.dataset.close = 'authModal';
  const document = { getElementById: node, createElement: tag => node('generated-' + nodes.size, tag), body: node('body'),
    addEventListener() {}, querySelector() { return null; }, querySelectorAll(selector) { if (selector === '[data-close]') return [close]; if (selector === '.modal-mask') return [node('authModal')]; return []; } };
  const location = { hash: '#leaderboard', href: gid ? '/g/' + gid : '/', replace(href) { this.href = href; } };
  const games = [{ id: 'darkchess', name: '暗棋', nav: [{ key: 'leaderboard' }, { key: 'mine', hash: 'my', auth: true }] }, { id: 'prisoner', name: '囚徒', nav: [{ key: 'mine', auth: true }] }];
  const context = vm.createContext({ document, window: { __PAGE__: { gid, games }, addEventListener() {} }, location,
    history: { replaceState(_a, _b, hash) { location.hash = hash; } }, console,
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); }, setTimeout() { return 1; }, clearTimeout() {},
    fetch(url, opts) { return new Promise((resolve, reject) => requests.push({ url, method: opts.method, body: opts.body && JSON.parse(opts.body), reply(json) { resolve({ status: json.__status || (json.ok ? 200 : 400), json: async () => json }); }, reject })); }, tabs });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/platform.js'), 'utf8'), context);
  vm.runInContext("Platform.registerGame({id:'darkchess', showTab(key) { tabs.push(key); }, onAuthChange() { tabs.authChanges = (tabs.authChanges || 0) + 1; }});", context);
  const run = code => vm.runInContext(code, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { node, run, requests, tabs, location, timers, flush, focused: () => document.activeElement?.id,
    loadGame(game) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../games', game, 'public/app.js'), 'utf8'), context); },
    async reply(json, url = requests.at(-1)?.url) { const req = requests.find(r => !r.done && r.url === url); assert.ok(req, 'pending request: ' + url); req.done = true; req.reply(json); await flush(); },
    tick(ms) { now += ms; for (const fn of timers.values()) fn(); },
    fill() { run("openAuth('register')"); node('reg-nick').value = '棋手甲'; node('reg-email').value = ' Alice@Example.COM '; node('reg-pw').value = node('reg-pw2').value = 'password123'; run('validateRegister()'); },
  };
}
const sent = { ok: true, registrationId: 'a'.repeat(32), emailMasked: 'a***@example.com', expiresInSec: 600, resendAfterSec: 60, devCode: '001234' };
const loggedIn = { ok: true, account: { id: 12, nickname: '棋手甲', emailVerified: true }, players: {} };
async function begin(h) { h.fill(); const p = h.node('regBtn').click(); await h.reply(sent); await p; }
function shown(h, id) { return !h.node(id).classList.contains('hidden'); }

test('initial registration sends protocol and canonical email, clears passwords, fills dev code without verifying', async () => {
  const h = harness(); await begin(h);
  assert.deepEqual(h.requests[0].body, { registrationProtocol: 'email-code-v1', nickname: '棋手甲', email: 'alice@example.com', password: 'password123' });
  assert.equal(h.node('reg-pw').value, ''); assert.equal(h.node('reg-pw2').value, '');
  assert.equal(h.node('reg-code').value, '001234'); assert.ok(shown(h, 'authVerify')); assert.ok(shown(h, 'authModal')); assert.equal(h.requests.length, 1);
});

test('initial mail recovery wait disables retry until the server deadline without blocking login', async () => {
  const h = harness(); h.fill(); const p = h.node('regBtn').click();
  await h.reply({ ok: false, reason: 'mail_status_unknown', error: '发送结果暂未确认', retryAfterSec: 17 }); await p;
  assert.ok(shown(h, 'authRegister')); assert.equal(h.node('regBtn').disabled, true);
  assert.doesNotMatch(h.node('err-pw2').textContent, /旧验证码仍可/);
  h.tick(16000); assert.equal(h.node('regBtn').disabled, true);
  h.tick(1000); assert.equal(h.node('regBtn').disabled, false);
  await h.node('toLogin').click(); assert.ok(shown(h, 'authLogin'));
});

test('auth success without a usable Cookie session cannot navigate into a guarded tab', async () => {
  const h = harness(); h.run("dispatchNav('mine'); openAuth('login')"); const p = h.node('loginBtn').click();
  await h.reply({ ok: true }); await h.reply({ ok: false, __status: 401 }, '/api/me'); await p;
  assert.deepEqual(Array.from(h.tabs), []); assert.match(h.node('toast').textContent, /登录|Cookie/);
});

test('late successful resend after close cannot replace a newly opened registration round', async () => {
  const h = harness(); await begin(h); h.tick(60000); const old = h.node('resendCodeBtn').click();
  await h.node('auth-close').click(); await begin(h);
  await h.reply({ ...sent, registrationId: 'b'.repeat(32), devCode: '999999' }, '/api/account/resend-code'); await old;
  assert.equal(h.node('reg-code').value, '001234'); assert.equal(h.run('registrationState.registrationId'), 'a'.repeat(32)); assert.ok(shown(h, 'authVerify'));
});

test('verification busy prevents resend, switching panels, changing email and duplicate submission', async () => {
  const h = harness(); await begin(h); h.tick(60000); const p = h.node('verifyCodeBtn').click();
  for (const id of ['verifyCodeBtn', 'resendCodeBtn', 'verifyToLogin', 'changeRegEmail']) await h.node(id).click();
  assert.equal(h.requests.length, 2); assert.ok(shown(h, 'authVerify')); assert.equal(h.node('reg-code').disabled, true);
  await h.reply({ ok: false, reason: 'code_incorrect', error: '错误', remaining: 4 }); await p;
});

test('pending_missing without a Cookie returns to data entry and explicitly offers password login', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'pending_missing', error: '注册信息已失效' }); await h.reply({ ok: false }, '/api/me'); await p;
  assert.ok(shown(h, 'authRegister')); assert.equal(h.run('registrationState'), null); assert.match(h.node('err-pw2').textContent, /密码登录/);
});

test('resend pending_missing recovers a shared Cookie session and completes guarded navigation', async () => {
  const h = harness(); h.run("dispatchNav('mine')"); await begin(h); h.tick(60000);
  const p = h.node('resendCodeBtn').click();
  await h.reply({ ok: false, reason: 'pending_missing', error: '注册信息已失效', __status: 404 });
  await h.reply(loggedIn, '/api/me'); await h.reply(loggedIn, '/api/me'); await p;
  assert.equal(shown(h, 'authModal'), false); assert.equal(h.run('ME.account.id'), 12);
  assert.deepEqual(Array.from(h.tabs), ['mine']); assert.equal(h.run('pendingNav'), null);
});

test('resend pending_missing without a Cookie returns to data entry with password login guidance', async () => {
  const h = harness(); await begin(h); h.tick(60000); const p = h.node('resendCodeBtn').click();
  await h.reply({ ok: false, reason: 'pending_missing', error: '注册信息已失效', __status: 404 });
  await h.reply({ ok: false, __status: 401 }, '/api/me'); await p;
  assert.ok(shown(h, 'authRegister')); assert.equal(h.run('registrationState'), null);
  assert.equal(h.node('reg-code').value, ''); assert.match(h.node('err-pw2').textContent, /密码登录/);
});

test('resend pending_missing recovery cannot replace a login panel opened after close', async () => {
  const h = harness(); await begin(h); h.tick(60000); const p = h.node('resendCodeBtn').click();
  await h.reply({ ok: false, reason: 'pending_missing', error: '注册信息已失效', __status: 404 });
  await h.node('auth-close').click(); h.run("openAuth('login')"); h.node('login-pw').value = 'new-secret';
  await h.reply({ ok: false, __status: 401 }, '/api/me'); await p;
  assert.ok(shown(h, 'authLogin')); assert.equal(h.node('login-pw').value, 'new-secret');
  assert.deepEqual(Array.from(h.tabs), []);
});

test('registration success focuses the enabled code input after busy is released', async () => {
  const h = harness(); await begin(h);
  assert.equal(h.node('reg-code').disabled, false); assert.equal(h.focused(), 'reg-code');
});

test('expired verification focuses the enabled password input after returning to data entry', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'expired', error: '请重新填写资料' }); await p;
  assert.equal(h.node('reg-pw').disabled, false); assert.equal(h.focused(), 'reg-pw');
});

test('nickname conflict focuses the enabled conflicting field rather than password', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'conflict', field: 'nickname', error: '昵称已被使用' }); await p;
  assert.equal(h.node('reg-nick').disabled, false); assert.equal(h.focused(), 'reg-nick');
});

test('verify rate limit uses the server retry deadline and still allows switching to password login', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'rate_limited', error: '稍后重试', retryAfterSec: 9 }); await p;
  assert.equal(h.node('verifyCodeBtn').disabled, true); h.tick(9000); assert.equal(h.node('verifyCodeBtn').disabled, false);
  await h.node('verifyToLogin').click(); assert.ok(shown(h, 'authLogin'));
});

for (const action of ['register', 'verify', 'resend']) {
  for (const field of ['nickname', 'email']) {
    test(`${action} conflict marks ${field} and retains guarded navigation intent`, async () => {
      const h = harness(); h.run("dispatchNav('mine')");
      if (action === 'register') h.fill(); else await begin(h);
      if (action === 'resend') h.tick(60000);
      const p = h.node({ register: 'regBtn', verify: 'verifyCodeBtn', resend: 'resendCodeBtn' }[action]).click();
      await h.reply({ ok: false, reason: 'conflict', field, error: '该字段已被注册' }); await p;
      assert.ok(shown(h, field === 'email' ? 'authLogin' : 'authRegister'));
      assert.equal(h.run('pendingNav.key'), 'mine');
      if (field === 'nickname') assert.match(h.node('err-nick').textContent, /注册/);
      else { assert.equal(h.node('login-email').value, 'alice@example.com'); assert.match(h.node('err-login').textContent, /登录/); }
    });
  }
}

test('mail unavailable explains password login availability', async () => {
  const h = harness(); h.fill(); const p = h.node('regBtn').click();
  await h.reply({ ok: false, reason: 'mail_unavailable', error: '注册邮件服务暂不可用' }); await p;
  assert.match(h.node('err-pw2').textContent, /登录/); assert.ok(shown(h, 'authRegister'));
});

for (const reason of ['expired', 'exhausted', 'registration_stale']) {
  test(`${reason} discards round and secrets while retaining nickname and email`, async () => {
    const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
    await h.reply({ ok: false, reason, error: '注册信息已失效，请重新填写资料' }); await p;
    assert.ok(shown(h, 'authRegister')); assert.equal(h.node('reg-nick').value, '棋手甲'); assert.match(h.node('reg-email').value, /Alice/);
    assert.equal(h.run('registrationState'), null); assert.equal(h.node('reg-code').value, ''); assert.equal(h.node('reg-pw').value, ''); assert.equal(h.timers.size, 0);
  });
}

test('wrong code displays remaining attempts; non-ASCII digits cannot submit and Enter submits once', async () => {
  const h = harness(); await begin(h); h.node('reg-code').value = '１２３４５６'; await h.node('reg-code').emit('input');
  await h.node('reg-code').emit('keydown', { key: 'Enter' }); assert.equal(h.requests.length, 1);
  h.node('reg-code').value = '000001'; await h.node('reg-code').emit('input');
  await h.node('reg-code').emit('keydown', { key: 'Enter' }); await h.node('reg-code').emit('keydown', { key: 'Enter' });
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].body.code, '000001');
  await h.reply({ ok: false, reason: 'code_incorrect', error: '验证码错误', remaining: 3 });
  assert.ok(shown(h, 'authVerify')); assert.match(h.node('err-code').textContent, /3/);
});

for (const reason of ['mail_failed', 'mail_unavailable']) {
  test(`resend ${reason} preserves usable old code`, async () => {
    const h = harness(); await begin(h); h.tick(60000); const p = h.node('resendCodeBtn').click();
    await h.reply({ ok: false, reason, error: '发信失败' }); await p;
    assert.ok(shown(h, 'authVerify')); assert.equal(h.node('reg-code').value, '001234'); assert.equal(h.run('registrationState.registrationId'), 'a'.repeat(32)); assert.equal(h.node('verifyCodeBtn').disabled, false);
  });
}

test('lost verification response recovers an already committed Cookie session and guarded destination', async () => {
  const h = harness(); h.run("dispatchNav('mine')"); await begin(h); const p = h.node('verifyCodeBtn').click();
  h.requests.at(-1).reject(new Error('response lost')); await h.flush();
  await h.reply(loggedIn, '/api/me'); await h.reply(loggedIn, '/api/me'); await p;
  assert.equal(shown(h, 'authModal'), false); assert.deepEqual(Array.from(h.tabs), ['mine']); assert.equal(h.location.hash, '#my');
});

test('late login success refreshes Cookie state but cannot consume a new guard intent', async () => {
  const h = harness(); h.run("openAuth('login')"); const p = h.node('loginBtn').click();
  await h.node('auth-close').click(); h.run("dispatchNav('mine')"); await h.reply({ ok: true }); await h.reply(loggedIn, '/api/me'); await p;
  assert.ok(shown(h, 'authRegister')); assert.equal(h.run('pendingNav.key'), 'mine'); assert.deepEqual(Array.from(h.tabs), []); assert.equal(h.run('ME.account.id'), 12);
});

test('hash guard and subsequent close never leak the guarded destination into ordinary login', async () => {
  const h = harness(); h.location.hash = '#my'; h.run('routeFromHash(false)'); assert.equal(h.run('pendingNav.key'), 'mine');
  await h.node('auth-close').click(); h.run("openAuth('login')"); const p = h.node('loginBtn').click();
  await h.reply({ ok: true }); await h.reply(loggedIn, '/api/me'); await p; assert.deepEqual(Array.from(h.tabs), []);
});

test('ordinary home registration success refreshes auth and keeps the home URL', async () => {
  const h = harness(null); await h.reply({ ok: false }, '/api/me'); await h.node('homeRegisterCta').click(); await begin(h);
  const p = h.node('verifyCodeBtn').click(); await h.reply({ ok: true }); await h.reply(loggedIn, '/api/me'); await p;
  assert.equal(h.location.href, '/'); assert.equal(h.node('homeCtaRow').innerHTML, ''); assert.deepEqual(Array.from(h.tabs), []);
});

for (const [game, url, bodyId] of [['clawclash', '/api/bot/me', 'mybotBody'], ['darkchess', '/api/games/darkchess/me', 'dqMybotBody'], ['prisoner', '/api/prisoner/me', 'pmybotBody']]) {
  test(`${game} mine page renders the create-player state with obsolete email status false`, async () => {
    const h = harness(game); h.loadGame(game); h.run("ME = {account: {id:12, nickname:'棋手甲'}, emailVerified:false}; Platform.current().showMine()");
    if (game === 'prisoner') await h.reply({ ok: true, rounds: 10 }, '/api/prisoner/meta');
    await h.reply({ ok: false, __status: 404 }, url);
    assert.match(h.node(bodyId).innerHTML, /创建/); assert.doesNotMatch(h.node(bodyId).innerHTML, /邮箱未验证/);
  });
}

test('register busy locks inputs and competing panel actions; input events cannot reenable duplicate requests', async () => {
  const h = harness(); h.fill(); const p = h.node('regBtn').click();
  assert.equal(h.node('reg-email').disabled, true);
  await h.node('reg-pw').emit('input'); await h.node('regBtn').click();
  await h.node('toLogin').click(); assert.ok(shown(h, 'authRegister')); assert.equal(h.requests.length, 1);
  await h.reply(sent); await p;
});

test('close through overlay clears every credential, registration round, timers and guarded intent', async () => {
  const h = harness(); h.run("dispatchNav('mine')"); await begin(h); h.node('login-pw').value = 'another-secret';
  await h.node('authModal').emit('click');
  for (const id of ['reg-pw', 'reg-pw2', 'reg-code', 'login-pw']) assert.equal(h.node(id).value, '');
  assert.equal(h.run('registrationState'), null); assert.equal(h.run('pendingNav'), null); assert.equal(h.timers.size, 0); assert.equal(h.run('verificationBusy'), false);
});

test('closing and reopening registration clears stale password validation feedback', async () => {
  const h = harness(); h.fill();
  assert.match(h.node('err-pw2').textContent, /密码一致/);
  await h.node('auth-close').click(); h.run("openAuth('register')");
  assert.equal(h.node('reg-pw').value, ''); assert.equal(h.node('reg-pw2').value, '');
  assert.equal(h.node('err-pw2').textContent, ''); assert.equal(h.node('err-pw2').classList.contains('ok'), false);
  assert.equal(h.node('regBtn').disabled, true);
});

test('late register after panel switch never revives verification', async () => {
  const h = harness(); h.fill(); const p = h.node('regBtn').click(); h.run("openAuth('login')");
  await h.reply(sent); await p;
  assert.ok(shown(h, 'authLogin')); assert.equal(h.run('registrationState'), null);
});

test('late operation finally cannot unlock a newer verification request', async () => {
  const h = harness(); await begin(h); const old = h.node('verifyCodeBtn').click();
  await h.node('auth-close').click(); await begin(h); const current = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'code_incorrect', error: '错误', remaining: 4 }, '/api/account/verify-code'); await old;
  assert.equal(h.node('verifyCodeBtn').disabled, true); assert.equal(h.run('verificationBusy'), true);
  await h.reply({ ok: false, reason: 'code_incorrect', error: '错误', remaining: 4 }, '/api/account/verify-code'); await current;
});

test('absolute countdown survives background pause and resend rotates the round without automatic verification', async () => {
  const h = harness(); await begin(h); h.tick(61500);
  assert.match(h.node('codeExpiryText').textContent, /8:59/); assert.equal(h.node('resendCodeBtn').disabled, false);
  const p = h.node('resendCodeBtn').click(); await h.reply({ ...sent, registrationId: 'b'.repeat(32), emailMasked: 'b***@example.com', expiresInSec: 90, resendAfterSec: 12, devCode: undefined }); await p;
  assert.equal(h.node('reg-code').value, ''); assert.equal(h.node('verifyEmailMasked').textContent, 'b***@example.com'); assert.match(h.node('codeExpiryText').textContent, /1:30/);
  assert.equal(h.run('registrationState.registrationId'), 'b'.repeat(32)); assert.equal(h.requests.length, 2);
});

test('unknown resend preserves old code and round while applying recovery wait', async () => {
  const h = harness(); await begin(h); h.tick(60000); const p = h.node('resendCodeBtn').click();
  await h.reply({ ok: false, reason: 'mail_status_unknown', error: '发送结果暂未确认', retryAfterSec: 17 }); await p;
  assert.equal(h.node('reg-code').value, '001234'); assert.equal(h.run('registrationState.registrationId'), 'a'.repeat(32));
  assert.match(h.node('resendWaitText').textContent, /17/); assert.equal(h.node('resendCodeBtn').disabled, true); assert.equal(h.node('verifyCodeBtn').disabled, false);
});

test('lost resend response does not promise that the old round is still valid', async () => {
  const h = harness(); await begin(h); h.tick(60000); const p = h.node('resendCodeBtn').click();
  h.requests.at(-1).reject(new Error('response lost')); await p;
  assert.match(h.node('err-code').textContent, /可尝试旧验证码/);
  assert.doesNotMatch(h.node('err-code').textContent, /仍可继续使用/);
});

test('pending_missing recovery cannot replace a panel opened after close', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: false, reason: 'pending_missing', error: '重新填写资料' });
  await h.node('auth-close').click(); h.run("openAuth('login')"); h.node('login-pw').value = 'new-password';
  await h.reply({ ok: false }, '/api/me'); await p;
  assert.ok(shown(h, 'authLogin')); assert.equal(h.node('login-pw').value, 'new-password');
});

test('failed /api/me recovery is handled and guides password login', async () => {
  const h = harness(); await begin(h); const p = h.node('verifyCodeBtn').click();
  h.requests.at(-1).reject(new Error('lost verify')); await h.flush();
  h.requests.at(-1).reject(new Error('offline')); await p;
  assert.match(h.node('err-code').textContent, /密码登录/);
});

test('opening a new modal while auth refresh is pending cancels old navigation', async () => {
  const h = harness(); h.run("dispatchNav('mine')"); await begin(h); const p = h.node('verifyCodeBtn').click();
  await h.reply({ ok: true }); h.run("openAuth('login')"); await h.reply(loggedIn, '/api/me'); await p;
  assert.deepEqual(Array.from(h.tabs), []); assert.ok(shown(h, 'authLogin')); assert.equal(h.location.hash, '#leaderboard');
});

test('guarded login consumes intent across panel switches and ordinary login stays on current tab', async () => {
  for (const guard of [false, true]) {
    const h = harness(); if (guard) h.run("dispatchNav('mine')"); else h.run("openAuth('register')");
    await h.node('toLogin').click(); const p = h.node('loginBtn').click(); await h.reply({ ok: true }); await h.reply(loggedIn, '/api/me'); await p;
    assert.equal(shown(h, 'authModal'), false); assert.deepEqual(Array.from(h.tabs), guard ? ['mine'] : []); assert.equal(h.run('pendingNav'), null); assert.equal(h.tabs.authChanges, 1);
  }
});
