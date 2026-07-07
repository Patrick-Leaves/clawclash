'use strict';
// 象棋暗战 · 前端插件（P4 前端插件化）
// 面板标记在同目录 panel.html，由平台壳（/platform.js）注入 DOM 后再加载本文件。
// 与壳共享全局作用域：直接使用 $ / apiFetch / esc / toast / avatarHtml / openModal / popup /
// copyText / ME / Platform / openCreatePlayer / openAvatarEditorShared / openAuth 等壳工具。
// 命名空间隔离：本文件专属的 document 级查询属性一律加 dq 前缀（data-dqtab / .dqtab-panel /
// data-dqplaymode），避免与 clawclash 的同类未加限定的 document 级选择器互相误伤。
const DQ_W = 8, DQ_H = 4;
const DQ_LABELS = {
  black: { general: '将', advisor: '士', elephant: '象', chariot: '車', horse: '馬', cannon: '炮', soldier: '卒' },
  red: { general: '帅', advisor: '仕', elephant: '相', chariot: '車', horse: '馬', cannon: '炮', soldier: '兵' },
};
const DQ_REASON_LABEL = {
  eliminated: '吃光判负', noCapture: '40 回合无吃子 · 价值裁定', stalemate: '双方停一手 · 价值裁定',
  draw: '平局', illegal: '非法动作判负', runtime: '超时/异常判负', error: '运行异常判负',
};
const DQ_RES_LABEL = { win: '胜', loss: '负', draw: '平' };
const DQ_RES_CLS = { win: 'passed', loss: 'failed', draw: 'pending' };

// ============================================================
// 二级导航：试玩 / 天梯榜 / 我的棋手 / Agent 指南（含登录守卫）
// ============================================================
function showDqTab(name) {
  Platform.activateGame('darkchess');
  document.querySelectorAll('.tab[data-dqtab]').forEach((b) => b.classList.toggle('active', b.dataset.dqtab === name));
  document.querySelectorAll('.dqtab-panel').forEach((p) => p.classList.remove('active'));
  const panel = $('dqtab-' + name); if (panel) panel.classList.add('active');
  if (name === 'dqleaderboard') loadDqLeaderboard();
  if (name === 'dqmybot') renderMyDarkchess();
}
document.querySelectorAll('.tab[data-dqtab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.dqtab;
    if (name === 'dqmybot' && !(ME && ME.account)) { openAuth('register'); return; }
    showDqTab(name);
  });
});
document.querySelectorAll('[data-dqplaymode]').forEach((btn) => btn.addEventListener('click', () => {
  const m = btn.dataset.dqplaymode;
  document.querySelectorAll('[data-dqplaymode]').forEach((x) => x.classList.toggle('active', x.dataset.dqplaymode === m));
  $('dqPlayControls').classList.toggle('hidden', m !== 'ai');
  $('dqLocalControls').classList.toggle('hidden', m !== 'local');
}));
$('dqRulesHint').addEventListener('click', () => {
  const hidden = $('dqRulesPanel').classList.toggle('hidden');
  $('dqRulesHint').textContent = hidden ? '规则速览 ▾' : '规则速览 ▴';
});

// ============================================================
// 玩法教程（多步骤弹窗）
// ============================================================
function dqTutToken(label, cls) { return `<span class="dq-tut-token ${cls || ''}">${esc(label)}</span>`; }
function dqTutCannonDemoHtml() {
  return `<div class="dq-tut-row">
    ${dqTutToken('炮', 'dq-black')}
    <span class="dq-tut-arrow">→</span>
    <span class="dq-tut-gap">空</span>
    <span class="dq-tut-arrow">→</span>
    ${dqTutToken('架', 'dq-hidden')}
    <span class="dq-tut-arrow">→</span>
    <span class="dq-tut-gap">空</span>
    <span class="dq-tut-arrow">→</span>
    ${dqTutToken('帅', 'dq-red')}
  </div>
  <p class="tut-p" style="margin-top:10px">同行/同列、中间<b>恰好隔一子</b>（不管明暗），炮就能吃掉最远端那颗棋子——不管它是明是暗、等级多高，连对方的帅/将都能吃。隔子数量不对（0 子或 2 子及以上）都不能吃。</p>`;
}
const DQ_TUT_STEPS = [
  { title: '棋盘与目标', body: `<p class="tut-p"><b>4×8 棋盘</b>共 32 格，中国象棋<b>全套棋子</b>（黑红各 16 颗）背面朝上随机摆满，翻开前谁也不知道每格是什么——包括你自己的棋子。<br><br><b>目标：</b>把对方棋子吃光；或在僵局/长期无吃子被裁定时，剩余棋子<b>价值总和</b>领先。</p>` },
  { title: '翻棋定序', body: `<p class="tut-p">开局谁执黑、谁执红尚未确定：双方按顺序<b>各翻开一格</b>。<br><br>· 两人翻到<b>不同颜色</b> → 谁翻到什么颜色就控制该颜色，整局固定不变<br>· 翻到<b>相同颜色</b> → 颜色仍未定，继续翻下一轮<br><br>归属确定前，每回合只能翻棋，不能移动棋子。</p>` },
  { title: '移动与吃子', body: `<p class="tut-p">所有棋子都只能沿<b>横竖方向走一格</b>，不能斜走、不能越子（炮的隔子吃是唯一例外，见下一步）。<br><br>移动到对方<b>已翻开</b>的棋子＝吃子，按等级<b>大吃小</b>：将/帅 &gt; 士/仕 &gt; 象/相 &gt; 車 &gt; 馬 &gt; 炮 &gt; 卒/兵。<br><br><b>等级相同 → 同归于尽</b>（双方棋子都移出棋盘，哪怕是两个"帅"相遇）。<br><b>特例：</b>卒/兵可以吃帅/将；但反过来<b>帅/将不能吃卒/兵</b>。</p>` },
  { title: '炮的隔子吃', body: null },
  { title: '终局判定', body: `<p class="tut-p"><b>吃光判负：</b>一方棋子被吃完，另一方获胜。<br><b>僵局裁定：</b>双方连续停一手（都无棋可走）→ 按子力价值总和判定，价值相等才判和。<br><b>无吃子裁定：</b>连续 40 回合没有任何吃子 → 同样按价值总和判定。<br><br><b>子力价值：</b>将/帅 7　士/仕 6　象/相 5　車 4　馬 3　炮 2　卒/兵 1</p>` },
];
let dqTutCur = 0;
function dqTutRenderStep() {
  $('dqTutBody').innerHTML = dqTutCur === 3 ? dqTutCannonDemoHtml() : `<div class="tut-card">${DQ_TUT_STEPS[dqTutCur].body}</div>`;
  document.querySelectorAll('#dqTutSteps .tut-chip').forEach((c, i) => c.classList.toggle('on', i === dqTutCur));
  $('dqTutDots').textContent = (dqTutCur + 1) + ' / ' + DQ_TUT_STEPS.length;
  $('dqTutPrev').style.visibility = dqTutCur === 0 ? 'hidden' : 'visible';
  $('dqTutNext').textContent = dqTutCur === DQ_TUT_STEPS.length - 1 ? '开始试玩 ✓' : '下一步 →';
}
$('dqTutSteps').innerHTML = DQ_TUT_STEPS.map((s, i) => `<button class="tut-chip" data-i="${i}">${['①', '②', '③', '④', '⑤'][i]} ${esc(s.title)}</button>`).join('');
document.querySelectorAll('#dqTutSteps .tut-chip').forEach((c) => c.addEventListener('click', () => { dqTutCur = +c.dataset.i; dqTutRenderStep(); }));
$('dqTutPrev').addEventListener('click', () => { if (dqTutCur > 0) { dqTutCur--; dqTutRenderStep(); } });
$('dqTutNext').addEventListener('click', () => { if (dqTutCur < DQ_TUT_STEPS.length - 1) { dqTutCur++; dqTutRenderStep(); } else closeModal('dqTutorialModal'); });
$('dqTutorialBtn').addEventListener('click', () => { dqTutCur = 0; openModal('dqTutorialModal'); dqTutRenderStep(); });

