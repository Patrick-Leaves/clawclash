# Agent 对局安全与公平修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变已拍板游戏规则的前提下，修复钳王争霸与象棋暗战的动作执行、计时、历史记录和回放安全问题，并用可重复的回归测试证明修复有效。

**Architecture:** 先在两个游戏各自的沙箱边界提取并规范化 Agent 动作，再由引擎用合法动作列表中的引擎对象执行和记录；不让原始 VM 对象跨越校验、执行、落盘三个阶段。计时改为每个座位独立预算，整局挂钟保留为安全阀；试玩、正式挑战、历史重放共用同一套规范化和记录边界。所有实现先以测试锁定行为，再分批修改引擎，最后才部署和线上验证。

**Tech Stack:** Node.js CommonJS，Node `vm`，SQLite/现有 server 路由，原生 JavaScript 前端，Node built-in test runner（Node >= 22），项目保持零新增运行时依赖。

**Spec:** `GameDesign/Agent方案结论复核_2026-10-09.md`；背景与原始问题清单：`GameDesign/Agent报告核实与迭代方案_Spec_v1.0.md`。本计划以复核文档为准，不把原始 Spec 中已被纠正的计时、时序、JSON 净化和证据表述直接作为实施要求。

## Global Constraints

- 基线为已推送提交 `5717c2e`；开始实现前必须在独立分支上工作，不直接在 `main` 上改代码。
- 不改变已确认的玩法决定：暗棋炮打暗子保持现状；暗棋 40 个无吃子单步阈值和按子力裁定本轮不改；反刷分方向不改；囚徒困境不纳入本轮。
- 钳王一次正式挑战仍为两局，暗棋一次正式挑战仍为一局；“一场 = 一次挑战”的文档定义保持不变。
- 本轮目标计时为每方独立 10 秒预算；每局仍保留整局级父进程安全上限，具体值必须由实测结果确认后写入 limits。
- 不使用 JSON 序列化作为唯一的安全净化边界；Getter、Proxy、`toJSON`、循环引用、BigInt 和超大对象必须在受限执行路径内被安全处理。
- 引擎必须执行自己生成的规范动作，并使用同一规范动作写入 history；不得校验一个对象、执行另一个原始对象。
- 所有不可信 history 在回放重建前校验；非法记录不能被静默跳过后继续生成“看似完整”的棋谱。
- 测试使用 Node 内置 test runner；不得引入第三方依赖。
- 每个可独立审查的任务完成后单独提交；提交前运行该任务的最小测试集。
- 未完成本地全量测试和线上测试账号复测前，不得部署或声称线上已修复。
- 安全风险评估报告中的线上观察、强推断和待验证项必须保留证据等级；本计划只把本地代码能够确认的部分列为实施项。
- 暗棋随机流 P0-1 不得按报告的同源结论直接修复：当前本地代码显示开局内部流与按座位暴露的 `game.random` 已分离，先做代码/部署版本核对，再决定是否改变 API。

## Review Focus

- **动作表示不一致：** 同一个返回值的下标读取、迭代器读取和嵌套坐标可能给出不同动作；预期是拒绝或使用引擎合法列表中唯一的规范动作，不得改变棋盘。测试归属：Task 2、Task 3。
- **带副作用的返回对象：** Getter、Proxy、`toJSON`、循环引用或超大对象不应在宿主侧造成未受控执行、分配或 500；预期是该方 `error`/`runtime` 负且对局可结算。测试归属：Task 2。
- **慢方与快方：** 慢方消耗自己的预算，快方不能因为对方慢而被判负；预期是慢方 `runtime` 负。测试归属：Task 5、Task 6。
- **history 共享引用：** Agent 修改传入 history、嵌套坐标、captured/revealed 或追加条目不应影响引擎记录；预期是记录与棋盘状态一致。测试归属：Task 7、Task 8。
- **恶意回放字段：** 非法坐标、错误行动方、终局后追加动作和 HTML 特殊字符不能破坏重建或执行；预期是 400/不完整标记或纯文本显示。测试归属：Task 8、Task 9。

---

## 文件边界与职责

本计划不在第一阶段重构大文件；沿用现有边界，只增加最小的规范化辅助函数和测试模块。

