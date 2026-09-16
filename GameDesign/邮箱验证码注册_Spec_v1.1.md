# 邮箱验证码注册 · Implementation Spec v1.1

> 日期：2026-09-15。状态：需求与实现契约已整理，作为下一步 Implementation Plan 的输入；功能尚未实现。
> 本文是本次改造的现行规范，取代 [邮箱验证注册设计 v1.0](邮箱验证注册设计_v1.0.md) 中的实现约定。旧文保留用于追溯。
> “必须”是验收条件。标记为“本期边界”的内容不是已经实现的能力，也不是隐含的后续任务。

## 1. 目标、基线与范围

### 1.1 目标

用户提交昵称、邮箱、密码后收到六位验证码；验证通过后，平台才创建正式账号并签发登录 Cookie。登录仍使用邮箱与密码。

成功主链路：

    填写资料 → register → 收取邮件 → verify-code → 创建账号、删除 pending → 登录
                            └→ resend-code → 收取新邮件 ────────────┘

验证码核验前没有本次注册产生的账号、会话或游戏资产。邮件发送失败必须可恢复，不能使一个仍有效的旧验证码失效。

### 1.2 当前代码基线

| 现状 | 代码依据 |
|---|---|
| 注册直接创建 accounts 并返回 201 + Cookie | [server.js](../server.js)，account/register |
| EMAIL_VERIFICATION 默认关闭，启动批量补齐 email_verified | [server.js](../server.js)，启动块 |
| 验证链接只打印日志，真实 SMTP 尚未实现 | [server.js](../server.js)，sendVerificationEmail |
| 密码使用加盐 scrypt，Cookie 使用 HMAC，有效期七天 | [auth.js](../auth.js) |
| 正式挑战检查 email_verified | [platform/routes_game.js](../platform/routes_game.js)，challenge |
| 登录和注册成功后会跳当前游戏“我的”页 | [public/platform.js](../public/platform.js) |
| 三款游戏均调用公共邮箱验证横幅 | games/clawclash、prisoner、darkchess 的 public/app.js |
| 频控为进程内滑动窗口，并定时清理一小时前的记录 | [ratelimit.js](../ratelimit.js) |

现有 QA 已包含部分目标行为，不能据此认定代码已完成。本文验收矩阵优先于旧清单中相冲突的账号条目。

### 1.3 本期范围

包括：两步注册、SMTP、pending 状态、发送额度、并发控制、前端导航意图、旧账号迁移、旧验证链路删除、回归验收。

本期边界：

- Node 内置模块、SQLite、零第三方运行依赖；SMTP 使用自有邮箱账号，不接服务商 HTTP API。
- 运行形态仍为一个 Web/DB 主进程；runner 池只执行游戏任务。SMTP 不进入 runner。
- 不增加验证码登录、找回密码、改密码、改邮箱、二次验证、OAuth、会话设备管理。
- 不增加多实例部署、分布式发信队列、自动补发或投递回执服务。
- 不改变游戏资产、Bot Key、RP、代码发布和对局执行契约。

## 2. 决策记录

### 2.1 用户明确指定

| ID | 决策 |
|---|---|
| D01 | 第五次错码删除 pending |
| D02 | SMTP 成功后才扣除三层正式发信额度 |
| D03 | 生产缺 SMTP_HOST 时注册接口返回 503，服务本身继续运行 |
| D04 | 历史 email_verified=0 账号统一按已验证处理 |
| D05 | “每日”采用自然日 |

### 2.2 根据授权补齐的约定

| ID | 约定及原因 |
|---|---|
| D06 | 自然日固定为 Asia/Shanghai 的 00:00–次日 00:00，不随服务器时区变化 |
| D07 | 三层额度一次性检查并预留；SMTP 确认成功后提交，确认失败后释放；SQLite 保存记录以跨重启保留额度 |
| D08 | 候选验证码先在内存准备，发信成功才替换有效 pending；失败保留旧 pending，首次发送失败不新增 pending |
| D09 | 60 秒冷却从成功发送时开始，register 与 resend-code 共用；失败不延长冷却，仍计入接口请求频控 |
| D10 | 同邮箱注册、重发、核验互斥；处理中冲突快速返回 409；不缓存成功响应、不对邮件自动重试 |
| D11 | 添加 registrationId 绑定当前注册轮次，防旧窗口核验被另一轮注册覆盖的资料 |
| D12 | 邮箱唯一键沿用 trim + 整体小写；不合并点号、加号别名或不同邮箱域名 |
| D13 | 注册继续明确返回“该邮箱已注册”与 field=email；登录继续统一“邮箱或密码错误” |
| D14 | 发码成功 200，核验建号成功 201，作为稳定 API 契约 |
| D15 | 单个验证码最长有效 10 分钟；同一 pending 注册流程最长 30 分钟；重发不延长流程期限 |
| D16 | 启动、每分钟和访问过期记录时清理 pending；删除会立即结束核验/重发资格 |
| D17 | 保留七天固定期限 Cookie；仅建号成功和密码登录成功签发，不滑动续期、不用已消费验证码重新签发 |
| D18 | 登出保留现有清 Cookie 语义；单个会话的服务端撤销不在本期 |
| D19 | 历史迁移成功后同版本切换新注册入口并删除挑战邮箱门槛，迁移须先于 HTTP 监听完成 |
| D20 | register 要求 registrationProtocol=email-code-v1；旧前端缺该字段时返回刷新提示，避免把发码当建号 |

相对 v1.0 的关键调整：不在检查限额前覆盖 pending；第五次错码后无法只靠 resend-code 恢复；日额度不复用现有滑动窗口。

## 3. 输入、唯一性与身份边界

### 3.1 请求格式

账号 POST 请求体必须是 JSON 对象，不接受 null、数组或把数字自动转换成字符串。所有字段先检查类型，再执行 trim 等操作。错误返回 400，不能因类型错误抛出 500。