// ============================================================
// 创建棋手 / 更换头像：复用壳的通用选手创建组件
// ============================================================
const DQ_PLAYER_CFG = {
  noun: '棋手', createTitle: '创建棋手', createLabel: '创建棋手', nameLabel: '棋手名称', placeholder: '例如：夜袭',
  urls: {
    create: '/api/games/darkchess/create', nameCheck: '/api/games/darkchess/name-check',
    preset: '/api/games/darkchess/me/avatar/preset', upload: '/api/games/darkchess/me/avatar',
  },
  onCreated(r) { MY_DARKCHESS_ID = r.darkchessId; toast('棋手已创建'); showDqDetail(); },
  onAvatarUpdated() { showDqDetail(); },
};
function openCreateDarkchess() { openCreatePlayer(DQ_PLAYER_CFG); }
function openDarkchessAvatarEditor(currentAvatar) { openAvatarEditorShared(DQ_PLAYER_CFG, currentAvatar); }

// 我的棋手 id 缓存：undefined=未知（需拉取），null=无棋手，number=有。登录态变化时失效。
let MY_DARKCHESS_ID;
async function ensureMyDarkchessId() {
  if (MY_DARKCHESS_ID !== undefined) return MY_DARKCHESS_ID;
  if (!ME || !ME.account) { MY_DARKCHESS_ID = null; return null; }
  const r = await apiFetch('GET', '/api/games/darkchess/me');
  MY_DARKCHESS_ID = (r.ok && r.darkchess) ? r.darkchess.id : null;
  return MY_DARKCHESS_ID;
}

function verifyBannerHtml() {
  if (!(ME && ME.account) || ME.emailVerified !== false) return '';
  return `<div class="warn-box verify-banner" style="margin-bottom:14px">
    ⚠ 邮箱未验证：发起<b>正式挑战</b>需先验证邮箱（${esc(ME.account.email)}）。
    <button class="mini" id="dqResendVerifyBtn" style="margin-left:8px">重新发送验证邮件</button>
  </div>`;
}
function bindVerifyBanner() {
  const btn = $('dqResendVerifyBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const r = await apiFetch('POST', '/api/account/resend-verification');
    if (!r.ok) return toast(r.error || '发送失败');
    if (r.emailVerified) { toast('邮箱已验证'); await refreshMe(); renderMyDarkchess(); return; }
    showVerifyLink(r.verifyUrl);
  });
}

async function renderMyDarkchess() {
  const box = $('dqMybotBody');
  if (!(ME && ME.account)) { box.innerHTML = '<div class="empty-hero"><h2>请先登录</h2><p>登录后即可创建并管理你的棋手。</p></div>'; return; }
  box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/games/darkchess/me');
  if (r.__status === 404) {
    MY_DARKCHESS_ID = null;
    box.innerHTML = verifyBannerHtml() + `<div class="empty-hero"><h2>你还没有棋手</h2><p>创建一名棋手，拿到它的棋手密钥，交给你的 Agent 来编写策略。</p><button class="primary" id="dqCreateOpen">创建棋手 →</button></div>`;
    bindVerifyBanner();
    $('dqCreateOpen').addEventListener('click', openCreateDarkchess);
    return;
  }
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const b = r.darkchess;
  MY_DARKCHESS_ID = b.id;
  const empty = b.status === 'empty';
  box.innerHTML = verifyBannerHtml() + `
    <div class="bot-card">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div class="grow">
        <h2>${esc(b.name)} ${empty ? '<span class="chip empty">空脚本</span>' : '<span class="chip active">可对战</span>'} <span class="chip ver">v${b.currentVersion}</span></h2>
        <div class="stat-row"><span>${esc(b.rank)} · 段位分 ${b.rp || 0} · 天梯排名 ${b.rankPosition ? '#' + b.rankPosition : '—'}</span></div>
        ${empty ? '<div class="warn-box" style="margin-top:10px">脚本为空，棋手尚不能对战 —— 进入详情，复制 Prompt 交给 Agent 提交首个版本。</div>' : ''}
      </div>
      <div class="actions"><button class="primary" id="dqGoDetail">详情</button></div>
    </div>`;
  bindVerifyBanner();
  $('dqGoDetail').addEventListener('click', () => showDqDetail());
}

