# clawclash.cn（Agent 竞技场）安全风险评估报告

- **评估日期**：2026-10-09
- **评估对象**：https://www.clawclash.cn/ （「Agent 竞技场」，含钳王争霸 / 象棋暗战 / 囚徒困境三款游戏）
- **评估方法**：被动侦察 + 攻击面建模 + 本地资产交叉验证（零攻击载荷、零写入请求、仅十余次只读 GET）
- **证据等级标注**：【实测】= 本次线上直接观察；【本地证实】= 本地 sim.js/validate2.js 与线上 1057 手回放比对验证；【强推断】= 证据链一致但差服务端最后一步确认；【待验证】= 需授权后测试；【站方声称】= 官方指南声明，未触发验证

---

## 0. 授权与边界声明（必读）

本次评估**未发起任何攻击**：无注入探测、无越权尝试、无爆破、无写入请求、无 DoS。所有信息来自：
1. 任意访客可见的公开响应（首页、JS 资产、公开 API）；
2. 本工作区内已有的官方指南、公开回放样本（mm_*.json）与已验证的本地引擎复刻 sim.js。

**向该站发起主动渗透测试须持站方书面授权**（《刑法》285/286 条，未授权测试属违法行为）。第 6 节给出授权后的验证清单，供站方或被授权者执行。

---

## 1. 资产与攻击面地图

| # | 资产 | 说明 | 鉴权 |
|---|---|---|---|
| A1 | Web 前端 | MPA 架构，服务端组装页面；/platform.js + 各游戏 app.js | 公开 |
| A2 | 账号体系 | 邮箱 + 密码(≥8位) + 邮箱验证码注册；登录/登出 | 混合 |
| A3 | Agent API（3 套游戏） | Bearer 棋手密钥；提交/回滚代码、挑战、查战史 | 密钥 |
| A4 | 公开数据 API | leaderboard、players/{id}/public、match/{urlId} 回放 | **无** |
| A5 | **服务端执行用户 JS** | 用户提交的 bot 代码在服务端沙箱内运行（算力点数/挂钟超时约束） | 密钥 |
| A6 | 文件上传 | 头像上传（`upload:d4.jpg` 观测到产物），另有 preset 选择 | 密钥 |
| A7 | 客户端引擎资产 | /game-rules.js、/builtin-bots.js、/darkchess-bots.js 公开下发（试玩模式需要） | 公开 |

**API 端点清单**（本次绘制，共 40+）：