- `games/clawclash/engine/sandbox.js`：编译用户代码、在 VM 内调用 `onTurn`、提取受控动作结果、转换异常。
- `games/darkchess/engine/sandbox.js`：与钳王相同，但支持 `flip` 与 `move` 两种暗棋动作。
- `games/clawclash/engine/engine_quota.js`：正式钳王对局、每手预算、引擎合法动作执行、规范 history。
- `games/darkchess/engine/engine.js`：正式暗棋对局、座位/颜色映射、每方时钟、规范 history。
- `games/clawclash/engine/play_session.js`：钳王试玩 history 重放与机器人应手。
- `games/darkchess/engine/play_session.js`：暗棋试玩 history 重放与机器人应手。
- `games/clawclash/engine/rules_core.js`、`rules_metered.js`：只在需要提供规范动作复制或安全边界时修改；不改变规则结果。
- `games/darkchess/engine/rules_core.js`：仅处理 judge 的遮罩语义修复；不改变真实棋盘裁定路径。
- `games/clawclash/index.js`、`games/darkchess/index.js`：调整父进程 limits，并保留游戏挑战局数契约。
- `games/clawclash/server.js`、`games/darkchess/server.js`：回放 JSON 入口的类型/结构边界；不在服务器中执行未经校验的棋谱；公共详情 DTO 脱敏。
- `platform/routes_game.js`：公共玩家/回放路由的字段暴露边界，以及头像上传和 rotate-key 路径的安全契约。
- `server.js`：统一 CORS、缓存和头像校验入口；只在本地代码确实负责的范围内补安全回归。
- `platform/execpool.js`、`platform/runner.js`：用户代码 runner 的 Node permission、读目录白名单、降权、网络出口和 worker 回收审计。
- `games/clawclash/public/app.js`：钳王棋谱文本渲染转义；暗棋现有 `esc()` 用法保持并补查遗漏点。
- `games/clawclash/guide.js`、`games/darkchess/guide.js`、`platform/guide_common.js`：实现完成且验证数值后同步指南，不提前宣称新时钟已上线。
- `test/engine-security.test.js`：钳王/暗棋动作、计时、history 和异常的回归测试；若文件增长过大，再按游戏拆分为两个测试文件。
- `test/replay-security.test.js`：试玩 history 重放、服务器回放结构和前端安全相关的可测试边界；使用现有测试 helper，不启动真实生产服务。
- `test/rules-examples.test.js`：两份指南中的固定局面向量，防止规则文档与规则内核再次漂移。
- `test/security-assessment.test.js`：公共回放 DTO、随机流隔离、头像校验、注册频控和 runner 安全配置的本地可验证契约。

## 安全风险评估报告核实结果（2026-10-09）

安全报告 `GameDesign/security-assessment-clawclash-2026-10-09.md` 是被动侦察和本地交叉验证报告，不是本计划的自动执行指令。以下核实以当前工作区代码为准；没有对生产站点发起新的主动测试，也没有把报告中的“实测线上”表述冒充为本地复现。

| 报告结论 | 当前核实 | 对本计划的处理 |
|---|---|---|
| P0-1：暗棋开局 PRNG 与 `game.random` 同源，可由 bot 反解 seed | **当前本地代码不支持该结论。** `games/darkchess/engine/engine.js` 的 `initMatchState` 使用内部 `rng` 生成开局和先手，`buildView` 暴露的是按座位派生的 `rngOf[seat]`；注释也明确两者独立。报告中的线上/复刻证据可能对应旧版本，反解数学路径本轮未重做。 | 不把它作为已证实漏洞直接改 API；新增审计任务核对部署版本和随机流，并保留“若发现同源则立即解耦”的验收分支。 |
| P0-2：公开回放暴露 seed、initialBoard、内部 ID、代码哈希；进行中回放可能泄露上帝视角 | **历史回放泄露在本地代码中成立。** `darkchess/server.js:144-156` 将数据库行、`seed`、`initialBoard` 和 `gameData` 组合返回；公共路由没有额外状态过滤。正式挑战的保存发生在结算后，因此“进行中正式挑战可读”不能由当前代码确认，需授权线上验证。钳王的公开详情也需要同样审计。 | 将“公共回放 DTO 脱敏”加入 P0 实施：完成后仅返回回放所需字段，默认去除 seed、内部数字 ID、battle_id、代码哈希；补充 finished-only/不存在中的状态测试。 |
| P1-1：Node `vm` 可能不是安全边界，网络出口和 OS 隔离需核实 | **部分成立。** 当前确实使用 `vm`，但用户代码在 runner 子进程中执行；`execpool.js` 有 Node permission、读目录白名单、可选降权和 worker 处决/回收。代码注释同时明确网络出站不由 Node permission 阻断，因此不能称为完整沙箱。 | 不把它与动作校验混为一谈；新增部署前沙箱审计/验证任务，检查 `CHILD_PERMISSION`、RUNNER_UID/GID、防火墙和最小权限，必要时单独立项加固。 |
| P1-2：头像上传可能存在 XSS/路径穿越/类型混淆 | **当前代码已有明显缓解。** `server.js:191-212` 限定 PNG/JPEG data URL、大小、尺寸并使用固定前缀+玩家 ID 文件名；尚未通过魔数/浏览器解析的授权攻击测试完全证明安全。 | 纳入安全回归清单，优先做本地单元测试和授权上传验证；不把它描述为已证实漏洞。 |
| P1-3：多账号互刷和改版重置计分额度 | **风险方向仍成立，但报告样本和线上影响未重新核实。** 当前计划已明确不改反刷分方向。 | 保持 Deferred；另做统计/产品决策，不阻塞 P0。 |
| P1-4：验证码 resend 频控、棋手密钥全权 | **resend/verify 本地已有频控、冷却和尝试上限测试；游戏路由已有 rotate-key 路径，但三款游戏一致性仍应核对。** | 增加账号安全核查任务；不在本轮擅自改变鉴权契约。 |
| P1-5：玩家画像和顺序 ID 可聚合 | **公开路由确实返回 `ownerNickname`、`createdAt` 等字段，属于隐私/产品取舍，不是本轮引擎安全修复。** | 记录为隐私评审项，暂不改变公开 API；需要产品决定后单独立项。 |
| P1-6：客户端 XSS 和回放 history 渲染 | **回放渲染风险与当前计划直接相关；钳王 `moveLiHtml` 有直接插值。** 其他字段需逐点审计，报告未做注入验证。 | 保留并扩大 Task 7 的前端转义测试；CSP 放入部署/基础设施清单。 |
| P2-1～P2-4：安全头、HSTS、CORS、robots、缓存头 | **当前仓库可确认全局 `Access-Control-Allow-Origin: *`，未找到 CSP/HSTS/X-Content-Type-Options/X-Frame-Options/Referrer-Policy 的应用层设置；TLS/反代配置不在仓库中。** | 新增部署配置审计任务；不在没有 nginx/生产配置文件的情况下伪造代码修复。 |
| P2-5：TLS 链与协议 | **本地仓库无法核实。** | 保留为运维/SSL Labs 检查项，不纳入本地代码任务。 |

