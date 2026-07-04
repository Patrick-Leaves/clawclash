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
  client: { scripts: ['/game-rules.js', '/builtin-bots.js', '/games/clawclash/app.js'] },

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
