# 新增一款游戏 · 标准作业流程（SOP）v1.0

> 适用对象：在本平台上接入第 N 款游戏的开发者（人类或 Agent）。
> 前置阅读：[技术架构说明_v1.0](技术架构说明_v1.0.md)（尤其 §二 分层边界、§五 游戏层契约）。
> 参考实现：**`games/darkchess/` 是最新、最干净的模板**——本 SOP 的每一步都能在其中找到对应代码。
>
> 总原则：**新增游戏 = 新建 `games/<id>/` 目录 + 在 `games/registry.js` 登记一行**。根目录 `server.js`、`db.js`、`platform/`、前端壳 `public/` 一律不改（唯一例外见步骤 8 的前端引擎打包）。

---

## 0. 设计决策先行（写代码前必须定稿）

先在 `GameDesign/` 落一份规则/策划文档（如 `<游戏名>规则_v1.0.md`），并明确以下决策——它们决定后面每个文件怎么写：

| 决策项 | 问题 | 现有游戏的选择 |
|---|---|---|
| 游戏 id | 小写字母数字，作目录名/路由段/game_id | `clawclash` / `prisoner` / `darkchess` |
| 脚本入口签名 | Agent 脚本导出什么函数？入参/返回值契约？ | `onTurn(me, opponent, game)→move` / `onRound(...)→'C'\|'D'` |
| 信息结构 | 完美信息 / 不完美信息（需要遮罩层）/ 同时出手？ | 钳王完美 / 暗战遮罩 / 囚徒同时 |
| 赛制 | 单场几局？怎么合计定胜负？ | 钳王双局 4 分制 / 囚徒、暗战单场 |
| 思考资源模型 | 只挂钟超时，还是加思考点计量？每手/每回合超时多少？ | 钳王 100 点+数秒 / 囚徒 50ms / 暗战挂钟 |
| 随机性 | seed 决定什么（开局分布/回合数/先手）？ | 必须**每场全新 seed**（平台契约：对局非确定性）；每座位独立 RNG（deriveRng，防共享随机流操纵） |
| 战报形态 | 统一 battles 够不够？专属数据放 ext/blob 还是私有表？ | 囚徒 ext+blob / 钳王、暗战私有表 |
| 试玩形态 | 人机试玩怎么交互？内置对手能否浏览器本地跑？ | 见步骤 6/8 |
| 训练对手 | 3 档左右、覆盖「随机/贪婪/一步推演」梯度，烟雾测试与试玩共用 | 三款均为 3 名 |
| 名词与文案 | 选手叫什么（棋手/囚徒/…）？ | manifest `noun` |

> ⚠️ 平台不变量（不要试图偏离，除非改平台并全量回归）：每账号每游戏 1 名选手；先测后存发布；哈希对计分窗口反刷分；全游戏共用同一套 RP 公式与段位；挑战结果只有 win/loss/draw 三态进结算。

---

## 1. 建目录骨架

```
games/<id>/
├── index.js       # manifest（子进程安全！）
├── server.js      # 服务端适配（仅主进程）
├── guide.js       # Agent 指南拼装
├── engine/
│   ├── rules_core.js      # 规则核心（纯函数，UMD）
│   ├── engine.js          # 对局主循环（+单步原语，若试玩/前端要复用）
│   ├── sandbox.js         # vm 沙箱 makeBot(code)
│   ├── training_bots.js   # 训练对手（UMD，若要浏览器本地试玩）
│   ├── smoke.js           # 烟雾测试
│   ├── play_session.js    # 试玩无状态重放（可选，看试玩形态）
│   └── builtins.js        # 内置对手查找 findBuiltin（UMD）
└── public/
    ├── panel.html         # 前端面板片段（data-slot 两段：panel + overlays）
    └── app.js             # 前端插件（IIFE + Platform.registerGame）
```

**开发顺序建议**：engine（可独立单测）→ index.js → guide.js → server.js → public/ → 登记 → 测试。

---

## 2. engine/ —— 对局引擎

硬约束：**整个 engine/ 不得 require `db`/`auth`/`platform` 下含状态的模块**（会被 runner 子进程加载）。

1. **rules_core.js**：纯函数规则核心。若前端需要本地推演（本地落子/本地对局），写成 UMD：
   ```js
   // 文件尾部
   if (typeof module !== 'undefined') module.exports = api;
   else window.<GameId>Rules = api;
   ```