本次核实结论：原计划已覆盖动作对象、计时、history、回放 XSS 和 masked judge，但**没有充分覆盖报告 P0-2 的公共回放字段脱敏、P1-1 的 OS/网络隔离审计、P2 安全头/HTTPS 配置审计，以及 P0-1 的“当前代码已独立随机流、需版本核对”纠偏**。以下任务补齐这些内容。
## Implementation Tasks

### Task 0: 建立实现基线和分支

**Files:**
- Create: `docs/superpowers/plans/2026-10-09-agent-security-hardening.md`（本计划）
- Modify: none
- Test: none

**Interfaces:**
- Produces: implementation baseline `5717c2e` and a dedicated feature branch for later tasks.

- [ ] **Step 1: Verify the baseline**

Run: `git status --short; git log -1 --oneline; npm test`

Expected: 工作区干净，HEAD 为 `5717c2e`，159 项测试通过。

- [ ] **Step 2: Create the implementation branch**

Run: `git switch -c codex/agent-security-hardening`

Expected: 当前分支变为 `codex/agent-security-hardening`，不修改工作区文件。

- [ ] **Step 3: Commit the plan separately**

Run: `git add docs/superpowers/plans/2026-10-09-agent-security-hardening.md; git commit -m "docs: add agent security hardening plan"`

Expected: 只包含计划文件，后续实现可逐任务审查。

### Task 1: 固化现有动作和历史契约

**Files:**
- Create: `test/engine-security.test.js`
- Create: `test/replay-security.test.js`
- Test: the two new files

**Interfaces:**
- Consumes: `require('../games/clawclash/engine/engine_quota')`, `require('../games/darkchess/engine/engine')`, both sandbox modules, and both play-session modules.
- Produces: named regression tests that fail only for the documented vulnerabilities and remain green for current normal behavior.

- [ ] **Step 1: Add baseline tests for normal legal actions**

Add tests named `clawclash normal builtin moves remain legal` and `darkchess normal builtin actions remain legal`. Assert that a normal bot can complete a bounded match and that every recorded non-pass history item matches the engine's legal action shape.

- [ ] **Step 2: Add reproductions for current unsafe behavior**

Add tests named `clawclash action representation mismatch cannot change board`, `darkchess action representation mismatch cannot change board`, `bot exception settles as a loss`, `slow side cannot make fast side lose`, and `history mutation is not reflected in result`. Initially mark the expected secure assertions so the tests demonstrate the current failure before implementation.

- [ ] **Step 3: Run only the new tests**

Run: `node --test --test-concurrency=1 test/engine-security.test.js test/replay-security.test.js`

Expected: baseline normal-behavior tests pass; vulnerability tests identify the intended gaps without modifying production code.

- [ ] **Step 4: Commit the test fixtures**

Run: `git add test/engine-security.test.js test/replay-security.test.js; git commit -m "test: capture agent engine security regressions"`

### Task 2: 设计并实现钳王动作规范化边界

**Files:**
- Modify: `games/clawclash/engine/sandbox.js`
- Modify: `games/clawclash/engine/engine_quota.js`
- Modify: `games/clawclash/engine/play_session.js`
- Test: `test/engine-security.test.js`, `test/replay-security.test.js`

**Interfaces:**
- Consumes: current `makeBot(code).bot.onTurn(me, opponent, game)` and `Rules.legalMoves(board, side)`.
- Produces: `onTurn` returns a plain canonical move `{ from: [number, number], to: [number, number] }` or throws a classified error; engine and play session execute the selected object from their own legal move list, never the original VM object.

- [ ] **Step 1: Define the canonical action contract in tests**

Pin exact requirements: `from` and `to` are two finite integer coordinates; no extra property is consulted for execution; the selected action must be one of the current legal move objects; pass is engine-generated only and is not accepted as an Agent move.

- [ ] **Step 2: Extract only required fields inside the VM boundary**

Update `games/clawclash/engine/sandbox.js` so the result crossing into the host is bounded and classified before host-side game logic uses it. Do not stringify arbitrary user output. Catch getter/proxy/iterator/BigInt/circular access failures and return a classified bot error without letting the server throw.

