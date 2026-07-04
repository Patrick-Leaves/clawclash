'use strict';
// 段位分模型特征测试：钉住 platform/scoring.js 的全部边界。
// 这些期望值即产品规则（README/指南/策划案里公示的公式），任何改动都应是有意为之。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RANK_TIERS, smallTierIndex, bigTierIndex, rankLabel, rpDelta, wldInc } = require('../platform/scoring');

test('段位标签：小段边界与夹取', () => {
  assert.equal(rankLabel(0), '青铜 III');
  assert.equal(rankLabel(99), '青铜 III');
  assert.equal(rankLabel(100), '青铜 II');
  assert.equal(rankLabel(200), '青铜 I');
  assert.equal(rankLabel(300), '白银 III');
  assert.equal(rankLabel(1399), '王者 II');
  assert.equal(rankLabel(1400), '王者 I');
  assert.equal(rankLabel(999999), '王者 I'); // 上限夹取
  assert.equal(rankLabel(-50), '青铜 III');  // 负数按 0 处理
});

test('小段/大段序号', () => {
  assert.equal(RANK_TIERS.length, 5);
  assert.equal(smallTierIndex(0), 0);
  assert.equal(smallTierIndex(1400), 14);
  assert.equal(smallTierIndex(99999), 14); // 夹取到王者 I
  assert.equal(bigTierIndex(0), 0);
  assert.equal(bigTierIndex(299), 0);   // 青铜 I 仍是大段 0
  assert.equal(bigTierIndex(300), 1);   // 白银 III 起大段 1
  assert.equal(bigTierIndex(1400), 4);  // 王者
});

test('RP 增减：同大段位基准 +25 / +10 / −15', () => {
  assert.equal(rpDelta('win', 0, 0), 25);
  assert.equal(rpDelta('draw', 0, 0), 10);
  assert.equal(rpDelta('loss', 0, 0), -15);
  // 同大段位但不同 rp（都在青铜）仍是基准值
  assert.equal(rpDelta('win', 250, 10), 25);
});

test('RP 增减：跨大段位修正（每差一段 ±8，平局 ±4）', () => {
  // 我青铜(0) vs 对手白银(300)：d=+1
  assert.equal(rpDelta('win', 0, 300), 33);
  assert.equal(rpDelta('loss', 0, 300), -7);
  assert.equal(rpDelta('draw', 0, 300), 14);
  // 我白银(300) vs 对手青铜(0)：d=−1
  assert.equal(rpDelta('win', 300, 0), 17);
  assert.equal(rpDelta('loss', 300, 0), -23);
  assert.equal(rpDelta('draw', 300, 0), 6);
});

test('RP 增减：保号夹取（胜[3,50] / 负[−50,−3] / 平[0,20]）', () => {
  // d=+4（我青铜 0 vs 对手王者 1400）
  assert.equal(rpDelta('win', 0, 1400), 50);   // 25+32=57 → 50
  assert.equal(rpDelta('loss', 0, 1400), -3);  // −15+32=+17 → −3（负不可能加分）
  assert.equal(rpDelta('draw', 0, 1400), 20);  // 10+16=26 → 20
  // d=−4（我王者 1400 vs 对手青铜 0）
  assert.equal(rpDelta('win', 1400, 0), 3);    // 25−32=−7 → 3（胜不可能扣分）
  assert.equal(rpDelta('loss', 1400, 0), -47); // −15−32=−47（在界内不夹取）
  assert.equal(rpDelta('draw', 1400, 0), 0);   // 10−16=−6 → 0
});

test('RP 增减：全段位差扫描恒在夹取区间内', () => {
  const rps = [0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350, 1400, 5000];
  for (const my of rps) {
    for (const opp of rps) {
      const w = rpDelta('win', my, opp);
      const l = rpDelta('loss', my, opp);
      const d = rpDelta('draw', my, opp);
      assert.ok(w >= 3 && w <= 50, `win(${my},${opp})=${w}`);
      assert.ok(l >= -50 && l <= -3, `loss(${my},${opp})=${l}`);
      assert.ok(d >= 0 && d <= 20, `draw(${my},${opp})=${d}`);
    }
  }
});

test('战绩增量 wldInc', () => {
  assert.deepEqual(wldInc('win'), [1, 0, 0]);
  assert.deepEqual(wldInc('loss'), [0, 1, 0]);
  assert.deepEqual(wldInc('draw'), [0, 0, 1]);
});
