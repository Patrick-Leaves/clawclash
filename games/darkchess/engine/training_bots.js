'use strict';
// 三档训练棋手：随手（随机）/ 贪吃（有吃必吃）/ 推演（一步价值估算）。
// 仅通过 game.rules 公开 API 操作（与真实 Agent 脚本同一套契约），不直接 require rules_core——
// 保证训练棋手也遵守信息边界（game.board 已按暗棋规则遮罩，无法窥视未翻开棋子的真实身份）。
// UMD：本文件不依赖其它模块，Node 下挂 module.exports，浏览器下挂 window.DarkchessTraining
// （/darkchess-bots.js，供试玩「训练棋手对战」在浏览器本地直接构造并推演，零网络）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DarkchessTraining = api;
})(typeof self !== 'undefined' ? self : this, function () {
const UNKNOWN_CAPTURE_ESTIMATE = 2; // 隔子吃到暗棋时无法预知价值，给一个保守估计用于评分

function randomChoice(list, rng) { return list[Math.floor(rng() * list.length)]; }

function evalGain(rules, board, side, action) {
  const r = rules.apply(board, side, action);
  return r.captured.reduce((s, c) => s + (c.power == null ? UNKNOWN_CAPTURE_ESTIMATE : (c.side === side ? -c.power : c.power)), 0);
}

function makeRandomBot() {
  return {
    name: '随手',
    onTurn(_me, _opp, game) { return randomChoice(game.legalActions, game.random); },
  };
}

function makeGreedyBot() {
  return {
    name: '贪吃',
    onTurn(me, _opp, game) {
      const moves = game.legalActions.filter((a) => a.action === 'move');
      let best = null, bestGain = 0;
      for (const a of moves) {
        const gain = evalGain(game.rules, game.board, me.side, a);
        if (gain > bestGain) { bestGain = gain; best = a; }
      }
      return best || randomChoice(game.legalActions, game.random);
    },
  };
}

function makeHeuristicBot() {
  return {
    name: '推演',
    onTurn(me, _opp, game) {
      let best = null, bestScore = -Infinity;
      for (const a of game.legalActions) {
        const score = a.action === 'flip' ? 0.5 : evalGain(game.rules, game.board, me.side, a);
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best || randomChoice(game.legalActions, game.random);
    },
  };
}

const TRAINING_BOTS = [
  { id: 'suishou', name: '随手', make: makeRandomBot },
  { id: 'tanchi', name: '贪吃', make: makeGreedyBot },
  { id: 'tuiyan', name: '推演', make: makeHeuristicBot },
];
function getTrainingBot(id) {
  const def = TRAINING_BOTS.find((b) => b.id === id);
  if (!def) throw new Error(`未知训练棋手: ${id}`);
  return def.make();
}

return { TRAINING_BOTS, getTrainingBot };
});