| 字段 | 约定 |
|---|---|
| nickname | 字符串，trim 后 1–64 个 Unicode 码点；禁止控制字符；区分大小写；不做 Unicode 折叠 |
| email | 字符串，trim 后整体小写，见下方支持范围 |
| password | 字符串，保留原始内容，不 trim、不改变大小写；按现有 JS length 校验 8–256 |
| code | 字符串，严格匹配六位 ASCII 数字；保留前导零，000000 是合法格式 |
| registrationId | 服务端生成的 16 字节随机值编码为 32 位小写 hex；核验、重发必须携带 |
| registrationProtocol | register 必须传固定字符串 email-code-v1；用于识别支持两步注册的客户端 |

新注册邮箱支持范围：ASCII 地址，总长不超过 254 字节、本地部分不超过 64 字节；本地部分采用非引号 dot-atom 形式，不允许首尾点或连续点；域名至少两段，各段 1–63 个字母/数字/连字符且首尾不为连字符。不接受空白、控制字符、显示名、注释、地址字面量、SMTPUTF8 地址；ASCII punycode 域名可用。

这是一项产品输入约束，并不宣称实现全部邮箱语法。登录保留历史 trim + 小写查询，不对已有邮箱和昵称施加新的注册格式限制，避免历史账号被锁在门外。

### 3.2 唯一性

- accounts.email 的规范键与 pending.email、邮件收件地址、发信额度邮箱键、邮箱锁键完全一致。
- Alice@Example.com 与 alice@example.com 是同一账号；a+b@example.com 与 a@example.com 不自动合并。
- 昵称仍由 accounts.nickname 的 UNIQUE 约束保护；等待验证码期间不预占昵称。
- 不自动修改历史邮箱或合并历史账号。如迁移前检查发现规范化后碰撞，终止本次迁移并保留数据，待人工消除冲突后再上线，不根据猜测选择账号。
- 注册查重优先昵称、其次邮箱；冲突返回 409 + field。验证码最终建号也必须重新查重。
- 注册返回邮箱占用属于明确保留的产品取舍；响应不附带该邮箱对应昵称、ID、资产或密码信息。

### 3.3 registrationId

每次成功发送新验证码都生成新的 registrationId，与该轮 code_hash、nickname、password_hash 一起激活。仅拿到 registrationId 不能登录，仍须核验验证码。

核验和重发 body 中的 registrationId 必须匹配当前 pending。旧轮次返回 409 registration_stale，不增加当前轮的错码次数、不发送邮件、不改资料。不同邮箱不共用 ID。

例：窗口 A 发起注册后，窗口 B 用同邮箱提交另一份资料并成功发码。A 即使收到 B 的验证码，也不能用 A 的旧 registrationId 完成 B 的注册；必须返回资料页重新发起。此约束同时防止被并发覆盖的密码被误用于建号。

registrationId 不放入 URL、邮件正文或普通日志，不存浏览器持久存储；刷新页面后返回资料页。SMTP 失败不会更换已有 registrationId。

## 4. 注册状态和生命周期

### 4.1 持久状态

| 状态 | 含义 | 可执行操作 |
|---|---|---|
| absent | 无 pending、也可能是已过期清理/错码耗尽/成功消费 | 有需要时重新提交 register |
| active | pending 存在，当前时间早于 code 与流程的截止时间，attempts 为 0–4 | 核验；冷却结束后重发 |
| expired | 记录仍在，但当前时间已达任一截止时间 | 当前请求删除记录并返回 410 expired |
| registered | accounts 已创建，pending 已删除 | 密码登录 |

“已耗尽”是第五次错码当次响应的原因，不建立耗尽墓碑，也不保存已消费验证码。

### 4.2 发送中的临时状态

发送准备阶段持有邮箱锁、预留额度和内存候选资料，HTTP 尚未返回成功。该阶段不产生可核验的新 pending；已有 pending 仍是旧版本，但同邮箱核验会收到处理中响应。

发信成功后在短事务内确认额度并激活候选 pending。发信失败丢弃候选资料，旧 pending 若仍未过期继续有效。

### 4.3 验证码与暂存期限

- 使用 crypto.randomInt 生成 0–999999 并补齐六位；只保存加盐 scrypt 哈希。生成新码时避免与当前有效码相同。
- 首次 register 在准备候选验证码时设 created_at、flow_expires_at=created_at+30 分钟；只有发送成功才持久化这些候选值。
- 每次候选验证码准备时固定 issued_at，expires_at=min(issued_at+10 分钟, flow_expires_at)；邮件与数据库共用同一个绝对截止时间，不在 SMTP 返回后另行延长。
- 成功重发保留 created_at、flow_expires_at、nickname、password_hash；只更新 registrationId、code_hash、attempts=0、issued_at、expires_at。
- 临近流程末尾的验证码有效期会短于 10 分钟；邮件显示北京时间截止时间，接口返回实际剩余秒数。
- 新的 register 要求重新提交完整资料，成功后开始一轮新流程；发送失败不延长任何旧期限。
- 时间边界采用 now >= expires_at 或 now >= flow_expires_at 即过期；attempts 达五立即删除。
- 已过期/已删除记录不能重发：前端回资料页重新提交。不要保留仅凭邮箱即可无限续期的密码哈希。
- 激活成功后前端清空密码和确认密码；“更换邮箱”、流程过期或耗尽回资料页时需要重新输入密码。

### 4.4 清理

启动监听前清理过期 pending；运行时每 60 秒清理一次并 unref 定时器；核验/重发读到过期记录立即删除。

清理跳过正被注册操作持有邮箱锁的记录；操作结束必须复查过期并清理，不能把网络等待当作延长资格的理由。候选资料在发送结束、失败或 60 秒操作期限到达时释放。

同一流程中密码哈希业务保留上限 30 分钟；在服务正常调度和操作期限受控时，数据库过期行额外清理滞后最多约一分钟。服务停机时无法执行清理，下一次启动先删除。此保证针对在线记录，不承诺 SQLite 空闲页、WAL 或外部备份的物理擦除。

