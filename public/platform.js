'use strict';
// 平台前端壳（P4 前端插件化）：共享工具 + 登录态 + 通用弹窗 + 选手创建/头像组件 + 游戏插件加载器。
// 游戏前端在 games/<id>/public/{panel.html, app.js}，壳按 GET /api/games 动态注入面板并加载脚本；
// 各游戏脚本与壳共享全局作用域（经典 script），通过 Platform.registerGame 挂接生命周期。
// 新增游戏无需改动本文件与 index.html。
const $ = (id) => document.getElementById(id);
const SMOKE_LABEL = { passed: '已通过', failed: '未通过', pending: '测试中' };
// 单场结果标签 / 结果 chip 配色类（胜/负/平三态，所有游戏通用）
const RES_LABEL = { win: '胜', loss: '负', draw: '平' };
const RES_CLS = { win: 'passed', loss: 'failed', draw: 'pending' };

let ME = null; // { account, hasBot, bot } | null

// ============================================================
// 段位
// ============================================================
const RANK_TIERS = ['青铜', '白银', '黄金', '钻石', '王者'];
function rankLabel(rp) {
  const idx = Math.min(14, Math.floor(Math.max(0, rp || 0) / 100));
  return `${RANK_TIERS[Math.floor(idx / 3)]} ${['III', 'II', 'I'][idx % 3]}`;
}

// ============================================================
// 通用工具
// ============================================================
async function apiFetch(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let json; try { json = await res.json(); } catch { json = { ok: false, error: 'HTTP ' + res.status }; }
  json.__status = res.status;
  return json;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
// 弹窗关闭按钮 / 遮罩点击：在游戏面板注入后统一绑定（覆盖壳与各游戏的弹窗），可重复调用
function bindModalChrome() {
  document.querySelectorAll('[data-close]').forEach((b) => {
    if (b.__bound) return; b.__bound = 1;
    b.addEventListener('click', () => closeModal(b.dataset.close));
  });
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.__bound) return; m.__bound = 1;
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });
}

function popup({ icon = '✉', title, text, actions }) {
  $('popupIcon').textContent = icon; $('popupTitle').textContent = title; $('popupText').textContent = text || '';
  const box = $('popupActions'); box.innerHTML = '';
  (actions || [{ label: '知道了', primary: true }]).forEach((a) => {
    const btn = document.createElement('button'); btn.textContent = a.label; if (a.primary) btn.className = 'primary';
    btn.addEventListener('click', () => { closeModal('popupModal'); a.onClick && a.onClick(); });
    box.appendChild(btn);
  });
  openModal('popupModal');
}

// 复制：clipboard API → textarea+execCommand 降级 → 最后弹窗
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'absolute'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { toast(okMsg); return true; }
  } catch {}
  popup({ icon: '📋', title: '请手动复制', text: text });
  return false;
}

// ============================================================
// 头像（6 款像素预设）
// ============================================================
function presetSvg(n) {
  const s = {
    1: `<rect width="40" height="40" fill="#cdeffb"/><rect x="14" y="14" width="12" height="12" fill="#ffd45e"/><rect x="18" y="6" width="4" height="5" fill="#ffb13b"/><rect x="18" y="29" width="4" height="5" fill="#ffb13b"/><rect x="6" y="18" width="5" height="4" fill="#ffb13b"/><rect x="29" y="18" width="5" height="4" fill="#ffb13b"/>`,
    2: `<rect width="40" height="40" fill="#e7f7ea"/><path d="M6 34 A20 20 0 0 1 34 34 Z" fill="#ff8a73"/><path d="M6 34 A20 20 0 0 1 34 34" fill="none" stroke="#7cc46a" stroke-width="4"/><rect x="15" y="24" width="2" height="2" fill="#2f4858"/><rect x="22" y="22" width="2" height="2" fill="#2f4858"/><rect x="19" y="28" width="2" height="2" fill="#2f4858"/>`,
    3: `<rect width="40" height="40" fill="#d9f0ff"/><path d="M0 26 q6 -8 12 0 t12 0 t12 0 v14 H0 Z" fill="#5bb8e8"/><path d="M0 30 q6 -7 12 0 t12 0 t12 0" fill="none" stroke="#fff" stroke-width="3"/>`,
    4: `<rect width="40" height="40" fill="#fff3da"/><rect x="18" y="18" width="4" height="18" fill="#b07a3c"/><path d="M20 6 q-14 2 -16 12 q12 -4 16 2 q4 -6 16 -2 q-2 -10 -16 -12 Z" fill="#3fb39e"/>`,
    5: `<rect width="40" height="40" fill="#fdeaf1"/><path d="M14 16 h12 l-6 18 Z" fill="#f4c08a"/><circle cx="20" cy="14" r="7" fill="#ff9ec2"/><circle cx="15" cy="14" r="6" fill="#fff0a8"/><circle cx="25" cy="14" r="6" fill="#a8e6c2"/>`,
    6: `<rect width="40" height="40" fill="#eef0f3"/><circle cx="15" cy="22" r="8" fill="#4a5a66"/><circle cx="13" cy="19" r="2.5" fill="#7d8b95"/><rect x="22" y="9" width="5" height="24" rx="2.5" fill="#e0a557" transform="rotate(18 24 21)"/>`,
  }[n] || '';
  return `<svg viewBox="0 0 40 40">${s}</svg>`;
}
function avatarHtml(avatar) {
  // class av-img 让上传头像在任何容器里都铺满并等比裁切（object-fit:cover）——
  // 否则 <img> 会按 256×256 原始尺寸渲染，被小容器的 overflow:hidden 截成左上角。
  if (typeof avatar === 'string' && avatar.startsWith('upload:'))
    return `<img class="av-img" src="/avatars/${esc(avatar.slice(7))}" alt="头像" />`;
  const n = typeof avatar === 'string' && avatar.startsWith('preset:') ? +avatar.slice(7) : 1;
  return presetSvg(n);
}

