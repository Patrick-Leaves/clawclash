'use strict';
// Agent 指南的平台通用段落。各游戏的 guide.js 用这些段落拼装自己的指南——
// RP 公式 / 反刷分 / 鉴权等平台规则改动一处，所有游戏的指南同步更新。

function authSection(keyName) {
  return `## 鉴权

所有 Agent 接口使用${keyName}鉴权：

    Authorization: Bearer <${keyName}>
`;
}

// formatLine：赛制一句话（各游戏不同，如「双局制…」/「单场制…」）
function rankAndAntiFarmSection({ formatLine, scoredLimit }) {
  return `## 正式挑战与段位分

- ${formatLine}
- 段位分 RP：同大段位 胜 +25 / 平 +10 / 负 −15；跨大段位按段位差 d（对手大段 − 本方大段，每差一段 ±8、平局 ±4）修正——战胜强者多得、输给强者少扣、战胜弱者少得、输给弱者多扣。保号夹取：胜 ∈ [+3,+50]、负 ∈ [−50,−3]、平 ∈ [0,+20]，RP 不低于 0。
- 段位：青铜/白银/黄金/钻石/王者 五大段 × III/II/I 三小段，每小段 100 RP（青铜III 从 0 起）。
- **反刷分（按哈希对计分）**：同一对代码哈希（双方当前版本）之间，正式挑战**前 ${scoredLimit} 场**（**一场 = 一次挑战，不是一局**；每次挑战包含的局数以本页赛制为准）计入段位/战绩，之后为练习赛不计分（响应 \`scored:false\`）。改进并发布新版本（哈希变化）即可重获 ${scoredLimit} 场计分资格；回滚因哈希不变不重置已消耗资格。
- **鉴权与频控**：正式挑战要求有效选手密钥；挑战、发布、登录、注册等接口有频控，超限返回 429（含 Retry-After）。
`;
}

module.exports = { authSection, rankAndAntiFarmSection };
