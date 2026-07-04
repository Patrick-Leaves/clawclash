'use strict';
// 钳王争霸 · 前端插件（P4 前端插件化）
// 面板标记在同目录 panel.html，由平台壳（/platform.js）注入 DOM 后再加载本文件。
// 与壳共享全局作用域：直接使用 $ / apiFetch / esc / toast / rankLabel / avatarHtml /
// openModal / popup / copyText / ME 等壳工具；函数命名延续拆分前的单文件时代，全站唯一。
const SIDE_LABEL = { black: '黑方', red: '红方', draw: '和棋' };
const REASON_LABEL = { eliminated:'≤1子判负', material:'20手子力裁定', stalemate:'互停子力裁定', draw:'平局', illegal:'非法走法判负', runtime:'思考点超额判负', error:'运行异常判负' };

// 开局布局：直接取共享规则核心（/game-rules.js，与服务器同一事实源）
function initialBoard() { return GameRules.initBoard(); }

// ============================================================
// 二级导航：试玩 / 天梯榜 / 我的棋手 / Agent 指南（含登录守卫）
// ============================================================
function showTab(name) {
  Platform.activateGame('clawclash'); // 外部跳转（如登录后进「我的棋手」）时确保本游戏面板可见
  document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  const panel = $('tab-' + name); if (panel) panel.classList.add('active');
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'mybot') renderMyBot();
}
document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    if (name === 'mybot' && !(ME && ME.account)) { openAuth('register'); return; }
    showTab(name);
  });
});

// ============================================================
// 创建棋手 / 更换头像：复用壳的通用选手创建组件（文案 + 接口 + 回调按游戏注入）
// ============================================================
const CC_PLAYER_CFG = {
  noun: '棋手', createTitle: '创建棋手', createLabel: '创建棋手', nameLabel: '棋手名称', placeholder: '例如：落叶',
  urls: { create: '/api/bot/create', nameCheck: '/api/bot/name-check', preset: '/api/bot/me/avatar/preset', upload: '/api/bot/me/avatar' },
  async onCreated() { await refreshMe(); showDetail(); toast('棋手已创建'); },
  async onAvatarUpdated() { await refreshMe(); showDetail(); },
};
function openCreateBot() { openCreatePlayer(CC_PLAYER_CFG); }
function openAvatarEditor() { openAvatarEditorShared(CC_PLAYER_CFG, ME && ME.bot && ME.bot.avatar); }