// ============================================================
// 天梯榜表格（平台通用组件）
// 三款游戏的榜单行结构完全一致，仅「id 字段名 / 空榜文案 / 详情点击去向」不同。
// 各游戏自管 fetch / 加载态 / 错误态（差异在此），拿到 rows 后调本函数渲染 + 绑定：
//   renderLeaderboardRows(tbody, rows, { idField, emptyText, onDetail })
//   - idField：行里 id 字段名（'botId' | 'prisonerId' | 'darkchessId'）
//   - onDetail(id)：点「详情」的去向（自己→详情页，他人→公开页，由调用方判定）
// ============================================================
function renderLeaderboardRows(tbody, rows, { idField, emptyText = '暂无选手', onDetail }) {
  tbody.innerHTML = rows.map((r) => `
    <tr class="rank-${r.rank}">
      <td>${r.rank}</td>
      <td><div class="lb-name"><span style="width:28px;height:28px;border-radius:8px;overflow:hidden;display:inline-block">${avatarHtml(r.avatar)}</span>${esc(r.name)}</div></td>
      <td>${esc(r.nickname)}</td>
      <td><span class="chip rank-chip">${esc(r.rankName)}</span></td>
      <td><b>${r.rp}</b></td>
      <td>${r.wins}胜 / ${r.losses}负 / ${r.draws}平</td>
      <td><button class="mini" data-lb-detail="${r[idField]}">详情</button></td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted-center">${esc(emptyText)}</td></tr>`;
  tbody.querySelectorAll('[data-lb-detail]').forEach((btn) =>
    btn.addEventListener('click', () => onDetail(+btn.dataset.lbDetail)));
}

// ============================================================
// 代码版本列表 + 查看脚本弹窗（平台通用组件）
// 三款游戏的版本列表结构完全一致，仅「版本接口前缀」不同。
//   renderVersionList(container, versions, viewBase)：viewBase 如 '/api/bot/me/version'，
//   点「查看脚本」时 GET `${viewBase}/${version}` 并弹出共享代码弹窗。
// ============================================================
async function viewCodeShared(versionUrl) {
  const r = await apiFetch('GET', versionUrl);
  if (!r.ok) return toast(r.error || '读取失败');
  $('codeTitle').textContent = `脚本 v${r.version.version}`;
  $('codeBody').textContent = r.version.code;
  $('codeCopy').onclick = () => copyText(r.version.code, '已复制');
  openModal('codeModal');
}
function renderVersionList(container, versions, viewBase) {
  if (!versions.length) { container.innerHTML = '<div class="muted-center">还没有版本 —— 复制 Prompt 让 Agent 提交首个脚本。</div>'; return; }
  container.innerHTML = versions.map((v) => `
    <div class="ver-row">
      <div class="grow">
        <b>v${v.version}</b> <span class="chip ${v.smoke_status}">${SMOKE_LABEL[v.smoke_status] || v.smoke_status}</span>
        <div class="vmeta">${esc(v.notes || '（无说明）')} · 提交者 ${esc(v.submitted_by || '—')} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
      <button class="mini" data-ver-view="${v.version}">查看脚本</button>
    </div>`).join('');
  container.querySelectorAll('[data-ver-view]').forEach((b) =>
    b.addEventListener('click', () => viewCodeShared(`${viewBase}/${b.dataset.verView}`)));
}

// ============================================================
// 游戏插件框架
// ============================================================
// 插件形状（games/<id>/public/app.js 里 Platform.registerGame 注册）：
//   { id, init()?, onShow()?, showMine()?, defaultView()?, onAuthChange()? }
let CURRENT_GAME = null;
const Platform = {
  games: [], byId: {},
  registerGame(p) { this.games.push(p); this.byId[p.id] = p; },
  current() { return this.byId[CURRENT_GAME] || null; },
  // 纯 DOM 切换（不触发 onShow）：主导航按钮态 + 二级导航显隐 + 游戏面板显隐。
  // 游戏内部跳转（如 showTab）也会调用它来确保自身可见，故不得在此回调 onShow（防递归）。
  activateGame(gid) {
    if (CURRENT_GAME === gid) return;
    CURRENT_GAME = gid;
    document.querySelectorAll('#gameNav .section').forEach((b) => b.classList.toggle('active', b.dataset.game === gid));
    document.querySelectorAll('#subnavHost > .subnav').forEach((n) => n.classList.toggle('hidden', n.dataset.game !== gid));
    document.querySelectorAll('#gameHost > .section-panel').forEach((p) => p.classList.toggle('active', p.dataset.game === gid));
  },
  // 登出后回到首个游戏的默认视图
  resetToDefault() {
    const first = this.games[0];
    if (!first) return;
    this.activateGame(first.id);
    first.defaultView && first.defaultView();
  },
};
function showGame(gid) {
  Platform.activateGame(gid);
  const p = Platform.byId[gid];
  p && p.onShow && p.onShow();
}

// ============================================================
// 二级 tab 控制器（平台通用组件）
// 各游戏子导航结构一致，仅 DOM 属性名 / 面板 class / 面板 id 前缀 / 各 tab 加载回调 /
// 登录守卫 tab 不同。DOM 属性名仍按游戏区分（IIFE 只隔离 JS，DOM 全站共享须防误伤）。
//   makeTabs(cfg) → { show(name) }，并绑定子导航按钮点击（含登录守卫）。
//   cfg = { gid, attr, panelClass, panelPrefix, onTab: { <tab>: fn }, authTabs: [<tab>] }
//     attr        子导航按钮/面板的 data 属性名（'tab'|'ptab'|'dqtab'），HTML 中为 data-<attr>
//     panelClass  面板容器 class（'tab-panel'|'ptab-panel'|'dqtab-panel'）
//     panelPrefix 面板 id 前缀（配 tab 名拼出面板 id，如 'tab-'+name）
//     onTab       进入某 tab 时的加载回调（如 leaderboard→loadLeaderboard）
//     authTabs    需登录才能进入的 tab（未登录点击 → 弹注册）
// 说明：onTab 的值多为文件后段声明的函数——函数声明会提升，故在此传引用安全。
// ============================================================
function makeTabs({ gid, attr, panelClass, panelPrefix, onTab = {}, authTabs = [] }) {
  function show(name) {
    Platform.activateGame(gid); // 外部跳转（如登录后进「我的」）时确保本游戏面板可见
    document.querySelectorAll(`.tab[data-${attr}]`).forEach((b) => b.classList.toggle('active', b.dataset[attr] === name));
    document.querySelectorAll('.' + panelClass).forEach((p) => p.classList.remove('active'));
    const panel = $(panelPrefix + name); if (panel) panel.classList.add('active');
    if (onTab[name]) onTab[name]();
  }
  document.querySelectorAll(`.tab[data-${attr}]`).forEach((btn) => btn.addEventListener('click', () => {
    const name = btn.dataset[attr];
    if (authTabs.includes(name) && !(ME && ME.account)) { openAuth('register'); return; }
    show(name);
  }));
  return { show };
}

// ============================================================
// 详情页卡片（平台通用组件）
// 三款游戏详情页的「概览卡」「Agent 接入卡」结构一致，仅名词/指南路径/接口前缀不同。
// 字段来自 routes_game.js#playerOverview（三款同名：rank/rp/rankPosition/winRate/
// wins/losses/draws/currentVersion/status）。
// ============================================================
// 概览卡：showStatus=true 用于「我的」详情（含状态行），false 用于公开页（无状态行）。
function overviewCardHtml(p, { showStatus = true } = {}) {
  const empty = p.status === 'empty';
  return `<div class="card">
    <h3>概览</h3>
    <div class="ov-row"><span>段位</span><b>${esc(p.rank)}</b></div>
    <div class="ov-row"><span>段位分</span><b>${p.rp}</b></div>
    <div class="ov-row"><span>当前排名</span><b>#${p.rankPosition || '—'}</b></div>
    <div class="ov-row"><span>胜率</span><b>${p.winRate == null ? '—' : p.winRate + '%'}</b></div>
    <div class="ov-row"><span>战绩</span><b>${p.wins}-${p.losses}-${p.draws}</b></div>
    <div class="ov-row"><span>当前版本</span><b>v${p.currentVersion}${empty ? '（空脚本）' : ''}</b></div>
    ${showStatus ? `<div class="ov-row"><span>状态</span>${empty ? '<span class="chip empty">待提交脚本</span>' : '<span class="chip active">可对战</span>'}</div>` : ''}
  </div>`;
}
// Agent 接入卡：HTML 与绑定分离。按 root 内 data-attr 绑定（非全局 id，防隐藏面板同 id 撞名）。
//   accessCardHtml({ noun, guidePath, maskedKey })
//   bindAccessCard(root, { promptUrl, rotateUrl, onRotated })
function accessCardHtml({ noun, guidePath, maskedKey }) {
  return `<div class="card">
    <h3>Agent 接入</h3>
    <p class="muted" style="margin-top:0">用「Agent 指南 + ${esc(noun)}密钥」让你的 Agent 阅读规则、编写并提交这名${esc(noun)}的脚本。</p>
    <div class="access-row"><span class="lbl">${esc(noun)}密钥</span><span class="val">${esc(maskedKey)}</span></div>
    <div class="access-row"><span class="lbl">Agent 指南</span><span class="val"><a href="${esc(guidePath)}" target="_blank">${esc(guidePath)}</a></span></div>
    <div class="access-actions">
      <button class="primary" data-copy-prompt>📋 一键复制 Agent Prompt</button>
      <button class="secondary" data-rotate-key>轮换密钥</button>
    </div>
  </div>`;
}
function bindAccessCard(root, { promptUrl, rotateUrl, onRotated }) {
  root.querySelector('[data-copy-prompt]')?.addEventListener('click', async () => {
    const p = await apiFetch('GET', promptUrl);
    if (!p.ok) return toast(p.error || '获取失败');
    copyText(p.prompt, '复制成功，粘贴并发送给你的 Agent 即可。');
  });
  root.querySelector('[data-rotate-key]')?.addEventListener('click', () => popup({
    icon: '🔑', title: '轮换密钥？', text: '旧密钥会立即失效，需重新复制 Prompt 给 Agent。',
    actions: [
      { label: '确认轮换', primary: true, onClick: async () => { const r = await apiFetch('POST', rotateUrl); if (r.ok) { toast('密钥已轮换'); onRotated && onRotated(); } else toast(r.error || '失败'); } },
      { label: '取消' },
    ],
  }));
}

// ============================================================
// 登录态
// ============================================================
async function refreshMe() {
  const r = await apiFetch('GET', '/api/me');
  ME = r.ok ? r : null;
  for (const p of Platform.games) p.onAuthChange && p.onAuthChange(); // 各游戏失效自己的登录态缓存
  renderAuthState();
  return ME;
}
function renderAuthState() {
  const el = $('authState');
  if (ME && ME.account) {
    el.innerHTML = `<span class="who">${esc(ME.account.nickname)}</span><button class="mini" id="logoutBtn">登出</button>`;
    $('logoutBtn').addEventListener('click', async () => { await apiFetch('POST', '/api/auth/logout'); await refreshMe(); Platform.resetToDefault(); toast('已登出'); });
  } else {
    el.innerHTML = `<button class="primary mini" id="openRegisterBtn">注册</button><button class="mini" id="openLoginBtn">登录</button>`;
    $('openRegisterBtn').addEventListener('click', () => openAuth('register'));
    $('openLoginBtn').addEventListener('click', () => openAuth('login'));
  }
}

// ============================================================
// 注册 / 登录 弹窗
// ============================================================
function openAuth(mode) {
  $('authRegister').classList.toggle('hidden', mode !== 'register');
  $('authLogin').classList.toggle('hidden', mode === 'register');
  $('authTitle').textContent = mode === 'register' ? '注册账号' : '登录';
  openModal('authModal');
}
$('toLogin').addEventListener('click', () => openAuth('login'));
$('toRegister').addEventListener('click', () => openAuth('register'));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validateRegister() {
  const pw = $('reg-pw').value, pw2 = $('reg-pw2').value;
  const email = $('reg-email').value.trim();
  const errEmail = $('err-email');
  const emailOk = EMAIL_RE.test(email);
  if (email && !emailOk) { errEmail.textContent = '邮箱格式不正确'; errEmail.classList.remove('ok'); }
  else { errEmail.textContent = ''; }
  const errEl = $('err-pw2');
  if (pw2 && pw !== pw2) { errEl.textContent = '两次密码不一致'; errEl.classList.remove('ok'); }
  else if (pw2 && pw === pw2) { errEl.textContent = '密码一致 ✓'; errEl.classList.add('ok'); }
  else { errEl.textContent = ''; }
  const ready = $('reg-nick').value.trim() && emailOk && pw.length >= 8 && pw.length <= 256 && pw === pw2;
  $('regBtn').disabled = !ready;
}
['reg-nick','reg-email','reg-pw','reg-pw2'].forEach((id) => $(id).addEventListener('input', () => { validateRegister(); if (id === 'reg-nick') $('err-nick').textContent = ''; }));

$('regBtn').addEventListener('click', async () => {
  const body = { nickname: $('reg-nick').value.trim(), email: $('reg-email').value.trim(), password: $('reg-pw').value };
  const r = await apiFetch('POST', '/api/account/register', body);
  if (r.ok) {
    closeModal('authModal'); await refreshMe();
    const cur = Platform.current(); cur && cur.showMine && cur.showMine(); // 进当前游戏的「我的」页
    toast('注册成功，来创建你的选手吧');
    // 提示验证邮箱（正式挑战前需完成）；演示环境直接给出验证链接
    if (r.emailVerified === false) showVerifyLink(r.verifyUrl);
    return;
  }
  if (r.field === 'nickname') { $('err-nick').textContent = r.error; return; }
  if (r.field === 'email') {
    popup({ icon: '✉', title: '该邮箱已注册', text: '你可以直接登录，或换一个邮箱注册新账号。', actions: [
      { label: '去登录', primary: true, onClick: () => openAuth('login') },
      { label: '换个邮箱', onClick: () => { openModal('authModal'); $('reg-email').focus(); } },
    ] });
    return;
  }
  $('err-pw2').textContent = r.error || '注册失败'; $('err-pw2').classList.remove('ok');
});

$('loginBtn').addEventListener('click', async () => {
  const body = { email: $('login-email').value.trim(), password: $('login-pw').value };
  const r = await apiFetch('POST', '/api/auth/login', body);
  if (r.ok) {
    closeModal('authModal'); await refreshMe();
    const cur = Platform.current(); cur && cur.showMine && cur.showMine();
    toast('欢迎回来');
    return;
  }
  $('err-login').textContent = r.error || '登录失败';
});

// 演示环境：服务端直接回链接 → 弹窗给出可点击链接；生产环境走真实邮件
function showVerifyLink(verifyUrl) {
  if (verifyUrl) {
    popup({ icon: '✉', title: '验证邮件已发送', text: '演示环境：点击下方链接完成验证。', actions: [
      { label: '打开验证链接', primary: true, onClick: () => window.open(verifyUrl, '_blank') },
      { label: '关闭' },
    ] });
  } else {
    toast('验证邮件已发送，请查收邮箱');
  }
}

// ============================================================
// 邮箱验证横幅（平台通用组件）
// 各游戏「我的」页把 verifyBannerHtml() 拼进自己的 innerHTML 开头，随后调
// bindVerifyBanner(root, refresh) 绑定重发按钮：root = 刚写入的容器（按容器查找，
// 不用全局 id——多个游戏面板可能同时各有一条横幅）；refresh = 该游戏「我的」页的
// 重渲染函数（点重发时若发现邮箱其实已验证，刷新登录态后重画本游戏面板）。
// ============================================================
function verifyBannerHtml() {
  if (!(ME && ME.account) || ME.emailVerified !== false) return '';
  return `<div class="warn-box verify-banner" style="margin-bottom:14px">
    ⚠ 邮箱未验证：发起<b>正式挑战</b>需先验证邮箱（${esc(ME.account.email)}）。
    <button class="mini" data-resend-verify style="margin-left:8px">重新发送验证邮件</button>
  </div>`;
}
function bindVerifyBanner(root, refresh) {
  const btn = root.querySelector('[data-resend-verify]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const r = await apiFetch('POST', '/api/account/resend-verification');
    if (!r.ok) return toast(r.error || '发送失败');
    if (r.emailVerified) { toast('邮箱已验证'); await refreshMe(); refresh && refresh(); return; }
    showVerifyLink(r.verifyUrl);
  });
}