// ============================================================
// 棋手详情（自己）
// ============================================================
async function showDqDetail() {
  showDqTab('dqdetail');
  const box = $('dqDetailBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/games/darkchess/me');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const b = r.darkchess;
  const empty = b.status === 'empty';
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div><h2>${esc(b.name)}</h2><div class="muted">当前工作版本：v${b.currentVersion}${empty ? '（空脚本）' : ''}</div></div>
      <div style="margin-left:auto"><button class="mini" id="dqEditAvatarBtn">更换头像</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(b.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${b.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${b.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${b.winRate == null ? '—' : b.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${b.wins}-${b.losses}-${b.draws}</b></div>
        <div class="ov-row"><span>当前版本</span><b>v${b.currentVersion}</b></div>
        <div class="ov-row"><span>状态</span>${empty ? '<span class="chip empty">待提交脚本</span>' : '<span class="chip active">可对战</span>'}</div>
      </div>
      <div class="card">
        <h3>Agent 接入</h3>
        <p class="muted" style="margin-top:0">用「Agent 指南 + 棋手密钥」让你的 Agent 阅读规则、编写并提交这名棋手的脚本。</p>
        <div class="access-row"><span class="lbl">棋手密钥</span><span class="val">${esc(b.maskedKey)}</span></div>
        <div class="access-row"><span class="lbl">Agent 指南</span><span class="val"><a href="/agent-guide-darkchess" target="_blank">/agent-guide-darkchess</a></span></div>
        <div class="access-actions">
          <button class="primary" id="dqCopyPromptBtn">📋 一键复制 Agent Prompt</button>
          <button class="secondary" id="dqRotateKeyBtn">轮换密钥</button>
        </div>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab active" data-dqsub="versions">版本</button>
      <button class="subtab" data-dqsub="matches">对战记录</button>
    </div>
    <div id="dqSubBody"></div>`;

  $('dqEditAvatarBtn').addEventListener('click', () => openDarkchessAvatarEditor(b.avatar));
  $('dqCopyPromptBtn').addEventListener('click', async () => {
    const p = await apiFetch('GET', '/api/games/darkchess/me/prompt');
    if (!p.ok) return toast(p.error || '获取失败');
    copyText(p.prompt, '复制成功，粘贴并发送给你的 Agent 即可。');
  });
  $('dqRotateKeyBtn').addEventListener('click', () => popup({ icon: '🔑', title: '轮换密钥？', text: '旧密钥会立即失效，需重新复制 Prompt 给 Agent。', actions: [
    { label: '确认轮换', primary: true, onClick: async () => { const r2 = await apiFetch('POST', '/api/games/darkchess/me/rotate-key'); if (r2.ok) { toast('密钥已轮换'); showDqDetail(); } else toast(r2.error || '失败'); } },
    { label: '取消' },
  ] }));
  box.querySelectorAll('[data-dqsub]').forEach((s) => s.addEventListener('click', () => {
    box.querySelectorAll('[data-dqsub]').forEach((x) => x.classList.toggle('active', x === s));
    s.dataset.dqsub === 'versions' ? loadDqVersions() : loadDqMyMatches();
  }));
  loadDqVersions();
}

async function loadDqVersions() {
  const box = $('dqSubBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/games/darkchess/me/versions');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.versions.length) { box.innerHTML = '<div class="muted-center">还没有版本 —— 复制 Prompt 让 Agent 提交首个脚本。</div>'; return; }
  box.innerHTML = r.versions.map((v) => `
    <div class="ver-row">
      <div class="grow">
        <b>v${v.version}</b> <span class="chip ${v.smoke_status}">${SMOKE_LABEL[v.smoke_status] || v.smoke_status}</span>
        <div class="vmeta">${esc(v.notes || '（无说明）')} · 提交者 ${esc(v.submitted_by || '—')} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
      <button class="mini" data-dqver="${v.version}">查看脚本</button>
    </div>`).join('');
  box.querySelectorAll('[data-dqver]').forEach((b) => b.addEventListener('click', () => viewDqCode(+b.dataset.dqver)));
}
async function viewDqCode(version) {
  const r = await apiFetch('GET', '/api/games/darkchess/me/version/' + version);
  if (!r.ok) return toast(r.error || '读取失败');
  $('codeTitle').textContent = `脚本 v${version}`;
  $('codeBody').textContent = r.version.code;
  $('codeCopy').onclick = () => copyText(r.version.code, '已复制');
  openModal('codeModal');
}

// ---- 对战列表（按场展示，我的详情页 / 公开详情页共用）----
function dqBattleCardHtml(b) {
  const rp = b.scored === 0
    ? '<span class="rp-delta practice">练习赛·不计分</span>'
    : b.rpDelta == null
      ? '<span class="rp-delta">RP —</span>'
      : `<span class="rp-delta ${b.rpDelta >= 0 ? 'up' : 'down'}">RP ${b.rpDelta >= 0 ? '+' : ''}${b.rpDelta}</span>`;
  return `<div class="match-row">
    <span class="chip ${DQ_RES_CLS[b.result]}">${DQ_RES_LABEL[b.result]}</span>
    <span class="m-av">${avatarHtml(b.opponentAvatar)}</span>
    <div class="grow">
      <b>vs ${esc(b.opponentName)}</b> ${rp}
      <div class="vmeta">${esc(DQ_REASON_LABEL[b.reason] || b.reason || '')} · 共 ${b.turns || 0} 手 · ${new Date(b.playedAt).toLocaleString()}</div>
    </div>
    <button class="mini" data-dqmatch="${esc(b.matchUrlId)}">查看</button>
  </div>`;
}
function bindDqReplays(root) {
  root.querySelectorAll('[data-dqmatch]').forEach((btn) => btn.addEventListener('click', () => openDqMatch(btn.dataset.dqmatch)));
}
async function loadDqMyMatches() {
  const box = $('dqSubBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/games/darkchess/me/matches');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.battles.length) { box.innerHTML = '<div class="muted-center">还没有正式对战记录。</div>'; return; }
  box.innerHTML = r.battles.map(dqBattleCardHtml).join('');
  bindDqReplays(box);
}

function dqActionText(h) {
  const seatLabel = h.seat === 'a' ? '甲方' : '乙方';
  if (h.pass) return `${seatLabel}：停一手`;
  if (!h.action) return `${seatLabel}：（无动作）`;
  if (h.action.action === 'flip') {
    const rv = h.revealed;
    const label = rv ? (rv.side === 'black' ? '黑' : '红') + (DQ_LABELS[rv.side][rv.kind] || '?') : '?';
    return `${seatLabel}：翻开 [${h.action.at.join(',')}] → ${label}`;
  }
  const cap = (h.captured || []).map((c) => (c.side === 'black' ? '黑' : '红') + (c.kind ? (DQ_LABELS[c.side][c.kind] || '?') : '?（暗棋隔子吃）')).join('、');
  const base = `${seatLabel}：[${h.action.from.join(',')}] → [${h.action.to.join(',')}]`;
  return cap ? `${base}，吃掉 ${cap}` : base;
}

// ============================================================
// 对局回放（动画）：用浏览器本地的规则核心从 initialBoard 顺着 history 逐步重算棋盘，
// 得到「翻棋渐次揭示」的帧序列——只重放实际发生过的翻棋/吃子，绝不提前剧透还没翻开的棋子。
// ============================================================
let dqReplay = { frames: [], cur: 0, playing: false, timer: null, meta: null };

function dqBuildReplayFrames(initialBoard, history) {
  const core = window.DarkchessRules;
  let board = core.cloneBoard(initialBoard);
  const frames = [{ board: core.cloneBoard(board), step: null }];
  for (const h of history) {
    if (h.pass || !h.action) { frames.push({ board: core.cloneBoard(board), step: h }); continue; }
    if (h.action.action === 'flip') {
      board = core.applyFlip(board, h.action.at).board;
    } else {
      const side = board[h.action.from[0]][h.action.from[1]].side;
      board = core.applyMove(board, side, h.action).board;
    }
    frames.push({ board: core.cloneBoard(board), step: h });
  }
  return frames;
}
// 阶段标签（仅用于展示）：复刻定序阶段「两次翻棋配对比较颜色」的逻辑，判断此时是否已分出黑红。
function dqPhaseAtFrame(historySlice) {
  let pending = [];
  for (const h of historySlice) {
    if (!h.action || h.action.action !== 'flip' || !h.revealed) continue;
    pending.push(h.revealed.side);
    if (pending.length === 2) {
      if (pending[0] !== pending[1]) return '行棋中';
      pending = [];
    }
  }
  return '翻棋定序';
}

function dqRCellAt(x, y) { return document.querySelector(`#dqRBoard .dq-cell[data-x="${x}"][data-y="${y}"]`); }
function dqBuildReplayBoardCells() {
  const board = $('dqRBoard'); board.innerHTML = '';
  for (let y = DQ_H - 1; y >= 0; y--) for (let x = 0; x < DQ_W; x++) {
    const cell = document.createElement('div');
    cell.className = 'dq-cell' + ((x + y) % 2 ? ' alt' : '');
    cell.dataset.x = x; cell.dataset.y = y;
    board.appendChild(cell);
  }
}
function dqRenderReplayFrame() {
  const f = dqReplay.frames[dqReplay.cur];
  document.querySelectorAll('#dqRBoard .dq-cell').forEach((c) => { c.classList.remove('lastfrom', 'lastto'); c.innerHTML = ''; });
  let black = 0, red = 0;
  for (let x = 0; x < DQ_W; x++) for (let y = 0; y < DQ_H; y++) {
    const cell = f.board[x][y];
    const el = dqRCellAt(x, y);
    if (!el || !cell) continue;
    if (cell.side === 'black') black++; else red++;
    const tok = document.createElement('div');
    if (cell.hidden) { tok.className = 'dq-token dq-hidden'; tok.textContent = '暗'; }
    else { tok.className = 'dq-token dq-' + cell.side; tok.textContent = DQ_LABELS[cell.side][cell.kind] || '?'; }
    el.appendChild(tok);
  }
  const h = f.step;
  if (h && !h.pass && h.action) {
    if (h.action.action === 'flip') dqRCellAt(h.action.at[0], h.action.at[1])?.classList.add('lastto');
    else {
      dqRCellAt(h.action.from[0], h.action.from[1])?.classList.add('lastfrom');
      dqRCellAt(h.action.to[0], h.action.to[1])?.classList.add('lastto');
    }
  }
  $('dqRBlackCount').textContent = black;
  $('dqRRedCount').textContent = red;
  $('dqRTurnNo').textContent = dqReplay.cur;
  $('dqRPhase').textContent = dqPhaseAtFrame(dqReplay.frames.slice(1, dqReplay.cur + 1).map((fr) => fr.step));
  $('dqRPlyIndicator').textContent = dqReplay.frames.length > 1 ? `第 ${dqReplay.cur} / ${dqReplay.frames.length - 1} 手` : '—';
  document.querySelectorAll('#dqRMoveList li').forEach((li, i) => li.classList.toggle('cur', i === dqReplay.cur - 1));
  document.querySelector('#dqRMoveList li.cur')?.scrollIntoView({ block: 'nearest' });
  const banner = $('dqRResultBanner');
  if (dqReplay.cur === dqReplay.frames.length - 1 && dqReplay.meta) {
    const m = dqReplay.meta;
    const winnerName = m.winner === 'draw' ? '' : (m.winner === 'a' ? (m.challengerName || '甲方') : (m.challengedName || '乙方'));
    banner.className = 'result-banner';
    banner.innerHTML = `${m.winner === 'draw' ? '和棋' : `🏆 ${esc(winnerName)} 获胜！`}<small>${esc(DQ_REASON_LABEL[m.reason] || m.reason)} · 共 ${m.turns} 手</small>`;
  } else {
    banner.className = 'result-banner hidden';
  }
}
function dqReplayGoTo(i) {
  dqReplay.cur = Math.max(0, Math.min(dqReplay.frames.length - 1, i));
  dqRenderReplayFrame();
}
function dqReplayPause() {
  dqReplay.playing = false;
  clearInterval(dqReplay.timer); dqReplay.timer = null;
  $('dqRPlayPause').textContent = '▶ 播放';
}
function dqReplayPlay() {
  if (dqReplay.cur >= dqReplay.frames.length - 1) dqReplayGoTo(0);
  dqReplay.playing = true;
  $('dqRPlayPause').textContent = '⏸ 暂停';
  clearInterval(dqReplay.timer);
  dqReplay.timer = setInterval(() => {
    if (dqReplay.cur >= dqReplay.frames.length - 1) { dqReplayPause(); return; }
    dqReplayGoTo(dqReplay.cur + 1);
  }, +$('dqRSpeed').value);
}
$('dqRToStart').addEventListener('click', () => { dqReplayPause(); dqReplayGoTo(0); });
$('dqRPrev').addEventListener('click', () => { dqReplayPause(); dqReplayGoTo(dqReplay.cur - 1); });
$('dqRNext').addEventListener('click', () => { dqReplayPause(); dqReplayGoTo(dqReplay.cur + 1); });
$('dqRToEnd').addEventListener('click', () => { dqReplayPause(); dqReplayGoTo(dqReplay.frames.length - 1); });
$('dqRPlayPause').addEventListener('click', () => { dqReplay.playing ? dqReplayPause() : dqReplayPlay(); });
$('dqRSpeed').addEventListener('input', () => { if (dqReplay.playing) dqReplayPlay(); });
// 关闭弹窗（✕ 或点遮罩）时停止播放计时器，避免隐藏后仍在后台跑
document.querySelector('[data-close="dqReplayModal"]')?.addEventListener('click', dqReplayPause);
$('dqReplayModal').addEventListener('click', (e) => { if (e.target.id === 'dqReplayModal') dqReplayPause(); });

async function openDqMatch(urlId) {
  const r = await apiFetch('GET', '/api/games/darkchess/match/' + urlId);
  if (!r.ok) return toast(r.error || '读取失败');
  dqReplayPause();
  dqBuildReplayBoardCells();
  const history = r.gameData.history || [];
  dqReplay.frames = dqBuildReplayFrames(r.initialBoard, history);
  dqReplay.meta = { winner: r.winner, reason: r.reason, turns: r.turns, challengerName: r.challengerName, challengedName: r.challengedName };
  dqReplay.cur = 0;
  $('dqReplayTitle').textContent = `对局回放 · ${r.challengerName || '?'} vs ${r.challengedName || '?'}`;
  $('dqRMoveList').innerHTML = history.map((h) => `<li>${esc(dqActionText(h))}</li>`).join('');
  openModal('dqReplayModal');
  dqRenderReplayFrame();
}

// ============================================================
// 公开棋手详情页（他人）
// ============================================================
async function showDqPublic(id) {
  showDqTab('dqpublic');
  const box = $('dqPublicBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const [info, ms] = await Promise.all([
    apiFetch('GET', `/api/games/darkchess/players/${id}/public`),
    apiFetch('GET', `/api/games/darkchess/players/${id}/matches/public`),
  ]);
  if (!info.ok) { box.innerHTML = `<div class="muted-center">${esc(info.error)}</div>`; return; }
  const b = info.darkchess;
  const battles = ms.ok ? ms.battles : [];
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div>
        <h2>${esc(b.name)}</h2>
        <div class="muted">玩家 ${esc(b.ownerNickname)} · ${b.status === 'empty' ? '待提交脚本' : '可对战'}</div>
      </div>
      <div style="margin-left:auto"><button class="mini" id="dqBackToLb">← 返回天梯榜</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(b.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${b.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${b.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${b.winRate == null ? '—' : b.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${b.wins}-${b.losses}-${b.draws}</b></div>
        <div class="ov-row"><span>当前版本</span><b>v${b.currentVersion}</b></div>
      </div>
      <div class="card">
        <h3>最近对战（${battles.length}）</h3>
        <div id="dqPubMatches">${battles.length ? '' : '<div class="muted-center">还没有正式对战记录。</div>'}</div>
      </div>
    </div>`;
  $('dqBackToLb').addEventListener('click', () => showDqTab('dqleaderboard'));
  const list = $('dqPubMatches');
  if (battles.length) { list.innerHTML = battles.map(dqBattleCardHtml).join(''); bindDqReplays(list); }
}

// ============================================================
// 天梯
// ============================================================
async function loadDqLeaderboard() {
  const tbody = $('dqLbBody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted-center">加载中…</td></tr>';
  try {
    const data = await apiFetch('GET', '/api/games/darkchess/leaderboard');
    if (!data.ok) throw new Error(data.error);
    tbody.innerHTML = data.leaderboard.map((b) => `
      <tr class="rank-${b.rank}">
        <td>${b.rank}</td>
        <td><div class="lb-name"><span style="width:28px;height:28px;border-radius:8px;overflow:hidden;display:inline-block">${avatarHtml(b.avatar)}</span>${esc(b.name)}</div></td>
        <td>${esc(b.nickname)}</td>
        <td><span class="chip rank-chip">${esc(b.rankName)}</span></td>
        <td><b>${b.rp}</b></td>
        <td>${b.wins}胜 / ${b.losses}负 / ${b.draws}平</td>
        <td><button class="mini" data-dqid="${b.darkchessId}">详情</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted-center">暂无棋手</td></tr>';
    tbody.querySelectorAll('[data-dqid]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = +btn.dataset.dqid;
      const mine = await ensureMyDarkchessId();
      if (mine === id) showDqDetail(); else showDqPublic(id);
    }));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(e.message)}</td></tr>`;
  }
}
$('dqRefreshLb').addEventListener('click', loadDqLeaderboard);

// ============================================================
// 对手清单 + 棋手搜索
// ============================================================
async function loadDqOpponents() {
  const sel = $('dqOppSel'); sel.innerHTML = '';
  // 训练棋手是浏览器本地可信代码（/darkchess-bots.js），直接从本地清单取，不必等服务器往返。
  for (const t of window.DarkchessTraining.TRAINING_BOTS) {
    const opt = document.createElement('option');
    opt.value = 'training:' + t.id; opt.textContent = `${t.name}（训练棋手）`;
    sel.appendChild(opt);
  }
  // 已发布的玩家棋手清单仍需服务器（正式数据，且挑战它们必须走服务器沙箱）。
  const r = await apiFetch('GET', '/api/games/darkchess/opponents');
  if (!r.ok) return;
  for (const p of r.players) {
    const opt = document.createElement('option');
    opt.value = 'player:' + p.darkchessId; opt.textContent = `${p.name}（${p.ownerNickname} · ${p.rank}）`;
    sel.appendChild(opt);
  }
}
let dqSearchTimer = null;
$('dqBotSearch').addEventListener('input', () => {
  clearTimeout(dqSearchTimer);
  const q = $('dqBotSearch').value.trim();
  const box = $('dqBotSearchResults');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  dqSearchTimer = setTimeout(async () => {
    const r = await apiFetch('GET', '/api/games/darkchess/players/search?q=' + encodeURIComponent(q));
    if (!r.ok || !r.players.length) { box.classList.add('hidden'); box.innerHTML = '<div class="search-empty">没有找到棋手</div>'; box.classList.remove('hidden'); return; }
    box.innerHTML = r.players.map((p) => `<div class="search-item" data-id="${p.darkchessId}" data-name="${esc(p.name)}"><div class="s-info"><b>${esc(p.name)}</b><small>${esc(p.ownerNickname)} · ${esc(p.rank)}</small></div>${p.playable ? '' : '<span class="s-tag">未发布</span>'}</div>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
      const id = +el.dataset.id, name = el.dataset.name;
      const val = 'player:' + id;
      let opt = $('dqOppSel').querySelector(`option[value="${val}"]`);
      if (!opt) { opt = document.createElement('option'); opt.value = val; opt.textContent = `${name}（搜索）`; $('dqOppSel').appendChild(opt); }
      $('dqOppSel').value = val;
      $('dqBotSearch').value = '';
      box.classList.add('hidden'); box.innerHTML = '';
    }));
  }, 300);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#dqBotSearch') && !e.target.closest('#dqBotSearchResults')) {
    $('dqBotSearchResults').classList.add('hidden');
  }
});