2. **engine.js**：`playMatch(bots, seed, opts) → { winner, reason, turns, history, ... }`。要点：
   - winner 用**座位**（如 `'a'|'b'|'draw'`）或颜色表达，由 server.js 换算成 challenger 视角——引擎不知道谁是挑战者；
   - 每座位用 `deriveRng(seed, seat)` 派生独立随机流（参照囚徒/暗战），绝不让双方共享一个 `random()`；
   - 不完美信息游戏：引擎负责 `buildView` 遮罩后再调 bot 的入口函数，规则核心只管真实棋盘；
   - 单场挂钟上限（如 `maxMatchMs`）防「每手不超时但整场长拖」；
   - 玩家脚本 illegal / runtime（超时）/ error 三类失败即时判负，`reason` 里区分。
   - 若试玩或浏览器本地对局要逐步推进，把主循环拆成**单步原语**（参照 `darkchess/engine/engine.js` 的 initMatchState/stepAction 族），三方（整场对局/试玩重放/浏览器）复用同一套，绝不写两份推进逻辑。
3. **sandbox.js**：`makeBot(code) → { bot, error }`。照抄现有实现的三件事：vm `timeout` 挂钟超时；不注入宿主内置对象；只暴露安全 API 给脚本。每次任务全新上下文（不复用）。
4. **training_bots.js**：3 档训练对手。**只经交给脚本的同一套公开 API 操作**（暗战靠这一点保证训练对手也不能窥视暗子）；若要浏览器本地跑，UMD 化且不依赖 Node-only 模块。
5. **smoke.js**：`runSmokeTests(code) → { passed, failures }`。惯例：3 名训练对手 × 双方座位各 1 = 6 场，**固定种子集**（同代码重复提交结果一致）；只拦 illegal/runtime/error，**不拦「输」**；failures 带对手/座位/种子/原因/回合，Agent 按明细修复。
6. **play_session.js**（可选）：无状态重放试玩。契约：`runPlay(spec, { makeBot, findBuiltin }) → { ok:false, status, error } | { ok:true, payload }`。要点：完整 history 服务端重算校验（不信任客户端附带的判定字段）；随机开局的游戏必须靠 seed 重导（首次响应回传 seed，客户端后续原样带回）；响应只含玩家可见视图。

建议此阶段顺手写规则单测（参照 `test_rules.js`），把规则文档里的官方示例全部钉住。

---

## 3. index.js —— manifest

**红线：本文件（及其 require 链）绝不 require db/auth**——runner 子进程经 `games/registry.js` 加载它。

```js
'use strict';
const { playMatch } = require('./engine/engine');
const { makeBot } = require('./engine/sandbox');
const { runSmokeTests } = require('./engine/smoke');
const { buildGuide } = require('./guide');

const SCORED_LIMIT = 10;

module.exports = {
  id: '<id>',
  name: '<中文名>',
  nameEn: '<英文名>',           // 首页卡片副标题 / 海报占位
  tagline: '<一句话简介>',      // 首页卡片
  noun: '<选手名词>',
  keyParam: '<id>_key',
  idField: '<id>Id',            // 对外 JSON 的 id 字段名
  wrapKey: '<id>',              // info/me/public 响应包装键
  avatarPrefix: '<唯一前缀>',    // ⚠️ 全游戏唯一！已占用 ''(钳王)/'p'(囚徒)/'d'(暗战)
  scoredLimit: SCORED_LIMIT,
  leaderboardTtlMs: 15000,
  guidePath: '/games/<id>/agent-guide',   // 新游戏直接用规范路径即可（短路径见步骤 4 aliases）
  guideMarkdown: buildGuide({ scoredLimit: SCORED_LIMIT }),
  client: {
    scripts: ['/games/<id>/app.js'],  // 若有引擎打包，排在 app.js 之前（见步骤 8）
    // 二级导航：壳按此渲染侧栏竖排导航；key 对应 app.js 的 tab 名（showTab 派发），auth:true 项未登录点击弹注册
    nav: [
      { key: '<id>play', label: '试玩' },
      { key: '<id>leaderboard', label: '天梯榜' },
      { key: '<id>mybot', label: '我的<选手名词>', auth: true },
      { key: '<id>guide', label: 'Agent 指南' },
    ],
  },

  limits: {          // 各任务父进程硬超时（ms）——按最坏情况给足余量
    smoke: 90000,    // 6 场烟雾
    challenge: 20000,
    play: 20000,
  },
  tasks: {           // runner 子进程任务；键 = execpool.run 的 kind
    smoke: (t) => runSmokeTests(t.code),
    challenge(t) {
      const { bot: aBot } = makeBot(t.aCode);
      const { bot: bBot } = makeBot(t.bCode);
      if (!aBot || !bBot) return { loadFailed: true };
      return playMatch({ a: aBot, b: bBot }, t.seed);
    },
    play: (t) => runPlay(t.spec, { makeBot, findBuiltin }),  // 试玩形态而定
  },
};
```

