'use strict';
// 囚徒困境 · 前端插件（P4 前端插件化）
// 面板标记在同目录 panel.html，由平台壳（/platform.js）注入 DOM 后再加载本文件。
// 与壳共享全局作用域：直接使用 $ / apiFetch / esc / toast / rankLabel / avatarHtml /
// openModal / closeModal / popup / ME 等壳工具；函数命名延续拆分前的单文件时代，全站唯一。

// ============================================================
// 二级导航：试玩 / 天梯榜 / 我的囚徒 / Agent 指南（含登录守卫）
// ============================================================
function showPTab(name) {
  Platform.activateGame('prisoner'); // 外部跳转（如登录后进「我的囚徒」）时确保本游戏面板可见
  document.querySelectorAll('.tab[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === name));
  document.querySelectorAll('.ptab-panel').forEach((p) => p.classList.remove('active'));
  const panel = $('ptab-' + name); if (panel) panel.classList.add('active');
  if (name === 'pplay') ensurePdPlayInit();
  if (name === 'pleaderboard') loadPrisonerLeaderboard();
  if (name === 'pmybot') renderMyPrisoner();
}
document.querySelectorAll('.tab[data-ptab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.ptab;
    if (name === 'pmybot' && !(ME && ME.account)) { openAuth('register'); return; }
    showPTab(name);
  });
});

// ============================================================
// 创建囚徒 / 更换头像：复用壳的通用选手创建组件
// ============================================================
const PD_PLAYER_CFG = {
  noun: '囚徒', createTitle: '创建囚徒', createLabel: '创建囚徒', nameLabel: '囚徒名称', placeholder: '例如：镜面囚徒',
  urls: { create: '/api/prisoner/create', nameCheck: '/api/prisoner/name-check', preset: '/api/prisoner/me/avatar/preset', upload: '/api/prisoner/me/avatar' },
  onCreated(r) { MY_PRISONER_ID = r.prisonerId; toast('囚徒已创建'); renderMyPrisoner(); },
  onAvatarUpdated() { renderMyPrisoner(); },
};
function openCreatePrisoner() { openCreatePlayer(PD_PLAYER_CFG); }
function openPrisonerAvatarEditor(currentAvatar) { openAvatarEditorShared(PD_PLAYER_CFG, currentAvatar); }

// ============================================================
// 囚徒困境：加载与渲染
// ============================================================
let PD_META = null;
async function ensurePDMeta() {
  if (PD_META) return PD_META;
  const r = await apiFetch('GET', '/api/prisoner/meta');
  if (r.ok) PD_META = r;
  return PD_META;
}

// 我的囚徒 id 缓存：undefined=未知（需拉取），null=无囚徒，number=有。登录态变化时在 refreshMe 里失效。
let MY_PRISONER_ID;
async function ensureMyPrisonerId() {
  if (MY_PRISONER_ID !== undefined) return MY_PRISONER_ID;
  if (!ME || !ME.account) { MY_PRISONER_ID = null; return null; }
  const r = await apiFetch('GET', '/api/prisoner/me');
  MY_PRISONER_ID = (r.ok && r.prisoner) ? r.prisoner.id : null;
  return MY_PRISONER_ID;
}