// ============================================================
// 试玩：状态、棋盘渲染与交互
// ============================================================
let dqState = null;          // 统一视图（形状与 /api/games/darkchess/play 响应一致，可能来自服务器或浏览器本地引擎）
let dqIsLocal = false;
let dqOpponentSpec = null;   // {darkchessId:id} | null（训练棋手/本地双人已不再需要服务器，故不再有 {training:id}）
let dqLocalNames = null;     // {a,b} 本地双人显示名
let dqSelectedFrom = null;   // 当前选中的己方棋子坐标

// ---- 本地对局（训练棋手对战 / 双人同屏）：浏览器内直接跑 /darkchess-bots.js 暴露的可信代码，
// 与服务器同一份规则源码（window.DarkchessRules / window.DarkchessEngine），零网络。
// 玩家上传脚本（不可信）不在此列，仍必须经服务器沙箱，见 dqStartPlay/dqSubmitAction 的分支。
let dqLocalMatchState = null; // engine.js 的原始 matchState（含真实棋盘），只在本地对局时使用
let dqLocalBots = null;       // {b:trainer} | null（本地双人两边都是人，不需要 bot）
let dqLocalOpponentName = null;

function dqLocalRunUntilHumanOrEnd() {
  const eng = window.DarkchessEngine;
  const ms = dqLocalMatchState;
  while (true) {
    const actions = eng.legalActionsForSeat(ms, ms.turnSeat);
    if (actions.length === 0) {
      const r = eng.stepPass(ms);
      if (r) { ms.__status = r; return; }
      continue;
    }
    if (dqIsLocal || ms.turnSeat === 'a') return; // 轮到人类：本地双人任何座位都是人；vs 模式人类固定坐 a
    const bot = dqLocalBots[ms.turnSeat];
    const view = eng.buildView(ms, ms.turnSeat);
    let action;
    try { action = bot.onTurn(view.me, view.opponent, view.game); }
    catch (e) { ms.__status = { over: true, winner: 'a', reason: 'error' }; return; }
    const ok = action && actions.some((a) => eng.actionsEqual(a, action));
    if (!ok) { ms.__status = { over: true, winner: 'a', reason: 'illegal' }; return; }
    const r = eng.stepAction(ms, ms.turnSeat, action);
    if (r) { ms.__status = r; return; }
  }
}
function dqSyncStateFromLocal() {
  const eng = window.DarkchessEngine, core = window.DarkchessRules;
  const ms = dqLocalMatchState;
  const status = ms.__status || { over: false, turns: ms.history.length };
  dqState = {
    ok: true, mode: dqIsLocal ? 'local' : 'vs', opponent: dqLocalOpponentName, seed: null,
    humanSeat: dqIsLocal ? null : 'a', botSeat: dqIsLocal ? null : 'b',
    toMoveSeat: status.over ? null : ms.turnSeat, phase: ms.phase, colorOf: { ...ms.colorOf },
    board: eng.fogBoard(ms.board), history: ms.history,
    counts: core.counts(ms.board), noCaptureCount: ms.noCaptureCount,
    legalActions: status.over ? [] : eng.legalActionsForSeat(ms, ms.turnSeat),
    status: status.over ? { over: true, winner: status.winner, reason: status.reason, turns: ms.history.length } : { over: false, turns: ms.history.length },
  };
}