- [ ] **Step 3: Match and execute the engine-owned legal move**

In `engine_quota.js`, find the unique legal move by coordinate equality, then pass that legal move object to `Rules._rawApply` and history. In `play_session.js`, use the same rule: validate the supplied history action, then execute the matching legal move object rather than `h` or a bot-returned object.

- [ ] **Step 4: Map failures to stable result reasons**

Preserve existing public result meanings: malformed/absent action is `illegal`; VM timeout is `runtime`; other bot exceptions are `error`; any normalization or execution failure must settle the acting side as the loser rather than escape to the server.

- [ ] **Step 5: Run focused tests**

Run: `node --test --test-concurrency=1 test/engine-security.test.js test/replay-security.test.js`

Expected: mismatch, malformed object, getter/proxy failure, and thrown bot tests pass; normal bot and play-session tests remain green.

- [ ] **Step 6: Commit**

Run: `git add games/clawclash/engine/sandbox.js games/clawclash/engine/engine_quota.js games/clawclash/engine/play_session.js test/engine-security.test.js test/replay-security.test.js; git commit -m "fix: canonicalize clawclash bot actions"`

### Task 3: 设计并实现暗棋动作规范化边界

**Files:**
- Modify: `games/darkchess/engine/sandbox.js`
- Modify: `games/darkchess/engine/engine.js`
- Modify: `games/darkchess/engine/play_session.js`
- Test: `test/engine-security.test.js`, `test/replay-security.test.js`

**Interfaces:**
- Consumes: `legalActionsForSeat(matchState, seat)` actions `{ action: 'flip', at: [x,y] }` or `{ action: 'move', from: [x,y], to: [x,y] }`.
- Produces: canonical dark-chess action with one of the two exact shapes above; `actionsEqual` is the only equality rule; `stepAction` receives an engine-owned legal action.

- [ ] **Step 1: Pin both action shapes in tests**

Add tests for `flip` and `move`, including rejection of a move-shaped object with a custom iterator or mismatched indexed coordinates. Assert that `stepAction` and history receive the same canonical action selected from `legalActionsForSeat`.

- [ ] **Step 2: Normalize in the dark-chess sandbox**

Apply the same bounded extraction and error classification as Task 2, while preserving the distinction between `flip` and `move`. Never expose hidden-piece identity while normalizing the action.

- [ ] **Step 3: Execute legal action objects only**

In `engine.js` and `play_session.js`, after equality matching, pass the legal-list object into `stepAction`; do not pass the VM return value or raw replay object. Keep `applyFlip`, `applyMove`, seat/color mapping and result reasons unchanged.

- [ ] **Step 4: Verify all dark-chess paths**