// ============================================================
// 创建选手 / 更换头像（平台通用组件）
// 各游戏传入配置复用同一弹窗：
//   cfg = { noun, createTitle, createLabel, nameLabel, placeholder,
//           urls: { create, nameCheck, preset, upload }, onCreated(r), onAvatarUpdated() }
// 入口：openCreatePlayer(cfg) / openAvatarEditorShared(cfg, currentAvatar)
// ============================================================
let selectedAvatar = 'preset:1';
let pendingUploadDataUrl = null;
let avatarCtx = null; // { mode: 'create' | 'edit', cfg }

function renderAvatarPicker() {
  const box = $('avatarPicker'); box.innerHTML = '';
  for (let n = 1; n <= 6; n++) {
    const tile = document.createElement('div');
    tile.className = 'av-tile' + (selectedAvatar === 'preset:' + n ? ' sel' : '');
    tile.innerHTML = presetSvg(n) + (selectedAvatar === 'preset:' + n ? '<span class="check">✓</span>' : '');
    tile.addEventListener('click', () => onPickPreset(n));
    box.appendChild(tile);
  }
  if (pendingUploadDataUrl) {
    const tile = document.createElement('div');
    tile.className = 'av-tile' + (selectedAvatar === 'upload' ? ' sel' : '');
    tile.style.gridColumn = 'span 2';
    tile.innerHTML = `<img src="${pendingUploadDataUrl}" alt="自定义" />` + (selectedAvatar === 'upload' ? '<span class="check">✓</span>' : '');
    tile.addEventListener('click', () => { selectedAvatar = 'upload'; renderAvatarPicker(); });
    box.appendChild(tile);
  }
  const up = document.createElement('div');
  up.className = 'av-upload'; up.innerHTML = '<span style="font-size:20px">⬆</span><span>上传头像<br>PNG/JPG · 1:1 · ≤100KB</span>';
  up.addEventListener('click', () => $('avatarFile').click());
  box.appendChild(up);
}
async function onPickPreset(n) {
  selectedAvatar = 'preset:' + n; pendingUploadDataUrl = null;
  renderAvatarPicker();
  if (avatarCtx && avatarCtx.mode === 'edit') {
    const r = await apiFetch('POST', avatarCtx.cfg.urls.preset, { preset: n });
    if (!r.ok) return toast(r.error || '更新失败');
    toast('头像已更新');
    closeModal('createBotModal');
    avatarCtx.cfg.onAvatarUpdated && avatarCtx.cfg.onAvatarUpdated();
  }
}