async function loadPrisonerLeaderboard() {
  await ensurePDMeta();
  const hint = $('pdRangeHint');
  if (hint && PD_META) hint.textContent = `每场正式对战实际进行 ${PD_META.minRounds}–${PD_META.maxRounds} 回合（开局区间随机抽取，对囚徒 Bot 隐藏）。`;
  const tbody = $('plbBody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted-center">加载中…</td></tr>';
  const data = await apiFetch('GET', '/api/leaderboard/prisoner');
  if (!data.ok) { tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(data.error || '加载失败')}</td></tr>`; return; }
  if (!data.leaderboard.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted-center">暂无囚徒，快来抢首位</td></tr>'; return; }
  tbody.innerHTML = data.leaderboard.map((p) => `
    <tr class="rank-${p.rank}">
      <td>${p.rank}</td>
      <td><div class="lb-name"><span style="width:28px;height:28px;border-radius:8px;overflow:hidden;display:inline-block">${avatarHtml(p.avatar)}</span>${esc(p.name)}</div></td>
      <td>${esc(p.nickname)}</td>
      <td><span class="chip rank-chip">${esc(p.rankName)}</span></td>
      <td><b>${p.rp}</b></td>
      <td>${p.wins}胜 / ${p.losses}负 / ${p.draws}平</td>
      <td><button class="mini" data-prisoner="${p.prisonerId}">详情</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-prisoner]').forEach((b) => b.addEventListener('click', async () => {
    const id = +b.dataset.prisoner;
    // 若点的是自己的囚徒 → 直接进「我的囚徒」详情（含 Agent 接入 + 版本记录），而非公开页
    const mine = await ensureMyPrisonerId();
    if (mine === id) showPTab('pmybot');
    else showPublicPrisoner(id);
  }));
}
$('prefreshLb') && $('prefreshLb').addEventListener('click', loadPrisonerLeaderboard);