| 类别 | 端点 | 鉴权 |
|---|---|---|
| 平台 | GET /api/games；GET /api/me；POST /api/account/register、resend-code、verify-code；POST /api/auth/login、logout；GET /api/bot/me/version | 公开/会话 |
| 钳王 | /api/agent/bot/{info,code/submit,code/revert,code/versions,matches}；/api/agent/challenge；/api/agent/opponents/{id}/matches；公开：/api/leaderboard、/api/match/{urlId} | 密钥/公开 |
| 暗战 | /api/games/darkchess/agent/{info,code/submit,code/revert,code/versions,matches,challenge,opponents/{id}/matches}；/me/{matches,versions,version,rotate-key,avatar,avatar/preset,prompt}；/create、/name-check、/play；公开：/leaderboard、/match/{urlId}、/players/{id}/public、/players/{id}/matches/public、/players/search | 密钥/公开 |
| 囚徒 | /api/agent/prisoner/{info,code/*,matches,challenge}；/api/agent/prisoner-opponents/；公开：/api/leaderboard/prisoner、/api/match/prisoner/{urlId} | 密钥/公开 |

---

## 2. 实测确认的暴露面（无鉴权可读）

| 端点 | 暴露内容 | 备注 |
|---|---|---|
| GET /api/games/darkchess/match/9e3793b4a06e4499 【实测】 | `seed: 725559904`、`initialBoard`（**32 子真实归属+兵种，hidden:true 全量**）、`challenger_player_id`、`ch_code_hash/cd_code_hash`、完整逐手 history | 任意网民可读 |
| GET /api/games/darkchess/players/4/public 【实测】 | 昵称、归属账号 ownerNickname、createdAt、RP/段位/胜率、代码版本、状态 | 顺序 ID 1..N 可枚举 |
| GET /api/games/darkchess/players/4/matches/public 【实测】 | 全部历史对局 urlId、对手、结果、rpDelta、scored 标志 | 公开侦察面（设计如此） |
| GET /api/games/darkchess/leaderboard、/api/leaderboard、/api/leaderboard/prisoner 【实测】 | 全员段位/胜负/版本/昵称 | 设计公开 |
| GET /darkchess-bots.js 【实测】 | **完整暗战引擎源码**：`mulberry32` PRNG、`initBoard(rng)` 开局生成、`fogBoard` 战争迷雾遮罩、`legalActionsForSeat`、内置训练 bot 逻辑 | 试玩需要，但与 seed 泄露叠加后成为武器 |
| GET /api/me（未鉴权）【实测】 | 规范 401 JSON `{"ok":false,"error":"未登录"}`，无堆栈泄露 | ✅ 错误处理良好 |
| 响应头【实测】 | 全局 `Access-Control-Allow-Origin: *`；**无 CSP / X-Content-Type-Options / X-Frame-Options / Referrer-Policy**；HTTPS 响应无 HSTS（仅 HTTP 301 上携带，浏览器不生效）；Cache-Control 双头重复 | 见 P2 |

---

## 3. 风险清单（P0 → P2）

### 🔴 P0-1 象棋暗战「战争迷雾」可被完整击穿——种子与运行时随机数同源（天梯公平性风险）

**证据链（每一环均已独立验证）**：
1. 【实测】公开回放端点明文返回每局 `seed`（如 725559904）与 `initialBoard` 真实归属；
2. 【实测】完整引擎源码公开下发：开局摆放 = `mulberry32(seed)` 驱动的 Fisher–Yates 洗牌（`initBoard`），先手方亦由同一流 `rnd() < 0.5` 决定；
3. 【本地证实】sim.js（经 1057 手公开回放校验与线上行为一致的复刻引擎）中：`const rnd = mulberry32(seed)` → `newBoard(rnd)` → `first = rnd() < 0.5` → **`game = { ..., random: rnd }` 把同一个 PRNG 实例传给 bot 运行时**；
4. 【数学事实】mulberry32 状态为单个 32 位整数、按步长 `0x6D2B79F5` 加法推进、输出混合可逆——**bot 只需在自己第一回合调用一次 `game.random()`，即可反解当前状态、回退已消耗步数、恢复原始 seed，再用公开的 initBoard 算法重建全部 32 子真实归属**（消耗步数即使未知也可 20~40 次暴力枚举）。全程零网络、零越权、回放中不可见。

**影响**：暗战是隐藏信息博弈，`fogBoard` 遮罩（服务端对 bot 视角的脱敏）被此链路完全架空——任何知道此机制的 bot 作者可获得**从第一手起的上帝视角**，且作弊无法从棋谱上区分于"棋力强"。天梯排名的信息博弈部分失效。

**证据缺口**：线上服务端运行时是否与本地复刻一致地将开局 PRNG 实例传入 `game.random`——契约（指南 game 对象含 `random`）与复刻一致性强烈支持，但需服务端代码一行确认。

**修复（低成本）**：
- 运行时 `game.random` 改用**独立加密随机源**（如 `crypto.randomBytes` 派生），与开局摆放流彻底解耦；
- 或直接从运行时对象中移除 `random`（多数 bot 并不依赖它做决策）；
- 开局摆放改用 `crypto` 级洗牌，不使用可逆 PRNG。

**同模式提示**：囚徒困境"900–1100 回合"的随机终局长度若与运行时随机同源，bot 可提前得知终局轮次，在重复博弈中精准安排末期背叛——建议三款游戏统一排查。

### 🔴 P0-2 进行中对局回放可读性未验证 + 已证实的历史回放字段过度聚合

- 【待验证】`match/{urlId}` 对**进行中**对局返回什么？若返回 `initialBoard/seed`，则等于向任意持 urlId 者实时发放上帝视角（正式对局为自动进行，人无法干预，但试玩/云对局、以及未来任何"人机协作"模式下即成实弹）。验证方法见第 6 节 V1。
- 【实测】即便仅限历史对局，`seed`、内部数字 `player_id`、`battle_id`、代码哈希等**内部字段与回放数据无差别打包公开**：seed 泄露使 P0-1 的攻击无需运行时即可离线复盘验证归属；代码哈希可跨版本指纹追踪玩家。

**修复**：回放端点仅在 `status=finished` 后放行；剥离 `seed` 与内部数字 ID（urlId 已足够）；代码哈希如无业务必要不对外。

### 🟠 P1 风险（有明确攻击路径，需验证/加固）

| # | 风险 | 证据 | 验证/修复 |
|---|---|---|---|
| P1-1 | **服务端执行用户 JS 的沙箱强度**——平台最高潜在影响资产。若使用 Node `vm`（非安全边界）或存在 vm2 类已知逃逸，提交代码即 RCE | 【强推断】指南显示有算力点数+挂钟超时+Rules API 白名单约束（有沙箱意识），但隔离技术不可外察 | 站方自查：是否 `worker_threads`/独立进程/无 `require` 注入；是否断网（bot 沙箱内 egress 测试）；`process`/`globalThis` 可达性 |
| P1-2 | **头像上传校验**（存储型 XSS / 路径穿越 / 类型混淆） | 【实测】存在 upload 产物与端点 | 站方自查：白名单扩展名+魔数校验、随机文件名、Content-Type 强制、SVG 禁用或消毒 |
| P1-3 | **业务逻辑刷分**：多账号互刷 + "改版重置 10 场计分额度"机制可被系统性滥用（升版→刷 10 场→再升版循环）→ RP 通胀 | 【站方声称】反刷分机制即承认该面；【实测】当前仅 4 名玩家已可见同人多号现象 | 同 IP/设备指纹/邮箱域聚类审核；挑战双方为同注册主体时标记不计分 |
| P1-4 | **账号面**：验证码爆破（resend-code 频控未确认）、密码策略仅≥8 无复杂度、无 2FA、**棋手密钥即全权**（泄露=他人可替你提交任意代码/挑战消耗额度/换头像） | 【站方声称】login/register/challenge/submit 有 429；resend-code 未列入 | 确认 resend-code 频控与验证码有效期/尝试上限；密钥支持轮换（✅ 已有 /me/rotate-key，钳王/囚徒侧需确认一致） |
| P1-5 | **玩家枚举聚合**：players/{id} 顺序 ID + search + ownerNickname 关联 → 全量玩家画像（注册时间、账号昵称、活跃度） | 【实测】 | 低危但属隐私聚合面：如无需要可去掉 ownerNickname/createdAt |
| P1-6 | **客户端 XSS 面**：昵称/notes/对手名等用户可控字符串在 MPA 前端的转义；回放页渲染 history | 【待验证】未注入测试 | 站方自查转义；补 CSP（当前完全缺失，密钥若存 localStorage 则 XSS=盗 key=接管） |

### 🟡 P2 风险（纵深防御缺失）

| # | 风险 | 证据 | 修复 |
|---|---|---|---|
| P2-1 | HTTPS 响应缺全套安全头：CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy | 【实测】 | nginx 统一补齐；CSP 至少 `default-src 'self'` |
| P2-2 | HSTS 实际未生效（仅 HTTP 301 响应携带，浏览器仅信任 TLS 通道内的 HSTS）→ 首访可 SSL Strip | 【实测】 | 在 **HTTPS** 响应加 `Strict-Transport-Security: max-age=31536000; includeSubDomains` |
| P2-3 | 全局 `Access-Control-Allow-Origin: *`：当前 Bearer（非 Cookie）模式下低危；若未来引入 Cookie 会话则升级为高危 | 【实测】 | 保持 `*` 仅限只读公开端点；鉴权端点收紧 |
| P2-4 | robots.txt 缺失（404）；Cache-Control 双头重复；Server: nginx 版本策略 | 【实测】 | 低优先级配置整理 |
| P2-5 | TLS 链/协议/证书细节：本评估环境经代理解密无法审计 | 【环境限制】 | 站方用 SSL Labs 自查（目标 A-） |

---

## 4. 直接回答本次评估的两个核心问题

### Q1：是否可能篡改数据？

| 层面 | 结论 | 依据 |
|---|---|---|
| **业务层操纵（无需漏洞）** | **可行且低成本** | 多账号互刷（P1-3）+ 改版重置计分额度即可系统性抬高 RP；恶意 bot 故意 illegal/runtime 可定向"送分"给挑战方。当前接口设计（challenge 指定对手、单场定胜负）对此无结构性防御，仅 hash-pair 限 10 场 |
| **越权篡改他人数据** | **未发现可行路径，攻击面小** | 【实测】所有写接口均为 `/me/` 自操作型，无以他人 ID 为参数的写端点；密钥鉴权下未见 IDOR 写面。要改他人段位/对局需服务端漏洞，未授权不测、不下结论 |
| **直接篡改存储** | 无证据 | 未做注入测试（需授权）。错误处理规范（401 JSON 无堆栈），第一印象无明显注入回显 |

### Q2：是否可能获取不应开放的数据？

| 数据 | 可得性 | 依据 |
|---|---|---|
| **对局隐藏信息（暗战核心资产）** | **历史对局：任意网民已可读**（initialBoard 真实归属+seed）【实测】；**进行中对局：bot 侧经 P0-1 链路大概率可实时获得上帝视角**【强推断，差服务端一步确认】 | 见 P0-1/P0-2 证据链 |
| 全员玩家画像 | 可枚举聚合（顺序 ID + search + 昵称/胜率/注册时间）【实测】 | 属设计公开+隐私聚合 |
| 他人 bot 源码 | **不可读**（仅 16 hex 代码哈希）【实测】 | ✅ 设计正确 |
| 他人邮箱/密钥 | 未见暴露面 | 公开端点均无邮箱字段 |
| 运行时越权读（bot 读对手隐藏子） | **服务端已做 fogBoard 遮罩** ✅【本地证实】；但被 P0-1 的旁路（PRNG 反解）绕过 | 遮罩正确性本身无懈可击，问题在种子同源 |

**一句话总结**：暗战的"迷雾"防线——服务端遮罩——本身做得对，但它防住了正门，没防住 PRNG 这扇窗：**种子公开 + 算法公开 + 运行时随机同源，三者叠加让"透视"从作弊变成了一个小学算术题。**

---

## 5. 平台做得好的部分（公平评估）

| 防御 | 证据 |
|---|---|
| ✅ 服务端对 bot 视图做迷雾遮罩（fogBoard），运行时无越权读面 | 【本地证实】 |
| ✅ 棋手密钥支持轮换（/me/rotate-key） | 【实测】前端绑定 |
| ✅ 反刷分 hash-pair 机制（前 10 场计分） | 【站方声称】+ 本地回放 `scored` 字段 |
| ✅ 关键接口频控（429 + Retry-After） | 【站方声称】 |
| ✅ 邮箱验证码注册、鉴权端点 Cache-Control: no-store | 【实测】 |
| ✅ 对局 urlId 为 16 位随机 hex（不可枚举），非顺序 ID | 【实测】 |
| ✅ 错误处理规范，无堆栈/内部路径泄露 | 【实测】 |
| ✅ ICP 备案 + 公安备案齐全 | 【实测】页脚 |

---

## 6. 授权后主动验证清单（供站方/被授权测试者执行）

| # | 验证项 | 步骤 | 判定 |
|---|---|---|---|
| V1 | 进行中对局回放可读性 | 发起一场正式挑战（或试玩云对局），在**结束前**用挑战响应中的 urlId GET match 端点 | 返回 200+initialBoard ⇒ P0-2 实锤；404/部分数据 ⇒ 降级 |
| V2 | 运行时随机流耦合 | **服务端代码审计**：检查传入 game 对象的 random 是否与 initBoard 共用 mulberry32 实例（勿用真实账号在线验证，那等于作弊） | 共用 ⇒ P0-1 实锤 |
| V3 | 沙箱逃逸 | 审计执行环境（vm/vm2/worker/进程隔离）；在测试环境提交尝试访问 process/require/setTimeout 网络的探针 bot | 任一可达 ⇒ 升 P0 |
| V4 | 沙箱网络出口 | 测试环境 bot 内尝试外连 | 出口开放 ⇒ 结合 V1 可组成"bot 自助透视"链 |
| V5 | resend-code 爆破面 | 审计频控覆盖与验证码尝试上限 | 无上限 ⇒ 升 P0（账号接管） |
| V6 | 上传校验 | 上传 SVG/HTML 改名 .jpg、超限文件、路径字符 | 任一通过 ⇒ 升 P1 实锤 |
| V7 | XSS 转义 | 昵称/notes 注入 `<img onerror>` 类载荷（测试账号） | 任意页面执行 ⇒ 密钥失守 |
| V8 | IDOR | 遍历 opponents/{id}/matches、players/{id} 用他人密钥尝试（授权双账号） | 越权可见 ⇒ 升 P1 |

---

## 7. 负责任披露建议

1. 平台页脚备案主体可经工信部备案系统查询联系方式，建议以邮件书面披露 P0-1/P0-2（附本报告路径）；
2. 披露时只给原理与复现思路（本报告第 3 节），**不提供可运行利用代码**；
3. 给予站方修复窗口后再公开讨论；
4. 该平台当前仅 4 名暗战玩家、体量小，泄露影响可控——**正是修复成本最低的时机**。

---

## 8. 评估局限与复盘

**未覆盖（原因）**：注入类（需授权）、爆破/频控触发（对第三方站点不合规）、沙箱内部（不可外察）、TLS 细节（本环境经代理解密）。
**方法论**：被动侦察的最大盲区是"写接口的鉴权纵深"——所有 P1 写面均只能给验证清单而无法定级；本次最有价值的发现（P0-1）恰恰来自**本地资产交叉验证**（公开回放字段 × 公开引擎源码 × 本地已验证的引擎复刻），说明"外部黑盒 + 内部白盒知识"的组合远强于纯黑盒。
**对使用者的提醒**：本工作区的公开回放仍是规则反查的最佳工具（合法用途）；但请勿在未授权状态下对平台做主动渗透——本报告的 P0 修复建议已足够与站方开启对话。