// 选手名实时查重（创建前检查名称是否已被占用）
let nameCheckTimer = null;
$('bot-name').addEventListener('input', () => {
  const errEl = $('err-botname');
  errEl.textContent = ''; errEl.classList.remove('ok');
  clearTimeout(nameCheckTimer);
  const name = $('bot-name').value.trim();
  if (!name || !avatarCtx) return;
  const { urls, noun } = avatarCtx.cfg;
  nameCheckTimer = setTimeout(async () => {
    const r = await apiFetch('GET', urls.nameCheck + '?name=' + encodeURIComponent(name));
    if (name !== $('bot-name').value.trim()) return; // 输入已变化，丢弃过期结果
    if (!r.ok) return;
    if (r.available) { errEl.textContent = '名称可用 ✓'; errEl.classList.add('ok'); }
    else { errEl.textContent = `该名称已被其他${noun}占用，换一个吧`; }
  }, 350);
});

function resetAvatarPickerModal() {
  $('bot-name').value = ''; $('err-botname').textContent = ''; $('err-botname').classList.remove('ok');
  $('bot-name').closest('.field').classList.remove('hidden');
  $('createBotBtn').classList.remove('hidden');
  selectedAvatar = 'preset:1'; pendingUploadDataUrl = null;
}
function openCreatePlayer(cfg) {
  avatarCtx = { mode: 'create', cfg };
  resetAvatarPickerModal();
  $('bot-name').placeholder = cfg.placeholder;
  document.querySelector('#createBotModal h2').textContent = cfg.createTitle;
  document.querySelector('#createBotModal .field label').textContent = cfg.nameLabel;
  $('createBotBtn').textContent = cfg.createLabel;
  renderAvatarPicker(); openModal('createBotModal');
}
function openAvatarEditorShared(cfg, currentAvatar) {
  avatarCtx = { mode: 'edit', cfg };
  pendingUploadDataUrl = null;
  selectedAvatar = (typeof currentAvatar === 'string' && currentAvatar.startsWith('preset:')) ? currentAvatar : 'preset:1';
  $('bot-name').closest('.field').classList.add('hidden');
  $('createBotBtn').classList.add('hidden');
  document.querySelector('#createBotModal h2').textContent = '更换头像';
  renderAvatarPicker(); openModal('createBotModal');
}

