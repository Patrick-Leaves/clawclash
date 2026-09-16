# 安全说明（公网部署必读）

本平台运行**玩家提交的不可信 JavaScript**（棋手脚本）。代码层已做的防护与**仍需在部署侧补齐**的隔离，分列如下。

## 一、代码层已实现

- **独立子进程执行（常驻 runner 池）**：所有不可信对局（正式挑战 / 烟雾测试 / 试玩）经 `platform/execpool.js` 的**常驻子进程池**派发到 `platform/runner.js` 执行（预 fork N 个、IPC 逐个下发任务、任务间不退出，任务按游戏注册表分发到 `games/<id>/`），与 Web/DB 主进程隔离：
  - 子进程 env 经白名单剥离机密（`SESSION_SECRET`、SMTP 等不传入），逃逸后读不到这些机密；
  - 父进程对每个任务设硬超时，超时 `SIGKILL` 该 worker 并补充新进程，**主事件循环不被阻塞**（实测：子进程跑死循环烟雾时，主进程其它请求仍毫秒级响应）；
  - **跨任务污染防线**（常驻进程相对 fork-per-task 的新增风险）：用户代码每任务都在全新 vm 上下文编译执行、绝不复用；任务超时/执行异常/进程意外退出 → 该 worker 直接处决换新；正常任务累计一定次数后也主动换新（防内存膨胀与隐性全局状态累积）；
  - 子进程不持有数据库句柄；池大小可配（`RUNNER_POOL_SIZE`，默认 4），排队超限回 503。
- **Node 权限模型（子进程内进程级闸门）**：`execpool.js` 以 `--permission --allow-fs-read=<platform 目录> --allow-fs-read=<games 目录>` fork 子进程。即便 vm 逃逸拿到宿主 realm 的真实 `fs`/`child_process`，越权操作也会在 C++ 层被拒（`ERR_ACCESS_DENIED`）：
  - **只放行读取 `platform/` 与 `games/` 目录**（runner 入口与各游戏引擎，均为本仓库代码、非机密）。app 根目录下的 `ecosystem.config.js`（含 `SESSION_SECRET`）与 `sixchess.db` 都在放行目录之外 → **逃逸后也读不到**（已实测：关闭权限模型时逃逸脚本能读出密钥文件，开启后同样脚本被 `ERR_ACCESS_DENIED` 拦下）；
  - **禁止一切 fs 写、`child_process`、`worker_threads`、原生插件**（均实测 `ERR_ACCESS_DENIED`）；
  - 兜底开关 `CHILD_PERMISSION=off` 可临时关闭（仅在极端不兼容时用，不建议线上关）；
  - **权限模型不拦网络出站**——网络隔离仍须靠部署侧（见下方第 3 项）。
- **每手挂钟超时**：`games/clawclash/engine/sandbox.js` 通过 vm `timeout` 对每次 `onTurn` 强制超时（`MOVE_TIMEOUT_MS`，数秒级），中断死循环/长耗时 → 判 `runtime` 负（囚徒困境同理：每回合 50ms，见 `games/prisoner/engine/sandbox.js`）。
- **单场挂钟上限**：`games/clawclash/engine/engine_quota.js` 的 `playMatch(maxMatchMs)` 防"每手不超时但整体长拖"的慢速消耗。
- **思考点计量（每手实例化）**：`makeRules(budget)` 每手一个计量实例，并发对局互不串改；交给脚本的 `Rules` 只含安全 API（**移除了 `_reset` / `_rawApply`**，杜绝脚本自行重置预算或绕过计量）。
- **收敛逃逸面**：沙箱不再注入宿主内置对象（`Math/JSON/…` 用上下文自带版本），去掉了 `Error.constructor('return process')` 这类最易用的逃逸路径。
- **接口频控**：`ratelimit.js` 对注册/登录/发布/挑战限速（超限 429）。
- **反刷分**：同一哈希对前 10 场计入段位/战绩/ELO，之后为练习赛不计分；正式挑战保留 Bearer 鉴权与账号存在检查，邮箱所有权在新账号创建前通过验证码核验。
- **鉴权**：密码 scrypt 加盐 + `timingSafeEqual`；会话为 HMAC 签名 Cookie（`HttpOnly`、`SameSite=Lax`）。

## 二、部署侧必须补齐（否则不要上公网）

> **Node 的 `vm` 不是安全边界。** 子进程内仍可经宿主对象（`game.rules`、`game.board`、`me.pieces` 等）的原型链触达该子进程的宿主 realm。代码层已把执行关进**独立子进程**并叠加 **Node 权限模型**——逃逸后已读不到机密文件/数据库、不能写盘、不能起子进程/线程（见上）。**但权限模型不拦网络出站**，且深度防御仍建议再叠一层 OS 级隔离。下列按「当前风险」排序，**第 1 项（网络）为上公网前的必做**：

