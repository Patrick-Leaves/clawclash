'use strict';
// 象棋暗战 · 游戏描述（manifest）。
// 子进程安全：本文件会被 runner 子进程经 games/registry 加载，
// 绝不 require db/auth 等服务端资源（服务端适配见 ./server.js）。
const { playMatch } = require('./engine/engine');
const { makeBot } = require('./engine/sandbox');
const { runSmokeTests } = require('./engine/smoke');
const { runPlay } = require('./engine/play_session');
const { findBuiltin } = require('./engine/builtins');
const { buildGuide } = require('./guide');

const SCORED_LIMIT = 10; // 反刷分：同一哈希对的计分场数上限

function pick(g) {
  return {
    winner: g.winner, reason: g.reason, turns: g.turns, history: g.history,
    initialBoard: g.initialBoard, finalCounts: g.finalCounts, finalValues: g.finalValues,
  };
}

module.exports = {
  id: 'darkchess',
  name: '象棋暗战',
  nameEn: 'Dark Chess',
  tagline: '信息不完全的象棋变体，用侦察与推理揭开战场迷雾。',
  noun: '棋手',
  keyParam: 'darkchess_key', // 指南/鉴权报错里的密钥占位名
  idField: 'darkchessId',    // 对外 JSON 的 id 字段名
  wrapKey: 'darkchess',      // info/me/public 响应的包装键
  avatarPrefix: 'd',         // 头像文件名前缀（各游戏隔离，防 id 撞名互覆盖；须与 '' / 'p' 都不同）
  scoredLimit: SCORED_LIMIT,
  leaderboardTtlMs: 15000,
  guidePath: '/agent-guide-darkchess',
  guideMarkdown: buildGuide({ scoredLimit: SCORED_LIMIT }),
  // /darkchess-bots.js 须先于 app.js 加载（app.js 引用其暴露的 window.Darkchess* 全局）
  // nav：壳层统一渲染的侧栏二级导航（key 须与 app.js 里 makeTabs 的 tab 名一致；auth=需登录；
  // hash=该 tab 在 URL 里的深链接名，如 /g/darkchess#leaderboard，缺省=key）
  client: {
    scripts: ['/darkchess-bots.js', '/games/darkchess/app.js'],
    nav: [
      { key: 'dqplay', hash: 'play', label: '试玩' },
      { key: 'dqleaderboard', hash: 'leaderboard', label: '天梯榜' },
      { key: 'dqmybot', hash: 'mybot', label: '我的棋手', auth: true },
      { key: 'dqguide', hash: 'guide', label: 'Agent 指南' },
    ],
  },

  // ---- runner 子进程任务（执行不可信代码；键 = execpool.run 的 kind）----
  // limits: 各任务的父进程硬超时（超时 SIGKILL 子进程）
  limits: {
    smoke: 150000,    // 烟雾 6 局（每局双方各 10s）+ 编译/进程余量
    challenge: 30000, // 正式挑战：单场制，1 局（双方各 10s）+ 编译/进程余量
    play: 30000,      // 试玩单请求推进若干手
  },
  tasks: {
    smoke: (t) => runSmokeTests(t.code),
    challenge(t) {
      const { bot: aBot } = makeBot(t.aCode);
      const { bot: bBot } = makeBot(t.bCode);
      if (!aBot || !bBot) return { loadFailed: true };
      const g = playMatch({ a: aBot, b: bBot }, t.seed);
      return pick(g);
    },
    play: (t) => runPlay(t.spec, { makeBot, findBuiltin }),
  },
};
