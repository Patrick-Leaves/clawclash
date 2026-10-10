# Agent 安全回归四类问题修复计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 闭环 2026-10-10 文档同步中发现的四类引擎与回放缺陷。

**Architecture:** 保留动作规范化、合法动作匹配和 history 隔离。默认整局不再按共享挂钟判某方负；双方独立扣减计算时间，VM 调用限制为单手 3000ms 与剩余预算的较小值。真实暗棋裁定与 Agent 遮罩视图分离，回放按吃子记录判断攻击子是否存活。

**Tech Stack:** Node.js >=22、CommonJS/UMD、node:test、node:vm，无新增依赖。

**Spec:** [Agent 指南与安全修复同步说明](../../../GameDesign/Agent指南与安全修复同步说明_2026-10-10.md)，其中“四类未闭环问题”为修复前证据。

## Global Constraints

- 单手上限 3000ms；每方每局计算预算 10000ms；钳王挑战双局分别重置预算。
- 父进程 limits 不变：钳王 challenge 60000ms，暗棋 challenge 30000ms；两游戏 smoke 150000ms。
- 暗棋 WIDTH=8、HEIGHT=4；身份不完整的遮罩局面不可凭空判胜负。
- 保留上一轮设计文档改动；本次在 codex/agent-regression-fixes 分支执行。初始阶段不提交、不推送、不部署；用户后续明确授权提交并合回本地 main，仍不推送或部署。
- 原 maxMatchMs 位置参数仍可显式使用，但触发时抛 MATCH_TIMEOUT 中止任务，不产生玩家判负记录。

## Review Focus

- 默认入口双方累计耗时超过旧共享阈值但均未用尽各自预算，应继续对局。
- 某方只剩不足 3000ms 时，动作提取中的无限 getter 也必须被剩余预算约束。
- x=7/y=3 可用，x=8/y=4、负数和小数拒绝；真实烟雾、挑战和试玩入口一致。
- 有暗子的真实棋盘可按完整身份裁定；Agent helper 对含暗子的视图仍返回 null。
- 炮吃明/暗子、普通吃子、卒吃将保留攻击子；同等级基础吃子同时移除双方，旧帧不变。

## Task 1: 独立时钟链路

**Files:** 两游戏 engine 与 sandbox；test/engine-security.test.js。
**Interfaces:** 保留 playMatch 的位置参数和 options.now/perSideBudgetMs；沙箱 bot.onTurn 新增可选第四参数 timeoutMs，不传给玩家函数。

- [x] 添加默认入口两方慢棋、显式整局安全阀、剩余时间传递、VM 剩余预算超时测试。
- [x] 运行定向测试，确认旧共享阈值与 VM 3000ms 固定超时测试失败。
- [x] maxMatchMs 默认 Infinity；显式整局超时抛 code=MATCH_TIMEOUT。引擎传 Math.min(3000, remaining[side])，沙箱取整且保留 >=1ms 的 VM 时限。
- [x] 运行同一测试文件，确认全部通过。

## Task 2: 暗棋动作宽度

**Files:** games/darkchess/engine/sandbox.js；test/darkchess-regressions.test.js。
**Interfaces:** 从 rules_core 导入 WIDTH/HEIGHT，仅输出已规范化 flip/move。

- [x] 添加右半棋盘 flip/move、非法边界及 manifest challenge/smoke/play 测试。
- [x] 运行定向测试，确认合法右半棋盘动作失败。
- [x] 坐标判断复用 WIDTH/HEIGHT。
- [x] 运行同一测试文件的边界与入口测试，确认通过。

## Task 3: 真实棋盘裁定

**Files:** rules_core.js、engine.js；test/darkchess-regressions.test.js、security-assessment.test.js、rules-examples.test.js。
**Interfaces:** core.judge 仅拒绝身份不完整棋盘；buildView.game.rules.judge 对有暗子的输入返回 null。

- [x] 添加含真实暗子的 40 步价值裁定、吃光优先、stepAction/stepPass 和 UMD 共享行为测试；原遮罩测试改用 fogBoard。
- [x] 确认真实棋盘裁定测试在修复前失败。
- [x] 按信息是否完整区分判定，不改变暗棋身份遮罩。
- [x] 确认真实棋盘与遮罩测试均通过。

## Task 4: 吃子回放与文档闭环

**Files:** games/darkchess/public/app.js；test/darkchess-replay.test.js；GameDesign/ 与 QA/ 的相关状态说明。
**Interfaces:** dqBuildReplayFrames(initialBoard, history) 输出初始帧和每步帧；与 core.applyMove 的棋盘结果一致。

- [x] 用生产回放函数与真实规则结果比较炮/普通吃子、卒吃将、同归于尽、翻棋、pass、移动和帧隔离。
- [x] 确认保留攻击子的吃子用例在修复前失败。
- [x] 先移除 captured 中的棋子，仅在起点未列入 captured 时将攻击子放到终点。
- [x] 跑针对性、全量、规则测试及 git diff --check；更新设计文档与 QA 的证据和状态，不将未执行手工/线上项标成通过。
- [x] 对代码变更进行独立审查，无需修复的发现。

## Execution Record

- 修复前基线：176 个自动化测试、12 个规则测试通过，但未覆盖上述四类反例。
- 执行方式：当前工作区原生执行，保留既有文档改动；已切换至修复分支。
- RED：首次三个定向文件共 45 项，29 项因四类目标缺陷失败；不是导入或测试配置错误。指南口径断言另观察 2 项失败。
- GREEN：最终五个定向文件 59/59 通过；全量直接 Node 命令 218/218 通过；npm.cmd run test:rules 12/12 通过。
- 文档验证：13 份更新 Markdown 的本地链接/标题锚点有效，346 个 QA 编号无重复；git diff --check 通过，CRLF 转换提示不属于空白错误。
- Ruling: npm 包装入口 spawn EPERM 时用 package.json 内等价 node --test --test-concurrency=1 执行，不修改 npm 配置或降低隔离；代价是未证明本环境 npm 包装入口可运行，QA 明确记录。
- Final review: 独立只读审查无实质问题；生产回放另比较 60 个种子、10,444 个帧，全部匹配。
- Review boundary: 显式整局阀仍在回合边界检查，生产使用默认 Infinity 加父进程硬时限；不把它作为单方思考判罚。若显式参数被误当精确单手硬截止，无法保证该语义，调用方应使用 VM/父进程时限。
- Review boundary: 无状态 play 的累计时钟/异常归因、畸形棋盘/棋谱和 VM/OS 隔离不纳入四类修复；继续按已有 QA 待办验收，不能推定已解决。
- Review boundary: 回放仍使用既有浅层 piece 对象，但只替换/移除格子而不改对象字段，已验前帧保持不变；未新增可变 piece 编辑 API。
- 初次收尾保留分支和未提交改动；用户后续授权提交并合回本地 main，执行提交前与合并后全量/规则测试，本地集成以 Git 记录为准。未推送或部署；浏览器交互和目标环境安全验收未执行。
