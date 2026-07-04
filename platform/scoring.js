'use strict';
// 段位分（RP）模型：平台通用，所有游戏共用同一套公式（见 GameDesign/平台系统说明_v1.0.md §四）。
// 自 server.js 原样迁出，行为不变；test/scoring.test.js 以特征测试钉住全部边界。

const RANK_TIERS = ['青铜', '白银', '黄金', '钻石', '王者'];
// 小段序号 0..14（青铜III=0 … 王者I=14），每小段 100 RP
function smallTierIndex(rp) {
  return Math.min(14, Math.floor(Math.max(0, rp) / 100));
}
// 大段序号 0..4（青铜=0 / 白银=1 / 黄金=2 / 钻石=3 / 王者=4）
function bigTierIndex(rp) {
  return Math.floor(smallTierIndex(rp) / 3);
}
function rankLabel(rp) {
  const idx = smallTierIndex(rp);
  return `${RANK_TIERS[Math.floor(idx / 3)]} ${['III', 'II', 'I'][idx % 3]}`;
}
// 每场（合计定胜负）只计一次。修正项按「大段位差」放大，不用内部 ELO：
//   d = 对手大段位 − 本方大段位（−4..4），STEP=8 同时作用于胜/负，平局用半步（4）。
//   保号夹取防刷分：胜 ∈ [+3,+50]、负 ∈ [−50,−3]、平 ∈ [0,+20]。
//   同大段位 d=0 → 回到基准 +25 / +10 / −15。战胜强者多得、输给强者少扣、战胜弱者少得、输给弱者多扣。
function rpDelta(result, myRp, oppRp) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const d = bigTierIndex(oppRp) - bigTierIndex(myRp);
  if (result === 'win') return clamp(25 + 8 * d, 3, 50);
  if (result === 'loss') return clamp(-15 + 8 * d, -50, -3);
  return clamp(10 + 4 * d, 0, 20);
}
// 'win'|'loss'|'draw' → [wins, losses, draws] 战绩增量
function wldInc(result) {
  return [result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, result === 'draw' ? 1 : 0];
}

module.exports = { RANK_TIERS, smallTierIndex, bigTierIndex, rankLabel, rpDelta, wldInc };