function dqBuildBoardCells() {
  const board = $('dqBoard'); board.innerHTML = '';
  for (let y = DQ_H - 1; y >= 0; y--) for (let x = 0; x < DQ_W; x++) {
    const cell = document.createElement('div');
    cell.className = 'dq-cell' + ((x + y) % 2 ? ' alt' : '');
    cell.dataset.x = x; cell.dataset.y = y;
    cell.addEventListener('click', () => dqOnCellClick(x, y));
    board.appendChild(cell);
  }
}
function dqCellAt(x, y) { return document.querySelector(`#dqBoard .dq-cell[data-x="${x}"][data-y="${y}"]`); }

function dqCanAct() {
  return dqState && !dqState.status.over && (dqIsLocal || dqState.toMoveSeat === dqState.humanSeat);
}
function dqMySideNow() {
  if (!dqState || !dqState.colorOf) return null;
  const seat = dqIsLocal ? dqState.toMoveSeat : dqState.humanSeat;
  return dqState.colorOf[seat] || null;
}
function dqLegalDestinationsFrom(from) {
  if (!dqState) return [];
  return dqState.legalActions.filter((a) => a.action === 'move' && a.from[0] === from[0] && a.from[1] === from[1]).map((a) => a.to);
}

function dqRenderBoard() {
  document.querySelectorAll('#dqBoard .dq-cell').forEach((c) => { c.classList.remove('sel', 'hint', 'lastfrom', 'lastto'); c.innerHTML = ''; });
  if (!dqState) return;
  for (let x = 0; x < DQ_W; x++) for (let y = 0; y < DQ_H; y++) {
    const cell = dqState.board[x][y];
    const el = dqCellAt(x, y);
    if (!el || !cell) continue;
    const tok = document.createElement('div');
    if (cell.hidden) { tok.className = 'dq-token dq-hidden'; tok.textContent = '暗'; }
    else { tok.className = 'dq-token dq-' + cell.side; tok.textContent = cell.label; }
    el.appendChild(tok);
  }
  const lastActed = [...dqState.history].reverse().find((h) => !h.pass);
  if (lastActed && lastActed.action) {
    if (lastActed.action.action === 'flip') {
      dqCellAt(lastActed.action.at[0], lastActed.action.at[1])?.classList.add('lastto');
    } else {
      dqCellAt(lastActed.action.from[0], lastActed.action.from[1])?.classList.add('lastfrom');
      dqCellAt(lastActed.action.to[0], lastActed.action.to[1])?.classList.add('lastto');
    }
  }
  if (dqSelectedFrom) {
    dqCellAt(dqSelectedFrom[0], dqSelectedFrom[1])?.classList.add('sel');
    dqLegalDestinationsFrom(dqSelectedFrom).forEach(([x, y]) => dqCellAt(x, y)?.classList.add('hint'));
  } else if (dqCanAct()) {
    dqState.legalActions.filter((a) => a.action === 'flip').forEach((a) => dqCellAt(a.at[0], a.at[1])?.classList.add('hint'));
  }
}