检查点：
- [ ] `limits` 的每个键与 server.js 里 `execpool.run(gid, kind, …)` 的 kind 一一对应（漏配会直接抛「未注册的执行任务」）；
- [ ] `tasks` 的返回值可 JSON 序列化（走 IPC）；
- [ ] `avatarPrefix` 与所有现有游戏不同。

---

## 4. server.js —— 服务端适配

模板照抄 `games/darkchess/server.js`（300 行）。分块要点：

**(a) 统一数据层**：
```js
const core = db.gameStore(manifest.id, {});   // 需 ELO 次级排序才传 { rankTiebreak: 'rating' }
```
需要附挂私有数据时展开覆写（如 `listBattles` 附加每场明细），否则直接 `const store = core`。

**(b) 游戏私有表**（若战报核心不够用）：经 `db.db` 句柄 `CREATE TABLE IF NOT EXISTS <id>_xxx`。注意：
- **先 exec 建表、再 prepare 引用它的语句**（node:sqlite 在 prepare 阶段就会报 no such table）；
- 无外键（与现有私有表一致），完整性应用层保证；
- 存 `battle_id` 链接回 battles 行。
轻量数据优先走 `battles.ext`（JSON 标量）/ `battles.blob`（二进制），省一张表（参照囚徒）。

**(c) 视图族**：`battleView/battleListView`（选手视角换算——`persp` 三态）、`leaderboardRow`（id 字段名用 manifest.idField 对应的名字）、`agentMatches` / `opponentMatches`（分页：limit 夹取 1–50、offset、total/hasMore）、`matchDetail`（null → 平台回 404；剔除大字段后返回，如 `game_json: undefined` + 解析后的 `gameData`）。

**(d) buildPrompt**：一键复制给 Agent 的 Prompt。必含：选手名/id/段位/版本、完整密钥、指南 URL（`origin + guidePath`）、提交接口（规范路径 `/api/games/<id>/agent/code/submit`）、脚本入口签名一句话、游戏最容易踩的规则坑一句话。

**(e) challenge**（核心）：
```js
const challenge = {
  bodyIdField: 'challenged<IdField大写>',   // 挑战 body 里目标 id 字段名
  async execute({ challenger, challenged, chCode, cdCode, ownerKey }) {
    const matchUrlId = db.urlId();
    const seed = crypto.randomInt(0, 1 << 30);        // 每场全新 seed（平台契约）
    let result;
    try {
      result = await execpool.run('<id>', 'challenge', { aCode: chCode.code, bCode: cdCode.code, seed }, ownerKey);
      if (result && result.loadFailed) return { status: 500, json: { ok: false, error: '代码加载失败' } };
    } catch (e) {
      return { status: e && e.busy ? 503 : 500, json: { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败，请重试' } };
    }
    // 座位视角 → 挑战者视角（引擎不知道谁是挑战者，换算在这里做）
    const battleResult = result.winner === 'a' ? 'challenger' : result.winner === 'b' ? 'challenged' : 'draw';
    const chResult = battleResult === 'challenger' ? 'win' : battleResult === 'challenged' ? 'loss' : 'draw';

    const settlement = await settleChallenge({
      ns: manifest.id, challenger, challenged,
      chHash: chCode.code_hash, cdHash: cdCode.code_hash,
      chResult, scoredLimit: manifest.scoredLimit,
      store: {
        getFresh: (id) => store.getById(id),
        getHashPair: (id, my, opp) => store.getHashPair(id, my, opp),
        recordHashPair: (id, my, opp) => store.recordHashPair(id, my, opp),
        applyScored({ chFresh, cdFresh, newChRp, newCdRp, chResult: cr, cdResult }) {
          store.updateStats(chFresh.id, null, newChRp, ...wldInc(cr));      // 无内部分传 null
          store.updateStats(cdFresh.id, null, newCdRp, ...wldInc(cdResult));
        },
        persist({ chFresh, cdFresh, newChRp, newCdRp, scored }) {
          const battleId = store.createBattle({ urlId: matchUrlId, challengerId: chFresh.id, challengedId: cdFresh.id,
            result: battleResult, reason: result.reason,
            chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
            scored: scored ? 1 : 0, seed,
            chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash });
          // + 私有表落库（若有）
        },
      },
    });
    return { status: 200, json: { ok: true, matchUrlId, result: battleResult, /* … */,
      rpChange: { challenger: { from: settlement.fromChRp, to: settlement.newChRp, rank: rankLabel(settlement.newChRp) },
                  challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, rank: rankLabel(settlement.newCdRp) } },
      scored: settlement.scored,
      scoringNote: /* 参照现有游戏的两条文案 */ } };
  },
};
```
不要绕过 `settleChallenge` 自己写结算——锁、锁内重读、计分窗口全在里面，绕过即重蹈并发覆盖事故。

