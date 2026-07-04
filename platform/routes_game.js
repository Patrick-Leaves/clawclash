'use strict';
// 游戏路由工厂：给定游戏 manifest（games/<id>/index.js）+ 服务端适配（games/<id>/server.js），
// 挂载该游戏的全套平台通用 API。每条路由同时注册两组路径：
//   规范路径：/api/games/<id>/...、/api/games/<id>/agent/...、/games/<id>/agent-guide（新游戏只有这组）
//   legacy 别名：web.aliases 里登记的旧路径（已发布给 Agent/前端的稳定契约，长期保留）
// 平台负责统一的鉴权 / 频控 / 邮箱门槛 / 先测后存发布 / 结算调度骨架；
// 游戏差异（响应包装键、战报视图、赛制执行）全部经 manifest / web 注入——新增游戏不改本文件。
const { withLock } = require('./locks');
const { makeJsonMicroCache } = require('./microcache');
const { rankLabel } = require('./scoring');
const execpool = require('./execpool');

function mountGameRoutes({ route, game, web, helpers }) {
  const { sendJson, rl, rateLimited, requireSession, getAccountById,
          validateAvatarDataUrl, saveAvatarFile, maskKey, originOf, sendMicroCached } = helpers;
  const gid = game.id;
  const store = web.store;

  // 每条路由注册规范路径 + legacy 别名（同一 handler，响应完全一致）
  const reg = (method, key, canonical, fn) => {
    route(method, canonical, fn);
    for (const alias of (web.aliases && web.aliases[key]) || []) route(method, alias, fn);
  };
  const rx = (suffix) => new RegExp(`^/api/games/${gid}${suffix}$`);

  // ---- Agent 鉴权（Bearer Key）----
  function requireAgent(req) {
    const header = req.headers['authorization'] || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) return { player: null, error: `缺少 Authorization: Bearer <${game.keyParam}>` };
    const player = store.getByApiKey(key);
    if (!player) return { player: null, error: 'API Key 无效' };
    return { player, error: null };
  }
  // ---- 人类会话 + 已建资产（未建回 404）----
  function requireOwned(req, res) {
    const { account, error } = requireSession(req);
    if (error) { sendJson(res, 401, { ok: false, error }); return null; }
    const player = store.getByAccount(account.id);
    if (!player) { sendJson(res, 404, { ok: false, error: `尚未创建${game.noun}` }); return null; }
    return { account, player };
  }
  // 玩家概览（me / agent info / 公开详情共用的白名单字段；不外泄内部 ELO 与 account_id）
  function playerOverview(p) {
    const total = p.wins + p.losses + p.draws;
    return {
      id: p.id, name: p.name, avatar: p.avatar,
      rp: p.rp, rank: rankLabel(p.rp), rankPosition: store.rankPosition(p.id),
      wins: p.wins, losses: p.losses, draws: p.draws,
      winRate: total ? Math.round((p.wins / total) * 100) : null,
      currentVersion: p.current_version,
      status: p.current_version === 0 ? 'empty' : 'active',
    };
  }

  // ============================================================
  // § 创建 / 名称检查（人类，Cookie）
  // ============================================================
  reg('POST', 'create', `/api/games/${gid}/create`, (req, res, _m, body) => {
    const { account, error } = requireSession(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    if (store.getByAccount(account.id))
      return sendJson(res, 409, { ok: false, error: `每账号在每款游戏仅 1 名${game.noun}` });
    const name = (body.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, error: `请填写${game.noun}名称` });
    if (store.getByName(name))
      return sendJson(res, 409, { ok: false, error: `该名称已被其他${game.noun}占用，换一个吧` });
    const avatar = typeof body.avatar === 'string' && /^preset:[1-6]$/.test(body.avatar) ? body.avatar : 'preset:1';
    const player = store.create(account.id, name, avatar);
    store.createApiKey(player.id);
    sendJson(res, 201, { ok: true, [game.idField]: player.id });
  });

  reg('GET', 'nameCheck', `/api/games/${gid}/name-check`, (req, res) => {
    const url = new URL(req.url, 'http://x');
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
    sendJson(res, 200, { ok: true, name, available: !store.getByName(name) });
  });

  // ============================================================
  // § 头像（前端已裁 1:1；服务端二次校验；文件名带游戏前缀防跨游戏 id 撞名互覆盖）
  // ============================================================
  reg('POST', 'avatarUpload', `/api/games/${gid}/me/avatar`, (req, res, _m, body) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const v = validateAvatarDataUrl(body.dataUrl);
    if (v.error) return sendJson(res, 400, { ok: false, error: v.error });
    const fileName = saveAvatarFile(game.avatarPrefix, ctx.player.id, v);
    // 文件名保持稳定（覆盖旧内容），返回值附版本戳查询串 → 上传后 <img src> 变新 URL，绕过浏览器缓存
    const avatarVal = `upload:${fileName}?v=${Date.now()}`;
    store.updateAvatar(ctx.player.id, avatarVal);
    sendJson(res, 200, { ok: true, avatar: avatarVal, url: `/avatars/${fileName}` });
  });

  reg('POST', 'avatarPreset', `/api/games/${gid}/me/avatar/preset`, (req, res, _m, body) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const n = +body.preset;
    if (!Number.isInteger(n) || n < 1 || n > 6) return sendJson(res, 400, { ok: false, error: 'preset 须为 1..6' });
    const avatarVal = `preset:${n}`;
    store.updateAvatar(ctx.player.id, avatarVal);
    sendJson(res, 200, { ok: true, avatar: avatarVal });
  });

  // ============================================================
  // § 我的资产（人类，Cookie）：概览 / Prompt / 轮换 Key / 版本 / 战绩
  // ============================================================
  reg('GET', 'me', `/api/games/${gid}/me`, (req, res) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const keyInfo = store.keyInfo(ctx.player.id);
    sendJson(res, 200, { ok: true, [game.wrapKey]: {
      ...playerOverview(ctx.player),
      maskedKey: maskKey(keyInfo ? keyInfo.key_plain : ''),
      guideUrl: game.guidePath,
    } });
  });

  reg('GET', 'prompt', `/api/games/${gid}/me/prompt`, (req, res) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const keyInfo = store.keyInfo(ctx.player.id);
    sendJson(res, 200, { ok: true, prompt: web.buildPrompt(ctx.player, keyInfo ? keyInfo.key_plain : '', originOf(req)) });
  });

  reg('POST', 'rotateKey', `/api/games/${gid}/me/rotate-key`, (req, res) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const key = store.rotateApiKey(ctx.player.id);
    sendJson(res, 200, { ok: true, maskedKey: maskKey(key) });
  });

  reg('GET', 'meVersions', `/api/games/${gid}/me/versions`, (req, res) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    sendJson(res, 200, { ok: true, versions: store.listVersions(ctx.player.id) });
  });

  reg('GET', 'meVersion', rx('/me/version/(\\d+)'), (req, res, m) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const v = store.getVersion(ctx.player.id, +m[1]);
    if (!v) return sendJson(res, 404, { ok: false, error: '版本不存在' });
    sendJson(res, 200, { ok: true, version: v });
  });

  reg('GET', 'meMatches', `/api/games/${gid}/me/matches`, (req, res) => {
    const ctx = requireOwned(req, res); if (!ctx) return;
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
    const rows = store.listBattles(ctx.player.id, limit);
    const myIdField = 'my' + game.idField[0].toUpperCase() + game.idField.slice(1);
    sendJson(res, 200, { ok: true, [myIdField]: ctx.player.id, battles: web.battleListView(rows, ctx.player.id) });
  });

  // ============================================================
  // § Agent 接口（Bearer Key）：信息 / 提交 / 回滚 / 版本 / 挑战 / 战绩 / 侦察
  // ============================================================
  reg('GET', 'agentInfo', `/api/games/${gid}/agent/info`, (req, res) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    sendJson(res, 200, { ok: true, [game.wrapKey]: { ...playerOverview(player), createdAt: player.created_at } });
  });

  // 提交代码（先测后存）：烟雾测试在隔离子进程跑，通过才分配版本号入库发布，失败不占用版本号。
  // 同一玩家的发布/回滚整体串行化（含烟雾测试）：杜绝「版本号读改写」竞态撞 UNIQUE 约束。
  reg('POST', 'codeSubmit', `/api/games/${gid}/agent/code/submit`, async (req, res, _m, body) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    if (rateLimited(res, rl.allow(`${gid}:publish:` + player.id, 6, 60 * 1000))) return;
    const { code, notes, submittedBy } = body;
    if (!code || typeof code !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 code 字段' });
    if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy 字段' });
    await withLock(`pub:${gid}:` + player.id, async () => {
      let passed, failures;
      try { ({ passed, failures } = await execpool.run(gid, 'smoke', { code }, `${gid}:` + player.id)); }
      catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '发布执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
      if (!passed) {
        return sendJson(res, 422, {
          ok: false, smokeStatus: 'failed',
          message: '烟雾测试未通过，代码未入库、不占用版本号；按失败明细修复后直接重提',
          failures,
        });
      }
      const fresh = store.getById(player.id) || player; // 锁内重读最新版本号（auth 快照可能已过期）
      const newVersion = (fresh.current_version || 0) + 1;
      const saved = store.publish(player.id, newVersion, code, notes, submittedBy);
      sendJson(res, 200, { ok: true, version: newVersion, codeHash: saved.code_hash, smokeStatus: 'passed', message: `v${newVersion} 发布成功` });
    });
  });

  // 版本回滚：与发布共用同一把串行锁（同键），回滚同样先测后存（规则可能已变更，旧代码不保证合规）
  reg('POST', 'codeRevert', `/api/games/${gid}/agent/code/revert`, async (req, res, _m, body) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    if (rateLimited(res, rl.allow(`${gid}:publish:` + player.id, 6, 60 * 1000))) return; // 与发布共享频控
    const { toVersion, submittedBy } = body;
    if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy' });
    await withLock(`pub:${gid}:` + player.id, async () => {
      const fresh = store.getById(player.id) || player; // 锁内重读最新版本号
      const target = store.getVersion(player.id, +toVersion);
      if (!target) return sendJson(res, 400, { ok: false, error: `v${toVersion} 不存在` });
      const current = store.getVersion(player.id, fresh.current_version);
      if (current && current.code_hash === target.code_hash)
        return sendJson(res, 400, { ok: false, error: '目标版本代码与当前版本一致，无需回滚' });
      let passed, failures;
      try { ({ passed, failures } = await execpool.run(gid, 'smoke', { code: target.code }, `${gid}:` + player.id)); }
      catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
      if (!passed) {
        return sendJson(res, 422, { ok: false, smokeStatus: 'failed', message: '回滚目标代码烟雾测试未通过，未入库、不占用版本号', failures });
      }
      const newVersion = (fresh.current_version || 0) + 1;
      const autoNotes = body.notes || `revert to v${toVersion}`;
      store.publish(player.id, newVersion, target.code, autoNotes, submittedBy);
      sendJson(res, 200, {
        ok: true, version: newVersion, revertedToVersion: toVersion,
        codeHash: target.code_hash, smokeStatus: 'passed',
        message: `已回滚至 v${toVersion} 的代码内容（新版本号 v${newVersion}）。注意：哈希对计分资格按哈希判定，回滚不重置已消耗资格`,
      });
    });
  });

  reg('GET', 'codeVersions', `/api/games/${gid}/agent/code/versions`, (req, res) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    sendJson(res, 200, { ok: true, versions: store.listVersions(player.id) });
  });

  // 正式挑战：平台骨架统一把守 鉴权 → 频控 → 邮箱门槛 → 目标/代码校验，
  // 赛制执行 + 结算落库（内部走 platform/settle.js）由游戏适配的 challenge.execute 完成。
  reg('POST', 'challenge', `/api/games/${gid}/agent/challenge`, async (req, res, _m, body) => {
    const { player: challenger, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    if (rateLimited(res, rl.allow(`${gid}:challenge:` + challenger.id, 30, 60 * 1000))) return;
    // 邮箱验证门槛（防多账号刷分）：未验证账号不能发起正式挑战
    const chAccount = getAccountById(challenger.account_id);
    if (!chAccount || !chAccount.email_verified)
      return sendJson(res, 403, { ok: false, error: `请先验证账号邮箱后再发起正式挑战（站内「我的${game.noun}」可重新发送验证邮件）` });
    const challengedId = +body[web.challenge.bodyIdField];
    if (!challengedId || challengedId === challenger.id)
      return sendJson(res, 400, { ok: false, error: `不能挑战自己或无效 ${game.idField}` });
    const challenged = store.getById(challengedId);
    if (!challenged) return sendJson(res, 404, { ok: false, error: `被挑战${game.noun}不存在` });
    const chCode = store.latestPassed(challenger.id);
    const cdCode = store.latestPassed(challenged.id);
    if (!chCode) return sendJson(res, 422, { ok: false, error: '你尚未发布可用代码（需先通过烟雾测试）' });
    if (!cdCode) return sendJson(res, 422, { ok: false, error: '对手尚未发布可用代码' });
    const r = await web.challenge.execute({ challenger, challenged, chCode, cdCode, ownerKey: `${gid}:` + challenger.id });
    sendJson(res, r.status, r.json);
  });

  reg('GET', 'agentMatches', `/api/games/${gid}/agent/matches`, (req, res) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    sendJson(res, 200, web.agentMatches(player, new URL(req.url, 'http://x')));
  });

  reg('GET', 'opponentMatches', rx('/agent/opponents/(\\d+)/matches'), (req, res, m) => {
    const { player, error } = requireAgent(req);
    if (error) return sendJson(res, 401, { ok: false, error });
    const target = store.getById(+m[1]);
    if (!target) return sendJson(res, 404, { ok: false, error: `目标${game.noun}不存在` });
    sendJson(res, 200, web.opponentMatches(target, new URL(req.url, 'http://x')));
  });

  // ============================================================
  // § 公开接口：天梯榜（微缓存）/ 玩家详情 / 玩家战绩 / 对局回放 / Agent 指南
  // ============================================================
  const lbPayload = makeJsonMicroCache(game.leaderboardTtlMs, () => ({
    ok: true,
    leaderboard: store.leaderboardRows().map(web.leaderboardRow),
  }));
  reg('GET', 'leaderboard', `/api/games/${gid}/leaderboard`, (req, res) =>
    sendMicroCached(req, res, lbPayload(), Math.round(game.leaderboardTtlMs / 1000)));

  reg('GET', 'playerPublic', rx('/players/(\\d+)/public'), (req, res, m) => {
    const p = store.getById(+m[1]);
    if (!p) return sendJson(res, 404, { ok: false, error: `${game.noun}不存在` });
    const owner = getAccountById(p.account_id);
    sendJson(res, 200, { ok: true, [game.wrapKey]: {
      ...playerOverview(p),
      ownerNickname: owner ? owner.nickname : '—',
      createdAt: p.created_at,
    } });
  });

  reg('GET', 'playerMatchesPublic', rx('/players/(\\d+)/matches/public'), (req, res, m) => {
    const p = store.getById(+m[1]);
    if (!p) return sendJson(res, 404, { ok: false, error: `${game.noun}不存在` });
    const rows = store.listBattles(p.id, 10);
    sendJson(res, 200, { ok: true, [game.idField]: p.id, battles: web.battleListView(rows, p.id) });
  });

  reg('GET', 'matchDetail', rx('/match/([a-z0-9]+)'), (req, res, m) => {
    const payload = web.matchDetail(m[1]);
    if (!payload) return sendJson(res, 404, { ok: false, error: '对局不存在' });
    sendJson(res, 200, payload);
  });

  reg('GET', 'guide', `/games/${gid}/agent-guide`, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(game.guideMarkdown);
  });
}

module.exports = { mountGameRoutes };