// ============================================================
// 棋子图标：黑色梭子蟹（黑方）/ 红色龙虾（红方）
// ============================================================
function tokenSvg(side) {
  if (side === 'black') {
    return `<svg viewBox="0 0 40 40">
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
    </svg>`;
  }
  return `<svg viewBox="0 0 40 40">
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
  </svg>`;
}
function miniIcon(side) { return `<span class="mini-icon">${tokenSvg(side)}</span>`; }
function verifyBannerHtml() {
  if (!(ME && ME.account) || ME.emailVerified !== false) return '';
  return `<div class="warn-box verify-banner" style="margin-bottom:14px">
    ⚠ 邮箱未验证：发起<b>正式挑战</b>需先验证邮箱（${esc(ME.account.email)}）。
    <button class="mini" id="resendVerifyBtn" style="margin-left:8px">重新发送验证邮件</button>
  </div>`;
}
function bindVerifyBanner() {
  const btn = $('resendVerifyBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const r = await apiFetch('POST', '/api/account/resend-verification');
    if (!r.ok) return toast(r.error || '发送失败');
    if (r.emailVerified) { toast('邮箱已验证'); await refreshMe(); renderMyBot(); return; }
    showVerifyLink(r.verifyUrl);
  });
}
function renderMyBot() {
  const box = $('mybotBody');
  if (!(ME && ME.account)) { box.innerHTML = '<div class="empty-hero"><h2>请先登录</h2><p>登录后即可创建并管理你的棋手。</p></div>'; return; }
  if (!ME.hasBot) {
    box.innerHTML = verifyBannerHtml() + `<div class="empty-hero"><h2>你还没有棋手</h2><p>创建一名棋手，拿到它的棋手密钥，交给你的 Agent 来编写策略。</p><button class="primary" id="createBotOpen">创建棋手 →</button></div>`;
    bindVerifyBanner();
    $('createBotOpen').addEventListener('click', openCreateBot);
    return;
  }
  const b = ME.bot;
  const empty = b.currentVersion === 0;
  box.innerHTML = verifyBannerHtml() + `
    <div class="bot-card">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div class="grow">
        <h2>${esc(b.name)} ${empty ? '<span class="chip empty">空脚本</span>' : '<span class="chip active">可对战</span>'} <span class="chip ver">v${b.currentVersion}</span></h2>
        <div class="stat-row"><span>${rankLabel(b.rp)} · 段位分 ${b.rp || 0} · 天梯排名 ${b.rankPosition ? '#' + b.rankPosition : '—'}</span></div>
        ${empty ? '<div class="warn-box" style="margin-top:10px">脚本为空，棋手尚不能对战 —— 进入详情，复制 Prompt 交给 Agent 提交首个版本。</div>' : ''}
      </div>
      <div class="actions"><button class="primary" id="goDetail">详情</button></div>
    </div>`;
  bindVerifyBanner();
  $('goDetail').addEventListener('click', () => showDetail());
}
// ============================================================
// 棋手详情（自己）
// ============================================================
async function showDetail() {
  showTab('detail');
  const box = $('detailBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const b = r.bot;
  const empty = b.status === 'empty';
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div><h2>${esc(b.name)}</h2><div class="muted">当前工作版本：v${b.currentVersion}${empty ? '（空脚本）' : ''}</div></div>
      <div style="margin-left:auto"><button class="mini" id="editAvatarBtn">更换头像</button></div>
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
        <div class="access-row"><span class="lbl">Agent 指南</span><span class="val"><a href="/agent-guide" target="_blank">/agent-guide</a></span></div>
        <div class="access-actions">
          <button class="primary" id="copyPromptBtn">📋 一键复制 Agent Prompt</button>
          <button class="secondary" id="rotateKeyBtn">轮换密钥</button>
        </div>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab active" data-sub="versions">版本</button>
      <button class="subtab" data-sub="matches">对战记录</button>
    </div>
    <div id="subBody"></div>`;

  $('editAvatarBtn').addEventListener('click', openAvatarEditor);
  $('copyPromptBtn').addEventListener('click', async () => {
    const p = await apiFetch('GET', '/api/bot/me/prompt');
    if (!p.ok) return toast(p.error || '获取失败');
    copyText(p.prompt, '复制成功，粘贴并发送给你的 Agent 即可。');
  });
  $('rotateKeyBtn').addEventListener('click', () => popup({ icon: '🔑', title: '轮换密钥？', text: '旧密钥会立即失效，需重新复制 Prompt 给 Agent。', actions: [
    { label: '确认轮换', primary: true, onClick: async () => { const r2 = await apiFetch('POST', '/api/bot/me/rotate-key'); if (r2.ok) { toast('密钥已轮换'); showDetail(); } else toast(r2.error || '失败'); } },
    { label: '取消' },
  ] }));
  box.querySelectorAll('.subtab').forEach((s) => s.addEventListener('click', () => {
    box.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === s));
    s.dataset.sub === 'versions' ? loadVersions() : loadMyMatches();
  }));
  loadVersions();
}

async function loadVersions() {
  const box = $('subBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me/versions');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.versions.length) { box.innerHTML = '<div class="muted-center">还没有版本 —— 复制 Prompt 让 Agent 提交首个脚本。</div>'; return; }
  box.innerHTML = r.versions.map((v) => `
    <div class="ver-row">
      <div class="grow">
        <b>v${v.version}</b> <span class="chip ${v.smoke_status}">${SMOKE_LABEL[v.smoke_status] || v.smoke_status}</span>
        <div class="vmeta">${esc(v.notes || '（无说明）')} · 提交者 ${esc(v.submitted_by || '—')} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
      <button class="mini" data-ver="${v.version}">查看脚本</button>
    </div>`).join('');
  box.querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', () => viewCode(+b.dataset.ver)));
}
async function viewCode(version) {
  const r = await apiFetch('GET', '/api/bot/me/version/' + version);
  if (!r.ok) return toast(r.error || '读取失败');
  $('codeTitle').textContent = `脚本 v${version}`;
  $('codeBody').textContent = r.version.code;
  $('codeCopy').onclick = () => copyText(r.version.code, '已复制');
  openModal('codeModal');
}
// ---- 对战列表（按场展示，我的详情页 / 公开详情页共用）----
const RES_LABEL = { win: '胜', loss: '负', draw: '平' };
const RES_CLS = { win: 'passed', loss: 'failed', draw: 'pending' };
function battleCardHtml(b) {
  const rp = b.scored === 0
    ? '<span class="rp-delta practice">练习赛·不计分</span>'
    : b.rpDelta == null
      ? '<span class="rp-delta">RP —</span>'
      : `<span class="rp-delta ${b.rpDelta >= 0 ? 'up' : 'down'}">RP ${b.rpDelta >= 0 ? '+' : ''}${b.rpDelta}</span>`;
  const games = b.games.map((g) =>
    `<span class="game-pill ${RES_CLS[g.result]}">第${g.gameNo}局·执${g.mySide === 'black' ? '黑' : '红'} ${RES_LABEL[g.result]}</span>`
  ).join('');
  return `<div class="match-row">
    <span class="chip ${RES_CLS[b.result]}">${RES_LABEL[b.result]}</span>
    <span class="m-av">${avatarHtml(b.opponentAvatar)}</span>
    <div class="grow">
      <b>vs ${esc(b.opponentName)}</b> ${rp}
      <div class="game-pills">${games}</div>
      <div class="vmeta">${new Date(b.playedAt).toLocaleString()}</div>
    </div>
    <button class="mini" data-battle="${esc(b.battleUrlId)}">回放</button>
  </div>`;
}
function bindBattleReplays(root, battles) {
  root.querySelectorAll('[data-battle]').forEach((btn) => btn.addEventListener('click', () => {
    const b = battles.find((x) => x.battleUrlId === btn.dataset.battle);
    if (b) openBattleReplay(b);
  }));
}
async function loadMyMatches() {
  const box = $('subBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me/matches');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.battles.length) { box.innerHTML = '<div class="muted-center">还没有正式对战记录。</div>'; return; }
  box.innerHTML = r.battles.map(battleCardHtml).join('');
  bindBattleReplays(box, r.battles);
}

// ============================================================
// 公开棋手详情页（他人）
// ============================================================
async function showPublicBot(botId) {
  showTab('publicbot');
  const box = $('publicBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const [info, ms] = await Promise.all([
    apiFetch('GET', `/api/bots/${botId}/public`),
    apiFetch('GET', `/api/bots/${botId}/matches/public`),
  ]);
  if (!info.ok) { box.innerHTML = `<div class="muted-center">${esc(info.error)}</div>`; return; }
  const b = info.bot;
  const battles = ms.ok ? ms.battles : [];
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div>
        <h2>${esc(b.name)}</h2>
        <div class="muted">玩家 ${esc(b.ownerNickname)} · ${b.status === 'empty' ? '待提交脚本' : '可对战'}</div>
      </div>
      <div style="margin-left:auto"><button class="mini" id="backToLb">← 返回天梯榜</button></div>
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
        <div id="pubMatches">${battles.length ? '' : '<div class="muted-center">还没有正式对战记录。</div>'}</div>
      </div>
    </div>`;
  $('backToLb').addEventListener('click', () => showTab('leaderboard'));
  const list = $('pubMatches');
  if (battles.length) {
    list.innerHTML = battles.map(battleCardHtml).join('');
    bindBattleReplays(list, battles);
  }
}

// ============================================================
// 天梯
// ============================================================
async function loadLeaderboard() {
  const tbody = $('lbBody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted-center">加载中…</td></tr>';
  try {
    const data = await apiFetch('GET', '/api/leaderboard');
    if (!data.ok) throw new Error(data.error);
    tbody.innerHTML = data.leaderboard.map((b) => `
      <tr class="rank-${b.rank}">
        <td>${b.rank}</td>
        <td><div class="lb-name"><span style="width:28px;height:28px;border-radius:8px;overflow:hidden;display:inline-block">${avatarHtml(b.avatar)}</span>${esc(b.name)}</div></td>
        <td>${esc(b.nickname)}</td>
        <td><span class="chip rank-chip">${esc(b.rankName)}</span></td>
        <td><b>${b.rp}</b></td>
        <td>${b.wins}胜 / ${b.losses}负 / ${b.draws}平</td>
        <td><button class="mini" data-bot="${b.botId}">详情</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted-center">暂无棋手</td></tr>';
    tbody.querySelectorAll('[data-bot]').forEach((btn) => btn.addEventListener('click', () => {
      const id = +btn.dataset.bot;
      if (ME && ME.bot && ME.bot.id === id) showDetail();
      else showPublicBot(id);
    }));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(e.message)}</td></tr>`;
  }
}
$('refreshLb').addEventListener('click', loadLeaderboard);

// ============================================================
// 棋盘渲染（试玩棋盘；正式对局回放在独立弹窗，见文末）
// ============================================================
let state = { match: null, frames: [], cur: 0 };

function cloneBoard(b) { return b.map((col) => col.slice()); }
function countOf(b) { let black=0,red=0; for(let x=0;x<4;x++) for(let y=0;y<4;y++){if(b[x][y]==='black')black++;else if(b[x][y]==='red')red++;} return{black,red}; }
function buildFrames(initBoard, history) {
  const frames=[];let b=cloneBoard(initBoard),ncm=0;
  frames.push({board:cloneBoard(b),move:null,ncm,turn:0,counts:countOf(b)});
  for(const h of history){
    if(!h.pass){ const[fx,fy]=h.from,[tx,ty]=h.to; b[fx][fy]=null;b[tx][ty]=h.side; for(const[cx,cy] of h.captured)b[cx][cy]=null; ncm=h.captured.length>0?0:ncm+1; }
    else ncm=ncm+1;
    frames.push({board:cloneBoard(b),move:h,ncm,turn:h.turn,counts:countOf(b)});
  }
  return frames;
}
function buildBoardCells(){
  const board=$('board');board.innerHTML='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    const cell=document.createElement('div');
    cell.className='cell'+((x+y)%2?' alt':'');
    cell.dataset.x=x;cell.dataset.y=y;
    cell.addEventListener('click',()=>onCellClick(x,y));
    board.appendChild(cell);
  }
}
function cellAt(x,y){return document.querySelector(`#board .cell[data-x="${x}"][data-y="${y}"]`);}
function renderFrame(){
  const f=state.frames[state.cur];if(!f)return;
  document.querySelectorAll('#board .cell').forEach((c)=>{c.classList.remove('lastfrom','lastto','captured','sel','hint','clickable');c.innerHTML='';});
  for(let x=0;x<4;x++)for(let y=0;y<4;y++){
    const v=f.board[x][y];if(!v)continue;
    const t=document.createElement('div');t.className='token '+v;t.innerHTML=tokenSvg(v);
    cellAt(x,y).appendChild(t);
  }
  const mv=f.move;
  if(mv&&!mv.pass){
    cellAt(mv.from[0],mv.from[1])?.classList.add('lastfrom');
    cellAt(mv.to[0],mv.to[1])?.classList.add('lastto');
    for(const[cx,cy]of mv.captured)cellAt(cx,cy)?.classList.add('captured');
  }
  $('blackCount').textContent=f.counts.black;
  $('redCount').textContent=f.counts.red;
  $('turnNo').textContent=f.turn;
  $('ncm').textContent=f.ncm;
  const tm=nextSideToMove();
  $('toMove').innerHTML=tm?`${SIDE_LABEL[tm]}`:'—';
  if(state.match){
    $('infoBlackName').innerHTML=`${miniIcon('black')} ${esc(state.match.blackName||'黑方')}`;
    $('infoRedName').innerHTML=`${miniIcon('red')} ${esc(state.match.redName||'红方')}`;
  }
  document.querySelector('.black-side').classList.toggle('active',tm==='black');
  document.querySelector('.red-side').classList.toggle('active',tm==='red');
  document.querySelectorAll('#moveList li').forEach((li,i)=>li.classList.toggle('cur',i===state.cur-1));
  document.querySelector('#moveList li.cur')?.scrollIntoView({block:'nearest'});
  updateStatusLine();
  $('plyIndicator').textContent=state.frames.length>1?`第 ${state.cur} / ${state.frames.length-1} 手`:'—';
  paintPlayHints();
}
function nextSideToMove(){
  if(play.started&&!play.over)return play.toMove;
  if(state.cur>=state.frames.length-1)return null;
  const next=state.frames[state.cur+1];
  return next&&next.move?next.move.side:null;
}
function updateStatusLine(){
  const banner=$('resultBanner');
  if(!play.started){
    banner.className='result-banner hidden';
    $('statusLine').textContent=play.mode==='local'
      ?'两位玩家同屏交替走子，点击「开始对局」'
      :'选择对手与执方，点击「开始对局」试玩';
    return;
  }
  if(play.over){
    const m=state.match;
    const who=m.winner==='draw'?'和棋':`${SIDE_LABEL[m.winner]}（${m.winner==='black'?m.blackName:m.redName}）胜`;
    if(play.mode==='local'){
      banner.className='result-banner '+(m.winner==='draw'?'':'win');
      banner.innerHTML=`${m.winner==='draw'?'和棋':`🏆 ${esc(m.winner==='black'?m.blackName:m.redName)} 获胜！`}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手</small>`;
    }else{
      const youWon=m.winner===play.humanSide;
      banner.className='result-banner '+(m.winner==='draw'?'':(youWon?'win':''));
      banner.innerHTML=`${m.winner==='draw'?'和棋':(youWon?'🎉 你赢了！':'你输了')}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手</small>`;
    }
    $('statusLine').textContent=`终局：${who}`;
    return;
  }
  banner.className='result-banner hidden';
  if(play.busy&&play.mode!=='local'){ $('statusLine').textContent='你已落子，对手思考中…'; return; }
  if(play.mode==='local'){
    const nm=play.toMove==='black'?play.p1:play.p2;
    $('statusLine').textContent=play.sel?'点击高亮格完成走子，或点其他棋子换选':`轮到 ${SIDE_LABEL[play.toMove]||''} · ${nm}：点击棋子走子`;
  }else{
    $('statusLine').textContent=play.sel?'点击高亮格完成走子，或点其他己方棋子换选':'轮到你走子：点击你的棋子';
  }
}
function renderMoveList(){
  const ol=$('moveList');ol.innerHTML='';
  if(!state.match||!state.match.history)return;
  state.match.history.forEach((h,i)=>{
    const li=document.createElement('li');
    li.innerHTML=moveLiHtml(h,i);
    ol.appendChild(li);
  });
}
// 棋谱行 HTML（试玩 / 回放共用）
function moveLiHtml(h,i){
  const icon=`<span class="mv-side">${tokenSvg(h.side)}</span>`;
  if(h.pass)return `<span class="mv-no">${i+1}</span>${icon}<span class="mv-pass">停一手</span>`;
  const cap=h.captured.length?`<span class="mv-cap">吃${h.captured.length}</span>`:'';
  return `<span class="mv-no">${i+1}</span>${icon}<span>(${h.from})→(${h.to})</span>${cap}`;
}

// ============================================================
// 试玩（挑战棋手 / 双人同屏 两个子界面共用棋盘与状态机）
// mode:'ai' 对战内置机器人或玩家棋手；mode:'local' 双人同屏（轮到谁 humanSide 就是谁）
// opp: { type:'builtin'|'bot', name, botId? }
// ============================================================
const play = { started:false, over:false, mode:'ai', opp:null, humanSide:'black', toMove:null, history:[], legal:[], sel:null, undosLeft:3, busy:false, resultShown:false, p1:'玩家 1', p2:'玩家 2' };

// ---- 试玩子页签切换（切换即重置当前对局）----
document.querySelectorAll('[data-playmode]').forEach((btn) => btn.addEventListener('click', () => {
  const m = btn.dataset.playmode;
  if (m === play.mode) return;
  play.mode = m;
  document.querySelectorAll('[data-playmode]').forEach((x) => x.classList.toggle('active', x.dataset.playmode === m));
  $('playControls').classList.toggle('hidden', m !== 'ai');
  $('localControls').classList.toggle('hidden', m !== 'local');
  resetPlayBoard();
}));
function resetPlayBoard() {
  play.started = false; play.over = false; play.busy = false;
  play.history = []; play.legal = []; play.sel = null; play.resultShown = false;
  state.match = null; state.frames = buildFrames(initialBoard(), []); state.cur = 0;
  renderMoveList(); renderFrame(); updateUndoBtn();
  $('infoBlackName').innerHTML = `${miniIcon('black')} 黑方`;
  $('infoRedName').innerHTML = `${miniIcon('red')} 红方`;
}

// ---- 终局弹窗动画 ----
function showResultOverlay() {
  const m = state.match; if (!m || !m.winner) return;
  const draw = m.winner === 'draw';
  let win;
  if (play.mode === 'local') {
    win = !draw; // 双人同屏：有人赢就撒彩带
    const winnerName = m.winner === 'black' ? m.blackName : m.redName;
    $('rpEmoji').textContent = draw ? '🤝' : '🏆';
    $('rpTitle').textContent = draw ? '和棋' : `${winnerName} 获胜！`;
    $('rpSub').textContent = `${REASON_LABEL[m.reason] || m.reason} · 共 ${m.turns} 手`;
  } else {
    win = m.winner === play.humanSide;
    $('rpEmoji').textContent = draw ? '🤝' : (win ? '🎉' : '🌊');
    $('rpTitle').textContent = draw ? '和棋' : (win ? '胜利！' : '惜败');
    $('rpSub').textContent = `${REASON_LABEL[m.reason] || m.reason} · 共 ${m.turns} 手 · 对手「${play.opp ? play.opp.name : ''}」`;
  }
  $('resultPop').className = 'result-pop ' + (draw ? 'draw' : (win ? 'win' : 'loss'));
  const box = $('confettiBox'); box.innerHTML = '';
  if (win) { // 胜利撒彩带
    const glyphs = ['🎉','✨','🦀','🦞','⭐','💧','🐚'];
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
  openModal('resultOverlay');
}
function maybeShowResult() {
  if (play.over && !play.resultShown) {
    play.resultShown = true;
    setTimeout(showResultOverlay, 420); // 等最后一帧落子动画
  }
}
$('rpAgain').addEventListener('click', () => { closeModal('resultOverlay'); play.mode === 'local' ? startLocalPlay() : startPlay(); });
$('rpClose').addEventListener('click', () => closeModal('resultOverlay'));

function updateUndoBtn(){
  $('undoBtn').textContent=`悔棋（剩 ${play.undosLeft} 次）`;
  const hasHumanMove=play.history.some((h)=>h.side===play.humanSide&&!h.pass);
  $('undoBtn').disabled=play.mode!=='ai'||!play.started||play.busy||play.undosLeft<=0||!hasHumanMove;
  $('undoLocalBtn').disabled=play.mode!=='local'||!play.started||play.busy||!play.history.some((h)=>!h.pass);
}
function paintPlayHints(){
  if(!play.started||play.over||play.busy)return;
  const froms=new Set(play.legal.map((m)=>m.from[0]+','+m.from[1]));
  for(const key of froms){const[x,y]=key.split(',').map(Number);cellAt(x,y)?.classList.add('clickable');}
  if(play.sel){
    cellAt(play.sel[0],play.sel[1])?.classList.add('sel');
    for(const m of play.legal)if(m.from[0]===play.sel[0]&&m.from[1]===play.sel[1])cellAt(m.to[0],m.to[1])?.classList.add('hint');
  }
}
// ---- 走子结果应用（服务器应手 与 前端本地推演 共用，payload 结构一致）----
function buildPlayMatch(r){
  if(play.mode==='local')
    return {blackName:play.p1,redName:play.p2,winner:r.status.winner,reason:r.status.reason,turns:r.status.turns,history:r.history};
  return {
    blackName:play.humanSide==='black'?'你':play.opp.name,
    redName:play.humanSide==='red'?'你':play.opp.name,
    winner:r.status.winner,reason:r.status.reason,turns:r.status.turns,history:r.history,
  };
}
function applyPlayResult(r,{animate=false,prevFrames=0}={}){
  play.history=r.history;
  play.legal=r.legalMoves;
  play.over=r.status.over;
  if(play.mode==='local'){
    play.toMove=r.toMove;
    if(r.toMove)play.humanSide=r.toMove; // 同屏：轮到谁，谁就是「人类执方」
  }else{
    play.toMove=play.over?null:play.humanSide;
  }
  play.sel=null;
  state.match=buildPlayMatch(r);
  state.frames=buildFrames(r.initialBoard,r.history);
  renderMoveList();
  // AI 模式：本地推演停在「该机器人应手」(needBot) 且未终局 → 保持忙碌，等服务器权威应手再解锁
  const keepBusy=play.mode!=='local'&&!!r.needBot&&!r.status.over;
  const finalize=()=>{ if(!keepBusy)play.busy=false; updateUndoBtn(); renderFrame(); maybeShowResult(); };
  if(animate&&state.frames.length>prevFrames&&prevFrames>0){
    // 逐帧播放新增着法（机器人应手 / 多步序列）
    let i=prevFrames-1;
    const stepAnim=()=>{
      i++;state.cur=Math.min(i,state.frames.length-1);renderFrame();
      if(i<state.frames.length-1)setTimeout(stepAnim,380);
      else finalize();
    };
    stepAnim();
  }else{
    state.cur=state.frames.length-1;
    finalize();
  }
}

// ---- 内置对手：浏览器内直接构造（/builtin-bots.js，与服务器同一份可信代码）----
// 供试玩「本地应手」用；玩家上传脚本(不可信)仍走服务器沙箱，clientBot 为 null 时自动回退。
function makeClientBuiltin(name){
  try{ return (window.ClawBuiltins&&ClawBuiltins.findBuiltin(name))||null; }catch{ return null; }
}
// 与 engine/engine_quota.js 同款随机源/取子：保证前端内置对手应手与服务器逐手一致。
function mulberry32(a){
  return function(){
    a|=0;a=(a+0x6D2B79F5)|0;
    let t=Math.imul(a^(a>>>15),1|a);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function piecesOf(board,side){
  const p=[];
  for(let x=0;x<4;x++)for(let y=0;y<4;y++)if(board[x][y]===side)p.push([x,y]);
  return p;
}
// ---- 前端本地推演：复刻 engine/play_session.js，与服务器共享 /game-rules.js 规则核心 ----
// AI 模式：内置对手(bot!=null)浏览器本地应手，零网络；玩家上传脚本(bot==null)推进到机器人回合即
// 停下标记 needBot 交服务器沙箱。local（双人同屏）模式整局自洽，全程无需服务器。
function runLocalPlay(rawHistory, mode, humanSide, bot){
  let board=GameRules.initBoard();
  let side='black', turn=1, ncm=0, lastPass=false;
  const history=[]; let status=null, needBot=false;
  const finish=(w,rs)=>{status={winner:w,reason:rs};};
  function applyStep(mv){
    const r=GameRules.apply(board,side,mv);
    board=r.board; ncm=r.captured.length>0?0:ncm+1;
    history.push({turn,side,from:mv.from.slice(),to:mv.to.slice(),captured:r.captured,pass:false});
    lastPass=false; turn++;
    const v=GameRules.judge(board,ncm);
    if(v)finish(v.winner,v.reason); else side=GameRules.other(side);
  }
  function applyPass(){
    history.push({turn,side,from:null,to:null,captured:[],pass:true});
    ncm++;
    if(lastPass){const c=GameRules.counts(board);finish(c.black===c.red?'draw':(c.black>c.red?'black':'red'),c.black===c.red?'draw':'stalemate');return;}
    lastPass=true; turn++;
    const v=GameRules.judge(board,ncm);
    if(v)finish(v.winner,v.reason); else side=GameRules.other(side);
  }
  for(const h of (rawHistory||[])){
    if(status)break;
    if(h.pass)applyPass(); else applyStep({from:h.from,to:h.to});
  }
  while(!status){
    const moves=GameRules.legalMoves(board,side);
    if(moves.length===0){applyPass();continue;} // 无合法走法自动停一手
    if(mode==='local'||side===humanSide)break;  // 轮到人类，停下等输入
    if(!bot){needBot=true;break;}                // 玩家上传脚本(不可信)：轮到机器人交服务器沙箱
    // 内置对手：浏览器本地算出应手（复刻 engine/play_session.js 机器人分支，含每手计量与同款随机源）
    const oppSide=GameRules.other(side);
    const myPieces=piecesOf(board,side),opPieces=piecesOf(board,oppSide);
    const game={
      board:GameRules.clone(board),turnNumber:turn,noCaptureMoves:ncm,
      legalMoves:moves.map((m)=>({from:m.from.slice(),to:m.to.slice()})),
      history,random:mulberry32((0x5EED^(turn*2654435761))>>>0),
      rules:GameRulesMetered.makeRules(100),
    };
    let mv;
    try{
      mv=bot.onTurn(
        {side,pieces:myPieces,capturedCount:6-myPieces.length},
        {side:oppSide,pieces:opPieces,capturedCount:6-opPieces.length},
        game,
      );
    }catch{finish(humanSide,'error');break;} // 内置对手异常（理论不达）：判人类胜，避免卡死
    const okMv=mv&&mv.from&&mv.to&&moves.some((m)=>m.from[0]===mv.from[0]&&m.from[1]===mv.from[1]&&m.to[0]===mv.to[0]&&m.to[1]===mv.to[1]);
    if(!okMv){finish(humanSide,'illegal');break;}
    applyStep(mv);
  }
  const toMove=status?null:(mode==='local'?side:humanSide);
  const legal=(status||needBot)?[]:GameRules.legalMoves(board,toMove);
  return {
    ok:true, mode, humanSide, toMove, needBot,
    initialBoard:GameRules.initBoard(), history, board, counts:GameRules.counts(board),
    legalMoves:legal,
    status: status?{over:true,winner:status.winner,reason:status.reason,turns:history.length}:{over:false,turns:history.length},
  };
}
// 本地推演 + 渲染（双人同屏全程、AI 人类落子即时反馈、悔棋回放都走这里，零网络）
function localApply(history,{animate=false,bot=null}={}){
  const prevFrames=state.frames.length;
  const r=runLocalPlay(history, play.mode, play.humanSide, bot);
  applyPlayResult(r,{animate,prevFrames});
  return r;
}
// 服务器应手（仅 AI 模式：机器人开局 / 人类落子后的机器人应手）
async function postPlay(history,{animate}={}){
  play.busy=true;updateUndoBtn();
  const prevFrames=state.frames.length;
  const payload={humanSide:play.humanSide,history,...(play.opp.type==='bot'?{botId:play.opp.botId}:{template:play.opp.name})};
  const r=await apiFetch('POST','/api/play',payload);
  if(!r.ok){play.busy=false;updateUndoBtn();toast(r.error||'走子失败');return null;}
  applyPlayResult(r,{animate,prevFrames});
  return r;
}
async function startPlay(){
  const sel=$('oppSel');
  if(!sel.value)return toast('请先选择对手');
  const opt=sel.options[sel.selectedIndex];
  play.opp=sel.value.startsWith('bot:')
    ?{type:'bot',botId:+sel.value.slice(4),name:opt.dataset.name||opt.textContent}
    :{type:'builtin',name:sel.value,clientBot:makeClientBuiltin(sel.value)};
  play.mode='ai';play.started=true;play.over=false;play.humanSide=$('sideSel').value;
  play.history=[];play.legal=[];play.sel=null;play.undosLeft=3;play.busy=false;play.resultShown=false;
  state.match=null;state.frames=[];state.cur=0;
  $('statusLine').textContent='对局开始…';
  if(play.humanSide==='black'){
    localApply([],{animate:false});      // 人类执黑先行：本地初始化，零延迟
  }else if(play.opp.clientBot){
    localApply([],{animate:false,bot:play.opp.clientBot}); // 内置对手：机器人（黑）先手本地应手，零网络
  }else{
    const r=await postPlay([]);           // 玩家棋手：机器人（黑）先手，服务器走第一手
    if(!r){play.started=false;updateUndoBtn();return;}
  }
  toast(`对局开始：你执${play.humanSide==='black'?'梭子蟹（黑方 · 先手）':'龙虾（红方 · 后手）'}，对手「${play.opp.name}」`);
}
function startLocalPlay(){
  play.mode='local';play.started=true;play.over=false;play.opp=null;
  play.p1=$('p1Name').value.trim()||'玩家 1';
  play.p2=$('p2Name').value.trim()||'玩家 2';
  play.history=[];play.legal=[];play.sel=null;play.busy=false;play.resultShown=false;
  state.match=null;state.frames=[];state.cur=0;
  localApply([],{animate:false});        // 双人同屏：全程本地，无需服务器
  toast(`对局开始：${play.p1} 执梭子蟹（黑方）先行，${play.p2} 执龙虾（红方）`);
}
function onCellClick(x,y){
  if(!play.started||play.over||play.busy)return;
  // 点击合法目标 → 走子
  if(play.sel){
    const mv=play.legal.find((m)=>m.from[0]===play.sel[0]&&m.from[1]===play.sel[1]&&m.to[0]===x&&m.to[1]===y);
    if(mv){
      const newHistory=play.history.concat([{side:play.humanSide,from:mv.from,to:mv.to,pass:false}]);
      doHumanMove(newHistory);
      return;
    }
  }
  // 点击己方可动棋子 → 选中/换选
  if(play.legal.some((m)=>m.from[0]===x&&m.from[1]===y)){
    play.sel=(play.sel&&play.sel[0]===x&&play.sel[1]===y)?null:[x,y];
    renderFrame();
  }
}
// 人类落子：双人同屏全程本地；AI 模式先本地即时落子（零延迟），再异步取机器人应手
async function doHumanMove(newHistory){
  if(play.mode==='local'){ localApply(newHistory,{animate:true}); return; }
  const bot=play.opp&&play.opp.clientBot;
  const prevHistory=play.history;
  const interim=localApply(newHistory,{animate:false}); // 人类这步立即落子渲染（不等网络）
  if(interim.status.over) return;     // 人类落子即终局，无需应手
  if(!interim.needBot) return;        // 机器人被迫停手并已轮回人类，本地已完成
  if(bot){ localApply(newHistory,{animate:true,bot}); return; } // 内置对手：浏览器本地应手并播放，零网络
  const r=await postPlay(newHistory,{animate:true}); // 玩家棋手：取服务器沙箱应手并播放
  if(!r) localApply(prevHistory,{animate:false});    // 应手失败 → 回滚到落子前，恢复人类可走
}
function undoMove(){
  if(play.undosLeft<=0||play.busy)return;
  let lastHuman=-1;
  for(let i=play.history.length-1;i>=0;i--){
    if(play.history[i].side===play.humanSide&&!play.history[i].pass){lastHuman=i;break;}
  }
  if(lastHuman<0)return toast('还没有可悔的着法');
  play.undosLeft--;play.over=false;play.resultShown=false;closeModal('resultOverlay');
  const truncated=play.history.slice(0,lastHuman).map((h)=>({side:h.side,from:h.from,to:h.to,pass:h.pass}));
  localApply(truncated,{animate:false}); // 悔棋后轮到人类，纯本地回放即可（无需服务器）
  toast(`已悔棋（剩 ${play.undosLeft} 次）`);
}
// 双人同屏悔棋：撤销最后一步实际走子（不限次数，双方协商使用）
function undoLocal(){
  if(!play.started||play.busy)return;
  let last=-1;
  for(let i=play.history.length-1;i>=0;i--){
    if(!play.history[i].pass){last=i;break;}
  }
  if(last<0)return toast('还没有可悔的着法');
  play.over=false;play.resultShown=false;closeModal('resultOverlay');
  const truncated=play.history.slice(0,last).map((h)=>({side:h.side,from:h.from,to:h.to,pass:h.pass}));
  localApply(truncated,{animate:false});
  toast('已悔一手');
}
$('startPlayBtn').addEventListener('click',startPlay);
$('undoBtn').addEventListener('click',undoMove);
$('startLocalBtn').addEventListener('click',startLocalPlay);
$('undoLocalBtn').addEventListener('click',undoLocal);

// ============================================================
// 玩家棋手搜索（挑战棋手子界面）
// ============================================================
let botSearchTimer=null;
$('botSearch').addEventListener('input',()=>{
  clearTimeout(botSearchTimer);
  const q=$('botSearch').value.trim();
  if(!q){hideBotSearch();return;}
  botSearchTimer=setTimeout(doBotSearch,300);
});
async function doBotSearch(){
  const q=$('botSearch').value.trim();
  if(!q)return;
  const r=await apiFetch('GET','/api/bots/search?q='+encodeURIComponent(q));
  if(q!==$('botSearch').value.trim())return; // 输入已变化，丢弃过期结果
  if(!r.ok)return;
  const box=$('botSearchResults');
  if(!r.bots.length){
    box.innerHTML='<div class="search-empty">没有找到匹配的棋手</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML=r.bots.map((b)=>`
    <div class="search-item${b.playable?'':' disabled'}" data-id="${b.botId}" data-name="${esc(b.name)}">
      <span class="s-av">${avatarHtml(b.avatar)}</span>
      <span class="s-info"><b>${esc(b.name)}</b><small>${esc(b.ownerNickname)} · ${esc(b.rank)}</small></span>
      <span class="s-tag">${b.playable?'可挑战':'空脚本'}</span>
    </div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.search-item:not(.disabled)').forEach((el)=>el.addEventListener('click',()=>selectPlayerBot(+el.dataset.id,el.dataset.name)));
}
function selectPlayerBot(botId,name){
  const sel=$('oppSel');
  let og=sel.querySelector('optgroup[label="玩家棋手"]');
  if(!og){og=document.createElement('optgroup');og.label='玩家棋手';sel.appendChild(og);}
  let opt=og.querySelector(`option[value="bot:${botId}"]`);
  if(!opt){
    opt=document.createElement('option');
    opt.value='bot:'+botId;opt.dataset.name=name;opt.textContent=`${name}（玩家棋手）`;
    og.appendChild(opt);
  }
  sel.value='bot:'+botId;
  $('botSearch').value='';hideBotSearch();
  toast(`已选择对手「${name}」，点击「开始对局」`);
}
function hideBotSearch(){$('botSearchResults').classList.add('hidden');$('botSearchResults').innerHTML='';}
document.addEventListener('click',(e)=>{if(!e.target.closest('.search-box'))hideBotSearch();});

// ============================================================
// 对局回放（正式对局 · 独立弹窗，与试玩棋盘完全隔离）
// ============================================================
const rstate = { match: null, frames: [], cur: 0, timer: null, playing: false };

function rCellAt(x,y){return document.querySelector(`#rBoard .cell[data-x="${x}"][data-y="${y}"]`);}
function buildReplayCells(){
  const board=$('rBoard');board.innerHTML='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    const cell=document.createElement('div');
    cell.className='cell'+((x+y)%2?' alt':'');
    cell.dataset.x=x;cell.dataset.y=y;
    board.appendChild(cell);
  }
}
function rRenderFrame(){
  const f=rstate.frames[rstate.cur];if(!f)return;
  document.querySelectorAll('#rBoard .cell').forEach((c)=>{c.classList.remove('lastfrom','lastto','captured');c.innerHTML='';});
  for(let x=0;x<4;x++)for(let y=0;y<4;y++){
    const v=f.board[x][y];if(!v)continue;
    const t=document.createElement('div');t.className='token '+v;t.innerHTML=tokenSvg(v);
    rCellAt(x,y).appendChild(t);
  }
  const mv=f.move;
  if(mv&&!mv.pass){
    rCellAt(mv.from[0],mv.from[1])?.classList.add('lastfrom');
    rCellAt(mv.to[0],mv.to[1])?.classList.add('lastto');
    for(const[cx,cy]of mv.captured)rCellAt(cx,cy)?.classList.add('captured');
  }
  $('rBlackCount').textContent=f.counts.black;
  $('rRedCount').textContent=f.counts.red;
  $('rTurnNo').textContent=f.turn;
  $('rNcm').textContent=f.ncm;
  const next=rstate.cur<rstate.frames.length-1?rstate.frames[rstate.cur+1]:null;
  const tm=next&&next.move?next.move.side:null;
  $('rToMove').textContent=tm?SIDE_LABEL[tm]:'—';
  document.querySelector('#replayModal .black-side').classList.toggle('active',tm==='black');
  document.querySelector('#replayModal .red-side').classList.toggle('active',tm==='red');
  document.querySelectorAll('#rMoveList li').forEach((li,i)=>li.classList.toggle('cur',i===rstate.cur-1));
  document.querySelector('#rMoveList li.cur')?.scrollIntoView({block:'nearest'});
  // 终局横幅：播到最后一手时展示
  const m=rstate.match,banner=$('rResultBanner');
  if(m&&rstate.cur===rstate.frames.length-1){
    const who=m.winnerSide==='draw'?'和棋':`${esc(m.winnerSide==='black'?m.blackName:m.redName)}（${SIDE_LABEL[m.winnerSide]}）胜`;
    banner.className='result-banner '+(m.winnerSide==='draw'?'':'win');
    banner.innerHTML=`${who}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手</small>`;
  }else banner.className='result-banner hidden';
  $('rPlyIndicator').textContent=rstate.frames.length>1?`第 ${rstate.cur} / ${rstate.frames.length-1} 手`:'—';
}
function rGoTo(i){rstate.cur=Math.max(0,Math.min(rstate.frames.length-1,i));rRenderFrame();}
function rStep(d){rGoTo(rstate.cur+d);}
function rPause(){rstate.playing=false;clearTimeout(rstate.timer);$('rPlayPause').textContent='▶ 播放';}
function rTick(){clearTimeout(rstate.timer);if(!rstate.playing)return;if(rstate.cur>=rstate.frames.length-1){rPause();return;}rStep(1);rstate.timer=setTimeout(rTick,+$('rSpeed').value);}
function rPlay(){if(rstate.cur>=rstate.frames.length-1)rstate.cur=0;rstate.playing=true;$('rPlayPause').textContent='⏸ 暂停';rTick();}
function rTogglePlay(){rstate.playing?rPause():rPlay();}
function rRenderMoveList(){
  const ol=$('rMoveList');ol.innerHTML='';
  rstate.match.history.forEach((h,i)=>{
    const li=document.createElement('li');
    li.innerHTML=moveLiHtml(h,i);
    li.addEventListener('click',()=>{rPause();rGoTo(i+1);});
    ol.appendChild(li);
  });
}
// 一场两局：弹窗顶部 tab 切换查看每局棋谱
const battleReplay = { games: [], cur: 0 };
function openBattleReplay(battle) {
  battleReplay.games = battle.games || [];
  battleReplay.cur = 0;
  renderReplayTabs();
  loadReplayGame(0);
}
function renderReplayTabs() {
  const box = $('rGameTabs');
  if (battleReplay.games.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = battleReplay.games.map((g, i) =>
    `<button class="game-tab${i === battleReplay.cur ? ' active' : ''}" data-g="${i}">第 ${g.gameNo} 局 · ${RES_LABEL[g.result]}</button>`
  ).join('');
  box.querySelectorAll('[data-g]').forEach((btn) => btn.addEventListener('click', () => {
    const i = +btn.dataset.g;
    if (i === battleReplay.cur) return;
    battleReplay.cur = i; renderReplayTabs(); loadReplayGame(i);
  }));
}
async function loadReplayGame(idx) {
  const g = battleReplay.games[idx];
  if (!g) return;
  const r = await apiFetch('GET', '/api/match/' + g.matchUrlId);
  if (!r.ok) return toast(r.error || '加载失败');
  // 挑战双方执方由 challenger_side 决定（第 2 局挑战者执红）
  const chSide = r.challenger_side === 'red' ? 'red' : 'black';
  const cdSide = chSide === 'black' ? 'red' : 'black';
  const names = { [chSide]: r.challengerName, [cdSide]: r.challengedName };
  const avatars = { [chSide]: r.challengerAvatar, [cdSide]: r.challengedAvatar };
  const winnerSide = r.winner === 'draw' ? 'draw' : (r.winner === 'challenger' ? chSide : cdSide);
  rstate.match = { blackName: names.black, redName: names.red, winnerSide, reason: r.reason, turns: r.turns, history: r.gameData.history };
  rstate.frames = buildFrames(r.gameData.initialBoard, r.gameData.history);
  rstate.cur = 0; rPause();
  $('replayTitle').innerHTML = `对局回放 · <span class="t-av">${avatarHtml(avatars.black)}</span>${esc(names.black || '黑方')} vs <span class="t-av">${avatarHtml(avatars.red)}</span>${esc(names.red || '红方')} · 第 ${g.gameNo} 局`;
  $('rBlackName').innerHTML = `${miniIcon('black')}<span class="r-av">${avatarHtml(avatars.black)}</span>${esc(names.black || '黑方')}`;
  $('rRedName').innerHTML = `${miniIcon('red')}<span class="r-av">${avatarHtml(avatars.red)}</span>${esc(names.red || '红方')}`;
  rRenderMoveList(); rRenderFrame();
  openModal('replayModal');
}
$('rPlayPause').addEventListener('click',rTogglePlay);
$('rNext').addEventListener('click',()=>{rPause();rStep(1);});
$('rPrev').addEventListener('click',()=>{rPause();rStep(-1);});
$('rToStart').addEventListener('click',()=>{rPause();rGoTo(0);});
$('rToEnd').addEventListener('click',()=>{rPause();rGoTo(rstate.frames.length-1);});
// 关闭弹窗（✕ 或点遮罩）时停止自动播放
$('replayModal').addEventListener('click',(e)=>{
  if(e.target===$('replayModal')||e.target.dataset.close==='replayModal')rPause();
});
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  if($('replayModal').classList.contains('hidden'))return;
  if(e.key==='ArrowRight'){rPause();rStep(1);}
  else if(e.key==='ArrowLeft'){rPause();rStep(-1);}
  else if(e.key===' '){e.preventDefault();rTogglePlay();}
  else if(e.key==='Escape'){rPause();closeModal('replayModal');}
});

$('rulesHint').addEventListener('click',()=>$('rulesPanel').classList.toggle('hidden'));

// ============================================================
// 玩法教程弹窗（迷你棋盘复用 tokenSvg，示例取自吃子规则）
// ============================================================
function tutCellCenter(x,y){return [8+x*46+21, 8+(3-y)*46+21];} // 迷你棋盘 196px：padding 8 + 格 42 + 间隙 4
function tutArrowSvg(from,to,id){
  const[x1,y1]=tutCellCenter(from[0],from[1]),[x2,y2]=tutCellCenter(to[0],to[1]);
  return `<svg class="mb-arrow" width="196" height="196" viewBox="0 0 196 196"><defs><marker id="${id}" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="var(--mint-dp)"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--mint-dp)" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 7" marker-end="url(#${id})"/></svg>`;
}
function miniBoardHtml(cfg,id){
  const has=(arr,x,y)=>arr&&arr.some((p)=>p[0]===x&&p[1]===y);
  let cells='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    let cls='mb-cell'+((x+y)%2?' alt':'');
    if(has(cfg.pairRed,x,y))cls+=' pair-red';
    if(has(cfg.pair,x,y))cls+=' pair';
    if(cfg.ring&&cfg.ring[0]===x&&cfg.ring[1]===y)cls+=' ring';
    const v=cfg.layout[x+','+y];
    let inner=v?`<div class="mb-token">${tokenSvg(v)}</div>`:'';
    if(has(cfg.captured,x,y))inner+='<div class="mb-cap">✕</div>';
    if(cfg.banned&&cfg.banned[0]===x&&cfg.banned[1]===y)inner+='<div class="mb-safe">🛡️</div>';
    cells+=`<div class="${cls}">${inner}</div>`;
  }
  return `<div class="mini-board-wrap"><div class="mini-board">${cells}</div>${cfg.arrow?tutArrowSvg(cfg.arrow[0],cfg.arrow[1],id):''}</div>`;
}
const TUT_EX=[
  {n:1,title:'基本吃子',sideTag:'黑方走子',sideCls:'black',
   before:{layout:{'0,1':'black','1,2':'black','2,1':'red'},arrow:[[1,2],[1,1]]},
   after:{layout:{'0,1':'black','1,1':'black'},ring:[1,1],pair:[[0,1],[1,1]],captured:[[2,1]]},
   capB:'黑方梭子蟹从 (1,2) 移到 (1,1)。',
   capA:'落子后只看新位置的横线 y=1：黑方 2 连「(0,1)(1,1)」+ 相邻一颗红子 → 吃掉 (2,1) 的红子。'},
  {n:2,title:'送上门不吃',sideTag:'黑方走子',sideCls:'black',
   before:{layout:{'1,1':'red','2,1':'red','0,2':'black'},arrow:[[0,2],[0,1]]},
   after:{layout:{'0,1':'black','1,1':'red','2,1':'red'},ring:[0,1],pairRed:[[1,1],[2,1]],banned:[0,1]},
   capB:'红方已有 2 连「(1,1)(2,1)」，黑方主动把子移到旁边的 (0,1)。',
   capA:'虽凑成「红 2 连 + 黑 1 子」，但吃子只由“走棋方”触发。本手是黑走，黑自己的 (0,1) 不会被吃——送上门不吃。'},
  {n:3,title:'双线同吃',sideTag:'红方走子',sideCls:'red',
   before:{layout:{'1,0':'red','0,1':'red','1,2':'red','2,1':'black','1,3':'black'},arrow:[[1,0],[1,1]]},
   after:{layout:{'1,1':'red','0,1':'red','1,2':'red'},ring:[1,1],pair:[[0,1],[1,1],[1,2]],captured:[[2,1],[1,3]]},
   capB:'红方龙虾从 (1,0) 移到中央的 (1,1)。',
   capA:'只结算新位置 (1,1)：横线吃 (2,1)、竖线吃 (1,3)，一步吃 2 子。单手至多 2 子、不连锁。'}
];
const TUT_STEPS=[
  {title:'棋盘与目标',body:`<p class="tut-p"><b>4×4 棋盘</b>，黑方<b>梭子蟹</b> vs 红方<b>龙虾</b>，各 6 子，黑方先行。<br>坐标 (x, y) 以<b>左下角为原点 (0,0)</b>，右上角 (3,3)。<br><br><b>目标：</b>把对手吃到只剩 ≤1 子，或在子力裁定时领先对方。</p>`},
  {title:'怎么走',body:`<p class="tut-p">每一手，选自己的一颗棋子，沿<b>横向或纵向</b>移动到<b>相邻的空格</b>。<br><br>· 一次只走一格　· 不能斜走　· 不能跨过其它棋子<br>· 无子可动时由系统自动停一手（pass）</p>`},
  {title:'吃子规则',body:null},
  {title:'胜负判定',body:`<p class="tut-p"><b>吃光取胜：</b>对手 ≤1 子 → 你胜（eliminated）。<br><b>子力裁定：</b>连续 20 手无吃子 → 比子数，<b>领先 1 子即胜</b>（material）。<br><b>互停裁定：</b>双方连续停手 → 按子力裁定（stalemate）。</p>`}
];
let tutCur=0;
const tutShown=[false,false,false];
function tutRenderExample(i){
  const ex=TUT_EX[i];
  $('exBoard'+i).innerHTML=miniBoardHtml(tutShown[i]?ex.after:ex.before,'mk'+i);
  $('exCap'+i).innerHTML=(tutShown[i]?'<b class="cap-after">走子后 → </b>':'<b class="cap-before">走子前 · </b>')+(tutShown[i]?ex.capA:ex.capB);
  const btn=document.querySelector('.tut-play[data-ex="'+i+'"]');
  if(btn)btn.textContent=tutShown[i]?'↺ 重置':'▶ 演示走子';
}
function tutCaptureHtml(){
  let s=`<div class="tut-card tut-tip"><p>💡 <b>核心口诀：</b>落子后只看<b>新位置</b>的横线和竖线；凑成「<b>己方 2 连 + 紧邻对方 1 子</b>」就吃掉那 1 子。双线可同吃（单手至多 2 子）、<b>不连锁</b>、<b>送上门不吃</b>。</p></div>`;
  TUT_EX.forEach((ex,i)=>{s+=`<div class="tut-card ex-card"><div class="ex-head"><span class="ex-no">${ex.n}</span><b>${ex.title}</b><span class="ex-tag ${ex.sideCls}">${ex.sideTag}</span></div><div class="ex-body"><div class="ex-board" id="exBoard${i}"></div><div class="ex-right"><p class="ex-cap" id="exCap${i}"></p><button class="tut-play" data-ex="${i}">▶ 演示走子</button></div></div></div>`;});
  return s;
}
function tutRenderStep(){
  $('tutBody').innerHTML=tutCur===2?tutCaptureHtml():`<div class="tut-card">${TUT_STEPS[tutCur].body}</div>`;
  document.querySelectorAll('#tutSteps .tut-chip').forEach((c,i)=>c.classList.toggle('on',i===tutCur));
  $('tutDots').textContent=(tutCur+1)+' / '+TUT_STEPS.length;
  $('tutPrev').style.visibility=tutCur===0?'hidden':'visible';
  $('tutNext').textContent=tutCur===TUT_STEPS.length-1?'开始试玩 ✓':'下一步 →';
  if(tutCur===2){
    [0,1,2].forEach((i)=>{tutShown[i]=false;tutRenderExample(i);});
    document.querySelectorAll('.tut-play').forEach((b)=>b.addEventListener('click',()=>{const i=+b.dataset.ex;tutShown[i]=!tutShown[i];tutRenderExample(i);}));
  }
}
const TUT_SEEN_KEY='clawclash_tut_seen';
function tutSeen(){try{return localStorage.getItem(TUT_SEEN_KEY);}catch{return true;}} // 隐私模式不可用时视作已看，不闪
function tutMarkSeen(){try{localStorage.setItem(TUT_SEEN_KEY,'1');}catch{}}
function tutInit(){
  $('tutSteps').innerHTML=TUT_STEPS.map((s,i)=>`<button class="tut-chip" data-i="${i}">${['①','②','③','④'][i]} ${s.title}</button>`).join('');
  document.querySelectorAll('#tutSteps .tut-chip').forEach((c)=>c.addEventListener('click',()=>{tutCur=+c.dataset.i;tutRenderStep();}));
  $('tutPrev').addEventListener('click',()=>{if(tutCur>0){tutCur--;tutRenderStep();}});
  $('tutNext').addEventListener('click',()=>{if(tutCur<TUT_STEPS.length-1){tutCur++;tutRenderStep();}else closeModal('tutorialModal');});
  $('tutorialBtn').addEventListener('click',()=>{$('tutorialBtn').classList.remove('pulse');tutMarkSeen();tutCur=0;openModal('tutorialModal');tutRenderStep();});
  if(!tutSeen())$('tutorialBtn').classList.add('pulse'); // 首次访问脉冲提示，打开一次后不再闪
}

async function loadTemplates(){
  const data=await apiFetch('GET','/api/templates');
  const opt=(t)=>`<option value="${esc(t.name)}" title="${esc(t.summary)}">${esc(t.name)} — ${esc(t.summary)}</option>`;
  const tpl=data.templates.filter((t)=>t.kind!=='training');
  const train=data.templates.filter((t)=>t.kind==='training');
  $('oppSel').innerHTML=
    `<optgroup label="评估流派">${tpl.map(opt).join('')}</optgroup>`+
    (train.length?`<optgroup label="训练棋手">${train.map(opt).join('')}</optgroup>`:'');
}


// ============================================================
// 插件注册（壳在面板注入 + 脚本加载完成后统一调用 init）
// ============================================================
Platform.registerGame({
  id: 'clawclash',
  async init() {
    buildBoardCells();
    buildReplayCells();
    tutInit();
    state.frames = buildFrames(initialBoard(), []);
    state.cur = 0; renderFrame();
    await loadTemplates();
    updateUndoBtn();
  },
  onShow() {
    const active = document.querySelector('.tab[data-tab].active');
    showTab(active ? active.dataset.tab : 'play');
  },
  showMine() { showTab('mybot'); },
  defaultView() { showTab('play'); },
});