function dqRenderSideInfo() {
  if (!dqState) {
    $('dqBlackCount').textContent = 16; $('dqRedCount').textContent = 16;
    $('dqPhase').textContent = '—'; $('dqTurnNo').textContent = 0; $('dqNcm').textContent = 0;
    $('dqMeSide').textContent = '未定'; $('dqOppSide').textContent = '未定';
    $('dqBlackCard').classList.remove('active'); $('dqRedCard').classList.remove('active');
    return;
  }
  $('dqBlackCount').textContent = dqState.counts.black;
  $('dqRedCount').textContent = dqState.counts.red;
  $('dqPhase').textContent = dqState.phase === 'determining' ? '翻棋定序' : '行棋中';
  $('dqTurnNo').textContent = dqState.history.length;
  $('dqNcm').textContent = dqState.noCaptureCount;
  const colorOf = dqState.colorOf || {};
  const seatLabel = (seat) => {
    const color = colorOf[seat];
    if (!color) return '未定';
    const label = color === 'black' ? '黑方' : '红方';
    if (dqIsLocal) return label;
    return seat === dqState.humanSeat ? `${label}（你）` : `${label}（对手）`;
  };
  $('dqMeSide').textContent = seatLabel('a');
  $('dqOppSide').textContent = seatLabel('b');
  const activeColor = !dqState.status.over && dqState.toMoveSeat ? colorOf[dqState.toMoveSeat] : null;
  $('dqBlackCard').classList.toggle('active', activeColor === 'black');
  $('dqRedCard').classList.toggle('active', activeColor === 'red');
}