async function renderMyPrisoner() {
  const box = $('pmybotBody');
  await ensurePDMeta();
  if (!ME || !ME.account) {
    box.innerHTML = `<div class="empty-hero"><h2>请先注册或登录</h2><p>创建你的囚徒，让 Agent 帮你写策略。</p>
      <button class="primary" id="pmGoReg">注册账号</button> <button id="pmGoLogin">登录</button></div>`;
    $('pmGoReg').onclick = () => openAuth('register');
    $('pmGoLogin').onclick = () => openAuth('login');
    return;
  }
  const r = await apiFetch('GET', '/api/prisoner/me');
  if (r.__status === 404) {
    MY_PRISONER_ID = null;
    box.innerHTML = `<div class="empty-hero"><h2>你还没有囚徒</h2><p>创建一名囚徒，选一个头像；策略脚本由你/Agent 稍后提交。</p>
      <button class="primary" id="pdCreateOpen">创建囚徒 →</button></div>`;
    $('pdCreateOpen').addEventListener('click', openCreatePrisoner);
    return;
  }
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const p = r.prisoner;
  MY_PRISONER_ID = p.id;
  const empty = p.status === 'empty';
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(p.avatar)}</div>
      <div><h2>${esc(p.name)}</h2><div class="muted">当前工作版本：v${p.currentVersion}${empty ? '（空脚本）' : ''}</div></div>
      <div style="margin-left:auto"><button class="mini" id="editPrisonerAvatarBtn">更换头像</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(p.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${p.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${p.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${p.winRate == null ? '—' : p.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${p.wins}-${p.losses}-${p.draws}</b></div>
        <div class="ov-row"><span>状态</span>${empty ? '<span class="chip empty">待提交脚本</span>' : '<span class="chip active">可对战</span>'}</div>
        <div class="ov-row"><span>当前版本</span><b>v${p.currentVersion}${empty ? '（空脚本）' : ''}</b></div>
      </div>
      <div class="card">
        <h3>Agent 接入</h3>
        <p class="muted" style="margin-top:0">用「Agent 指南 + 囚徒密钥」让你的 Agent 阅读规则、编写并提交策略脚本。</p>
        <div class="access-row"><span class="lbl">囚徒密钥</span><span class="val">${esc(p.maskedKey)}</span></div>
        <div class="access-row"><span class="lbl">Agent 指南</span><span class="val"><a href="/agent-guide-prisoner" target="_blank">/agent-guide-prisoner</a></span></div>
        <div class="access-actions">
          <button class="primary" id="pdCopyPromptBtn">📋 一键复制 Agent Prompt</button>
          <button class="secondary" id="pdRotateBtn">轮换密钥</button>
        </div>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab active" data-psub="versions">版本</button>
      <button class="subtab" data-psub="matches">对战记录</button>
    </div>
    <div id="psubBody"></div>`;
  $('editPrisonerAvatarBtn').addEventListener('click', () => openPrisonerAvatarEditor(p.avatar));
  $('pdCopyPromptBtn').addEventListener('click', async () => {
    const pr = await apiFetch('GET', '/api/prisoner/me/prompt');
    if (!pr.ok) return toast(pr.error || '获取失败');
    copyText(pr.prompt, '复制成功，粘贴并发送给你的 Agent 即可。');
  });
  $('pdRotateBtn').addEventListener('click', () => popup({ icon: '🔑', title: '轮换密钥？', text: '旧密钥会立即失效，需重新复制 Prompt。', actions: [
    { label: '确认轮换', primary: true, onClick: async () => { const r2 = await apiFetch('POST', '/api/prisoner/me/rotate-key'); if (r2.ok) { toast('密钥已轮换'); renderMyPrisoner(); } else toast(r2.error || '失败'); } },
    { label: '取消' },
  ] }));
  box.querySelectorAll('.subtab').forEach((s) => s.addEventListener('click', () => {
    box.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === s));
    s.dataset.psub === 'versions' ? loadPrisonerVersions() : loadMyPrisonerMatches();
  }));
  loadPrisonerVersions();
}

async function loadPrisonerVersions() {
  const box = $('psubBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/prisoner/me/versions');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.versions.length) { box.innerHTML = '<div class="muted-center">还没有版本 —— 复制 Prompt 让 Agent 提交首个脚本。</div>'; return; }
  box.innerHTML = r.versions.map((v) => `
    <div class="ver-row">
      <div class="grow">
        <b>v${v.version}</b> <span class="chip ${v.smoke_status}">${SMOKE_LABEL[v.smoke_status] || v.smoke_status}</span>
        <div class="vmeta">${esc(v.notes || '（无说明）')} · 提交者 ${esc(v.submitted_by || '—')} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
      <button class="mini" data-pver="${v.version}">查看脚本</button>
    </div>`).join('');
  box.querySelectorAll('[data-pver]').forEach((b) => b.addEventListener('click', () => viewPrisonerCode(+b.dataset.pver)));
}
async function viewPrisonerCode(version) {
  const r = await apiFetch('GET', '/api/prisoner/me/version/' + version);
  if (!r.ok) return toast(r.error || '读取失败');
  $('codeTitle').textContent = `脚本 v${version}`;
  $('codeBody').textContent = r.version.code;
  $('codeCopy').onclick = () => copyText(r.version.code, '已复制');
  openModal('codeModal');
}

function pdMatchRow(b, mySideIsCh) {
  // b: 来自 prisonerBattleView
  const cls = b.result === 'win' ? 'win' : b.result === 'loss' ? 'loss' : '';
  const rp = b.scored === 0
    ? '<span class="rp-delta practice">练习赛·不计分</span>'
    : b.rpDelta == null
      ? ''
      : `<span class="rp-delta ${b.rpDelta >= 0 ? 'up' : 'down'}">RP ${b.rpDelta >= 0 ? '+' : ''}${b.rpDelta}</span>`;
  const reasonLabel = { completed: '完赛', illegal: '非法选择判负', runtime: '超时判负', error: '运行异常判负' }[b.reason] || b.reason;
  return `<div class="pd-match-row">
    <span class="chip ${RES_CLS[b.result] || ''}">${RES_LABEL[b.result] || '—'}</span>
    <span class="pd-score-pill ${cls}">${b.myScore} : ${b.oppScore}</span>
    <div class="grow">
      <b>vs ${esc(b.opponentName)}</b> ${rp}
      <div class="vmeta">${b.actualRounds} 回合 · ${reasonLabel} · ${new Date(b.playedAt).toLocaleString()}</div>
    </div>
    <button class="mini" data-pmatch="${esc(b.matchUrlId)}">回放</button>
  </div>`;
}
function bindPdReplays(root) {
  root.querySelectorAll('[data-pmatch]').forEach((b) => b.addEventListener('click', () => openPdReplay(b.dataset.pmatch)));
}
async function loadMyPrisonerMatches() {
  const box = $('psubBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/prisoner/me/matches');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.battles.length) { box.innerHTML = '<div class="muted-center">还没有正式对战记录。</div>'; return; }
  box.innerHTML = r.battles.map((b) => pdMatchRow(b)).join('');
  bindPdReplays(box);
}

async function showPublicPrisoner(prisonerId) {
  document.querySelectorAll('.ptab-panel').forEach((p) => p.classList.remove('active'));
  $('ptab-ppublic').classList.add('active');
  const box = $('ppublicBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const [info, ms] = await Promise.all([
    apiFetch('GET', `/api/prisoners/${prisonerId}/public`),
    apiFetch('GET', `/api/prisoners/${prisonerId}/matches/public`),
  ]);
  if (!info.ok) { box.innerHTML = `<div class="muted-center">${esc(info.error)}</div>`; return; }
  const p = info.prisoner;
  const battles = ms.ok ? ms.battles : [];
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(p.avatar)}</div>
      <div><h2>${esc(p.name)}</h2><div class="muted">玩家 ${esc(p.ownerNickname)} · ${p.status === 'empty' ? '待提交脚本' : '可对战'}</div></div>
      <div style="margin-left:auto"><button class="mini" id="pdBackLb">← 返回天梯榜</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(p.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${p.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${p.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${p.winRate == null ? '—' : p.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${p.wins}-${p.losses}-${p.draws}</b></div>
        <div class="ov-row"><span>当前版本</span><b>v${p.currentVersion}${p.status === 'empty' ? '（空脚本）' : ''}</b></div>
      </div>
      <div class="card">
        <h3>最近对战（${battles.length}）</h3>
        <div id="pdPubMatches">${battles.length ? '' : '<div class="muted-center">还没有正式对战记录。</div>'}</div>
      </div>
    </div>`;
  $('pdBackLb').addEventListener('click', () => showPTab('pleaderboard'));
  const list = $('pdPubMatches');
  if (battles.length) {
    list.innerHTML = battles.map((b) => pdMatchRow(b)).join('');
    bindPdReplays(list);
  }
}

// 回放：决策时间带 + 统计
async function openPdReplay(matchUrlId) {
  const r = await apiFetch('GET', '/api/match/prisoner/' + matchUrlId);
  if (!r.ok) return toast(r.error || '读取失败');
  const m = r.match;
  $('pdReplayTitle').textContent = `${m.challenger.name} vs ${m.challenged.name}（${m.actualRounds} 回合）`;
  const moves = m.moves;
  const failureRound = m.failure && m.failure.round ? m.failure.round : null;
  // 失败时实际进行到 failureRound（包含该回合的 failing 一侧未产出选择）；
  // 但 history 仅写入了完整回合 → 渲染 moves.length 个格子，再标注失败
  const effective = moves.length;

  // 统计
  let cc = 0, dd = 0, cdAB = 0, dcAB = 0;
  let chScoreSum = 0, cdScoreSum = 0;
  const PAYOFF = { C: { C: 3, D: 0 }, D: { C: 5, D: 1 } };
  for (const mv of moves) {
    if (mv.a === 'C' && mv.b === 'C') cc++;
    else if (mv.a === 'D' && mv.b === 'D') dd++;
    else if (mv.a === 'C' && mv.b === 'D') cdAB++;
    else dcAB++;
    chScoreSum += PAYOFF[mv.a][mv.b];
    cdScoreSum += PAYOFF[mv.b][mv.a];
  }
  const coopRate = (n) => effective ? Math.round((n / effective) * 100) : 0;
  const aCoop = moves.filter((x) => x.a === 'C').length;
  const bCoop = moves.filter((x) => x.b === 'C').length;

  const reasonLabel = { completed: '完赛', illegal: '非法选择判负', runtime: '超时判负', error: '运行异常判负' }[m.reason] || m.reason;
  $('pdReplaySummary').innerHTML = `
    <div class="pd-side"><span class="av">${avatarHtml(m.challenger.avatar)}</span><b>${esc(m.challenger.name)}</b></div>
    <div class="pd-score">${m.chScore} : ${m.cdScore}</div>
    <div class="pd-side"><b>${esc(m.challenged.name)}</b><span class="av">${avatarHtml(m.challenged.avatar)}</span></div>
    <div class="pd-meta">· ${m.actualRounds} 回合 · ${reasonLabel}${m.scored === 0 ? ' · 练习赛不计分' : ''}</div>`;

  const renderRow = (key) => moves.map((mv, i) => `<div class="pd-band-cell ${mv[key].toLowerCase()}" title="第 ${i + 1} 回合：${esc(m.challenger.name)} ${mv.a} / ${esc(m.challenged.name)} ${mv.b}"></div>`).join('');
  $('pdReplayBand').innerHTML = `
    ${m.failure ? `<div class="pd-fail-box">⚠ ${esc(reasonLabel)}（第 ${m.failure.round} 回合，${m.failure.side === 'a' ? esc(m.challenger.name) : esc(m.challenged.name)}）：${esc(m.failure.message || '')}</div>` : ''}
    <div class="pd-band-title"><span>${esc(m.challenger.name)}（挑战方）</span><span>合作 ${aCoop} · 背叛 ${effective - aCoop}</span></div>
    <div class="pd-band-row">${renderRow('a')}</div>
    <div class="pd-band-title"><span>${esc(m.challenged.name)}（被挑战方）</span><span>合作 ${bCoop} · 背叛 ${effective - bCoop}</span></div>
    <div class="pd-band-row">${renderRow('b')}</div>
    <div class="pd-band-legend"><span><span class="sw" style="background:#5bb8e8"></span>合作 C</span><span><span class="sw" style="background:#ff8a73"></span>背叛 D</span></div>`;

  $('pdReplayStats').innerHTML = [
    ['合作率（挑战）', coopRate(aCoop) + '%'],
    ['合作率（被挑）', coopRate(bCoop) + '%'],
    ['互合作 CC', cc + '（' + coopRate(cc) + '%）'],
    ['互背叛 DD', dd + '（' + coopRate(dd) + '%）'],
    ['单方剥削', (cdAB + dcAB) + ' 回合'],
    ['平均每回合得分', effective ? ((chScoreSum / effective).toFixed(2) + ' / ' + (cdScoreSum / effective).toFixed(2)) : '—'],
  ].map(([k, v]) => `<div class="pd-stat-card"><div class="label">${k}</div><div class="value">${v}</div></div>`).join('');

  openModal('pdReplayModal');
}

// ============================================================
// 囚徒困境：人机试玩（无回合上限，切换对手才重置）
// ============================================================
const PDPlay = {
  opponent: null,     // { kind, id|prisonerId, name, avatar?, summary? }
  history: [],        // [{me:'C'|'D', opp:'C'|'D'}, ...]
  myScore: 0, oppScore: 0,
  pending: false,
  initialized: false,
};

function ensurePdPlayInit() {
  if (PDPlay.initialized) { pdPlayRender(); return; }
  PDPlay.initialized = true;
  $('pdPlayChangeBtn').addEventListener('click', openPdOppPicker);
  $('pdPlayResetBtn').addEventListener('click', () => {
    if (!PDPlay.opponent) return;
    popup({ icon: '↻', title: '重置本场？', text: `当前对「${PDPlay.opponent.name}」的累计分数将清零，但对手保持不变。`, actions: [
      { label: '确认重置', primary: true, onClick: () => pdPlayReset(false) },
      { label: '取消' },
    ] });
  });
  $('pdPlayCoopBtn').addEventListener('click', () => pdPlayMove('C'));
  $('pdPlayDefectBtn').addEventListener('click', () => pdPlayMove('D'));
  pdPlayRender();
}

function pdPlayReset(alsoClearOpp) {
  PDPlay.history = []; PDPlay.myScore = 0; PDPlay.oppScore = 0; PDPlay.pending = false;
  if (alsoClearOpp) PDPlay.opponent = null;
  pdPlayRender();
}

async function openPdOppPicker() {
  openModal('pdOppModal');
  const tBox = $('pdOppTraining'), pBox = $('pdOppPlayers');
  tBox.innerHTML = '<div class="muted-center">加载中…</div>';
  pBox.innerHTML = '';
  const r = await apiFetch('GET', '/api/prisoner/opponents');
  if (!r.ok) { tBox.innerHTML = `<div class="muted-center">${esc(r.error || '加载失败')}</div>`; return; }
  const trainEmoji = { allc: '🤝', alld: '🔪', rand: '🎲' };
  tBox.innerHTML = r.training.map((o) => `
    <div class="pd-opp-card" data-train="${esc(o.id)}">
      <span class="av">${trainEmoji[o.id] || '🤖'}</span>
      <div class="grow">
        <div class="pd-opp-name">${esc(o.name)}</div>
        <div class="pd-opp-sub">${esc(o.summary || '')}</div>
      </div>
    </div>`).join('');
  pBox.innerHTML = r.players.length
    ? r.players.map((o) => `
      <div class="pd-opp-card" data-player="${o.prisonerId}">
        <span class="av">${avatarHtml(o.avatar)}</span>
        <div class="grow">
          <div class="pd-opp-name">${esc(o.name)}</div>
          <div class="pd-opp-sub">${esc(o.rank)} · RP ${o.rp} · ${esc(o.ownerNickname)}</div>
        </div>
      </div>`).join('')
    : '<div class="muted-center">暂无可对战的玩家囚徒</div>';
  tBox.querySelectorAll('[data-train]').forEach((el) => el.addEventListener('click', () => {
    const o = r.training.find((x) => x.id === el.dataset.train);
    pdPlayPickOpponent({ kind: 'training', id: o.id, name: o.name, summary: o.summary });
  }));
  pBox.querySelectorAll('[data-player]').forEach((el) => el.addEventListener('click', () => {
    const o = r.players.find((x) => String(x.prisonerId) === el.dataset.player);
    pdPlayPickOpponent({ kind: 'prisoner', prisonerId: o.prisonerId, name: o.name, avatar: o.avatar, summary: `${o.rank} · RP ${o.rp}` });
  }));
}

function pdPlayPickOpponent(opp) {
  closeModal('pdOppModal');
  PDPlay.opponent = opp;
  pdPlayReset(false); // 切换对手清零（保留对手）
}

// 训练囚徒 = 本仓库可信代码 → 浏览器内直接算出本回合选择（/builtin-bots.js，零网络）。
// 与服务器 /api/prisoner/play 训练分支同款：me=训练囚徒自身视角，随机源按 roundNumber 复刻。
function pdTrainingReply(id) {
  try {
    if (!window.PdTraining || !window.PdRules) return null;
    const t = PdTraining.getTrainingBot(id);
    const meHist = PDPlay.history.map((h) => h.opp); // 训练囚徒自己的历史选择
    const opHist = PDPlay.history.map((h) => h.me);  // 训练囚徒眼里的对手 = 玩家
    Object.freeze(meHist); Object.freeze(opHist);
    const me = { score: PDPlay.oppScore, history: meHist };
    const op = { score: PDPlay.myScore, history: opHist };
    let s = ((PDPlay.history.length + 1) * 2654435761) >>> 0;
    const random = () => { s = (s + 0x6D2B79F5) | 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
    const game = { roundNumber: PDPlay.history.length + 1, random };
    return PdRules.normalizeChoice(t.onRound(me, op, game));
  } catch { return null; }
}

async function pdPlayMove(myMove) {
  if (!PDPlay.opponent || PDPlay.pending) return;
  // 训练囚徒（可信自有代码）→ 浏览器本地即时结算，零网络
  if (PDPlay.opponent.kind === 'training') {
    const oppMove = pdTrainingReply(PDPlay.opponent.id);
    if (oppMove) {
      const myGain = PdRules.PAYOFF[myMove][oppMove], oppGain = PdRules.PAYOFF[oppMove][myMove];
      PDPlay.history.push({ me: myMove, opp: oppMove });
      PDPlay.myScore += myGain; PDPlay.oppScore += oppGain;
      PDPlay.lastGain = { mine: myGain, opp: oppGain };
      pdPlayRender();
      return;
    }
    // 本地脚本未就绪（bundle 未加载）→ 落到服务器兜底
  }
  PDPlay.pending = true;
  pdPlayRender();
  let r;
  try {
    r = await apiFetch('POST', '/api/prisoner/play', {
      opponent: PDPlay.opponent.kind === 'training'
        ? { kind: 'training', id: PDPlay.opponent.id }
        : { kind: 'prisoner', prisonerId: PDPlay.opponent.prisonerId },
      history: PDPlay.history,
      myMove,
    });
  } finally { PDPlay.pending = false; }
  if (!r.ok) { toast(r.error || '请求失败'); pdPlayRender(); return; }
  if (r.botFailure) {
    const k = r.botFailure.kind === 'illegal' ? '非法选择' : r.botFailure.kind === 'runtime' ? '超时' : '运行异常';
    popup({ icon: '⚠', title: `对手脚本${k}`, text: r.botFailure.message || '本回合无法推进。建议换一个对手或重置本场。', actions: [
      { label: '更换对手', primary: true, onClick: openPdOppPicker },
      { label: '重置本场', onClick: () => pdPlayReset(false) },
      { label: '关闭' },
    ] });
    pdPlayRender();
    return;
  }
  PDPlay.history.push({ me: myMove, opp: r.opponentMove });
  PDPlay.myScore = r.myScore;
  PDPlay.oppScore = r.oppScore;
  PDPlay.lastGain = { mine: r.myGain, opp: r.oppGain };
  pdPlayRender();
}

function pdPlayRender() {
  const hasOpp = !!PDPlay.opponent;
  const avEl = $('pdPlayOppAv'), nameEl = $('pdPlayOppName'), subEl = $('pdPlayOppSub');
  if (hasOpp) {
    if (PDPlay.opponent.kind === 'training') {
      const emoji = { allc: '🤝', alld: '🔪', rand: '🎲' }[PDPlay.opponent.id] || '🤖';
      avEl.innerHTML = `<span style="font-size:28px">${emoji}</span>`;
    } else avEl.innerHTML = avatarHtml(PDPlay.opponent.avatar);
    nameEl.textContent = PDPlay.opponent.name;
    subEl.textContent = PDPlay.opponent.summary || '玩家囚徒';
  } else {
    avEl.innerHTML = '<span style="font-size:24px;opacity:.4">？</span>';
    nameEl.textContent = '未选择对手';
    subEl.textContent = '从下方选一个开始试玩';
  }
  $('pdPlayMyScore').textContent = PDPlay.myScore;
  $('pdPlayOppScore').textContent = PDPlay.oppScore;
  const canMove = hasOpp && !PDPlay.pending;
  $('pdPlayCoopBtn').disabled = !canMove;
  $('pdPlayDefectBtn').disabled = !canMove;
  $('pdPlayResetBtn').disabled = !hasOpp || PDPlay.history.length === 0;

  // 上回合
  const last = PDPlay.history[PDPlay.history.length - 1];
  const lastEl = $('pdPlayLast');
  if (!hasOpp) {
    lastEl.innerHTML = '<span class="muted">先选一个对手 →</span>';
  } else if (PDPlay.pending) {
    lastEl.innerHTML = '<span class="muted">等待对手出手…</span>';
  } else if (!last) {
    lastEl.innerHTML = `<b>第 1 回合</b>　点下方按钮做出选择`;
  } else {
    const myText = last.me === 'C' ? '合作' : '背叛';
    const oppText = last.opp === 'C' ? '合作' : '背叛';
    const myCls = last.me === 'C' ? 'c' : 'd';
    const oppCls = last.opp === 'C' ? 'c' : 'd';
    const g = PDPlay.lastGain || { mine: 0, opp: 0 };
    lastEl.innerHTML = `第 ${PDPlay.history.length} 回合：我 <b class="pd-${myCls}">${myText}</b>，对手 <b class="pd-${oppCls}">${oppText}</b>　<span class="gain ${g.mine >= g.opp ? 'up' : 'down'}">本回合 +${g.mine} / +${g.opp}</span>　→ 进入第 ${PDPlay.history.length + 1} 回合`;
  }

  // 最近 50 回合时间带
  const recent = PDPlay.history.slice(-50);
  const myCoop = PDPlay.history.filter((x) => x.me === 'C').length;
  const oppCoop = PDPlay.history.filter((x) => x.opp === 'C').length;
  $('pdPlayBandMyMeta').textContent = `合作 ${myCoop} · 背叛 ${PDPlay.history.length - myCoop}`;
  $('pdPlayBandOppMeta').textContent = `合作 ${oppCoop} · 背叛 ${PDPlay.history.length - oppCoop}`;
  const cell = (ch) => `<div class="pd-band-cell ${ch === 'C' ? 'c' : 'd'}"></div>`;
  $('pdPlayBandMyRow').innerHTML = recent.length ? recent.map((x) => cell(x.me)).join('') : '<div style="flex:1;text-align:center;color:var(--muted);font-size:12px">尚未对战</div>';
  $('pdPlayBandOppRow').innerHTML = recent.length ? recent.map((x) => cell(x.opp)).join('') : '<div style="flex:1;text-align:center;color:var(--muted);font-size:12px">尚未对战</div>';

  // 统计卡
  const N = PDPlay.history.length;
  let cc = 0, dd = 0, cd = 0, dc = 0;
  for (const h of PDPlay.history) {
    if (h.me === 'C' && h.opp === 'C') cc++;
    else if (h.me === 'D' && h.opp === 'D') dd++;
    else if (h.me === 'C' && h.opp === 'D') cd++;
    else dc++;
  }
  const pct = (n) => N ? Math.round((n / N) * 100) + '%' : '—';
  const stats = [
    ['回合数', N],
    ['我的合作率', N ? Math.round((myCoop / N) * 100) + '%' : '—'],
    ['对手合作率', N ? Math.round((oppCoop / N) * 100) + '%' : '—'],
    ['互合作 CC', N ? `${cc}（${pct(cc)}）` : '—'],
    ['互背叛 DD', N ? `${dd}（${pct(dd)}）` : '—'],
    ['平均每回合', N ? (PDPlay.myScore / N).toFixed(2) + ' / ' + (PDPlay.oppScore / N).toFixed(2) : '—'],
  ];
  $('pdPlayStats').innerHTML = stats.map(([k, v]) => `<div class="pd-stat-card"><div class="label">${k}</div><div class="value">${v}</div></div>`).join('');
}

// ============================================================
// 插件注册
// ============================================================
Platform.registerGame({
  id: 'prisoner',
  onShow() {
    const active = document.querySelector('.tab[data-ptab].active');
    showPTab(active ? active.dataset.ptab : 'pleaderboard');
  },
  showMine() { showPTab('pmybot'); },
  defaultView() { showPTab('pplay'); },
  onAuthChange() { MY_PRISONER_ID = undefined; }, // 登录态变化 → 我的囚徒 id 缓存失效，下次重取
});