**(f) extraRoutes**：游戏专属路由。惯例三件套：对手清单（训练对手 + 榜单前 20 已发布者）、试玩 `POST /api/games/<id>/play`（IP 频控 120/min；**信任分流**：玩家脚本→execpool，内置/双人→主进程直推 + `makeBot(){ throw }` 守卫）、选手搜索 `GET /api/games/<id>/players/search`。

**(g) aliases**：新游戏一般为空对象即可。若想给指南配短路径（如 `/agent-guide-<id>`），登记 `{ guide: ['/agent-guide-<id>'] }` 并把 manifest.guidePath 指向它。

**(h) module.exports**：`{ store, battleListView, leaderboardRow, buildPrompt, agentMatches, opponentMatches, matchDetail, challenge, aliases, extraRoutes }` —— 缺一不可（路由工厂直接引用）。

---

## 5. guide.js —— Agent 指南

`buildGuide(params) → markdown`。结构照抄现有游戏：

1. 标题 + 一句话定位（顺手排雷：主动澄清最容易被 Agent 误解的规则点，如钳王「与五子棋无关」）；
2. `authSection(keyName)`（平台段落）；
3. 规则要点（浓缩版，别复制整份规则文档）；
4. 坐标/数据表示（**用具体例子钉死索引顺序**——钳王的 `board[x][y]` 说明就是被 Agent 反复读反后加的）；
5. 代码契约：入口签名、入参结构、超时/计量、非法输出判负规则、**对局非确定性**声明；
6. API 一览表（用规范路径 `/api/games/<id>/…`）；
7. 烟雾测试说明（先测后存、只拦崩溃不拦输）；
8. `rankAndAntiFarmSection({ formatLine: '<赛制一句话>', scoredLimit })`（平台段落）;
9. 良好 Agent 行为（revert 止血、侦察、防侦察、推荐循环）。

---

## 6. public/ —— 前端插件

**panel.html**：两个 `data-slot` 顶层节点，壳按槽注入（**二级导航不再写在此**——改由 manifest `client.nav` 声明，壳统一渲染在侧栏）：
```html
<div class="section-panel" data-slot="panel"> …各 tab 面板（id="<前缀>-<tab名>"）… </div>
<div data-slot="overlays"> …本游戏专属弹窗（挂到 body，不随面板隐藏）… </div>
```

**app.js**：整体 IIFE，尾部 `Platform.registerGame({ id, init, onShow, showTab, showMine, defaultView, onAuthChange })`。要点：