$('createBotBtn').addEventListener('click', async () => {
  if (!avatarCtx || avatarCtx.mode !== 'create') return;
  const { cfg } = avatarCtx;
  const name = $('bot-name').value.trim();
  if (!name) { $('err-botname').textContent = `请填写${cfg.noun}名称`; return; }
  // 提交前再查一次占用，避免输入后未触发防抖检查就直接提交
  const chk = await apiFetch('GET', cfg.urls.nameCheck + '?name=' + encodeURIComponent(name));
  if (chk.ok && !chk.available) { $('err-botname').classList.remove('ok'); $('err-botname').textContent = `该名称已被其他${cfg.noun}占用，换一个吧`; return; }
  const presetForCreate = selectedAvatar === 'upload' ? 'preset:1' : selectedAvatar;
  const r = await apiFetch('POST', cfg.urls.create, { name, avatar: presetForCreate });
  if (!r.ok) { $('err-botname').classList.remove('ok'); $('err-botname').textContent = r.error || '创建失败'; return; }
  if (pendingUploadDataUrl) await apiFetch('POST', cfg.urls.upload, { dataUrl: pendingUploadDataUrl });
  closeModal('createBotModal');
  cfg.onCreated && await cfg.onCreated(r);
});

$('avatarFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!['image/png','image/jpeg'].includes(file.type)) { toast('仅支持 PNG / JPG'); return; }
  const reader = new FileReader();
  reader.onload = () => { const img = new Image(); img.onload = () => openCropper(img); img.src = reader.result; };
  reader.readAsDataURL(file);
});