## 5. 数据契约与原子性

### 5.1 pending_registrations

    CREATE TABLE IF NOT EXISTS pending_registrations (
      email             TEXT PRIMARY KEY,
      registration_id   TEXT NOT NULL UNIQUE,
      nickname          TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      code_hash         TEXT NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
      created_at        INTEGER NOT NULL,
      issued_at         INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      flow_expires_at   INTEGER NOT NULL,
      CHECK(expires_at <= flow_expires_at)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_expiry
      ON pending_registrations(expires_at);

第五次错误直接执行条件删除，不能先写 attempts=5 触发约束。密码与验证码哈希不得通过接口返回。

### 5.2 registration_mail_attempts

发信记录同时服务于三层自然日计数、在途预留、邮箱冷却和故障定位，无须依次扣减三个互不关联的计数器。

    CREATE TABLE IF NOT EXISTS registration_mail_attempts (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL,
      source_ip         TEXT NOT NULL,
      state             TEXT NOT NULL
                        CHECK(state IN ('reserved','sent','failed','unknown')),
      reserved_at       INTEGER NOT NULL,
      lease_expires_at  INTEGER NOT NULL,
      accepted_at       INTEGER,
      quota_day         TEXT,
      finished_at       INTEGER,
      CHECK(state <> 'sent' OR (accepted_at IS NOT NULL AND quota_day IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_regmail_day
      ON registration_mail_attempts(state, quota_day);
    CREATE INDEX IF NOT EXISTS idx_regmail_email
      ON registration_mail_attempts(email, state, accepted_at);
    CREATE INDEX IF NOT EXISTS idx_regmail_ip
      ON registration_mail_attempts(source_ip, state, quota_day);
    CREATE INDEX IF NOT EXISTS idx_regmail_lease
      ON registration_mail_attempts(state, lease_expires_at);

约定：

- id 为独立随机发送操作 ID，不能复用 registrationId。
- sent 是已获得 SMTP 接受确认的发送，包括已接受但后续业务激活未成功的情况。
- reserved/unknown 在租约有效时占用“可发名额”，但不计入正式成功次数。
- failed 不占额度、不产生冷却。相同发送 ID 的状态提交必须条件更新，重复回调不能重复记账。
- 不存验证码、密码、密码哈希、SMTP 凭据或邮件原文。
- 每次发送/检查和定时清理都会处理过期租约；已终结记录保留 48 小时后删除，清理依据 accepted_at 或 finished_at，不按旧 reserved_at 提前删除成功记录。
- 日期和有效成功记录跨重启保留；pending 的删除不得删除发信记录或重置额度/冷却。

### 5.3 数据操作语义

具体函数名可由 Plan 安排，但下列操作必须独立可测试：

| 操作 | 必须保证 |
|---|---|
| 预留发送名额 | 一个短事务内检查三层成功数与有效预留；全部通过后才插入一条 reserved |
| 完成发送 | 以操作 ID 条件更新 sent；激活 pending 时与该更新在同一短事务内完成 |
| 发送失败 | 标记 failed 或 unknown；按 §7 处理名额，保留旧 pending |
| 记录错码 | 按 email + registrationId 条件递增；第 5 次删除并返回 exhausted |
| 最终建号 | 重新读取匹配轮次、检查期限和次数、终查唯一性、插入已验证 accounts、删除 pending，全在同一事务内 |
| 过期清理 | 幂等，不修改账号、有效轮次或当日成功发送记录 |

SQLite 事务中不能 await SMTP、TLS 或其他网络 I/O。验证码比较结果只能用于它对应的 registrationId；若哈希比较采用异步实现，必须保留邮箱锁并在写入前重读轮次与期限。

唯一性冲突属于预期业务结果，按 §8.3 提交该轮 pending 的删除；意外 SQL/存储错误才是整笔事务回滚。两者不能共用“失败就删记录”的异常分支。

## 6. 并发、重复请求和客户端断开

### 6.1 锁范围

- register、resend-code、verify-code 使用同一套“规范化邮箱”互斥。
- 同邮箱已有操作在执行：后续请求快速返回 409 reason=registration_busy，retryAfterSec=2，并带 Retry-After: 2；不进入无界等待队列。
- 全部写操作在持锁后重读状态。任何成功、失败、异常和超时出口都必须释放操作锁。
- 不同邮箱可并行；发送最多四个在途操作，满时返回 503 send_busy，retryAfterSec=2，不预留名额。
- 额度检查及插入预留是同步短事务，不能出现“检查都通过后两个 await 请求都发送最后一个名额”的窗口。
- 这套进程锁建立在单 Web 主进程部署前提上；SQLite 持久化额度不等于整个服务已支持多实例。

### 6.2 重复请求语义

本期保证副作用受控，不提供 Idempotency-Key 或成功响应重放。

| 场景 | 结果 |
|---|---|
| 注册按钮重复点击 | 前端忽略；绕过前端的在途重复请求 409 busy |
| 发信刚成功又重复 register | 60 秒内 429 cooldown，不重复发信、不覆盖 pending |
| 冷却结束后再次 register | 视为明确发起新轮次；仅新邮件成功后覆盖旧资料 |
| 并发 resend-code | 同一时刻只发一封；竞争请求 busy，之后旧 registrationId 返回 stale |
| 并发正确核验 | 至多一次 201/建号；竞争请求 busy，消费后再次请求 404 pending_missing |
| 并发错误核验 | 已受理的请求串行更新次数；busy 不算一次错码，次数不会丢失 |
| 第五次错码后再核验/重发 | 第五次当次 410 exhausted；之后 404 pending_missing |
| 成功核验后重放验证码 | 404 pending_missing，不查询历史验证码、不签新 Cookie |

前端遇到核验网络错误或 pending_missing 可先 GET /api/me 检查浏览器是否已经收到会话；若有登录态则完成 UI 收尾，否则引导密码登录。不能按邮箱已存在推断登录成功。

客户端关闭连接后，已经开始的 SMTP 操作继续在期限内收尾。成功发送仍记账、激活 pending、启动冷却；不能因为浏览器取消就释放已消耗的额度。建号已提交但响应丢失时保留账号，不补建、不回滚；用户可用原密码登录。

## 7. 发信额度、冷却与失败恢复

### 7.1 限额与自然日

| 维度 | 正式额度 | 判断条件 |
|---|---|---|
| 同规范邮箱 | 3 封 / 自然日 | 当日 sent + 有效在途预留 < 3 |
| 同来源 IP | 10 封 / 自然日 | 当日 sent + 有效在途预留 < 10 |
| 全平台 | SMTP_DAILY_MAX，默认 200 | 非零时，当日 sent + 有效在途预留 < 上限 |

SMTP_DAILY_MAX 仅接受非负安全整数；0 只关闭全局额度检查，邮箱/IP/冷却/请求频控仍生效。

自然日固定北京时间（UTC+08:00）。quota_day 使用 SMTP 接受确认时刻对应的 YYYY-MM-DD。午夜前发起、午夜后成功的邮件计入后一天。

未结束的预留跨午夜继续占用新一天的可发名额，不能仅按 reserved_at 所在日期过滤；提交成功时变成成功当天的 sent 记录。这样午夜附近也不会超发最后一个名额。

先检查已确认成功数是否达限，命中多层时按邮箱、IP、全平台顺序返回 429，Retry-After 为到下一个北京时间午夜的秒数；成功数尚未达限再检查加入在途预留后是否暂时占满，若是返回 429 send_reserved，retryAfterSec=2，提示稍后重试。失败的额度检查不插入任何预留、不改任何成功次数。

### 7.2 两阶段额度处理

    检查冷却/三层额度 → 短事务预留 → SMTP
      ├─ 确认接受 → 短事务变为 sent + 激活 pending → 200
      ├─ 明确失败 → failed，释放预留 → 502
      └─ 接受结果不明 → unknown，暂留预留 → 502

预留租约为 120 秒，从预留时刻计算；单个发信操作总期限为 60 秒。预留不是正式扣费，查询正式发信数只统计 sent。

当前 ratelimit.js 每十分钟会清理一小时前的请求记录，不能承担自然日额度；三层日额度必须由本节持久账本计算。

### 7.3 什么算 SMTP 成功

收到 DATA 内容终结符之后的最终接受响应（正常为 250）才算成功；连接成功、AUTH 成功或 RCPT 接受都不够。成功代表邮件服务器接受投递责任，不代表邮件已经到达收件箱。之后 QUIT 超时/失败不改变已接受结果，也不允许自动再发。依据：[RFC 5321 §4.2.5](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5)。

### 7.4 失败矩阵

| 情况 | pending | 60 秒成功冷却 | 正式额度/预留 | HTTP |
|---|---|---|---|---|
| 生产配置缺失或无效 | 不改 | 不改 | 不记账、不预留 | 503 mail_unavailable |
| 接口频控/冷却/日额度拒绝 | 不改 | 不改 | 不记账、不预留 | 429 |
| SMTP 明确失败，包括连接、认证、TLS、明确拒信 | 旧记录保留；首次仍无记录 | 不启动、不延长 | 0；释放预留 | 502 mail_failed |
| DATA 已写出但最终确认丢失，不能确定是否接受 | 旧记录保留；新候选不激活 | 不启动、不延长 | 0；unknown 暂占到租约结束 | 502 mail_status_unknown，附剩余租约秒数 |
| SMTP 确认接受且业务提交成功 | 新轮次激活、旧轮次失效 | 从 accepted_at 起 60 秒 | sent 计 1；预留结束 | 200 |
| SMTP 已接受，但原 pending 或候选码在等待中到期 | 删除过期 pending，不激活新码 | 仍从 accepted_at 起算 | sent 计 1 | 410 expired |
| SMTP 已接受，但 accounts 出现冲突或轮次不再匹配 | 不覆盖已改变的状态 | 仍从 accepted_at 起算 | sent 计 1 | 409 conflict/stale |
| SMTP 已接受但数据库提交失败 | 事务回滚，保留原状态 | 成功冷却可能尚未落盘；按预留暂时禁止重发 | 无已提交 sent 时保留预留，禁止再次发送来“补偿” | 503 registration_storage_error |

发送失败时仅清理已自然过期的旧 pending。旧码、旧轮次、旧 attempts 和旧期限不得被失败的重发重置；也不能通过失败重发把错误次数清零。

unknown 租约有效时，同邮箱发信返回 503 send_recovering，Retry-After 为剩余租约秒数；旧有效验证码仍允许核验。已无对应运行操作的遗留 reserved（包括数据库故障未能改状态）按同样规则处理。明确失败无需等 60 秒，可在请求频控允许时重试。

SMTP 与 SQLite 不共享事务：进程可能在邮件被接受后、落库之前崩溃，也可能丢失最终 SMTP 确认。本期不承诺这些场景的跨系统“恰好一次”。重启后未完成预留按 unknown 保留到原租约截止，不自动重发、不凭空计入成功数；到期释放。可能出现用户收到一封未激活邮件、确认成功数少记的极小窗口，这是本期明确的故障边界。

### 7.5 冷却和接口请求频控

成功冷却读取同邮箱最近 sent.accepted_at，跨日有效；即使 pending 已删除，60 秒内也不能重新发信。剩余秒数向上取整，以服务器响应为准。

| 请求频控 | 配额 | 说明 |
|---|---|---|
| register + resend-code 共用 reg:IP | 5 次 / 10 分钟 | 包括 SMTP 失败请求，抑制故障时反复连接 |
| verify-code，按邮箱与 IP | 各 10 次 / 10 分钟 | 校验格式后，两桶一起检查、一起记录 |
| login，按 IP | 10 次 / 5 分钟 | 保留现有行为 |

请求频控与“成功邮件额度”是两种计数。频控拒绝不计错码；格式不合规不触发 scrypt、不消耗错码次数。多桶请求频控需要 all-or-none 的检查/记录语义，不能先让第一个 allow 扣数再被第二个拒绝。

## 8. HTTP API 契约

### 8.1 通用响应

以下三个注册接口的成功对象包含 ok:true。错误对象包含 ok:false、reason（稳定机器码）、error（中文文案）；特定错误附 field、remaining 或 retryAfterSec。所有 429 返回 Retry-After；有明确短期重试时间的 409/502/503 同样返回。

账号及登录态响应加 Cache-Control: no-store。三个注册接口的错误响应不签发、不清除现有会话；发码成功也不发送任何 Set-Cookie。

验证与重发需同时提供规范邮箱和 registrationId。不同轮次校验失败先返回 stale，不能拿旧请求扣当前轮错码。

### 8.2 POST /api/account/register

请求：

    {
      "registrationProtocol": "email-code-v1",
      "nickname": "棋手甲",
      "email": "alice@example.com",
      "password": "example-password"
    }

受理顺序：JSON 对象校验 → 协议字段检查 → 资料字段校验 → IP 请求频控 → 发信配置检查 → 邮箱互斥 → 锁内账号查重 → 冷却 → 准备候选资料 → 三层预留 → SMTP → 提交。

registrationProtocol 缺失或不匹配返回 409 client_upgrade_required，error 为“注册流程已更新，请刷新页面后重试”；无 Cookie、pending、预留或发信。旧前端现有错误展示分支可以直接呈现这条信息；新客户端必须按上述契约传入字段。

成功 200：

    {
      "ok": true,
      "registrationId": "<32位hex>",
      "emailMasked": "a***@example.com",
      "expiresInSec": 600,
      "resendAfterSec": 60
    }

掩码只保留本地部分首字符和完整域名。expiresInSec/resendAfterSec 在响应时按实际截止时间向上取整，耗时情况下可小于示例值。仅 §9 开发模拟模式额外返回 devCode。

有效请求在生产未配置 SMTP_HOST 时返回 503 mail_unavailable；其余常见响应为 400 invalid_input、409 conflict（含 field）、409 registration_busy、429、502 或 503。不返回 accountId，不在本接口建号。

### 8.3 POST /api/account/verify-code

请求：

    { "email": "alice@example.com", "registrationId": "<本轮ID>", "code": "001234" }

受理顺序：格式 → 双维请求频控 → 邮箱互斥 → pending/轮次/期限 → scrypt 比对 → 条件计错或事务建号。

| 情况 | 响应 | 副作用 |
|---|---|---|
| 参数格式错误 | 400 invalid_input | 无错码计数 |
| 同邮箱处理中 | 409 registration_busy | 无错码计数 |
| pending 不存在 | 404 pending_missing | 不签 Cookie |
| registrationId 不匹配 | 409 registration_stale | 不影响当前轮 |
| 读到过期 pending | 410 expired | 删除该过期轮 |
| 第 1–4 次错误 | 400 code_incorrect，remaining 分别 4、3、2、1 | 增加 attempts |
| 第 5 次错误 | 410 exhausted，remaining=0 | 删除 pending |
| 最终账号查重冲突 | 409 conflict + field | 不建号，删除这轮 pending，引导重新填写或登录 |
| 核验建号成功 | 201，见下方 | 建号与删除 pending 原子完成，提交后签 Cookie |

成功：

    { "ok": true, "accountId": 123, "nickname": "棋手甲", "emailVerified": true }

第 5 次不再返回普通 400。后台已清理过期数据时只返回 404，前端把 expired/exhausted/pending_missing 都映射到重新填写资料；它们不能承诺提供可重发的 pending。

核验依赖已发出的有效 pending，不依赖此时 SMTP 配置是否可用。

### 8.4 POST /api/account/resend-code

请求：

    { "email": "alice@example.com", "registrationId": "<当前ID>" }

受理顺序：格式 → 发信请求频控 → 配置检查 → 邮箱互斥 → pending/轮次/期限/账号校验 → 冷却 → 准备新码 → 预留 → SMTP → 提交。

只有有效 pending 可重发，不接受前端再次传入昵称或密码来隐式更新资料。成功返回 200，结构同 register，但 registrationId 是新值，有效期可能受流程期限缩短。前端必须同时更新轮次、计时与输入框。

通过配置检查后，无 pending 为 404；旧轮次为 409 registration_stale；读到过期为 410 并删记录。若邮箱已完成注册则返回 409 conflict + field=email，并清理残留的匹配轮次；其他邮件错误与 register 相同。

### 8.5 429 文案

| reason | 文案与附加行为 |
|---|---|
| rate_limited | 请求过于频繁，请稍后重试；附实际 Retry-After |
| cooldown | 请等待后再获取验证码；附剩余成功冷却秒数 |
| email_daily_limit | 该邮箱今日验证码次数已达上限，请明日再试 |
| ip_daily_limit | 当前网络今日验证码次数已达上限，请明日再试 |
| global_daily_limit | 今日注册名额已满，请明日再试 |
| send_reserved | 验证邮件正在发送，请稍后重试；Retry-After: 2 |

错误文案不输出 SMTP 原始响应、主机地址、认证内容或数据库异常文本。

## 9. SMTP 契约和开发模式

### 9.1 配置

| 环境变量 | 规则 |
|---|---|
| SMTP_HOST | 配置后使用真实 SMTP；生产缺失时 register/resend 返回 503 |
| SMTP_SECURE | true 为隐式 TLS，false 为必须成功 STARTTLS；未设默认 true，其他值视为配置无效 |
| SMTP_PORT | 正整数 1–65535；缺省按模式取 465/587 |
| SMTP_USER / SMTP_PASS | 真实模式必填，不得向 runner 传递 |
| SMTP_FROM | 缺省使用 SMTP_USER；必须是本 Spec 支持的单一邮箱地址，不接受显示名或 CRLF |
| SMTP_DAILY_MAX | 缺省 200；非负安全整数；0 仅关闭全局每日上限 |

SMTP 配置无效使发码服务不可用并记录脱敏诊断；平台启动、已有账号登录、首页、游戏页继续可用。无效配置不能静默转开发模式。

### 9.2 协议

- 新增 platform/mail.js；每封邮件独立连接，不做自动 SMTP 重试。
- TLS 验证服务端证书链与主机名；最低 TLS 1.2，不能用关闭证书验证绕过测试失败。
- 465 在连接建立时启动 TLS；587 收到 EHLO 能力后必须 STARTTLS，成功后重新 EHLO，再 AUTH LOGIN。无 STARTTLS、升级失败或不支持所需认证均报错，不能明文发凭据。依据：[RFC 3207 §4](https://www.rfc-editor.org/rfc/rfc3207.html#section-4)、[RFC 8314 §3.3](https://datatracker.ietf.org/doc/html/rfc8314#section-3.3)。
- 命令按 EHLO / AUTH / MAIL FROM / RCPT TO / DATA / QUIT 串行执行；接受标准多行响应，正确处理 TCP 拆包和粘包。
- 每个连接/命令步骤期限 15 秒；总操作期限 60 秒。定时器必须按步骤计时，不能被零碎数据无限续期；超时销毁 socket。
- DATA 后最终接受为成功边界；QUIT 仅负责收尾。已接受后故障不能触发重复发信或额度释放。
- 邮件为 UTF-8 文本；中文主题使用编码词；正文 base64 按 76 字符折行、统一 CRLF；正确处理 DATA 终结符与 dot-stuffing。
- 信封地址、邮件头字段禁止 CR/LF 注入；From、To、Date、Message-ID、MIME-Version、Content-Type 和 Content-Transfer-Encoding 均正确生成。
- 主题为“【Claw Clash】邮箱验证码”；内容含验证码、实际有效期、非本人操作可忽略与平台不会索取密码的提示。

应用 15/60 秒上限是为注册交互制定的超时策略，不等同于通用邮件队列客户端的全部重试/超时规范。

### 9.3 开发模拟

仅当 NODE_ENV 不为 production 且 SMTP_HOST 未配置，并且其他已提供配置值有效时，允许模拟发送：

- 可将验证码输出至明确标识的开发日志，成功响应附 devCode。
- 模拟接受同样走额度预留/提交、成功冷却与 pending 激活，不能跳过额度分支逻辑。
- 前端自动填验证码但不自动核验建号。
- SMTP_HOST 已配置时必须尝试真实 SMTP；失败返回 502，不回退、不返回 devCode。
- production 无论配置/错误情况都不能打印验证码或返回 devCode。

## 10. 登录与会话 Cookie

- 密码仍以随机盐 + scrypt 保存，不重新哈希已有哈希；本期不迁移全部密码格式。
- 登录统一错误“邮箱或密码错误”，保留最大密码长度在 scrypt 前的短路。用户不存在时不额外披露账号信息；不承诺响应时间完全相同。
- 核验建号的数据库事务提交后，或邮箱密码登录成功后，才签发 sx_session。
- 保留 Path=/、HttpOnly、SameSite=Lax、Max-Age=604800；production 加 Secure。会话为固定七天，从签发时刻计算。
- GET /api/me 和其他鉴权请求不自动续期；成功密码登录重新签发七天 Cookie。到期后返回 401，需要登录。
- logout 清除浏览器 Cookie，重复 logout 仍返回 200。它不撤销已复制的 Cookie；本期不添加会话黑名单或版本号。
- 同一 SESSION_SECRET 下重启保留有效会话；未设时沿用启动随机密钥，旧会话在重启后失效。生产部署必须提供稳定强随机密钥。
- 重放已消费验证码不续期、不补发 Cookie。HTTP 响应丢失后使用密码登录恢复；不引入仅凭邮箱/账号存在即可登录的兜底。
- /api/me 保留 emailVerified 字段以兼容消费方；迁移与新建号保证正常账号为 true。去掉门槛不等于隐藏账号是否存在的鉴权检查。

## 11. 前端状态与导航

### 11.1 两步弹窗

资料页：昵称、邮箱、密码、确认密码，保留实时校验与 loading。成功发码后保留弹窗、切验证码页；保存规范邮箱、registrationId、邮箱掩码和服务端截止时间，清空密码。

验证码页：显示掩码邮箱、验证码输入（numeric inputmode、maxlength=6、one-time-code 自动填充提示）、剩余有效期、重发倒计时、更换邮箱。回车可提交；请求进行中相关按钮禁用，避免多次提交。

倒计时使用绝对截止时间与当前时间重新计算，切后台后返回不会延长。服务端冷却/额度响应覆盖前端估计。

错误行为：

- code_incorrect 保留第二步并显示 remaining。
- exhausted、expired、pending_missing 回资料页，保留昵称与邮箱、密码重新输入。
- registration_stale 提示“注册信息已更新，请重新填写资料”，不得自动跟随陌生轮次。
- mail_failed 保留资料页或旧验证码页，旧码仍有效时可继续输入；不假装已发送。
- mail_status_unknown 告知发送结果暂未确认，按 retryAfterSec 等待；若有旧有效码仍可核验，不自动尝试新码。
- mail_unavailable 显示注册邮件服务暂不可用；已有账号可以去登录。
- 字段冲突标出 nickname 或引导已注册邮箱去登录；频控按服务端原因和重试时间显示。

关闭弹窗清理计时器、密码、验证码、registrationId 与 pendingNav；不发送服务端删除 pending 请求。切换注册/登录子面板不丢 pendingNav，用户主动关闭才清除。

为弹窗维护一次打开的本地标识：关闭/切换后的迟到异步回调不能重开旧面板、消费新导航意图或自动跳转；请求完成后仍需处理实际 Cookie 登录态，不能把页面状态当作数据库回滚。

### 11.2 登录/注册完成后的导航

- 从普通注册/登录入口完成：留在当前页和当前 tab，refreshMe 刷新头部、侧栏和游戏登录态缓存。
- 只有 dispatchNav / routeFromHash 的鉴权守卫可写入 pendingNav={gid,key}。
- 守卫触发后，用户切到登录并成功也消费同一个 pendingNav。
- 成功处理须先取出并清除意图，再关闭弹窗、刷新登录态、跳目标；避免通用 closeModal 把意图提前丢掉。
- 同游戏调用 showTab 并同步 hash；跨游戏只跳注册表内合法 gid/nav 构造的路径，不接受外部 return URL。
- 关闭弹窗后下次普通登录不应恢复旧意图。
- 登出沿用现状：游戏页回首页，首页原地刷新。

## 12. 历史迁移与兼容切换

### 12.1 一次性迁移

新增持久迁移标记，例如 schema_migrations(name PRIMARY KEY, applied_at)，迁移名 email_code_registration_v1_1。

首次部署先于 HTTP 监听在事务内完成：

1. 创建 pending 与发信记录表和必要索引。
2. 保留 accounts.email_verified 列；将当时全部 email_verified=0 历史账号置为 1。
3. 写入迁移标记，与补齐操作一起提交。

重复启动只检查标记，不再执行旧的“每次启动全部放行”业务逻辑。迁移失败不监听、不提供半迁移服务；事务回滚，保留既有账号及游戏数据。按既有 P3 迁移顺序执行，本次标记不得替代或破坏 P3 历史迁移。

新账号创建方法必须在 INSERT 时写 email_verified=1，不能先建号再补写。

### 12.2 同版本删除旧链路

| 删除/调整内容 | 位置 |
|---|---|
| EMAIL_VERIFICATION 与启动批量验证业务块 | server.js |
| sendVerificationEmail、旧 verify/resend-verification handler | server.js |
| makeVerifyToken / verifyVerifyToken | auth.js |
| 旧 setEmailVerified / markAllAccountsVerified 业务导出 | db.js |
| challenge 中 !email_verified 门槛 | platform/routes_game.js |
| showVerifyLink / verifyBannerHtml / bindVerifyBanner | public/platform.js |
| 三款游戏对上述横幅函数的调用和相关说明 | games/*/public/app.js |
| 原自动跳“我的”页行为 | public/platform.js |

旧 GET /api/account/verify 与 POST /api/account/resend-verification 返回 404，不再解析旧 Token，也不能修改账号。旧环境变量即使残留也不再改变任何行为。

挑战入口仍保持 Bearer 鉴权、账号存在性检查、频控、目标和代码校验。只删除邮箱状态门槛，不修改游戏计分规则。

### 12.3 发布与回退契约

- 同次部署后端、共享前端、三款游戏横幅移除和迁移；生产仅一个 Web 主进程，禁止新旧版本同时受理注册。
- 停止旧进程后执行经验证可恢复的 SQLite 备份流程；运行中不能把分别随手复制 DB/WAL/SHM 当作一致快照。
- 完成迁移再开始接流量；历史会话在密钥不变时有效，账号/选手/代码/排名/战报不变。
- 旧浏览器标签页缺 registrationProtocol，按 §8.2 返回 409 + 刷新文案；它不会收到发码成功的 200。新前端带该字段进入两步流程。上线验收必须覆盖旧请求未发邮件、未创建 pending/账号。
- 紧急回退不能直接恢复开放的旧直建号接口；先暂停 register/resend，保留登录/游戏能力，再回退。已完成的新账号不删除，已发送成功记录和冷却不得通过回退清零。
- 本 Spec 仅定义发布要求；实际备份、部署、回退操作由后续任务执行。

## 13. 日志、隐私与运行观测

- 可记录独立发送操作 ID、模式、阶段、耗时、结果机器码、脱敏邮箱；普通日志不记录密码/哈希、验证码、Cookie、registrationId、SMTP 授权码、完整 SMTP 对话。
- 开发模拟验证码输出是 §9.3 的唯一例外，测试必须验证 production 分支无法到达。
- 记录 SMTP 配置不可用、认证失败、TLS 错误、超时、接受状态不明和存储提交失败，便于区别“用户没收到”和“平台未发出”。
- mail_attempts 的邮箱与 IP 用于限额，限期保留；不借本次改造长期收集设备或用户画像。
- 请求体及异常日志不得把整个注册 body 序列化输出；发信环境变量只存在 Web 主进程。
- 时间由后端统一提供，生产固定真实时钟；测试通过内部注入时钟模拟过期/跨午夜，不暴露调时 HTTP 接口。

## 14. 验收矩阵

下表是需写入 Plan 的验收契约，不表示相应测试已存在。所有自动化使用临时数据库和本地假 SMTP，显式隔离继承的 SMTP 环境变量。

| ID | 场景 | 必须验证的结果 |
|---|---|---|
| AC01 | 正常两步注册 | register 200，无 accounts/Set-Cookie；verify 201、已验证账号、pending 删除、Cookie 可读 /api/me |
| AC02 | 前导零及字段类型 | 六位字符串 001234 可用；数字/数组/null/控制字符等受控 400，无 500 |
| AC03 | 邮箱大小写/别名 | 大小写同一键；点号/加号不错误合并；旧账号仍可登录 |
| AC04 | 前四次错码 | attempts 持久递增，remaining=4/3/2/1，服务重启不重置 |
| AC05 | 第五次与后续 | 第五次 410 exhausted 并删行；随后 verify/resend 404，不签 Cookie |
| AC06 | 过期边界与清理 | now 等于截止时不可核验；启动/每分钟/访问清理生效；清理后返回 404 |
| AC07 | 重发成功 | 新 ID/码生效，attempts 归零；旧 ID stale；保留密码哈希与原流程期限 |
| AC08 | 首发失败/重发失败 | 首发无 pending；重发保留旧码/ID/attempts/期限；不扣成功额度、不延长冷却 |
| AC09 | 60 秒冷却 | register/resend 共用；59 秒拒绝、60 秒可发送；删除 pending/跨日/重启不绕过 |
| AC10 | 同邮箱并发 | 在途冲突快速 busy；不会发送两封、重复建号或覆盖错码计数 |
| AC11 | stale 请求 | 另一窗口更新资料后旧 ID 不能核验/重发新轮次，也不计当前轮错码 |
| AC12 | 成功核验重放 | 最多一次 201；消费后 404，无会话补签、无重复 accounts |
| AC13 | 昵称争抢 | 两邮箱同昵称最终只有一人建号；失败一方 409 field=nickname 并清理 pending |
| AC14 | 建号事务异常 | 插入/删除任一步失败全部回滚；账号唯一性保持，失败不发 Cookie |
| AC15 | 最后一个发信名额 | 多邮箱/多 IP 并发只有可用名额被预留；无三桶部分扣数 |
| AC16 | SMTP 成功记账 | 仅 DATA 最终接受后记 sent；一个发送操作最多计一次；QUIT 失败不释放额度 |
| AC17 | 发送结果不明 | 502 unknown、不激活候选；暂存预留后释放；无自动补发，旧码可核验 |
| AC18 | 自然日切换 | 北京时间午夜归零；午夜前预留后成功计新一天；在途名额仍参与新日检查 |
| AC19 | 默认额度与 0 | 邮箱3/IP10/全局200分别可触发；全局0不关闭其他限制；无效配置不能当0 |
| AC20 | 重启与持久化 | 已确认发送、冷却保留；遗留预留按租约恢复；删除 pending 不重置额度 |
| AC21 | 生产缺 SMTP | 有效 register/resend 返回503；首页、登录、已发码的核验仍可用；无验证码日志/响应 |
| AC22 | 开发模拟与真邮件 | 模拟返回 devCode 并走完整额度；配置 SMTP 后失败不降级，不返回 devCode |
| AC23 | SMTP 解析 | 多行响应、拆包、粘包、拒绝认证/收件、连接关闭均正确收尾 |
| AC24 | TLS 与超时 | 465与STARTTLS成功；证书错误/无STARTTLS拒绝；15秒步骤/60秒总期限生效，无明文凭据 |
| AC25 | 邮件内容 | 中文主题、UTF-8、base64折行/CRLF/终结符正确；地址头注入被拒 |
| AC26 | 密码/会话回归 | 旧密码登录、七天固定期限、无滑动续期、Secure属性、登出清Cookie、密钥不变重启有效 |
| AC27 | 两步 UI | loading禁重复、错误次数/期限/重发更新正确、密码不在第二步长期保留 |
| AC28 | 导航意图 | 普通入口留原页；守卫注册/登录后去目标；主动关闭后无残留；迟到回调不误跳 |
| AC29 | 一次性迁移 | 旧0→1、标记幂等、失败回滚；原账号ID和三款游戏数据保持 |
| AC30 | 旧链路清理 | 旧接口404、旧开关无效、三款“我的”页无缺失函数错误、挑战不再检查邮箱状态 |
| AC31 | 隐私与保留 | 生产日志无凭据/验证码；pending期限与发信记录48小时清理正确 |
| AC32 | 响应丢失/存储失败 | SMTP成功但HTTP断开仍记账；建号成功响应丢失可密码登录；SMTP后DB失败不补发 |
| AC33 | 已接收但流程过期 | 发信计费/冷却仍生效；不复活过期密码哈希；返回410引导重填 |
| AC34 | 整体回归 | 原账号→建选手→发布→挑战→回放通过；计分/锁/迁移测试与官方规则示例通过 |
| AC35 | 旧标签页与发布 | 无/错误 registrationProtocol 得409刷新提示，无邮件/pending/账号/Cookie；正确协议可进入两步流程 |

真实发信人工验收在测试发信账号配置后单独执行，检查收信、垃圾箱情况、验证码期限和失败提示；自动化测试不向真实用户发邮件。

原 npm test 在先前分析中因环境 spawn EPERM 未实际跑通，不能把该结果当测试基线通过。Plan 需要先解决测试执行权限并记录基线，再据上表安排验证。

## 15. 后续 Plan 的输入与完成定义

Plan 从本 Spec 拆解依赖、文件改动和验证步骤；如遇行为冲突，先更新 Spec 的决策记录及对应验收项，再改实现。

已识别影响面：

- db.js：pending、发信账本、迁移标记、事务建号和清理。
- server.js / auth.js：注册接口、输入校验、Cookie、旧链接移除。
- platform/mail.js（新增）：邮件协议；日额度/注册编排模块的拆分由 Plan 确定。
- ratelimit.js：短期多桶频控；不得拿其现有一小时清理逻辑承载日额度。
- platform/routes_game.js：删除挑战邮箱门槛、保留其他鉴权。
- public/fragments/shared_modals.html / public/platform.js / 必要样式：两步弹窗与导航意图。
- 三款 games/*/public/app.js：移除旧横幅调用；相关 guide/文档也需去掉旧邮箱门槛说明。
- test/、QA 平台清单、README、SECURITY、平台系统/技术架构/部署说明：测试、行为和配置同步。

实现完成须满足：AC01–AC35 均有可追溯验证结果；新接口和旧链路清理同版本完成；迁移可重复运行且不影响游戏数据；生产无 SMTP 正确拒绝发码；实际邮件投递经指定测试邮箱验证。配置凭据缺失时应明确记录真实投递未验收，不将其写成已通过。

本文件不包含分阶段编码任务清单；下一份 Implementation Plan 应引用本文件版本与验收 ID。
