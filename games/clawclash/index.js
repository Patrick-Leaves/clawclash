'use strict';
// 钳王争霸 · 游戏描述（manifest）。
// 子进程安全：本文件会被 runner 子进程经 games/registry 加载，
// 绝不 require db/auth 等服务端资源（服务端适配见 ./server.js）。
const { playMatch } = require('./engine/engine_quota');
const { makeBot } = require('./engine/sandbox');
const { runSmokeTests } = require('./engine/smoke');
const { runPlay } = require('./engine/play_session');
const { findBuiltin } = require('./engine/builtins');
const { buildGuide } = require('./guide');

const SCORED_LIMIT = 10;   // 反刷分：同一哈希对的计分场数上限
const MATCH_BUDGET = 100;  // 每手思考点（§6：抹平机器快慢对搜索深度的影响）

function pick(g) { return { winner: g.winner, reason: g.reason, turns: g.turns, history: g.history, finalPieces: g.finalPieces }; }

module.exports = {
  id: 'clawclash',
  name: '钳王争霸',
  nameEn: 'Claw Clash',
  tagline: '梭子蟹对阵小龙虾的 4×4 吃子棋，机动、换子与中心控制的短兵相接。',
  noun: '棋手',
  keyParam: 'bot_key',        // 指南/鉴权报错里的密钥占位名
  idField: 'botId',           // 对外 JSON 的 id 字段名（兼容既有契约）
  wrapKey: 'bot',             // info/me/public 响应的包装键
  avatarPrefix: '',           // 头像文件名前缀（各游戏隔离，防 id 撞名互覆盖）
  scoredLimit: SCORED_LIMIT,
  matchBudget: MATCH_BUDGET,
  leaderboardTtlMs: 15000,
  guidePath: '/agent-guide',  // legacy 指南路径（已发布给 Agent 的稳定契约）
  guideMarkdown: buildGuide({ scoredLimit: SCORED_LIMIT }),
  // 前端插件（P4）：壳按序加载；规则核心/内置对手包为共享资产，多游戏声明会去重加载
  // nav：壳层统一渲染的侧栏二级导航（key 须与 app.js 里 makeTabs 的 tab 名一致；auth=需登录；
  // hash=该 tab 的 URL 深链接名（缺省=key，本游戏 key 本身即干净英文名，如 /g/clawclash#leaderboard）
  client: {
    scripts: ['/game-rules.js', '/builtin-bots.js', '/games/clawclash/app.js'],
    nav: [
      { key: 'play', label: '试玩' },
      { key: 'leaderboard', label: '天梯榜' },
      { key: 'mybot', label: '我的棋手', auth: true },
      { key: 'guide', label: 'Agent 指南' },
    ],
  },

  // ---- runner 子进程任务（执行不可信代码；键 = execpool.run 的 kind）----
  // limits: 各任务的父进程硬超时（超时 SIGKILL 子进程）
  limits: {
    smoke: 90000,      // 烟雾 6 局（每局封顶 ~10s）→ 给足余量
    challenge: 40000,  // 正式挑战 2 局
    play: 20000,       // 试玩单请求推进若干手
  },
  tasks: {
    smoke: (t) => runSmokeTests(t.code),
    challenge(t) {
      const { bot: chBot } = makeBot(t.chCode);
      const { bot: cdBot } = makeBot(t.cdCode);
      if (!chBot || !cdBot) return { loadFailed: true };
      const g1 = playMatch({ black: chBot, red: cdBot }, t.seed, t.budget);
      const g2 = playMatch({ black: cdBot, red: chBot }, t.seed + 1, t.budget);
      return { game1: pick(g1), game2: pick(g2) };
    },
    play: (t) => runPlay(t.spec, { makeBot, findBuiltin }),
  },
};
