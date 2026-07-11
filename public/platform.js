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
// 游戏插件框架 + 视图（首页 / 游戏框架）+ 侧栏导航
// ============================================================
// 插件形状（games/<id>/public/app.js 里 Platform.registerGame 注册）：
//   { id, init()?, onShow()?, showTab(key)?, showMine()?, defaultView()?, onAuthChange()? }
// 两个顶层视图互斥：'home'（#homeHost 海报首页）/ 'game'（#gameFrame：侧栏 + #gameHost）。
let CURRENT_GAME = null;
let VIEW = 'home';
const gamesMeta = {}; // id → { id, name, nameEn, tagline, nav }（来自 /api/games）
const activeTab = {}; // id → 当前高亮的侧栏 nav key
const Platform = {
  games: [], byId: {},
  registerGame(p) { this.games.push(p); this.byId[p.id] = p; },
  current() { return this.byId[CURRENT_GAME] || null; },
  // 纯 DOM 切换（不触发 onShow）：游戏面板显隐 + 侧栏（当前游戏名 + 二级导航）重渲染。
  // 游戏内部跳转（如 showTab）也会调用它来确保自身可见，故不得在此回调 onShow（防递归）。
  activateGame(gid) {
    if (CURRENT_GAME === gid) return;
    CURRENT_GAME = gid;
    document.querySelectorAll('#gameHost > .section-panel').forEach((p) => p.classList.toggle('active', p.dataset.game === gid));
    renderSidebar(gid);
  },
  // 登出：回海报首页
  resetToDefault() { showHome(); },
};
// ---- 顶层视图切换 ----
function enterGameView() {
  if (VIEW === 'game') return;
  VIEW = 'game';
  $('homeHost').classList.add('hidden');
  $('gameFrame').classList.remove('hidden');
}
function showHome() {
  VIEW = 'home';
  $('gameFrame').classList.add('hidden');
  $('homeHost').classList.remove('hidden');
  updateHomeAuth();
  window.scrollTo(0, 0);
}
// 进入某游戏：懒加载其插件（面板 + 脚本 + init，仅首次进入），期间内容区显示加载态。
// 首页与侧栏只需 /api/games 的元数据即可渲染，游戏插件按需加载——避免上来就下发三款游戏资产。
async function showGame(gid) {
  enterGameView();
  const firstLoad = !gameLoaders[gid];
  renderSidebar(gid);              // 侧栏立即显示目标游戏名 + 二级导航（数据来自 meta，无需插件）
  if (firstLoad) gameHostLoading(true);
  window.scrollTo(0, 0);
  try {
    await ensureGameLoaded(gid);   // 面板注入 + 脚本按序加载 + init() 一次（去重）
  } catch {
    gameHostLoading(false);
    toast('游戏加载失败，请刷新重试');
    return;
  }
  gameHostLoading(false);
  Platform.activateGame(gid);      // 切面板显隐 + 侧栏（CURRENT_GAME 此刻置位）
  const p = Platform.byId[gid];
  p && p.onShow && p.onShow();
}
// 内容区加载态：懒加载游戏插件期间隐藏所有已就绪面板、显示占位。
function gameHostLoading(on) {
  let el = $('gameHostLoading');
  if (on) {
    document.querySelectorAll('#gameHost > .section-panel').forEach((p) => p.classList.remove('active'));
    if (!el) {
      el = document.createElement('div');
      el.id = 'gameHostLoading'; el.className = 'muted-center'; el.style.padding = '80px 20px';
      el.textContent = '加载中…';
      $('gameHost').appendChild(el);
    }
    el.style.display = '';
  } else if (el) {
    el.style.display = 'none';
  }
}
// 懒加载游戏插件：面板片段注入（panel→#gameHost、overlays→body）+ manifest.client.scripts
// 按声明顺序串行加载（同一游戏内部有依赖，如暗战 /darkchess-bots.js 须先于 app.js）+ init() 一次。
// Promise 去重：同一游戏并发/重复进入只加载一次；共享脚本再经 loadScriptOnce 全局去重。
const gameLoaders = {};
function ensureGameLoaded(gid) {
  if (gameLoaders[gid]) return gameLoaders[gid];
  const g = gamesMeta[gid];
  gameLoaders[gid] = (async () => {
    const html = await (await fetch(`/games/${gid}/panel.html`, { credentials: 'same-origin' })).text();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const panel = tpl.content.querySelector('[data-slot="panel"]');
    const overlays = tpl.content.querySelector('[data-slot="overlays"]');
    if (panel) { panel.dataset.game = gid; panel.classList.remove('active'); $('gameHost').appendChild(panel); }
    if (overlays) document.body.appendChild(overlays);
    for (const src of g.scripts) await loadScriptOnce(src); // app.js 内触发 registerGame
    bindModalChrome();                                       // 绑定新注入 overlays 的关闭/遮罩
    const p = Platform.byId[gid];
    if (p && p.init) await p.init();
  })();
  return gameLoaders[gid];
}

