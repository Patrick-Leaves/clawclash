'use strict';
// 象棋暗战 · 前端插件（MPA）
// 面板标记在同目录 panel.html，由服务器内联进游戏页 /g/darkchess 后再加载本文件。
// 整个文件包在 IIFE 内：所有声明均为本游戏私有，跨游戏零命名碰撞；对外只经
// Platform.registerGame 暴露插件对象。壳工具（$ / apiFetch / esc / toast / avatarHtml /
// openModal / popup / copyText / ME / RES_LABEL 等）是壳脚本的
// 全局词法绑定，闭包内直接可用。
// DOM 命名空间：document 级查询属性仍须加 dq 前缀（data-dqtab / .dqtab-panel /
// data-dqplaymode）——IIFE 只隔离 JS 命名，DOM 是全站共享的，选择器照旧要防误伤。
(() => {
const DQ_W = 8, DQ_H = 4;
const DQ_LABELS = {
  black: { general: '将', advisor: '士', elephant: '象', chariot: '車', horse: '馬', cannon: '炮', soldier: '卒' },
  red: { general: '帅', advisor: '仕', elephant: '相', chariot: '車', horse: '馬', cannon: '炮', soldier: '兵' },
};
const DQ_REASON_LABEL = {
  eliminated: '吃光判负', noCapture: '40 回合无吃子 · 价值裁定', stalemate: '双方停一手 · 价值裁定',
  draw: '平局', illegal: '非法动作判负', runtime: '超时/异常判负', error: '运行异常判负',
};
// 单场结果标签 RES_LABEL / RES_CLS 来自壳（/platform.js）

// ============================================================
// 二级导航：试玩 / 天梯榜 / 我的棋手 / Agent 指南（含登录守卫）—— 壳的 makeTabs 共享组件
// ============================================================
const { show: showDqTab } = makeTabs({
  gid: 'darkchess', attr: 'dqtab', panelClass: 'dqtab-panel', panelPrefix: 'dqtab-',
  onTab: { dqleaderboard: loadDqLeaderboard, dqmybot: renderMyDarkchess },
  authTabs: ['dqmybot'],
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
  async onCreated() { await refreshMe(); toast('棋手已创建'); showDqDetail(); },
  async onAvatarUpdated() { await refreshMe(); showDqDetail(); },
};
function openCreateDarkchess() { openCreatePlayer(DQ_PLAYER_CFG); }
function openDarkchessAvatarEditor(currentAvatar) { openAvatarEditorShared(DQ_PLAYER_CFG, currentAvatar); }

async function renderMyDarkchess() {
  const box = $('dqMybotBody');
  if (!(ME && ME.account)) { box.innerHTML = '<div class="empty-hero"><h2>请先登录</h2><p>登录后即可创建并管理你的棋手。</p></div>'; return; }
  box.innerHTML = loadingHtml();
  const r = await apiFetch('GET', '/api/games/darkchess/me');
  if (r.__status === 404) {
    box.innerHTML = `<div class="empty-hero"><h2>你还没有棋手</h2><p>创建一名棋手，拿到它的棋手密钥，交给你的 Agent 来编写策略。</p><button class="primary" id="dqCreateOpen">创建棋手 →</button></div>`;
    $('dqCreateOpen').addEventListener('click', openCreateDarkchess);
    return;
  }
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const b = r.darkchess;
  const empty = b.status === 'empty';
  box.innerHTML = `
    <div class="bot-card">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div class="grow">
        <h2>${esc(b.name)} ${empty ? '<span class="chip empty">空脚本</span>' : '<span class="chip active">可对战</span>'} <span class="chip ver">v${b.currentVersion}</span></h2>
        <div class="stat-row"><span>${esc(b.rank)} · 段位分 ${b.rp || 0} · 天梯排名 ${b.rankPosition ? '#' + b.rankPosition : '—'}</span></div>
        ${empty ? '<div class="warn-box" style="margin-top:10px">脚本为空，棋手尚不能对战 —— 进入详情，复制 Prompt 交给 Agent 提交首个版本。</div>' : ''}
      </div>
      <div class="actions"><button class="primary" id="dqGoDetail">详情</button></div>
    </div>`;
  $('dqGoDetail').addEventListener('click', () => showDqDetail());
}

// ============================================================
// 棋手详情（自己）
// ============================================================
async function showDqDetail() {
  showDqTab('dqdetail');
  const box = $('dqDetailBody'); box.innerHTML = loadingHtml();
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
      ${overviewCardHtml(b)}
      ${accessCardHtml({ noun: '棋手', guidePath: '/agent-guide-darkchess', maskedKey: b.maskedKey })}
    </div>
    <div class="subtabs">
      <button class="subtab active" data-dqsub="versions">版本</button>
      <button class="subtab" data-dqsub="matches">对战记录</button>
    </div>
    <div id="dqSubBody"></div>`;

  $('dqEditAvatarBtn').addEventListener('click', () => openDarkchessAvatarEditor(b.avatar));
  bindAccessCard(box, { promptUrl: '/api/games/darkchess/me/prompt', rotateUrl: '/api/games/darkchess/me/rotate-key', onRotated: showDqDetail });
  box.querySelectorAll('[data-dqsub]').forEach((s) => s.addEventListener('click', () => {
    box.querySelectorAll('[data-dqsub]').forEach((x) => x.classList.toggle('active', x === s));
    s.dataset.dqsub === 'versions' ? loadDqVersions() : loadDqMyMatches();
  }));
  loadDqVersions();
}

async function loadDqVersions() {
  const box = $('dqSubBody'); box.innerHTML = loadingHtml();
  const r = await apiFetch('GET', '/api/games/darkchess/me/versions');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  renderVersionList(box, r.versions, '/api/games/darkchess/me/version'); // 版本列表 + 查看脚本：壳共享组件
}

// ---- 对战列表（按场展示，我的详情页 / 公开详情页共用）----
function dqBattleCardHtml(b) {
  const rp = b.scored === 0
    ? '<span class="rp-delta practice">练习赛·不计分</span>'
    : b.rpDelta == null
      ? '<span class="rp-delta">RP —</span>'
      : `<span class="rp-delta ${b.rpDelta >= 0 ? 'up' : 'down'}">RP ${b.rpDelta >= 0 ? '+' : ''}${b.rpDelta}</span>`;
  return `<div class="match-row">
    <span class="chip ${RES_CLS[b.result]}">${RES_LABEL[b.result]}</span>
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
  const box = $('dqSubBody'); box.innerHTML = loadingHtml();
  const r = await apiFetch('GET', '/api/games/darkchess/me/matches');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.battles.length) { box.innerHTML = '<div class="muted-center">还没有正式对战记录。</div>'; return; }
  box.innerHTML = r.battles.map(dqBattleCardHtml).join('');
  bindDqReplays(box);
}

// nameOf(seat) → 该座位的展示名。试玩传 dqSeatName（你/对手/两位玩家名），
// 回放传 挑战方/被挑战方名；缺省回落到「甲方/乙方」保持兼容。
function dqActionText(h, nameOf) {
  const who = nameOf ? nameOf(h.seat) : (h.seat === 'a' ? '甲方' : '乙方');
  if (h.pass) return `${who}：停一手`;
  if (!h.action) return `${who}：（无动作）`;
  if (h.action.action === 'flip') {
    const rv = h.revealed;
    const label = rv ? (rv.side === 'black' ? '黑' : '红') + (DQ_LABELS[rv.side][rv.kind] || '?') : '?';
    return `${who}：翻开 [${h.action.at.join(',')}] → ${label}`;
  }
  const cap = (h.captured || []).map((c) => (c.side === 'black' ? '黑' : '红') + (c.kind ? (DQ_LABELS[c.side][c.kind] || '?') : '?（暗棋隔子吃）')).join('、');
  const base = `${who}：[${h.action.from.join(',')}] → [${h.action.to.join(',')}]`;
  return cap ? `${base}，吃掉 ${cap}` : base;
}

// ============================================================
// 对局回放（动画）：用浏览器本地的规则核心从 initialBoard 顺着 history 逐步重算棋盘，
// 得到「翻棋渐次揭示」的帧序列——只重放实际发生过的翻棋/吃子，绝不提前剧透还没翻开的棋子。
// ============================================================
let dqReplay = { frames: [], cur: 0, playing: false, timer: null, meta: null, prevCur: null };
// 被吃子的「幽灵子」DOM（吃子淡出动效用）：按棋盘格对象还原其样子（暗子 / 已揭示子）。
function dqGhostToken(cellObj) {
  const g = document.createElement('div');
  if (cellObj.hidden) { g.className = 'dq-token dq-hidden'; g.textContent = '暗'; }
  else { g.className = 'dq-token dq-' + cellObj.side; g.textContent = cellObj.label || (DQ_LABELS[cellObj.side] && DQ_LABELS[cellObj.side][cellObj.kind]) || '?'; }
  return g;
}
function dqCloneBoard(b) { return b.map((col) => col.map((c) => (c ? { ...c } : c))); }
// 重建一步之后的棋盘 + 该步动画描述。翻子用 history 的 revealed 定身份；走子用规则引擎算结果（正确处理
// 同归于尽/炮隔子吃），失败兜底为「起点子占据目标格」。被吃子样子取走子前目标格；炮吃暗子的真身取 h.captured。
function dqReconstructStep(board, h) {
  const core = window.DarkchessRules;
  if (h.pass || !h.action) return { board: dqCloneBoard(board), anim: null };
  if (h.action.action === 'flip') {
    const [x, y] = h.action.at; const b = dqCloneBoard(board); const rv = h.revealed || {};
    b[x][y] = { hidden: false, side: rv.side, kind: rv.kind, label: rv.label || (DQ_LABELS[rv.side] && DQ_LABELS[rv.side][rv.kind]) };
    return { board: b, anim: { type: 'flip', at: [x, y] } };
  }
  const [fx, fy] = h.action.from, [tx, ty] = h.action.to;
  const mover = board[fx] && board[fx][fy];
  const target = (board[tx] && board[tx][ty]) ? { ...board[tx][ty] } : null;
  let capturedReveal = null;
  if (target && target.hidden) { // 炮吃暗子：真身由本步 captured 元数据（含公示身份）按坐标取
    const c = (h.captured || []).find((it) => it && it.x === tx && it.y === ty && it.side);
    if (c) capturedReveal = { side: c.side, kind: c.kind };
  }
  let nb;
  try { nb = core.applyMove(dqCloneBoard(board), mover && mover.side, h.action).board; }
  catch (e) { nb = dqCloneBoard(board); nb[tx][ty] = nb[fx][fy]; nb[fx][fy] = null; }
  return { board: nb, anim: { type: 'move', from: [fx, fy], to: [tx, ty], target, capturedReveal } };
}
// 播放单步动画（在已渲染到该步终局的棋盘上），返回 Promise（含吃子退场，await 至全部播完）。
async function dqPlayStepAnim(anim) {
  Platform.boardAnim.stillFrame($('dqBoard'));
  if (anim.type === 'flip') { await Platform.boardAnim.flipIn(dqCellAt(anim.at[0], anim.at[1])?.querySelector('.dq-token')); return; }
  const [fx, fy] = anim.from, [tx, ty] = anim.to;
  const proms = [Platform.boardAnim.slide(dqCellAt(tx, ty)?.querySelector('.dq-token'), dqCellAt(fx, fy), dqCellAt(tx, ty))];
  if (anim.target) {
    const rv = anim.capturedReveal;
    const revealSwap = (anim.target.hidden && rv && rv.side)
      ? (el) => { el.className = 'dq-token dq-' + rv.side; el.textContent = (DQ_LABELS[rv.side] && DQ_LABELS[rv.side][rv.kind]) || '?'; }
      : null;
    proms.push(Platform.boardAnim.captureOut(dqCellAt(tx, ty), $('dqBoard'), dqGhostToken(anim.target), revealSwap));
  }
  await Promise.all(proms);
}
// 试玩落子动效（串行）：试玩用 live dqState，一次 submit 可能推进多步（人类 + 对手应手）。
// 以 submit 前快照 prevBoard 为基准逐步重建棋盘，逐帧渲染并播放该步动画，必须等本步播完再进下一步；
// 末了 dqRenderAll 权威同步侧栏/状态/终局弹层（stillFrame 压掉终态 drop，避免收尾时全盘弹跳）。
async function dqAnimateNewSteps(prevBoard, prevLen) {
  const hist = dqState.history.slice(prevLen);
  if (!prevBoard || Platform.boardAnim.reduced() || !hist.some((h) => !h.pass && h.action)) { dqRenderAll(); return; }
  let b = dqCloneBoard(prevBoard);
  const frames = [];
  for (const h of hist) { const rec = dqReconstructStep(b, h); frames.push({ board: rec.board, anim: rec.anim }); b = rec.board; }
  dqAnimating = true;
  try {
    for (const fr of frames) {
      if (!fr.anim) continue; // 停一手：棋盘不变，不渲染/不动画
      dqRenderBoardOnly(fr.board);
      await dqPlayStepAnim(fr.anim);
      await Platform.boardAnim.wait(Platform.boardAnim.STEP_GAP_MS);
    }
  } finally { dqAnimating = false; }
  dqRenderAll();
  Platform.boardAnim.stillFrame($('dqBoard'));
}

function dqBuildReplayFrames(initialBoard, history) {
  const core = window.DarkchessRules;
  let board = core.cloneBoard(initialBoard);
  const frames = [{ board: core.cloneBoard(board), step: null }];
  for (const h of history) {
    if (h.pass || !h.action) { frames.push({ board: core.cloneBoard(board), step: h }); continue; }
    if (h.action.action === 'flip') {
      const nb = core.cloneBoard(board);
      const [x, y] = h.action.at;
      if (h.revealed) nb[x][y] = { hidden: false, side: h.revealed.side, kind: h.revealed.kind, power: h.revealed.power };
      board = nb;
    } else {
      const nb = core.cloneBoard(board);
      const [fx, fy] = h.action.from, [tx, ty] = h.action.to;
      const piece = nb[fx] && nb[fx][fy];
      if (piece) {
        nb[fx][fy] = null;
        nb[tx][ty] = piece;
        for (const c of (h.captured || [])) if (c && Number.isInteger(c.x) && Number.isInteger(c.y)) nb[c.x][c.y] = null;
      }
      board = nb;
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
// 逐帧算出「座位 → 颜色」的揭示进度，复刻引擎定序逻辑（两次翻棋配对，颜色不同即分定）。
// 与揭示节奏保持一致：定序未完成前返回 {}，卡片仍只显示「黑方/红方」，绝不提前剧透谁执何色。
// 极端兜底（全翻仍未分色 → 引擎随机分派，无法据翻棋重演）从首个走子动作反推：走子方必已定色，
// 其所动棋子的颜色即其执方色。frames[k] 是 history[k-1] 之后的棋盘，即 history[k] 走子前的棋盘。
function dqColorRevealFrames(frames, history) {
  const otherSeat = (s) => (s === 'a' ? 'b' : 'a');
  const out = [{}];
  const colorOf = {};
  let pending = [];
  for (let k = 0; k < history.length; k++) {
    const h = history[k];
    if (Object.keys(colorOf).length < 2 && h && h.action) {
      if (h.action.action === 'flip') {
        if (h.revealed) {
          pending.push({ seat: h.seat, side: h.revealed.side });
          if (pending.length === 2) {
            if (pending[0].side !== pending[1].side) {
              colorOf[pending[0].seat] = pending[0].side;
              colorOf[pending[1].seat] = pending[1].side;
            }
            pending = [];
          }
        }
      } else if (h.action.from) {
        const b = frames[k] && frames[k].board;
        const cell = b && b[h.action.from[0]] && b[h.action.from[0]][h.action.from[1]];
        if (cell && cell.side) {
          colorOf[h.seat] = cell.side;
          colorOf[otherSeat(h.seat)] = cell.side === 'black' ? 'red' : 'black';
        }
      }
    }
    out.push({ ...colorOf });
  }
  return out;
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
  // —— 走子/翻子/吃子动效：仅「前进一帧且真实动作」时播放。返回该步动画 Promise，播放循环 await 后再进下一手。——
  let dqrAnimP = Promise.resolve();
  if (dqReplay.prevCur !== null && dqReplay.cur === dqReplay.prevCur + 1 && h && !h.pass && h.action) {
    const prev = dqReplay.frames[dqReplay.prevCur].board;
    Platform.boardAnim.stillFrame($('dqRBoard'));
    if (h.action.action === 'flip') {
      dqrAnimP = Platform.boardAnim.flipIn(dqRCellAt(h.action.at[0], h.action.at[1])?.querySelector('.dq-token'));
    } else {
      const [fx, fy] = h.action.from, [tx, ty] = h.action.to;
      const proms = [Platform.boardAnim.slide(dqRCellAt(tx, ty)?.querySelector('.dq-token'), dqRCellAt(fx, fy), dqRCellAt(tx, ty))];
      const capd = prev[tx] && prev[tx][ty];
      if (capd) {
        // 回放棋盘带完整身份：暗子被吃(炮)时可直接由 capd.side/kind 翻开亮明。
        const revealSwap = capd.hidden ? (el) => { el.className = 'dq-token dq-' + capd.side; el.textContent = (DQ_LABELS[capd.side] && DQ_LABELS[capd.side][capd.kind]) || '?'; } : null;
        proms.push(Platform.boardAnim.captureOut(dqRCellAt(tx, ty), $('dqRBoard'), dqGhostToken(capd), revealSwap));
      }
      dqrAnimP = Promise.all(proms);
    }
  }
  dqReplay.prevCur = dqReplay.cur;
  $('dqRBlackCount').textContent = black;
  $('dqRRedCount').textContent = red;
  // 卡片持方名：随揭示进度逐帧显示，定序完成后把挑战方/被挑战方名挂到对应色卡上。
  const colorOf = (dqReplay.colorFrames && dqReplay.colorFrames[dqReplay.cur]) || {};
  const seatOfColor = (color) => (colorOf.a === color ? 'a' : (colorOf.b === color ? 'b' : null));
  const rCardName = (color, label) => {
    const labelHtml = `<span class="side-label">${esc(label)}</span>`;
    const seat = seatOfColor(color);
    if (!seat) return labelHtml;
    const name = seat === 'a' ? (dqReplay.names?.a || '甲方') : (dqReplay.names?.b || '乙方');
    return `${labelHtml} <span class="side-owner">${esc(name)}</span>`;
  };
  $('dqRBlackName').innerHTML = rCardName('black', '黑方');
  $('dqRRedName').innerHTML = rCardName('red', '红方');
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
  return dqrAnimP;
}
function dqReplayGoTo(i) {
  dqReplay.cur = Math.max(0, Math.min(dqReplay.frames.length - 1, i));
  return dqRenderReplayFrame();
}
function dqReplayPause() {
  dqReplay.playing = false;
  clearTimeout(dqReplay.timer); dqReplay.timer = null;
  $('dqRPlayPause').textContent = '▶ 播放';
}
// 自动播放：渲染并播完本手动画（含吃子退场/翻子），再按速度滑块留间隔进下一手——上一步动画播完才播下一步。
async function dqReplayTick() {
  clearTimeout(dqReplay.timer);
  if (!dqReplay.playing) return;
  if (dqReplay.cur >= dqReplay.frames.length - 1) { dqReplayPause(); return; }
  dqReplay.cur += 1;
  await dqRenderReplayFrame();
  if (!dqReplay.playing) return;
  dqReplay.timer = setTimeout(dqReplayTick, +$('dqRSpeed').value);
}
function dqReplayPlay() {
  if (dqReplay.cur >= dqReplay.frames.length - 1) dqReplayGoTo(0);
  dqReplay.playing = true;
  $('dqRPlayPause').textContent = '⏸ 暂停';
  clearTimeout(dqReplay.timer);
  dqReplayTick();
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
  dqReplay.colorFrames = dqColorRevealFrames(dqReplay.frames, history);
  dqReplay.names = { a: r.challengerName || '甲方', b: r.challengedName || '乙方' };
  dqReplay.meta = { winner: r.winner, reason: r.reason, turns: r.turns, challengerName: r.challengerName, challengedName: r.challengedName };
  dqReplay.cur = 0; dqReplay.prevCur = null;
  $('dqReplayTitle').textContent = `对局回放 · ${r.challengerName || '?'} vs ${r.challengedName || '?'}`;
  const rNameOf = (seat) => (seat === 'a' ? dqReplay.names.a : dqReplay.names.b);
  $('dqRMoveList').innerHTML = history.map((h) => `<li>${esc(dqActionText(h, rNameOf))}</li>`).join('');
  openModal('dqReplayModal');
  dqRenderReplayFrame();
}

// ============================================================
// 公开棋手详情页（他人）
// ============================================================
async function showDqPublic(id) {
  showDqTab('dqpublic');
  const box = $('dqPublicBody'); box.innerHTML = loadingHtml();
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
      ${overviewCardHtml(b, { showStatus: false })}
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
  tbody.innerHTML = '<tr><td colspan="7" class="muted-center"><span class="spinner"></span>加载中…</td></tr>';
  const data = await apiFetch('GET', '/api/games/darkchess/leaderboard');
  if (!data.ok) { tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(data.error || '加载失败')}</td></tr>`; return; }
  renderLeaderboardRows(tbody, data.leaderboard, {
    idField: 'darkchessId', emptyText: '暂无棋手',
    onDetail: (id) => { const mine = myPlayer('darkchess'); mine && mine.id === id ? showDqDetail() : showDqPublic(id); },
  });
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

let dqAnimating = false; // 落子动效播放中：锁输入，保证「上一步动画播完才播下一步」
let dqBusy = false;      // 提交处理中（含等待服务器/对手 bot 应手）：锁输入，杜绝并发重复提交
function dqCanAct() {
  return dqState && !dqAnimating && !dqBusy && !dqState.status.over && (dqIsLocal || dqState.toMoveSeat === dqState.humanSeat);
}
// 试玩状态栏「等待对方 bot」提示（vs 玩家棋手时，等服务器沙箱跑对手应手期间显示）
function dqSetWaiting() {
  const el = $('dqStatusLine');
  if (el) { el.className = 'status-line busy'; el.innerHTML = '<span class="spinner"></span>已落子，等待对方 bot 应手…'; }
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

// 只画棋盘 token（清格 + 按给定棋盘重建棋子），不加提示/高亮/选中——供落子动效逐帧渲染中间态复用。
function dqRenderBoardOnly(board) {
  document.querySelectorAll('#dqBoard .dq-cell').forEach((c) => { c.classList.remove('sel', 'dq-hint', 'lastfrom', 'lastto', 'dq-flip-pending'); c.innerHTML = ''; });
  if (!board) return;
  for (let x = 0; x < DQ_W; x++) for (let y = 0; y < DQ_H; y++) {
    const cell = board[x][y];
    const el = dqCellAt(x, y);
    if (!el || !cell) continue;
    const tok = document.createElement('div');
    if (cell.hidden) { tok.className = 'dq-token dq-hidden'; tok.textContent = '暗'; }
    else { tok.className = 'dq-token dq-' + cell.side; tok.textContent = cell.label || (DQ_LABELS[cell.side] && DQ_LABELS[cell.side][cell.kind]) || '?'; }
    el.appendChild(tok);
  }
}
// 落子后可交互态：最近一手高亮 + 选中/可走/可翻提示（作用于已画好的终局棋盘，不重建 token → 不重复 drop 弹跳）。
function dqPaintPlayAffordances() {
  if (!dqState) return;
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
    dqLegalDestinationsFrom(dqSelectedFrom).forEach(([x, y]) => dqCellAt(x, y)?.classList.add('dq-hint'));
  } else if (dqCanAct()) {
    dqState.legalActions.filter((a) => a.action === 'flip').forEach((a) => dqCellAt(a.at[0], a.at[1])?.classList.add('dq-hint'));
  }
}
function dqRenderBoard() {
  dqRenderBoardOnly(dqState && dqState.board);
  dqPaintPlayAffordances();
}

// 座位 → 展示名：vs 模式人类座为「你」、对手座为对手名；双人同屏用两位玩家名。
// 颜色（黑/红）在翻棋定序阶段才分出，故这里以「座位」为锚，避免再引入甲方/乙方中间层。
function dqSeatName(seat) {
  if (dqIsLocal) return seat === 'a' ? (dqLocalNames?.a || '玩家1') : (dqLocalNames?.b || '玩家2');
  return seat === dqState?.humanSeat ? '你' : (dqState?.opponent || '对手');
}

function dqRenderSideInfo() {
  if (!dqState) {
    $('dqBlackCount').textContent = 16; $('dqRedCount').textContent = 16;
    $('dqPhase').textContent = '—'; $('dqTurnNo').textContent = 0; $('dqNcm').textContent = 0;
    $('dqBlackName').innerHTML = '<span class="side-label">黑方</span>'; $('dqRedName').innerHTML = '<span class="side-label">红方</span>';
    $('dqBlackCard').classList.remove('active'); $('dqRedCard').classList.remove('active');
    return;
  }
  $('dqBlackCount').textContent = dqState.counts.black;
  $('dqRedCount').textContent = dqState.counts.red;
  $('dqPhase').textContent = dqState.phase === 'determining' ? '翻棋定序' : '行棋中';
  $('dqTurnNo').textContent = dqState.history.length;
  $('dqNcm').textContent = dqState.noCaptureCount;
  const colorOf = dqState.colorOf || {};
  const seatOfColor = (color) => (colorOf.a === color ? 'a' : (colorOf.b === color ? 'b' : null));
  // 归属未定（翻棋定序中）只显示「黑方/红方」；一旦分出颜色，直接把持方名挂到对应色卡上，
  // 人类持方额外高亮，让玩家一眼看出哪张卡是自己。
  const cardName = (color, label) => {
    const labelHtml = `<span class="side-label">${esc(label)}</span>`;
    const seat = seatOfColor(color);
    if (!seat) return labelHtml;
    const isMe = !dqIsLocal && seat === dqState.humanSeat;
    return `${labelHtml} <span class="side-owner${isMe ? ' me' : ''}">${esc(dqSeatName(seat))}</span>`;
  };
  $('dqBlackName').innerHTML = cardName('black', '黑方');
  $('dqRedName').innerHTML = cardName('red', '红方');
  const activeColor = !dqState.status.over && dqState.toMoveSeat ? colorOf[dqState.toMoveSeat] : null;
  $('dqBlackCard').classList.toggle('active', activeColor === 'black');
  $('dqRedCard').classList.toggle('active', activeColor === 'red');
}

function dqRenderMoveList() {
  const ol = $('dqMoveList');
  if (!dqState) { ol.innerHTML = ''; return; }
  ol.innerHTML = dqState.history.map((h) => `<li>${esc(dqActionText(h, dqSeatName))}</li>`).join('');
  ol.scrollTop = ol.scrollHeight;
}

function dqRenderStatus() {
  const banner = $('dqResultBanner');
  const status = $('dqStatusLine');
  status.className = 'status-line'; // 清掉「等待对方」busy 态（dqSetWaiting 设的）
  if (!dqState) {
    banner.className = 'result-banner hidden';
    status.textContent = '选择对手，点击「开始对局」试玩';
    $('dqPlyIndicator').textContent = '—';
    return;
  }
  if (dqState.status.over) {
    const w = dqState.status.winner;
    const reason = DQ_REASON_LABEL[dqState.status.reason] || dqState.status.reason;
    const iWon = !dqIsLocal && w === dqState.humanSeat;
    banner.className = 'result-banner ' + (w === 'draw' ? '' : (iWon ? 'win' : ''));
    banner.innerHTML = w === 'draw' ? `和棋<small>${esc(reason)}</small>` : `🏆 ${esc(dqSeatName(w))} 获胜！<small>${esc(reason)}</small>`;
    status.textContent = `对局结束 · 共 ${dqState.history.length} 手`;
  } else {
    banner.className = 'result-banner hidden';
    const turnLabel = `轮到 ${esc(dqSeatName(dqState.toMoveSeat))}`;
    status.textContent = dqState.phase === 'determining' ? `翻棋定序阶段 · ${turnLabel}` : turnLabel;
  }
  $('dqPlyIndicator').textContent = dqState.history.length ? `第 ${dqState.history.length} 手` : '—';
}

// ---- 试玩终局动效（与钳王 clawclash 同款：全屏弹层 + 撒彩带；复用壳 .result-pop/.confetti-box）----
let dqResultShown = false;
function dqShowResult() {
  if (!dqState || !dqState.status.over) return;
  const st = dqState.status;
  const reason = DQ_REASON_LABEL[st.reason] || st.reason || '';
  const turns = st.turns != null ? st.turns : dqState.history.length;
  const draw = st.winner === 'draw';
  let win;
  if (dqIsLocal) {
    // 双人同屏：有人获胜就撒彩带，标题用获胜方名
    win = !draw;
    $('dqRpEmoji').textContent = draw ? '🤝' : '🏆';
    $('dqRpTitle').textContent = draw ? '和棋' : `${dqSeatName(st.winner)} 获胜！`;
    $('dqRpSub').textContent = `${reason} · 共 ${turns} 手`;
  } else {
    // 挑战棋手：人类固定坐 a，从人类视角判胜负
    win = st.winner === dqState.humanSeat;
    $('dqRpEmoji').textContent = draw ? '🤝' : (win ? '🎉' : '🌊');
    $('dqRpTitle').textContent = draw ? '和棋' : (win ? '胜利！' : '惜败');
    $('dqRpSub').textContent = `${reason} · 共 ${turns} 手 · 对手「${dqState.opponent || ''}」`;
  }
  $('dqResultPop').className = 'result-pop ' + (draw ? 'draw' : (win ? 'win' : 'loss'));
  const box = $('dqConfettiBox'); box.innerHTML = '';
  if (win) { // 胜利撒彩带（象棋主题字形）
    const glyphs = ['🎉', '✨', '♟', '♜', '⭐', '🏆', '🎴'];
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('span');
      s.className = 'confetti'; s.textContent = glyphs[i % glyphs.length];
      s.style.left = Math.random() * 100 + '%';
      s.style.fontSize = (14 + Math.random() * 16) + 'px';
      s.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      s.style.animationDelay = (Math.random() * 0.7) + 's';
      box.appendChild(s);
    }
  }
  openModal('dqResultOverlay');
}
function dqMaybeShowResult() {
  if (dqState && dqState.status.over && !dqResultShown) {
    dqResultShown = true;
    setTimeout(dqShowResult, 420); // 等最后一手落子渲染完，给一个终局节拍
  }
}
$('dqRpAgain').addEventListener('click', () => { closeModal('dqResultOverlay'); dqStartPlay(dqIsLocal); });
$('dqRpClose').addEventListener('click', () => closeModal('dqResultOverlay'));

function dqRenderAll() {
  dqRenderBoard();
  dqRenderSideInfo();
  dqRenderMoveList();
  dqRenderStatus();
  dqMaybeShowResult();
}

function dqNewSeed() { return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0; }

async function dqStartPlay(local) {
  dqSelectedFrom = null;
  dqIsLocal = local;
  dqResultShown = false; // 新对局重置终局动效标记

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
  if (!dqState || dqState.status.over || dqBusy || dqAnimating) return; // 锁：杜绝并发/重入（修「点了没动画」）
  const prevBoard = dqCloneBoard(dqState.board); // submit 前快照，供落子动效计算滑入/吃子/翻子
  const prevLen = dqState.history.length;
  const seat = dqState.toMoveSeat;

  // ---- 本地/训练：全程浏览器推演、零网络，直接串行播放 ----
  if (dqLocalMatchState) {
    dqBusy = true;
    try {
      try {
        const r = window.DarkchessEngine.stepAction(dqLocalMatchState, dqLocalMatchState.turnSeat, action);
        if (r) dqLocalMatchState.__status = r;
      } catch (e) { toast('本地对局出错：' + (e && e.message || e)); dqBusy = false; return; }
      dqLocalRunUntilHumanOrEnd();
      dqSyncStateFromLocal();
      dqBusy = false;                               // 先清锁再播动画（末帧 dqRenderAll 才画得出可交互提示）
      await dqAnimateNewSteps(prevBoard, prevLen);
    } finally { dqBusy = false; }
    return;
  }

  // ---- 挑战玩家棋手（vs）：不可信对手脚本须走服务器沙箱，可能有网络/执行延迟 ----
  dqBusy = true;
  try {
    // A2 即时反馈：人类这步先本地播动画——走子结果确定可即时滑入/吃子；翻子身份未知（待服务器揭示），仅给「翻开中」脉冲。
    let baseBoard = prevBoard, animFrom = prevLen;
    if (action.action === 'move') {
      const rec = dqReconstructStep(prevBoard, { seat, action, captured: [], revealed: null, pass: false });
      dqRenderBoardOnly(rec.board);
      if (rec.anim) await dqPlayStepAnim(rec.anim);  // 人类走子/吃子动画立刻播，不等服务器
      baseBoard = rec.board; animFrom = prevLen + 1; // 服务器返回后只补播对手 bot 的新增步
    } else {
      dqMarkFlipPending(action.at);                  // 翻子：即时脉冲反馈（真身待服务器揭示后再翻开）
    }
    dqSetWaiting();                                  // A3 「已落子，等待对方 bot 应手…」

    const newHistory = dqState.history.concat([{ seat, action, pass: false }]);
    const body = { mode: dqState.mode, seed: dqState.seed, history: newHistory };
    if (dqState.mode === 'vs') Object.assign(body, { humanSeat: dqState.humanSeat }, dqOpponentSpec);
    let r;
    try { r = await apiFetch('POST', '/api/games/darkchess/play', body); }
    catch (e) { r = { ok: false, error: '网络错误，请重试' }; }
    if (!r.ok) {                                     // A4 兜底：回滚到落子前权威态，解锁恢复可走
      toast(r.error || '走子失败');
      dqSelectedFrom = null;
      dqBusy = false;
      dqRenderAll();
      return;
    }
    dqState = r;
    dqBusy = false;                                  // 清锁，交给 dqAnimateNewSteps（dqAnimating 接管动画锁）
    await dqAnimateNewSteps(baseBoard, animFrom);    // 只补播对手 bot 新增步（人类步已即时播过）
  } finally { dqBusy = false; }
}
// 翻子即时反馈：服务器未揭示前，先给被点格一个「翻开中」脉冲（真身回来后 dqAnimateNewSteps 再播翻开动画）。
function dqMarkFlipPending(at) {
  const el = dqCellAt(at[0], at[1]);
  if (el) el.classList.add('dq-flip-pending');
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
  showTab: showDqTab,               // 供壳侧栏导航 + hash 路由派发（key: dqplay/dqleaderboard/dqmybot/dqguide）
  onShow() { showDqTab('dqplay'); },// 无 hash 时的默认落点 tab
  showMine() { showDqTab('dqmybot'); },
});
})();