function dqRenderMoveList() {
  const ol = $('dqMoveList');
  if (!dqState) { ol.innerHTML = ''; return; }
  ol.innerHTML = dqState.history.map((h) => `<li>${esc(dqActionText(h))}</li>`).join('');
  ol.scrollTop = ol.scrollHeight;
}

function dqRenderStatus() {
  const banner = $('dqResultBanner');
  const status = $('dqStatusLine');
  if (!dqState) {
    banner.className = 'result-banner hidden';
    status.textContent = '选择对手，点击「开始对局」试玩';
    $('dqPlyIndicator').textContent = '—';
    return;
  }
  const seatDisplayName = (seat) => {
    if (dqIsLocal) return seat === 'a' ? (dqLocalNames?.a || '甲方') : (dqLocalNames?.b || '乙方');
    return seat === dqState.humanSeat ? '你' : (dqState.opponent || '对手');
  };
  if (dqState.status.over) {
    const w = dqState.status.winner;
    const reason = DQ_REASON_LABEL[dqState.status.reason] || dqState.status.reason;
    const iWon = !dqIsLocal && w === dqState.humanSeat;
    banner.className = 'result-banner ' + (w === 'draw' ? '' : (iWon ? 'win' : ''));
    banner.innerHTML = w === 'draw' ? `和棋<small>${esc(reason)}</small>` : `🏆 ${esc(seatDisplayName(w))} 获胜！<small>${esc(reason)}</small>`;
    status.textContent = `对局结束 · 共 ${dqState.history.length} 手`;
  } else {
    banner.className = 'result-banner hidden';
    const turnLabel = `轮到 ${esc(seatDisplayName(dqState.toMoveSeat))}`;
    status.textContent = dqState.phase === 'determining' ? `翻棋定序阶段 · ${turnLabel}` : turnLabel;
  }
  $('dqPlyIndicator').textContent = dqState.history.length ? `第 ${dqState.history.length} 手` : '—';
}