// ---- 方形裁剪器 ----
// 画布 288，其中居中的 240×240 白框才是最终头像区域（白框外仅作预览、导出时裁掉）。
// baseFit=把整张图“放进”白框的缩放（contain）→ 默认 zoom=100% 即完整显示整图；放大可裁掉多余。
// 坐标 x/y 为图片左上角在画布缓冲坐标系中的位置；拖拽按显示/缓冲比例换算，导出用独立离屏画布，
// 均不依赖画布在屏幕上的实际显示尺寸。
const CROP_CANVAS = 288, CROP_FRAME = 240, CROP_MARGIN = (CROP_CANVAS - CROP_FRAME) / 2, CROP_OUT = 256;
const CROP_BG = '#eef7fd'; // 头像底色（不透明），非正方图片留白与页面底色一致
const crop = { img: null, baseFit: 1, zoom: 1, x: 0, y: 0, dragging: false, lx: 0, ly: 0, sx: 1, sy: 1 };
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawCrop() {
  const cv = $('cropCanvas'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, CROP_CANVAS, CROP_CANVAS);
  if (!crop.img) return;
  // 1) 头像底色 + 图片
  ctx.fillStyle = CROP_BG; ctx.fillRect(0, 0, CROP_CANVAS, CROP_CANVAS);
  const s = crop.baseFit * crop.zoom, w = crop.img.width * s, h = crop.img.height * s;
  ctx.drawImage(crop.img, crop.x, crop.y, w, h);
  // 2) 压暗白框外区域（上/下/左/右四条）
  const M = CROP_MARGIN, F = CROP_FRAME;
  ctx.fillStyle = 'rgba(47,72,88,.42)';
  ctx.fillRect(0, 0, CROP_CANVAS, M);
  ctx.fillRect(0, CROP_CANVAS - M, CROP_CANVAS, M);
  ctx.fillRect(0, M, M, F);
  ctx.fillRect(CROP_CANVAS - M, M, M, F);
  // 3) 白框边 + 四角标记
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(M, M, F, F);
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath();
  const t = 18;
  ctx.moveTo(M, M + t); ctx.lineTo(M, M); ctx.lineTo(M + t, M);
  ctx.moveTo(M + F - t, M); ctx.lineTo(M + F, M); ctx.lineTo(M + F, M + t);
  ctx.moveTo(M + F, M + F - t); ctx.lineTo(M + F, M + F); ctx.lineTo(M + F - t, M + F);
  ctx.moveTo(M + t, M + F); ctx.lineTo(M, M + F); ctx.lineTo(M, M + F - t);
  ctx.stroke();
  // 4) 圆角虚线：提示头像最终呈现为圆角方形
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
  roundRectPath(ctx, M + 6, M + 6, F - 12, F - 12, 26); ctx.stroke(); ctx.setLineDash([]);
}
// 夹取图片位置：图片≥框时保证盖满框（可平移不留白）；图片<框时保持整图留在框内（留白居中可微调）
function clampAxis(pos, drawLen, frameStart) {
  const frameEnd = frameStart + CROP_FRAME;
  if (drawLen >= CROP_FRAME) return Math.min(frameStart, Math.max(frameEnd - drawLen, pos));
  return Math.max(frameStart, Math.min(frameEnd - drawLen, pos));
}
function clampCrop() {
  const s = crop.baseFit * crop.zoom, w = crop.img.width * s, h = crop.img.height * s;
  crop.x = clampAxis(crop.x, w, CROP_MARGIN);
  crop.y = clampAxis(crop.y, h, CROP_MARGIN);
}
function openCropper(img) {
  crop.img = img; crop.zoom = 1;
  crop.baseFit = Math.min(CROP_FRAME / img.width, CROP_FRAME / img.height); // contain 进白框
  const w = img.width * crop.baseFit, h = img.height * crop.baseFit;
  crop.x = CROP_MARGIN + (CROP_FRAME - w) / 2; crop.y = CROP_MARGIN + (CROP_FRAME - h) / 2;
  $('cropZoom').value = 100;
  openModal('cropModal'); drawCrop();
}
const cv = $('cropCanvas');
cv.addEventListener('pointerdown', (e) => {
  crop.dragging = true;
  const r = cv.getBoundingClientRect();
  crop.sx = cv.width / r.width; crop.sy = cv.height / r.height; // 显示→缓冲 换算比
  crop.lx = e.clientX; crop.ly = e.clientY;
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', (e) => {
  if (!crop.dragging) return;
  crop.x += (e.clientX - crop.lx) * crop.sx; crop.y += (e.clientY - crop.ly) * crop.sy;
  crop.lx = e.clientX; crop.ly = e.clientY;
  clampCrop(); drawCrop();
});
cv.addEventListener('pointerup', () => { crop.dragging = false; });
cv.addEventListener('pointercancel', () => { crop.dragging = false; });
$('cropZoom').addEventListener('input', (e) => {
  // 以白框中心为锚点缩放，避免图片跳动
  const cx = CROP_MARGIN + CROP_FRAME / 2, cy = cx;
  const sOld = crop.baseFit * crop.zoom;
  const ptX = (cx - crop.x) / sOld, ptY = (cy - crop.y) / sOld;
  crop.zoom = +e.target.value / 100;
  const sNew = crop.baseFit * crop.zoom;
  crop.x = cx - ptX * sNew; crop.y = cy - ptY * sNew;
  clampCrop(); drawCrop();
});
$('cropConfirm').addEventListener('click', async () => {
  // 用独立离屏画布确定性导出白框内容 → 与屏幕显示尺寸无关
  const out = document.createElement('canvas'); out.width = out.height = CROP_OUT;
  const octx = out.getContext('2d');
  octx.fillStyle = CROP_BG; octx.fillRect(0, 0, CROP_OUT, CROP_OUT);
  const k = CROP_OUT / CROP_FRAME, s = crop.baseFit * crop.zoom;
  octx.drawImage(crop.img, (crop.x - CROP_MARGIN) * k, (crop.y - CROP_MARGIN) * k,
    crop.img.width * s * k, crop.img.height * s * k);
  let dataUrl = out.toDataURL('image/png');
  if (dataUrl.length * 0.75 > 100 * 1024) dataUrl = out.toDataURL('image/jpeg', 0.85);
  pendingUploadDataUrl = dataUrl; selectedAvatar = 'upload';
  closeModal('cropModal'); renderAvatarPicker();
  if (avatarCtx && avatarCtx.mode === 'edit') {
    const r = await apiFetch('POST', avatarCtx.cfg.urls.upload, { dataUrl });
    if (!r.ok) return toast(r.error || '更新失败');
    toast('头像已更新');
    closeModal('createBotModal');
    avatarCtx.cfg.onAvatarUpdated && avatarCtx.cfg.onAvatarUpdated();
  }
});