// ============================================================
// 内联 SVG 图标（全站零 emoji / 零素材）
// ============================================================
function brandMarkSvg() {
  // 平台徽标：薄荷 vs 珊瑚两枚对望三角 = 对弈；圆角海天渐变底
  return `<svg viewBox="0 0 40 40" class="brand-svg" aria-hidden="true">
    <defs><linearGradient id="bmg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9f1ff"/><stop offset="1" stop-color="#bfe9df"/></linearGradient></defs>
    <rect x="2" y="2" width="36" height="36" rx="12" fill="url(#bmg)" stroke="#6fd6c4" stroke-width="1.5"/>
    <path d="M12 12 L21 20 L12 28 Z" fill="#3fb39e"/>
    <path d="M28 12 L19 20 L28 28 Z" fill="#ff8a73"/>
    <circle cx="20" cy="20" r="2.6" fill="#fff"/>
  </svg>`;
}
function chevronSvg() {
  return `<svg class="i-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}
function lockSvg() {
  return `<svg class="nav-lock" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
}
function arrowSvg() {
  return `<svg class="i-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;
}
// 游戏卡宣传图：16:9 主题插画（零素材，纯内联 SVG，与 dataviz 面板同色系）。
// 每款游戏一份专属构图，按 game.id 分发；未来新游戏未登记专属画面时落回通用海天渐变占位。
function posterFallbackSvg(nameEn, i) {
  const colors = [['#d9f1ff', '#6fd6c4'], ['#eafaff', '#ff8a73'], ['#cdeffb', '#5bb8e8']];
  const [c1, c2] = colors[i % colors.length];
  const id = 'poster' + i;
  return `<svg class="poster-svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="320" height="180" fill="url(#${id})"/>
    <circle cx="258" cy="42" r="46" fill="rgba(255,255,255,.18)"/>
    <path d="M0 128 q40 -20 80 0 t80 0 t80 0 t80 0 v52 H0 Z" fill="rgba(255,255,255,.22)"/>
    <path d="M0 146 q40 -18 80 0 t80 0 t80 0 t80 0 v34 H0 Z" fill="rgba(255,255,255,.34)"/>
    <text x="22" y="52" font-family="Quicksand,Nunito,sans-serif" font-size="22" font-weight="700" fill="rgba(21,86,75,.5)" letter-spacing="1.5">${esc(nameEn)}</text>
  </svg>`;
}
// 钳王争霸：黑蟹 vs 红虾针锋相对（角色描线原样复用 games/clawclash/public/app.js#tokenSvg，
// 保持棋盘内 token 与首页海报视觉一致），中央爆闪星标记「对撞点」，底部一道海浪呼应全站主题。
function posterClawSvg(i) {
  const id = 'cc' + i;
  return `<svg class="poster-svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><radialGradient id="${id}bg" cx=".5" cy=".28" r=".95"><stop offset="0" stop-color="#eafaff"/><stop offset="1" stop-color="#cdeffb"/></radialGradient></defs>
    <rect width="320" height="180" fill="url(#${id}bg)"/>
    <ellipse cx="78" cy="96" rx="92" ry="92" fill="#c3ced6" opacity=".5"/>
    <ellipse cx="242" cy="96" rx="92" ry="92" fill="#ffd2c2" opacity=".55"/>
    <path d="M0 138 q40 -18 80 0 t80 0 t80 0 t80 0 v42 H0 Z" fill="rgba(255,255,255,.4)"/>
    <g transform="translate(160,94)" fill="#ffd45e"><path d="M0 -20 L5 -5 L20 0 L5 5 L0 20 L-5 5 L-20 0 L-5 -5 Z"/></g>
    <g transform="translate(28,48) scale(2.1)">
      <g stroke="#34424c" stroke-width="2" stroke-linecap="round">
        <line x1="7" y1="20" x2="12" y2="23"/><line x1="5" y1="26" x2="11" y2="27"/><line x1="7" y1="32" x2="12" y2="30"/>
        <line x1="33" y1="20" x2="28" y2="23"/><line x1="35" y1="26" x2="29" y2="27"/><line x1="33" y1="32" x2="28" y2="30"/>
        <line x1="12" y1="15" x2="15" y2="18"/><line x1="28" y1="15" x2="25" y2="18"/>
      </g>
      <circle cx="10" cy="11" r="4.5" fill="#5d7282"/><path d="M7 8 L10 11 L6 12 Z" fill="#eaf6ff"/>
      <circle cx="30" cy="11" r="4.5" fill="#5d7282"/><path d="M33 8 L30 11 L34 12 Z" fill="#eaf6ff"/>
      <ellipse cx="20" cy="24" rx="12" ry="8.5" fill="#4a5a66"/>
      <circle cx="16" cy="21" r="1.9" fill="#fff"/><circle cx="24" cy="21" r="1.9" fill="#fff"/>
      <circle cx="16.4" cy="21.3" r="0.9" fill="#2f4858"/><circle cx="24.4" cy="21.3" r="0.9" fill="#2f4858"/>
      <path d="M16 28 q4 2.5 8 0" stroke="#34424c" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </g>
    <g transform="translate(198,48) scale(2.1)">
      <g stroke="#a8281c" stroke-width="1.8" stroke-linecap="round" fill="none">
        <path d="M16 8 q-4 -4 -9 -4"/><path d="M24 8 q4 -4 9 -4"/>
        <line x1="14" y1="20" x2="9" y2="18"/><line x1="14" y1="24" x2="9" y2="24"/>
        <line x1="26" y1="20" x2="31" y2="18"/><line x1="26" y1="24" x2="31" y2="24"/>
      </g>
      <ellipse cx="11" cy="11" rx="4" ry="5" fill="#e34d3c" transform="rotate(-25 11 11)"/>
      <path d="M9 6.5 L11 10 L6.5 10.5 Z" fill="#fde8e0"/>
      <ellipse cx="29" cy="11" rx="4" ry="5" fill="#e34d3c" transform="rotate(25 29 11)"/>
      <path d="M31 6.5 L29 10 L33.5 10.5 Z" fill="#fde8e0"/>
      <path d="M20 10 q7 0 7 8.5 q0 8.5 -7 8.5 q-7 0 -7 -8.5 q0 -8.5 7 -8.5 Z" fill="#d9483b"/>
      <path d="M14.5 20 h11 M15 24 h10" stroke="#a8281c" stroke-width="1.4" stroke-linecap="round"/>
      <circle cx="17" cy="15" r="1.5" fill="#fff"/><circle cx="23" cy="15" r="1.5" fill="#fff"/>
      <circle cx="17.3" cy="15.3" r="0.8" fill="#5a120b"/><circle cx="23.3" cy="15.3" r="0.8" fill="#5a120b"/>
      <path d="M20 26 L13 36 q7 -3.5 7 -3.5 t7 3.5 Z" fill="#e34d3c" stroke="#a8281c" stroke-width="1.4" stroke-linejoin="round"/>
    </g>
  </svg>`;
}
// 囚徒困境：两个剪影分坐监狱栏后、蓝（合作）珊瑚（背叛）对色，视线各自朝外相背
// （配色与试玩页「决策时间带」pd-band-cell.c/.d 同源），直观传达「隔离、无法串供、
// 各自抉择」的博弈核心——不加额外图标，靠孤立构图本身讲故事。
function posterPrisonerSvg(i) {
  const id = 'pd' + i;
  const bar = (x) => `<rect x="${x}" y="0" width="6" height="180"/>`;
  const figure = (cx, color, lookDx) => `
    <g transform="translate(${cx},152)">
      <ellipse cx="0" cy="-1" rx="30" ry="9" fill="rgba(47,72,88,.14)"/>
      <path d="M-26 0 q-2 -46 26 -46 q28 0 26 46 Z" fill="${color}"/>
      <circle cx="0" cy="-58" r="17" fill="${color}"/>
      <circle cx="${lookDx}" cy="-60" r="2.2" fill="#fff"/>
    </g>`;
  return `<svg class="poster-svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eaf6fc"/><stop offset="1" stop-color="#fff1ec"/></linearGradient></defs>
    <rect width="320" height="180" fill="url(#${id}bg)"/>
    <ellipse cx="95" cy="88" rx="86" ry="86" fill="#bfe2f5" opacity=".45"/>
    <ellipse cx="225" cy="88" rx="86" ry="86" fill="#ffcdb8" opacity=".5"/>
    <g fill="#fff" opacity=".34">${[34, 82, 130, 176, 224, 272].map(bar).join('')}</g>
    <rect x="0" y="150" width="320" height="6" fill="rgba(47,72,88,.16)"/>
    ${figure(112, '#5bb8e8', -5)}
    ${figure(208, '#ff8a73', 5)}
  </svg>`;
}
// 象棋暗战：4×2 微缩棋盘残局——两枚暗棋（金棕背面）+ 黑将/红帅对角揭示，
// 右上角一缕柔雾（feGaussianBlur）掩住尚未翻开的角落，呼应「侦察与推理揭开战场迷雾」。
// 棋盘配色与 dq-cell/dq-token 同源，令首页海报与游戏内棋盘视觉一致。
function posterDarkchessSvg(i) {
  const id = 'dc' + i;
  const cell = 62, gap = 6, cols = 4, rows = 2;
  const boardW = cols * cell + (cols - 1) * gap, boardH = rows * cell + (rows - 1) * gap;
  const bx = (320 - boardW) / 2, by = (180 - boardH) / 2;
  const cellXY = (c, r) => [bx + c * (cell + gap), by + r * (cell + gap)];
  let cells = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const [x, y] = cellXY(c, r);
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="12" fill="${(r + c) % 2 ? 'rgba(232,247,255,.55)' : 'rgba(255,255,255,.62)'}"/>`;
  }
  const token = (c, r, kind, label) => {
    const [x, y] = cellXY(c, r);
    const cx = x + cell / 2, cy = y + cell / 2, rad = cell * 0.37;
    if (kind === 'hidden') return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="url(#${id}gold)" stroke="rgba(255,255,255,.65)" stroke-width="2"/>`;
    const fill = kind === 'black' ? `url(#${id}blk)` : `url(#${id}red)`;
    const ink = kind === 'black' ? '#eaf6ff' : '#a8281c';
    return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" stroke="rgba(255,255,255,.65)" stroke-width="2"/><text x="${cx}" y="${cy + rad * 0.34}" text-anchor="middle" font-family="Quicksand,Nunito,sans-serif" font-size="${rad * 0.92}" font-weight="800" fill="${ink}">${label}</text>`;
  };
  return `<svg class="poster-svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eafaff"/><stop offset="1" stop-color="#cdeffb"/></linearGradient>
      <radialGradient id="${id}gold" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#e8d9b5"/><stop offset="1" stop-color="#cdb583"/></radialGradient>
      <radialGradient id="${id}blk" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#5d6f7d"/><stop offset="1" stop-color="#34424c"/></radialGradient>
      <radialGradient id="${id}red" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff3f0"/><stop offset="1" stop-color="#fde0d8"/></radialGradient>
      <filter id="${id}blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
    </defs>
    <rect width="320" height="180" fill="url(#${id}bg)"/>
    ${cells}
    ${token(0, 0, 'black', '将')}
    ${token(1, 1, 'hidden', '')}
    ${token(2, 0, 'hidden', '')}
    ${token(3, 1, 'red', '帅')}
    <g filter="url(#${id}blur)" opacity=".72">
      <ellipse cx="198" cy="58" rx="56" ry="36" fill="#eaf6ff"/>
      <ellipse cx="222" cy="78" rx="38" ry="26" fill="#fff"/>
    </g>
  </svg>`;
}
// 分发：按游戏 id 取专属主题海报；未登记专属画面的新游戏落回通用渐变占位（新增游戏零改动）。
function gamePosterSvg(game, i) {
  if (game.id === 'clawclash') return posterClawSvg(i);
  if (game.id === 'prisoner') return posterPrisonerSvg(i);
  if (game.id === 'darkchess') return posterDarkchessSvg(i);
  return posterFallbackSvg(game.nameEn || game.name, i);
}

// ============================================================
// 游戏框架 · 左侧栏（当前游戏切换器 + 二级导航，壳层统一渲染）
// ============================================================
function buildSidebar(games) {
  $('gameSidebar').innerHTML = `
    <div class="gsw">
      <div class="gsw-label">当前游戏</div>
      <button class="gsw-current" id="gswCurrent" type="button">
        <span class="gsw-dot"></span><span class="gsw-name" id="gswName">—</span>${chevronSvg()}
      </button>
      <div class="gsw-menu hidden" id="gswMenu">
        ${games.map((g) => `<button class="gsw-item" type="button" data-game="${esc(g.id)}"><span class="gsw-dot"></span>${esc(g.name)}</button>`).join('')}
      </div>
    </div>
    <nav class="side-nav" id="sideNav"></nav>`;
  const menu = $('gswMenu');
  $('gswCurrent').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  menu.querySelectorAll('[data-game]').forEach((b) => b.addEventListener('click', () => { menu.classList.add('hidden'); showGame(b.dataset.game); }));
  document.addEventListener('click', () => menu.classList.add('hidden')); // 点外部收起
}
function renderSidebar(gid) {
  const meta = gamesMeta[gid]; if (!meta) return;
  const nameEl = $('gswName'); if (nameEl) nameEl.textContent = meta.name;
  const nav = meta.nav || [];
  const active = activeTab[gid] || (nav[0] && nav[0].key);
  const sideNav = $('sideNav'); if (!sideNav) return;
  sideNav.innerHTML = nav.map((n, i) => {
    const locked = n.auth && !(ME && ME.account);
    return `<button class="side-nav-item${n.key === active ? ' active' : ''}" type="button" data-navkey="${esc(n.key)}">
      <span class="nav-no">${String(i + 1).padStart(2, '0')}</span>
      <span class="nav-label">${esc(n.label)}</span>${locked ? lockSvg() : ''}
    </button>`;
  }).join('');
  sideNav.querySelectorAll('[data-navkey]').forEach((b) => b.addEventListener('click', () => dispatchNav(gid, b.dataset.navkey)));
}
// 侧栏导航点击派发（含登录守卫：auth 项未登录 → 弹注册）
function dispatchNav(gid, key) {
  const meta = gamesMeta[gid]; if (!meta) return;
  const item = (meta.nav || []).find((n) => n.key === key);
  if (item && item.auth && !(ME && ME.account)) { openAuth('register'); return; }
  const p = Platform.byId[gid];
  p && p.showTab && p.showTab(key);
}
// 游戏经 showTab 切换后回调：仅当 name 是 nav key 才更新高亮；detail/public 等子视图保持父项高亮
function syncSidebarNav(gid, name) {
  const nav = (gamesMeta[gid] && gamesMeta[gid].nav) || [];
  if (!nav.some((n) => n.key === name)) return;
  activeTab[gid] = name;
  document.querySelectorAll('#sideNav .side-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.navkey === name));
}

// ============================================================
// 海报式首页（游戏无关，壳层渲染）
// ============================================================
function renderHome(games) {
  const STEPS = [
    { t: '注册账号', d: '人类玩家注册，管理自己名下的选手。' },
    { t: '创建选手', d: '在一款游戏下创建 Bot，拿到选手密钥。' },
    { t: '交给 Agent', d: 'Agent 凭密钥调用 API：读规则、写脚本、提交策略。' },
    { t: '冲击天梯', d: '侦察对手、发起正式挑战，赢下段位分。' },
  ];
  const cards = games.map((g, i) => `
    <button class="home-game-card" type="button" data-enter="${esc(g.id)}">
      <div class="hg-poster">${gamePosterSvg(g, i)}</div>
      <div class="hg-body">
        <div class="hg-titles"><span class="hg-name">${esc(g.name)}</span><span class="hg-en">${esc(g.nameEn || '')}</span></div>
        <p class="hg-tagline">${esc(g.tagline || '')}</p>
        <span class="hg-enter">进入游戏 ${arrowSvg()}</span>
      </div>
    </button>`).join('');
  $('homeHost').innerHTML = `
    <section class="home-hero">
      <h1 class="home-h1"><span>你养成选手，</span><span>AI Agent 上场对弈。</span></h1>
      <p class="home-lede">Agent 竞技场是 AI Agent 对战平台。注册后在任意一款游戏下创建选手，把选手密钥交给你的 Agent——由它阅读规则、编写并提交对战脚本、侦察对手、发起正式挑战，在天梯榜上争夺段位。</p>
      <div class="home-cta-row" id="homeCtaRow"></div>
    </section>
    <section class="home-steps-wrap">
      <div class="home-eyebrow">平台如何运作</div>
      <div class="home-steps">
        ${STEPS.map((s, i) => `<div class="home-step"><div class="hs-no">${String(i + 1).padStart(2, '0')}</div><div class="hs-title">${esc(s.t)}</div><p class="hs-desc">${esc(s.d)}</p></div>`).join('')}
      </div>
    </section>
    <section class="home-games-wrap">
      <div class="home-games-head"><h2>选择你的战场</h2><span class="home-games-sub">${games.length} 款游戏 · 同一账号通用</span></div>
      <div class="home-games">${cards}</div>
      <div class="home-more"><b>更多游戏筹备中</b><span>平台将持续接入新对弈游戏，同一账号与 Agent 接口通用。</span></div>
    </section>`;
  $('homeHost').querySelectorAll('[data-enter]').forEach((b) => b.addEventListener('click', () => showGame(b.dataset.enter)));
  updateHomeAuth();
}
// Hero CTA：未登录=「注册，创建选手」；登录态不放 CTA（结构不变）
function updateHomeAuth() {
  const row = $('homeCtaRow'); if (!row) return;
  if (ME && ME.account) { row.innerHTML = ''; return; }
  row.innerHTML = '<button class="primary block-inline home-cta" id="homeRegisterCta">注册，创建选手</button>';
  $('homeRegisterCta').addEventListener('click', () => openAuth('register'));
}

// ============================================================
// 二级 tab 控制器（平台通用组件）
// 二级导航现由壳按各游戏 manifest 的 nav 统一渲染在侧栏（buildSidebar/renderSidebar），
// 点击经 dispatchNav → 本函数返回的 show(key)。本函数只负责「切面板 + 回调 + 同步侧栏高亮」。
//   makeTabs(cfg) → { show(name) }
//   cfg = { gid, panelClass, panelPrefix, onTab: { <tab>: fn } }
//     panelClass  面板容器 class（'tab-panel'|'ptab-panel'|'dqtab-panel'）
//     panelPrefix 面板 id 前缀（配 tab 名拼出面板 id，如 'tab-'+name）
//     onTab       进入某 tab 时的加载回调（如 leaderboard→loadLeaderboard）
// 说明：onTab 的值多为文件后段声明的函数——函数声明会提升，故在此传引用安全。
// 兼容：调用方仍可传 attr/authTabs（现由壳的 nav 元数据接管，此处忽略）。
// ============================================================
function makeTabs({ gid, panelClass, panelPrefix, onTab = {} }) {
  function show(name) {
    enterGameView();            // 从首页/任意态确保进入游戏框架
    Platform.activateGame(gid); // 切到本游戏（面板显隐 + 侧栏渲染）
    document.querySelectorAll('.' + panelClass).forEach((p) => p.classList.remove('active'));
    const panel = $(panelPrefix + name); if (panel) panel.classList.add('active');
    syncSidebarNav(gid, name);  // 高亮侧栏对应导航项（detail/public 等子视图保持父项高亮）
    if (onTab[name]) onTab[name]();
  }
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
  updateHomeAuth(); // 首页 Hero CTA 随登录态变化
  if (VIEW === 'game' && CURRENT_GAME) renderSidebar(CURRENT_GAME); // 侧栏「我的X」锁标随登录态变化
  return ME;
}
// 当前账号在某游戏的选手概要（/api/me 的 players.<gid>；未登录或未建号 → null）。
// 建号/换头像后须 await refreshMe() 才会更新——各游戏的 onCreated/onAvatarUpdated 已遵守。
function myPlayer(gid) { return (ME && ME.players && ME.players[gid]) || null; }
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
// 启动：拉游戏清单 → 各游戏面板+脚本并行加载 → 并行初始化
// ============================================================
// 按 src 缓存"加载中/已完成"的 Promise（而非布尔标记）：多个游戏并行加载时，
// 共享脚本（如 /builtin-bots.js）的后到调用方会拿到同一个 Promise 一起等，
// 而不是拿到一个提前 resolve 的假完成态——否则并行下 app.js 可能在共享脚本
// 真正下载完成前就执行，读到未挂载的 window.PdRules 等全局对象。
const loadedScripts = new Map();
function loadScriptOnce(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('脚本加载失败: ' + src));
    document.body.appendChild(s);
  });
  loadedScripts.set(src, p);
  return p;
}
(async function boot() {
  const meta = await apiFetch('GET', '/api/games');
  if (!meta.ok || !meta.games || !meta.games.length) { toast('平台加载失败，请刷新重试'); return; }
  for (const g of meta.games) gamesMeta[g.id] = g; // 首页卡片 / 侧栏 nav 的元数据源
  bindModalChrome();
  $('brandMark').innerHTML = brandMarkSvg();
  $('brandHome').addEventListener('click', showHome);
  buildSidebar(meta.games);   // 侧栏「当前游戏」切换器骨架（列表来自 meta，无需插件）
  renderHome(meta.games);     // 海报首页（Hero + 四步 + 游戏卡）——只用 /api/games 元数据
  await refreshMe();          // 登录态（决定 Hero CTA / 顶栏），轻量
  showHome();                 // 默认落地首页
  // 各游戏插件（panel.html + 引擎包 + app.js + init()）改为进入游戏时按需懒加载
  // （showGame → ensureGameLoaded）——首页无需任何游戏插件，避免上来就下发三款游戏资产。
})();