- **DOM 命名空间**：IIFE 只隔离 JS；document 级的 data 属性/class/id 必须带游戏前缀（现占用：钳王 `tab`/`tab-panel`、囚徒 `ptab`、暗战 `dqtab`）。
- **二级导航由壳渲染**：`makeTabs(cfg)` 返回的 `show(key)` 注册为插件 `showTab`，供壳侧栏点击派发；`makeTabs` 本身**不再绑导航按钮**（按钮由壳画，登录守卫在壳的 `dispatchNav`）。`client.nav` 的每个 `key` 必须与 `makeTabs` 的 tab 名一致。
- 能复用的都复用壳组件：`makeTabs`（二级 tab 切换）、`renderLeaderboardRows`、`renderVersionList`、`overviewCardHtml`/`accessCardHtml`+`bindAccessCard`、`verifyBannerHtml`+`bindVerifyBanner`、`openCreatePlayer`/`openAvatarEditorShared`、`myPlayer(gid)`、`popup/toast/copyText/apiFetch/esc/avatarHtml/rankLabel`。真正要自己写的只有：试玩交互（棋盘渲染/操作）与回放视图。棋类若要试玩终局动效，复用壳样式 `.result-pop`/`.confetti-box`（参照钳王/暗棋，overlay 用带前缀 id）。
- 登录态缓存失效放 `onAuthChange`；建号/换头像后 `await refreshMe()` 再重画。
- **懒加载时机**：游戏插件（面板 + `client.scripts` + `init()`）在**用户首次进入该游戏时**才由壳 `ensureGameLoaded` 加载，不在开站时——`init()` 只在首次进入跑一次，勿假设它在页面启动即执行；面板 DOM 也是进入后才存在（`init` 里可安全操作自己的面板子树）。
- （可选）首页卡片海报：默认落回壳的通用渐变占位；若要主题化插画，在壳 `gamePosterSvg` 按 `game.id` 加一个分支（参照钳王/囚徒/暗棋）。

---

## 7. 登记 —— 唯一的平台侧改动

`games/registry.js`：
```js
const ids = ['clawclash', 'prisoner', 'darkchess', '<id>'];
```

到此新游戏自动获得：全套 22 条平台 API（`/api/games/<id>/…`）、统一数据层（零 schema 工作）、天梯微缓存、结算与并发保护、指南路由、`/api/me` 里的选手概要、首页卡片与侧栏「当前游戏」入口、二级导航（按 `client.nav`）、以及进入时的插件懒加载注入（首页不受新增游戏拖累）。

---

## 8. （仅当需要）前端引擎打包路由

若试玩要在浏览器本地跑内置对手/本地对局（推荐——零网络、不占执行池），引擎相关文件需 UMD 化并打包下发。当前打包路由硬编码在根 `server.js`（`/game-rules.js`、`/builtin-bots.js`、`/darkchess-bots.js`）——**这是「零改平台」的唯一例外**。做法参照暗战：

```js
// server.js（模仿 DARKCHESS_BOTS_JS 块）
const <ID>_BOTS_JS = [
  '<id>/engine/rules_core.js', '<id>/engine/engine.js',
  '<id>/engine/training_bots.js', '<id>/engine/builtins.js',
].map((f) => fs.readFileSync(path.join(__dirname, 'games', f), 'utf8')).join('\n;\n');
route('GET', '/<id>-bots.js', (req, res) => sendCached(req, res, <ID>_BOTS_JS, 'text/javascript; charset=utf-8', 'no-cache'));
```

规矩：独立路由（别并进共享包，避免其它游戏白下发）；`'\n;\n'` 相接（IIFE 边界）；`no-cache` 协商缓存（规则改动即时生效，防前后端判定漂移）；manifest `client.scripts` 里把它排在 `app.js` **之前**；**玩家上传脚本绝不下发**。

---

## 9. 测试与验收

**自动化**：
- [ ] `npm test` 全绿（现有测试是平台回归网——新游戏不该弄挂任何一项）；
- [ ] 新增本游戏规则单测（参照 `test_rules.js`，规则文档官方示例全钉住）；
- [ ] （建议）在 `test/api.e2e.test.js` 模式上补一条本游戏的注册→建号→提交→挑战冒烟。

**手动清单**（`node server.js` 后过一遍）：
- [ ] 启动日志出现新游戏名；首页出现该游戏卡片（名/英文名/简介，点卡进入）；侧栏「当前游戏」下拉可切到本游戏、竖排二级导航（按 `client.nav`）正常切换、未登录点「我的X」弹注册；
- [ ] 懒加载：首页 Network 无本游戏 `panel.html`/脚本请求；点卡进入后才加载该游戏插件、`init()` 只跑一次、再次进入不重复 fetch；
- [ ] 注册 → 建选手（名称查重、头像上传/预设）→「我的」页概览/密钥掩码/一键 Prompt；
- [ ] 用 Prompt 里的 key 走 Agent 链路：`code/submit` 烟雾失败（提交个 `throw` 脚本验证 422 明细）→ 提交正常脚本 → v1 发布；
- [ ] 两个账号互相 `challenge`：结果/rpChange/scored 正确；打满 `scoredLimit` 场后转练习赛（`scored:false`）；
- [ ] 天梯榜/公开详情/公开战绩/回放详情；`/games/<id>/agent-guide` 可读；
- [ ] 试玩：内置对手 / 玩家脚本 / （若有）双人模式；死循环脚本被超时判负且**主进程仍响应其它请求**；
- [ ] `/api/me` 的 `players.<id>` 出现新游戏概要。