// ============================================================
// 启动：拉游戏清单 → 注入各游戏面板 → 顺序加载脚本 → 初始化
// ============================================================
const loadedScripts = new Set();
function loadScriptOnce(src) {
  if (loadedScripts.has(src)) return Promise.resolve();
  loadedScripts.add(src);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('脚本加载失败: ' + src));
    document.body.appendChild(s);
  });
}
function buildGameNav(games) {
  const nav = $('gameNav'); nav.innerHTML = '';
  for (const g of games) {
    const btn = document.createElement('button');
    btn.className = 'section'; btn.dataset.game = g.id; btn.textContent = g.name;
    btn.addEventListener('click', () => showGame(g.id));
    nav.appendChild(btn);
  }
}
(async function boot() {
  const meta = await apiFetch('GET', '/api/games');
  if (!meta.ok || !meta.games || !meta.games.length) { toast('平台加载失败，请刷新重试'); return; }
  for (const g of meta.games) {
    // 面板片段：subnav → 页头、panel → 主区、overlays → body（弹窗不随面板隐藏）
    const html = await (await fetch(`/games/${g.id}/panel.html`, { credentials: 'same-origin' })).text();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const subnav = tpl.content.querySelector('[data-slot="subnav"]');
    const panel = tpl.content.querySelector('[data-slot="panel"]');
    const overlays = tpl.content.querySelector('[data-slot="overlays"]');
    if (subnav) { subnav.dataset.game = g.id; subnav.classList.add('hidden'); $('subnavHost').appendChild(subnav); }
    if (panel) { panel.dataset.game = g.id; panel.classList.remove('active'); $('gameHost').appendChild(panel); }
    if (overlays) document.body.appendChild(overlays);
    // 面板注入后再按序加载该游戏声明的脚本（共享依赖如 /builtin-bots.js 去重只载一次）
    for (const src of g.scripts) await loadScriptOnce(src);
  }
  bindModalChrome();
  buildGameNav(meta.games);
  await refreshMe();
  for (const g of meta.games) { const p = Platform.byId[g.id]; if (p && p.init) await p.init(); }
  showGame(meta.games[0].id);
})();