function dqRenderAll() {
  dqRenderBoard();
  dqRenderSideInfo();
  dqRenderMoveList();
  dqRenderStatus();
}

function dqNewSeed() { return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0; }

async function dqStartPlay(local) {
  dqSelectedFrom = null;
  dqIsLocal = local;

  if (local) {
    // 双人同屏：两边都是人，纯浏览器本地推演，零网络。
    dqOpponentSpec = null; dqLocalOpponentName = null; dqLocalBots = null;
    dqLocalNames = { a: $('dqP1Name').value.trim() || '玩家1', b: $('dqP2Name').value.trim() || '玩家2' };
    dqLocalMatchState = window.DarkchessEngine.initMatchState(dqNewSeed());
    dqLocalRunUntilHumanOrEnd();
    dqSyncStateFromLocal();
    dqRenderAll();
    return;
  }

  const val = $('dqOppSel').value || '';
  if (!val) { toast('请选择对手'); return; }
  const [kind, idStr] = val.split(':');

  if (kind === 'training') {
    // 训练棋手对战：内置可信代码，浏览器本地推演，零网络。
    const trainer = window.DarkchessBuiltins.findBuiltin(idStr);
    if (!trainer) { toast('内置对手加载失败'); return; }
    dqOpponentSpec = null; dqLocalOpponentName = trainer.name; dqLocalBots = { b: trainer };
    dqLocalMatchState = window.DarkchessEngine.initMatchState(dqNewSeed());
    dqLocalRunUntilHumanOrEnd();
    dqSyncStateFromLocal();
    dqRenderAll();
    return;
  }

  // 挑战已发布的玩家棋手：脚本不可信，必须走服务器沙箱。
  dqLocalMatchState = null; dqLocalBots = null;
  dqOpponentSpec = { darkchessId: +idStr };
  const body = Object.assign({ mode: 'vs', humanSeat: 'a', history: [] }, dqOpponentSpec);
  const r = await apiFetch('POST', '/api/games/darkchess/play', body);
  if (!r.ok) { toast(r.error || '开局失败'); return; }
  dqState = r;
  dqRenderAll();
}
$('dqStartPlayBtn').addEventListener('click', () => dqStartPlay(false));
$('dqStartLocalBtn').addEventListener('click', () => dqStartPlay(true));

async function dqSubmitAction(action) {
  if (!dqState || dqState.status.over) return;

  if (dqLocalMatchState) {
    try {
      const r = window.DarkchessEngine.stepAction(dqLocalMatchState, dqLocalMatchState.turnSeat, action);
      if (r) dqLocalMatchState.__status = r;
    } catch (e) { toast('本地对局出错：' + (e && e.message || e)); return; }
    dqLocalRunUntilHumanOrEnd();
    dqSyncStateFromLocal();
    dqRenderAll();
    return;
  }

  const newHistory = dqState.history.concat([{ seat: dqState.toMoveSeat, action, pass: false }]);
  const body = { mode: dqState.mode, seed: dqState.seed, history: newHistory };
  if (dqState.mode === 'vs') Object.assign(body, { humanSeat: dqState.humanSeat }, dqOpponentSpec);
  const r = await apiFetch('POST', '/api/games/darkchess/play', body);
  if (!r.ok) { toast(r.error || '走子失败'); dqSelectedFrom = null; dqRenderBoard(); return; }
  dqState = r;
  dqRenderAll();
}

function dqOnCellClick(x, y) {
  if (!dqCanAct()) return;
  const cell = dqState.board[x][y];
  if (dqSelectedFrom) {
    const dests = dqLegalDestinationsFrom(dqSelectedFrom);
    if (dests.some(([dx, dy]) => dx === x && dy === y)) {
      const from = dqSelectedFrom; dqSelectedFrom = null;
      dqSubmitAction({ action: 'move', from, to: [x, y] });
      return;
    }
  }
  if (cell && cell.hidden) {
    const canFlip = dqState.legalActions.some((a) => a.action === 'flip' && a.at[0] === x && a.at[1] === y);
    if (canFlip) { dqSelectedFrom = null; dqSubmitAction({ action: 'flip', at: [x, y] }); return; }
  }
  if (cell && !cell.hidden) {
    const mySide = dqMySideNow();
    if (mySide && cell.side === mySide) {
      const hasMoves = dqState.legalActions.some((a) => a.action === 'move' && a.from[0] === x && a.from[1] === y);
      dqSelectedFrom = hasMoves ? [x, y] : null;
      dqRenderBoard();
      return;
    }
  }
  dqSelectedFrom = null;
  dqRenderBoard();
}

// ============================================================
// 插件注册
// ============================================================
Platform.registerGame({
  id: 'darkchess',
  async init() {
    dqBuildBoardCells();
    dqRenderAll();
    await loadDqOpponents();
  },
  onShow() {
    const active = document.querySelector('.tab[data-dqtab].active');
    showDqTab(active ? active.dataset.dqtab : 'dqplay');
  },
  showMine() { showDqTab('dqmybot'); },
  defaultView() { showDqTab('dqplay'); },
  onAuthChange() { MY_DARKCHESS_ID = undefined; },
});
