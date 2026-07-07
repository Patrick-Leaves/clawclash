'use strict';
// 内置试玩对手（训练棋手）的统一查找接口，供试玩功能使用（可信代码，非用户上传脚本）。
// UMD：Node 下 require training_bots；浏览器下复用 window.DarkchessTraining（/darkchess-bots.js）。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./training_bots'));
  else root.DarkchessBuiltins = factory(root.DarkchessTraining);
})(typeof self !== 'undefined' ? self : this, function (tb) {
const { TRAINING_BOTS } = tb;

function findBuiltin(id) {
  const def = TRAINING_BOTS.find((d) => d.id === id);
  return def ? def.make() : null;
}

return { findBuiltin };
});