Cover formal `playMatch`, local/training play session, and history replay. Ensure a malformed replay returns 400 and a bot exception returns a settled game result, not an uncaught exception.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test --test-concurrency=1 test/engine-security.test.js test/replay-security.test.js`

Expected: dark-chess flip/move tests and normal builtins pass.

Run: `git add games/darkchess/engine/sandbox.js games/darkchess/engine/engine.js games/darkchess/engine/play_session.js test/engine-security.test.js test/replay-security.test.js; git commit -m "fix: canonicalize darkchess bot actions"`

### Task 4: 统一异常结算和试玩错误边界

**Files:**
- Modify: `games/clawclash/server.js`
- Modify: `games/darkchess/server.js`
- Modify: `games/clawclash/engine/play_session.js`
- Modify: `games/darkchess/engine/play_session.js`
- Test: `test/replay-security.test.js`, relevant API tests

**Interfaces:**
- Produces: malformed submitted history and bot execution faults become controlled 400/settled-game responses; no engine exception reaches the HTTP handler as an unclassified 500 for a user-controlled action.

- [ ] **Step 1: Add HTTP-level tests**

Add cases for malformed history, history after terminal state, invalid action shape, and bot getter/exception in both game play endpoints. Assert status, error/reason, and absence of partial successful payloads.

- [ ] **Step 2: Implement narrow error translation**

Keep storage and infrastructure failures distinguishable from user-controlled replay/action failures. Translate only the latter at the game boundary; do not catch and hide database or process failures.

- [ ] **Step 3: Run API regression tests**

Run: `node --test --test-concurrency=1 test/api.e2e.test.js test/replay-security.test.js`

Expected: existing API tests and new controlled-error tests pass.

- [ ] **Step 4: Commit**

Run: `git add games/clawclash/server.js games/darkchess/server.js games/clawclash/engine/play_session.js games/darkchess/engine/play_session.js test/replay-security.test.js; git commit -m "fix: contain game action and replay failures"`

### Task 5: 设计并实现每方独立时钟

**Files:**
- Modify: `games/clawclash/engine/engine_quota.js`
- Modify: `games/darkchess/engine/engine.js`
- Modify: `games/clawclash/engine/sandbox.js`
- Modify: `games/darkchess/engine/sandbox.js`
- Test: `test/engine-security.test.js`

**Interfaces:**
- Consumes: `playMatch(..., perSideBudgetMs, maxMatchMs)` and existing VM invocation.
- Produces: each side has an independent remaining wall-clock budget initialized to 10,000 ms; time is charged to the side whose callback is running; timeout result is `runtime` for that side; the global match deadline remains a separate safety valve.

- [ ] **Step 1: Add deterministic timing tests**

Use injectable clock or a bounded fake timer seam rather than relying only on wall-clock sleeps. Add a real smoke-style test with approximately 2.6 s slow turns and 5 ms fast turns to prove the fast side does not lose. Add a near-budget test proving a side within 10,000 ms is not rejected solely because the opponent used time.

- [ ] **Step 2: Define charge boundaries**

Measure from immediately before invoking the side's `onTurn` through return/throw and action normalization. Do not charge the opponent for the current side's work. Include a separate documented safety margin for host-side work and do not treat the global deadline as a per-side budget.

- [ ] **Step 3: Implement per-side budget accounting**

Replace the single `deadline` decision with `remainingMs = {black: 10000, red: 10000}` for Claw Clash and `{a: 10000, b: 10000}` for Dark Chess. Deduct elapsed time after each callback. If the active side exhausts its budget, return the opposing side as winner with reason `runtime`. Check natural terminal results before applying an outer safety timeout when the current action already ended the game.

- [ ] **Step 4: Recalculate parent limits**

In both `index.js` manifests, set challenge/play/smoke limits only after measuring worst-case local runs. Keep enough margin for compilation, process startup and serialization. Document the calculation in the plan execution notes; do not blindly set values from the original Spec.

- [ ] **Step 5: Run timing tests and commit**

Run: `node --test --test-concurrency=1 test/engine-security.test.js test/api.e2e.test.js`

Expected: slow side loses its own budget; fast side never loses because of opponent delay; all existing challenge and smoke API behavior remains valid.

Run: `git add games/clawclash/engine/engine_quota.js games/darkchess/engine/engine.js games/clawclash/engine/sandbox.js games/darkchess/engine/sandbox.js games/clawclash/index.js games/darkchess/index.js test/engine-security.test.js; git commit -m "fix: give game bots independent clocks"`

### Task 6: 完善 history 规范化和深层隔离

**Files:**
- Modify: `games/clawclash/engine/engine_quota.js`
- Modify: `games/darkchess/engine/engine.js`
- Modify: `games/clawclash/engine/play_session.js`
- Modify: `games/darkchess/engine/play_session.js`
- Test: `test/engine-security.test.js`, `test/replay-security.test.js`

**Interfaces:**
- Produces: each recorded history entry is a fresh plain object containing only the game's documented fields; nested coordinate/captured/revealed values are copied and cannot alias the bot view or engine mutable state.

- [ ] **Step 1: Specify canonical history schemas in tests**

Claw Clash: `{turn, side, from, to, captured, pass}` with copied coordinate arrays and captured entries. Dark Chess: `{turn, seat, action, captured, revealed, pass}` with copied action coordinates and revealed/captured fields. Assert no VM object, Rules instance or board cell is reachable from history.

- [ ] **Step 2: Build entries from engine results**

In each engine, create history entries from the result of the engine-owned apply operation, not from the bot return object. For pass, create the pass entry internally. Freeze or otherwise isolate the returned view/history passed to the bot, but preserve existing documented read-only behavior without breaking legitimate bot code.

- [ ] **Step 3: Protect final results and persisted payloads**

Return a detached result snapshot from `fin`/`finFrom`. Ensure server persistence receives only the detached game data and cannot observe later mutations by the engine or bot.

- [ ] **Step 4: Test mutation attempts**

Add tests where a bot pushes to history, edits a prior nested coordinate, mutates captured/revealed, retains a prior game object across turns, and attempts to mutate the board view. Assert legal engine state and returned history remain correct.

- [ ] **Step 5: Run and commit**

Run: `node --test --test-concurrency=1 test/engine-security.test.js test/replay-security.test.js`

Expected: all mutation/isolation tests pass and normal history snapshots remain backward compatible.

Run: `git add games/clawclash/engine/engine_quota.js games/darkchess/engine/engine.js games/clawclash/engine/play_session.js games/darkchess/engine/play_session.js test/engine-security.test.js test/replay-security.test.js; git commit -m "fix: isolate canonical game history"`

### Task 7: 修复回放输入校验与前端棋谱渲染

**Files:**
- Modify: `games/clawclash/server.js`
- Modify: `games/darkchess/server.js`
- Modify: `games/clawclash/public/app.js`
- Modify: `games/darkchess/public/app.js` only where an unescaped replay path is found
- Test: `test/replay-security.test.js`, existing browser-bundle/API tests

**Interfaces:**
- Produces: public replay data is schema-validated before frame reconstruction; replay text is rendered as text or escaped HTML; malformed records return controlled errors and do not partially render.

- [ ] **Step 1: Add replay schema tests**

Cover wrong types, missing fields, invalid coordinates, action/seat mismatch, post-terminal actions, oversized history, and unexpected nested values. Assert controlled 400 or explicit incomplete replay behavior according to the existing API contract.

- [ ] **Step 2: Validate before reconstruction**

At the server/game replay boundary, validate the complete record before applying frames. Do not skip an invalid step and continue, because that would make later board state untrustworthy. Preserve compatibility for valid records produced by the current engines.

- [ ] **Step 3: Escape all dynamic replay text**

In Claw Clash, replace direct interpolation in `moveLiHtml` with the existing escaping helper or DOM text nodes. Audit all replay fields used by `innerHTML`; do not assume the dark-chess text escaping covers other fields or future branches.

- [ ] **Step 4: Run browser/API tests**

Run: `node --test --test-concurrency=1 test/browser-bundles.test.js test/api.e2e.test.js test/replay-security.test.js`

Expected: normal replay rendering remains unchanged; malicious text is inert; malformed replay does not produce a successful partial frame list.

- [ ] **Step 5: Commit**

Run: `git add games/clawclash/server.js games/darkchess/server.js games/clawclash/public/app.js games/darkchess/public/app.js test/replay-security.test.js; git commit -m "fix: validate and escape public game replays"`

### Task 8: 公共回放 DTO 脱敏与完成态边界

**Files:**
- Modify: `games/darkchess/server.js`
- Modify: `games/clawclash/server.js`
- Modify: `platform/routes_game.js` only if the shared route needs an explicit completed-record contract
- Test: `test/replay-security.test.js`, `test/security-assessment.test.js`, `test/api.e2e.test.js`

**Interfaces:**
- Produces: public `GET /api/games/{gid}/match/{urlId}` returns only fields required by the public replay UI; internal `seed`, numeric player IDs, `battle_id`, code hashes and raw database row fields are not public by default.
- Produces: a replay is publicly addressable only after a completed record exists; there is no partially persisted public frame path.

- [ ] **Step 1: Define the public replay schema in tests**

Assert the exact allowed top-level fields for both games: public names/avatars, winner/reason/turns, sanitized replay data and any fields required by the current UI. Assert absence of `seed`, `initialBoard` real ownership data where it is not needed by the viewer, `challenger_player_id`, `challenged_player_id`, `battle_id`, code hashes and raw SQL columns. If the browser truly needs a field, document why and expose a purpose-built redacted form rather than spreading `row`.

- [ ] **Step 2: Verify lifecycle semantics before changing the endpoint**

Trace `saveMatch` and the public route. Confirm that formal matches are inserted only after settlement; add a test showing an uncommitted/in-progress match is 404 or unavailable. Do not claim this verifies production behavior for a separately deployed version without an authorized deployment check.

- [ ] **Step 3: Replace row spreading with explicit DTO builders**

Implement explicit `publicMatchView` builders in both game server adapters. Parse and redact game data deliberately; do not return `...row` with selected properties set to `undefined`, because JSON serialization and future columns can re-expose internal data.

- [ ] **Step 4: Preserve replay compatibility**

Update the two replay clients only for fields removed from the public payload. Keep public replay rendering and battle tabs working without giving the client the seed or hidden-side truth unless a documented product requirement proves it necessary.

- [ ] **Step 5: Run API and security tests**

Run: `node --test --test-concurrency=1 test/replay-security.test.js test/security-assessment.test.js test/api.e2e.test.js`

Expected: valid replay still renders; sensitive database fields are absent; unfinished/unknown replay is controlled 404; no existing match list or settlement test regresses.

- [ ] **Step 6: Commit**

Run: `git add games/clawclash/server.js games/darkchess/server.js platform/routes_game.js test/replay-security.test.js test/security-assessment.test.js test/api.e2e.test.js; git commit -m "fix: redact public replay metadata"`

### Task 8A: 核对暗棋随机流隔离，暂不按报告盲改

**Files:**
- Modify: `games/darkchess/engine/engine.js` only if the audit finds a same-source regression
- Test: `test/security-assessment.test.js`

**Interfaces:**
- Produces: a tested invariant that the internal opening/turn-order RNG is not the same callable or state stream as any seat's exposed `game.random`.

- [ ] **Step 1: Add a source-level/runtime identity test**

Construct a match state, consume the internal opening stream through initialization, consume a seat's `rngOf[seat]`, and assert the public callable is not the internal `rng` and that one seat's extra calls do not change the other seat's sequence or opening state.

- [ ] **Step 2: Audit the deployed-version question separately**

Record that the report's online evidence may describe an older deployment. Compare the exact deployed commit or artifact version before making a production claim. If the deployed artifact exposes the old shared stream, create a follow-up fix to remove `random` or derive it from a cryptographically independent source, then add a production-version regression test.

- [ ] **Step 3: Commit the audit test**

Run: `node --test --test-concurrency=1 test/security-assessment.test.js`

Expected: current local code proves separation; no gameplay behavior changes are committed unless the audit fails.

Run: `git add games/darkchess/engine/engine.js test/security-assessment.test.js; git commit -m "test: verify darkchess random stream isolation"`
### Task 9: 暗棋遮罩 judge 语义修复

**Files:**
- Modify: `games/darkchess/engine/rules_core.js`
- Modify: `games/darkchess/guide.js`
- Test: `test/rules-examples.test.js`, `test/engine-security.test.js`

**Interfaces:**
- Produces: `judge(board, ncm)` returns a result only when the board contains no hidden cells, or when an unambiguous elimination condition can be established from the provided view; a masked board with insufficient information returns `null` rather than inventing a winner.

- [ ] **Step 1: Add masked-board regression vectors**

Test fully hidden board, masked board with no visible black pieces, masked board with one visible black piece, fully revealed board at `ncm=0`, and threshold `ncm=40`. Assert the API never treats hidden pieces as red and never reports a false `eliminated`/`noCapture` result from missing power data.

- [ ] **Step 2: Implement conservative judge behavior**

Detect hidden cells before using `counts` or `pieceValueSum` for an externally supplied board. Keep the internal engine's true-board calls unchanged. Return `null` for ambiguous masked views.

- [ ] **Step 3: Add guide wording and example tests**

Keep the guide warning that `judge` is for fully revealed boards, and add fixed examples for the two cases above. Do not change the 40-step rule.

- [ ] **Step 4: Run and commit**

Run: `node --test --test-concurrency=1 test/rules-examples.test.js test/engine-security.test.js`

Expected: masked `judge` is conservative; true-board game outcomes are unchanged.

Run: `git add games/darkchess/engine/rules_core.js games/darkchess/guide.js test/rules-examples.test.js test/engine-security.test.js; git commit -m "fix: make darkchess masked judge conservative"`

### Task 10: 固化指南示例和规则回归向量

**Files:**
- Modify: `games/clawclash/guide.js`
- Modify: `games/darkchess/guide.js`
- Modify: `platform/guide_common.js`
- Test: `test/rules-examples.test.js`

**Interfaces:**
- Produces: guide examples and runtime rules share stable, executable examples; the guides state the implemented clock semantics only after Task 5 lands.

- [ ] **Step 1: Encode Claw Clash guide vectors**

Add tests for the documented landing-line capture order, double-line capture, non-matching color sequence, pass counting, and 20 single-step threshold. Compare expected capture list and winner/reason with the rule engine.

- [ ] **Step 2: Encode Dark Chess guide vectors**

Add tests for cannon screen/target behavior, hidden target capture metadata, flip versus move action shape, and the masked `judge` warning. Keep cannon-on-hidden behavior unchanged.

- [ ] **Step 3: Update clock/lifecycle wording only to match code**

After independent clocks are implemented and measured, update the guides from shared per-game wording to per-side wording, preserving formal challenge/smoke lifecycle statements. If implementation measurements require a different parent safety limit, update only the limit text supported by tests.

- [ ] **Step 4: Run guide rendering and rules tests**

Run: `npm run test:rules; node --test --test-concurrency=1 test/rules-examples.test.js test/api.e2e.test.js`

Expected: all vectors pass; generated guides contain the new truthful clock and judge wording, and old contradictory wording is absent.

- [ ] **Step 5: Commit**

Run: `git add games/clawclash/guide.js games/darkchess/guide.js platform/guide_common.js test/rules-examples.test.js; git commit -m "test: lock guide examples to game rules"`

### Task 11: 纳入统一测试入口并完成全量回归

**Files:**
- Modify: `package.json`
- Modify: `test/engine-security.test.js`, `test/replay-security.test.js`, `test/rules-examples.test.js` as needed
- Test: all repository tests

- [ ] **Step 1: Include rule vectors in the standard test command**

Update the `test` script only if the new tests are not automatically discovered by Node's test runner. Keep `npm run test:rules` as a compatibility command, but make the security and rules regressions part of `npm test`.

- [ ] **Step 2: Run targeted suites**

Run:

```text
node --test --test-concurrency=1 test/engine-security.test.js test/replay-security.test.js test/rules-examples.test.js
npm run test:rules
```

Expected: all new tests pass with no skipped security cases.

- [ ] **Step 3: Run the complete suite**

Run: `npm test`

Expected: existing tests plus new tests pass with 0 failures; record test count and duration in the implementation log.

- [ ] **Step 4: Run syntax and diff checks**

Run: `node --check` on every modified `.js` file and `git diff --check`.

Expected: no syntax errors and no whitespace errors.

- [ ] **Step 5: Commit**

Run: `git add package.json test; git commit -m "test: include security regressions in full suite"`

### Task 12: 安全评估报告的部署与账号面核查清单

**Files:**
- Modify: `platform/execpool.js`, `platform/runner.js` only if local configuration/guard behavior is missing
- Modify: deployment configuration or runbook only when the actual deployment repository contains it
- Test: `test/security-assessment.test.js`, existing registration/API tests, authorized staging checks

**Interfaces:**
- Consumes: current runner permission flags, registration quota service, rotate-key routes, upload validator and response-header behavior.
- Produces: evidence-backed disposition for P1-1, P1-2, P1-4, P1-5, P1-6 and P2-1 through P2-5; unresolved online/infrastructure items remain explicitly marked as unverified.

- [ ] **Step 1: Test local runner defenses**

Assert that the runner uses a child process, permission mode is enabled unless explicitly disabled, read access is limited to platform/games, no user secrets are included in the child environment, workers are recycled after timeout, and no code path claims Node `vm` alone is a security boundary. Do not write an exploit payload against production.

- [ ] **Step 2: Test existing account and upload controls**

Use existing test seams to assert resend has IP frequency limits and email cooldown, verify has email/IP attempt limits, rotate-key exists for each game, and avatar data URLs reject non-PNG/JPEG, oversize, invalid dimensions and unsupported content. Mark magic-byte and browser parser validation as a remaining hardening question if not covered by current helpers.

- [ ] **Step 3: Audit public data minimization**

Document the product decision for `ownerNickname`, `createdAt`, sequential player IDs and public match lists. Do not remove fields merely because the report labels them a risk; record a separate privacy change request if the product wants minimization.

- [ ] **Step 4: Audit response security headers and HTTPS configuration**

Search application and deployment configuration for CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS, CORS scope, duplicate Cache-Control, robots.txt and server-version exposure. For headers/TLS not controlled by this repository, create an operations ticket with exact evidence needed; do not fake a source-level fix.

- [ ] **Step 5: Run authorized staging checks only**

For report items V1–V8, execute only with written authorization and test accounts. The production report must distinguish local code evidence, staging evidence, production evidence, and not tested. Do not test other users, brute-force accounts, send injection payloads, or probe production egress without authorization.

- [ ] **Step 6: Commit evidence and disposition**

Create or update a dated `GameDesign/security-verification-YYYY-MM-DD.md` only after checks run. Include report item, evidence level, affected commit/deployment, result, remediation owner and follow-up. Commit it separately from gameplay fixes.
### Task 13: 部署前审查、部署与测试账号线上验证

**Files:**
- Modify: deployment files only if the repository's existing deployment procedure requires them
- Test: local full suite and authorized production smoke checks

**Interfaces:**
- Consumes: completed commits from Tasks 2–12 and the repository's existing上线操作手册.
- Produces: a deployable revision, a bounded production verification report, and a rollback commit/ref.

- [ ] **Step 1: Review the final diff against the plan**

Check every changed file against the file-boundary section. Confirm no rule change, anti-farm change, or unrelated prisoner change slipped in.

- [ ] **Step 2: Verify production build inputs**

Confirm the deploy artifact includes updated `games/`, `platform/`, server/engine files and public bundles, not only public assets. Record the exact commit deployed.

- [ ] **Step 3: Deploy only with explicit authorization**

Follow the repository's existing deployment procedure. Do not use other users' accounts or perform attack payloads against production.

- [ ] **Step 4: Run authorized production checks**

With test accounts, verify:

- slow/fast bot result: slow side loses by `runtime`, fast side does not;
- malformed action settles the game rather than returning 500;
- replay text is inert and malformed replay is rejected;
- normal built-in bot challenge and replay still work;
- generated guides show the implemented clock semantics.

- [ ] **Step 5: Record rollback information**

Record previous production commit, deployed commit, test timestamps, observed results and the exact rollback command/procedure. Stop and roll back if any normal challenge, settlement or replay regression appears.

- [ ] **Step 6: Commit documentation of verification**

Create or update a dated implementation/deployment report under `GameDesign/` only after the checks actually run; do not write “verified” in advance.

## Deferred Work

- 暗棋 40 手阈值和按子力结算的数据统计与设计评估。
- 钳王先手/结算结构的专属干净数据统计；现有报告数据不作为结论依据。
- 若部署版本仍存在同源随机流，运行时随机流解耦与 seed 保密的专项修复；当前本地代码已先证明开局流与座位流分离。
- 囚徒困境的同类渲染、引擎和沙箱审计。
- 反刷分机制任何方向的修改。

## Plan Self-Review

- **Spec coverage:** N1、N2、N3、N4、N5 分别由 Tasks 9、6–8、5、2–4、5 与 limits 复核覆盖；P0-1/2/3、P1、P2 和部署要求均有对应任务。
- **Security-report reconciliation:** 报告 P0-2 的历史回放字段泄露已新增 Task 8；报告 P0-1 已按当前代码降级为需版本核对的审计项；P1-1 沙箱、P1-2 上传、P1-4 账号、P1-6 XSS 和 P2 安全头均有独立核查边界。
- **Correction coverage:** 计划没有采用“判定发生在脚本前”“冻结外层对象即可”“JSON 净化即可隔离”“整场共享时钟必然等于每局预算”等已被复核文档纠正的说法。
- **Type consistency:** 钳王 canonical move 为 `{from,to}`；暗棋 canonical action 为 `{action:'flip',at}` 或 `{action:'move',from,to}`；两者均由引擎合法列表提供最终执行对象。
- **Test coverage:** 正常动作、表示不一致、异常、超大/副作用对象、计时方向、history 共享引用、非法回放、XSS 文本、masked judge 和指南示例均有任务归属。
- **Deployment safety:** 计划明确要求先本地全量测试、再授权部署、再用测试账号验证并准备回滚；没有把文档中的部署建议当成已经执行的部署指令。线上安全报告中的主动验证清单仅在获得书面授权后执行。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-09-agent-security-hardening.md`. Please review the plan. Does it capture what you want?

Recommended execution method: **Native** — these tasks share canonical action/history and timing interfaces, so one implementer should integrate them sequentially; a fresh whole-branch review should run before merge or push.
