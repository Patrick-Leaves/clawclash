'use strict';
// 囚徒困境 · 游戏描述（manifest）。
// 子进程安全：会被 runner 子进程经 games/registry 加载，绝不 require db/auth（服务端适配见 ./server.js）。
const { playPrisonerMatch, MIN_ROUNDS, MAX_ROUNDS } = require('./engine/engine');
const { makePrisonerBot } = require('./engine/sandbox');
const { runPrisonerSmokeTests } = require('./engine/smoke');
const { normalizeChoice } = require('./engine/rules');
const { buildGuide } = require('./guide');

const SCORED_LIMIT = 10;

module.exports = {
  id: 'prisoner',
  name: '囚徒困境',
  nameEn: 'Dilemma',
  tagline: '900–1100 回合的重复博弈，合作与背叛之间的长线心理战。',
  noun: '囚徒',
  keyParam: 'prisoner_key',
  idField: 'prisonerId',
  wrapKey: 'prisoner',
  avatarPrefix: 'p',
  scoredLimit: SCORED_LIMIT,
  leaderboardTtlMs: 10000,
  guidePath: '/agent-guide-prisoner',
  guideMarkdown: buildGuide({ minRounds: MIN_ROUNDS, maxRounds: MAX_ROUNDS, scoredLimit: SCORED_LIMIT }),
  // 前端插件（P4）：/builtin-bots.js 提供训练囚徒的浏览器本地执行（与钳王共享，去重加载）
  // nav：壳层统一渲染的侧栏二级导航（key 须与 app.js 里 makeTabs 的 tab 名一致；auth=需登录；
  // hash=该 tab 在 URL 里的深链接名，如 /g/prisoner#leaderboard，缺省=key）
  client: {
    scripts: ['/builtin-bots.js', '/games/prisoner/app.js'],
    nav: [
      { key: 'pplay', hash: 'play', label: '试玩' },
      { key: 'pleaderboard', hash: 'leaderboard', label: '天梯榜' },
      { key: 'pmybot', hash: 'mybot', label: '我的囚徒', auth: true },
      { key: 'pguide', hash: 'guide', label: 'Agent 指南' },
    ],
  },
  minRounds: MIN_ROUNDS,
  maxRounds: MAX_ROUNDS,

  // ---- runner 子进程任务 ----
  limits: {
    smoke: 90000,        // 烟雾 6 场（每场 ≤1100 回合 × 50ms）→ 给足余量
    challenge: 30000,    // 单场正式挑战
    'play-one': 5000,    // 试玩单回合推进（玩家囚徒脚本走子进程）
  },
  tasks: {
    smoke: (t) => runPrisonerSmokeTests(t.code),
    challenge(t) {
      const { bot: aBot } = makePrisonerBot(t.aCode);
      const { bot: bBot } = makePrisonerBot(t.bCode);
      if (!aBot || !bBot) return { loadFailed: true };
      return playPrisonerMatch({ a: aBot, b: bBot }, t.seed);
    },
    // 试玩单回合推进：接收完整 history + 玩家本回合选择 → 调用一次玩家 bot 给出应手
    'play-one'(t) {
      const { bot, error } = makePrisonerBot(t.code);
      if (!bot) return { loadFailed: true, error: error && error.message };
      // 玩家视角：myHistory = 玩家选择数组；botHistory = bot 历史选择
      // 对 bot 来说：me.history = bot 之前选择；opponent.history = 玩家选择
      const me = { score: t.botScore || 0, history: t.botHistory.slice() };
      const opp = { score: t.myScore || 0, history: t.myHistory.slice() };
      Object.freeze(me.history); Object.freeze(opp.history);
      const game = { roundNumber: t.roundNumber, random: () => Math.random() };
      let raw;
      try { raw = bot.onRound(me, opp, game); }
      catch (e) {
        return { failure: { kind: (e && e.runtime) ? 'runtime' : 'error', message: (e && e.message) || String(e) } };
      }
      const ch = normalizeChoice(raw);
      if (ch == null) return { failure: { kind: 'illegal', message: `返回非法选择: ${JSON.stringify(raw)}` } };
      return { move: ch };
    },
  },
};