---

## 10. 文档与发布

- [ ] `GameDesign/<游戏>规则_v1.0.md` 定稿（若步骤 0 后有改动同步回去）；
- [ ] README「当前游戏」表 + 结构说明补一行；
- [ ] [平台系统说明_v1.1](平台系统说明_v1.1.md) 的游戏清单补一行；
- [ ] 生产发布按既有流程：**先备份 `sixchess.db*` 三件** → `git pull` → PM2 重启 → 手动验收清单关键项复跑一遍（新游戏首次上线时统一表族会自动为其服务，无迁移动作）。

---

## 11. 常见陷阱清单（历史踩坑汇总）

| # | 陷阱 | 后果 | 规避 |
|---|---|---|---|
| 1 | manifest（或其 require 链）引了 db/auth | runner 子进程打开 SQLite / 被权限模型拦（ERR_ACCESS_DENIED）| index.js 顶部注释写明「子进程安全」；只 require engine 与 guide |
| 2 | `avatarPrefix` 与现有游戏重复 | 跨游戏同 id 选手头像互相覆盖 | 登记前 grep `avatarPrefix` 确认唯一 |
| 3 | 私有表先 prepare 后建表 | 启动即崩（no such table） | `db.db.exec(CREATE TABLE…)` 在所有 prepare 之前 |
| 4 | 绕过 settleChallenge 手写结算 | 并发挑战互相覆盖丢分（复盘文档里那个事故） | 一律走 `settleChallenge`，差异只经 store 回调注入 |
| 5 | 挑战响应把引擎座位（a/b）直接返给用户 | 前端/Agent 视角混乱 | server.js 里统一换算成 challenger/challenged 与 win/loss/draw |
| 6 | 双方共享同一个 `game.random` | 脚本可通过消耗随机流操纵对手的随机决策 | 每座位 `deriveRng(seed, seat)` 独立派生 |
| 7 | 试玩把玩家脚本放主进程跑 | 不可信代码逃出隔离 | 信任分流 + `makeBot(){ throw }` 守卫（照抄现有实现） |
| 8 | 试玩响应泄露隐藏信息（暗子/剩余回合数） | 玩家开图作弊 | play_session 只回遮罩视图；对 bot 隐藏的信息对试玩客户端同样隐藏 |
| 9 | 前端 DOM 选择器不带游戏前缀 | 误伤其它游戏面板（DOM 全站共享） | data 属性/class/id 全部加前缀；新前缀与 `tab`/`ptab`/`dqtab` 不同 |
| 10 | UMD 打包文件直接 `+` 拼接 | 前一 IIFE 的 `)(…)` 与后一 `(function` 连成调用，加载即炸 | 以 `'\n;\n'` 相接（照抄 server.js 现有打包块） |
| 11 | `limits` 漏配某 kind | `execpool.run` 直接 reject「未注册的执行任务」 | limits 与 server.js 里用到的 kind 一一核对 |
| 12 | 烟雾用随机种子 | 同一份代码时过时不过，Agent 无法收敛 | 固定种子集（同代码重复提交结果一致） |
| 13 | 烟雾顺带拦「输棋」 | Agent 首版弱脚本永远发不出去 | 只拦 illegal/runtime/error |
| 14 | guideMarkdown 里写 legacy 风格路径 | 新游戏没有 legacy 别名，Agent 404 | 指南/Prompt 一律用 `/api/games/<id>/…` 规范路径 |

---

## 12. 交付定义（Definition of Done）

全部满足才算接入完成：

1. `games/<id>/` 五件套齐备，registry 登记；
2. 平台文件零改动（或仅步骤 8 的打包路由一处）；
3. `npm test` 全绿 + 本游戏规则单测通过；
4. §9 手动清单全过，含「死循环脚本不拖垮主进程」与「计分窗口耗尽转练习赛」两个关键项；
5. §10 文档四项更新完毕；
6. 一名真实 Agent（拿一键 Prompt 冷启动）能在不询问人类的情况下走通「读指南 → 提交过烟雾 → 发起挑战 → 读回放」全链路——这是最终验收标准。