1. **网络出站隔离（必做）**：权限模型不拦 socket，逃逸脚本仍可对外连接（数据外带 / 打内网 / SSRF）。做法——让 runner 子进程以**专用低权限用户**运行，再用 `iptables`/`nftables` 的 owner 匹配丢弃该用户的 OUTPUT（放行本机回环即可）。**降权已由代码支持**：`execpool.js` 读环境变量 `RUNNER_UID`/`RUNNER_GID`（POSIX，Windows 自动跳过）以该用户 fork 子进程；主进程须有 setuid 权限（PM2 以 root 跑即可），且该用户须能读 `platform/`、`games/` 与 node 可执行文件。配置示例：

   ```bash
   useradd -r -s /usr/sbin/nologin clawbot           # 建专用无登录用户
   id -u clawbot; id -g clawbot                       # 取数字 uid/gid，填入 ecosystem.config.js 的 env
   #   env: { ..., RUNNER_UID: '<uid>', RUNNER_GID: '<gid>' }
   iptables -A OUTPUT -m owner --uid-owner clawbot -o lo -j ACCEPT   # 放行回环（IPC/本地）
   iptables -A OUTPUT -m owner --uid-owner clawbot -j REJECT         # 丢弃其余对外连接
   ```
   或整体置于禁网的网络命名空间 / 容器。
2. **进程/容器隔离（建议）**：让子进程跑在独立低权限用户 / 容器中（容器 + seccomp，或 gVisor/Firecracker 等），把权限模型之外的攻击面（内核漏洞、`/proc` 信息泄露等）也收口。代码侧是可随时处决换新的常驻 runner 池（超时/异常即杀），部署侧补齐 OS 约束即可。
3. **资源上限（建议）**：对执行进程设 CPU/内存/句柄 cgroup 限额，叠加在挂钟超时之上，防单场极端占用拖垮小机器。
4. **密钥隔离（已由权限模型 + env 白名单覆盖，仍建议冗余）**：`SESSION_SECRET` 等机密既不在子进程 env 中，其所在文件也在只读放行目录之外；进一步可把机密文件挪出应用目录并收紧属主权限。

## 三、其他部署项

- **`SESSION_SECRET`**：务必设为稳定强随机值（未设则每次启动随机、重启即登出）。
- **邮箱投递**：真实 SMTP 仅由 Web 主进程执行，TLS ≥1.2 并验证证书链/主机名；隐式 TLS 或必须成功的 STARTTLS，升级后重新 EHLO 才 AUTH LOGIN。DATA 最终接受才记 sent，QUIT 失败不自动重发。production 无 SMTP 或配置无效时发码 503；配置 SMTP 后失败绝不降级。仅非 production、未配置 SMTP_HOST 且其余配置有效时可模拟并返回 devCode，生产日志与响应禁止泄露验证码、密码/哈希、Cookie、registrationId 和 SMTP 凭据。
- **棋手密钥**：当前 `api_keys.key_plain` 明文留存以支持站内展示掩码与一键 Prompt（demo 取舍）。更高安全要求下应改为只存哈希、明文仅创建/轮换时一次性返回。
- **反向代理**：`clientIp()` 仅在直连来自本机回环（即同机反代）时采用 `X-Forwarded-For` 的**最后一跳**（由反代追加的真实客户端地址；前面的条目可被客户端伪造，不予采信），公网直连时忽略该头以防伪造绕过频控。反代须配置 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，未配置时退回按直连地址聚合（生产同机反代下即所有用户共享频控桶，务必配置）。
- **HTTPS**：生产须在代理层启用 TLS；production 会话 Cookie 已带 Secure，并有 Path=/、HttpOnly、SameSite=Lax、固定七天期限；访问 /api/me 不滑动续期。登出只清浏览器 Cookie，不撤销已复制的 Cookie。
- **单主进程**：本期只支持一个 Web/DB 主进程。邮箱互斥、在途发送上限（4）与请求频控均有进程状态；SQLite 持久账本不代表多实例安全，不能仅增加共享频控就开启 PM2 cluster。

## 四、注册状态、隐私与发布

- register 只激活已成功发码的 pending，verify-code 原子建号并删 pending 后才签会话；全部账号与登录态响应 no-store。哈希使用随机盐与 scrypt，轮次 ID 只放请求体和弹窗内存。
- 北京时间自然日额度为邮箱 3/IP 10/全局默认 200；仅成功发信扣正式额度。未知发送保留 120 秒租约，崩溃恢复不补发；SMTP 与 SQLite 之间不承诺跨系统恰好一次。
- pending 最长 30 分钟；验证码最长 10 分钟，启动、每分钟与访问时清理；第 5 次错码直接删行。发信终态记录按 accepted_at/finished_at 保留 48 小时，含限额所需邮箱/IP，不保存邮件正文或验证码。在线清理不承诺擦除 WAL、空闲页或备份。
- 历史账号一次性迁移为已验证，保留 ID 与所有游戏资产；规范化邮箱碰撞则停止迁移/监听，不合并账号。旧验证链接/旧令牌辅助函数和 EMAIL_VERIFICATION 开关已移除，/api/me.emailVerified 是兼容字段。
- 发布前做一致 SQLite 备份及恢复演练；停旧进程后同版本发布前后端。回退先暂停 register/resend，保留新账号、成功发信账本和冷却，禁止恢复可用的旧直建号接口。执行步骤与外部验收见 [部署指南](GameDesign/部署指南_上海宝塔_v1.0.md) 和 [验收记录](QA/邮箱验证码注册_AC01-AC35_验收记录_v1.1.md)。
