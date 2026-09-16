'use strict';
// 平台数据层（P3 统一版）：node:sqlite 持久化。
// - 平台核心表：accounts + 统一的 players / player_api_keys / player_code_versions / battles / hash_pairs，
//   全部以 game_id 区分游戏；players 主键为 (game_id, id)，id 按游戏独立自增 →
//   新增游戏零 schema 工作，且历史公开 id（botId / prisonerId）在迁移中原样保留。
// - battles 为统一战报核心：通用列（结果/得分/RP增减/计分/种子/双方版本哈希）+
//   ext（游戏专属标量，JSON）+ blob（游戏专属二进制，如囚徒的选择序列）。
// - 游戏私有数据不进平台层：钳王的逐局棋谱表 matches 由 games/clawclash/server.js 自建自管
//   （经本模块导出的 db 句柄）；囚徒 move_blob 编解码在 games/prisoner/server.js。
// - 旧版「按游戏复制表族」的库在启动时一次性迁移（老表重命名为 legacy_* 保留备查，不删除）。
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

// 库文件路径可用 DB_PATH 覆盖（测试打临时库用）；生产/开发默认不变。
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'sixchess.db'));
// SQLite lower()/trim() only cover ASCII casing/spaces. Historical identities
// must use exactly the same canonical key as registration and collision checks.
db.function('canonical_email', { deterministic: true }, (email) => email.trim().toLowerCase());

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
`);

const hasTable = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// ---- 统一 schema（幂等）----
function createUnifiedSchema() {
  db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname       TEXT    UNIQUE NOT NULL,
  email          TEXT    UNIQUE NOT NULL,
  password_hash  TEXT    NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,  -- 正式挑战要求已验证
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  game_id         TEXT    NOT NULL,
  id              INTEGER NOT NULL,              -- 按游戏独立自增（建号时取该游戏 MAX(id)+1）
  account_id      INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  avatar          TEXT    NOT NULL DEFAULT 'preset:1',  -- 'preset:1..6' 或 'upload:<file>?v=<ts>'
  current_version INTEGER NOT NULL DEFAULT 0,
  rating          INTEGER NOT NULL DEFAULT 1200, -- 内部实力分（钳王 ELO 次级排序用；其它游戏可不用）
  rp              INTEGER NOT NULL DEFAULT 0,    -- 段位分（对外展示，决定段位）
  wins   INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, account_id),                  -- 每账号在每款游戏 1 名选手
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS player_api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    TEXT    NOT NULL,
  player_id  INTEGER NOT NULL,
  key_hash   TEXT    NOT NULL,
  key_prefix TEXT    NOT NULL,
  key_plain  TEXT    NOT NULL,   -- 明文留存：详情页掩码展示 + 组装 Prompt 需完整 key（demo 取舍）
  created_at INTEGER NOT NULL,
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);
CREATE INDEX IF NOT EXISTS idx_pkeys_hash   ON player_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_pkeys_player ON player_api_keys(game_id, player_id);

CREATE TABLE IF NOT EXISTS player_code_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      TEXT    NOT NULL,
  player_id    INTEGER NOT NULL,
  version      INTEGER NOT NULL,
  code         TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,
  notes        TEXT,
  submitted_by TEXT,
  smoke_status TEXT    NOT NULL DEFAULT 'pending',
  smoke_detail TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (game_id, player_id, version),
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);

-- 统一战报核心（一场 = 一行；游戏内部的更细粒度记录归各游戏自管，如钳王 matches）
CREATE TABLE IF NOT EXISTS battles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         TEXT    NOT NULL,
  url_id          TEXT    NOT NULL,
  challenger_id   INTEGER NOT NULL,
  challenged_id   INTEGER NOT NULL,
  result          TEXT    NOT NULL,   -- 'challenger' | 'challenged' | 'draw'
  reason          TEXT,               -- 结束原因（游戏自定；钳王在逐局记录上）
  ch_score        INTEGER,            -- 本场双方得分（赛制自定；可空）
  cd_score        INTEGER,
  ch_rp_delta     INTEGER,
  cd_rp_delta     INTEGER,
  scored          INTEGER NOT NULL DEFAULT 1,  -- 0=练习赛（哈希对资格用尽，不计段位/战绩）
  ch_code_version INTEGER, cd_code_version INTEGER,
  ch_code_hash    TEXT,    cd_code_hash    TEXT,
  seed            INTEGER,
  ext             TEXT,               -- 游戏专属标量（JSON，如囚徒 {actualRounds, failure}）
  blob            BLOB,               -- 游戏专属二进制（如囚徒按位打包的选择序列）
  played_at       INTEGER NOT NULL,
  UNIQUE (game_id, url_id),
  FOREIGN KEY (game_id, challenger_id) REFERENCES players(game_id, id),
  FOREIGN KEY (game_id, challenged_id) REFERENCES players(game_id, id)
);
CREATE INDEX IF NOT EXISTS idx_battles_game_ch ON battles(game_id, challenger_id);
CREATE INDEX IF NOT EXISTS idx_battles_game_cd ON battles(game_id, challenged_id);

-- 反刷分：哈希对计分窗口
CREATE TABLE IF NOT EXISTS hash_pairs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    TEXT    NOT NULL,
  player_id  INTEGER NOT NULL,
  my_hash    TEXT    NOT NULL,
  opp_hash   TEXT    NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (game_id, player_id, my_hash, opp_hash),
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);
`);
}

// ---- P3 一次性迁移：旧版按游戏分表（bots/prisoner_* 等）→ 统一表族 ----
// 迁移基线 = 2026-07 生产 schema（含 email_verified / battles.scored / matches.battle_id 等历史增量）。
// 公开 id 全部保留：players 复用旧表 id；钳王 battles 连主键 id 一并保留（matches.battle_id 免重链）。
// 旧表重命名为 legacy_* 留底备查；确认无误后可另行手动清理。
function migrateLegacyToUnified() {
  console.log('[P3 迁移] 检测到旧版按游戏分表结构，开始一次性迁移到统一表族…');
  db.exec('BEGIN');
  try {
    // 1) 旧表重命名留底（矩阵按存在性逐个处理，兼容部分表缺失的库）
    const renames = [
      ['bots', 'legacy_bots'], ['api_keys', 'legacy_api_keys'],
      ['code_versions', 'legacy_code_versions'], ['battles', 'legacy_battles'],
      ['hash_pair_scores', 'legacy_hash_pair_scores'],
      ['prisoner_bots', 'legacy_prisoner_bots'], ['prisoner_api_keys', 'legacy_prisoner_api_keys'],
      ['prisoner_code_versions', 'legacy_prisoner_code_versions'],
      ['prisoner_battles', 'legacy_prisoner_battles'],
      ['prisoner_hash_pair_scores', 'legacy_prisoner_hash_pair_scores'],
    ];
    for (const [from, to] of renames) if (hasTable(from)) db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);

    // 2) matches（钳王逐局棋谱，继续在线使用）重建去外键：
    //    RENAME 会把 matches 的外键引用自动改指 legacy_bots，新棋手落子会撞外键 → 重建为无外键表
    //    （完整性由钳王 server.js 在应用层保证，与其余游戏私有表一致）。
    if (hasTable('matches')) {
      db.exec(`CREATE TABLE matches_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_url_id TEXT UNIQUE NOT NULL,
        challenger_bot_id INTEGER NOT NULL,
        challenged_bot_id INTEGER NOT NULL,
        ch_code_version INTEGER NOT NULL,
        cd_code_version INTEGER NOT NULL,
        ch_code_hash TEXT NOT NULL,
        cd_code_hash TEXT NOT NULL,
        winner TEXT NOT NULL,
        reason TEXT NOT NULL,
        turns INTEGER NOT NULL,
        final_challenger_pieces INTEGER NOT NULL,
        final_challenged_pieces INTEGER NOT NULL,
        game_json TEXT NOT NULL,
        challenger_side TEXT NOT NULL,
        seed INTEGER NOT NULL,
        played_at INTEGER NOT NULL,
        battle_id INTEGER,
        game_no INTEGER
      )`);
      db.exec(`INSERT INTO matches_rebuilt
        SELECT id, match_url_id, challenger_bot_id, challenged_bot_id, ch_code_version, cd_code_version,
               ch_code_hash, cd_code_hash, winner, reason, turns, final_challenger_pieces,
               final_challenged_pieces, game_json, challenger_side, seed, played_at, battle_id, game_no
        FROM matches`);
      db.exec('DROP TABLE matches');
      db.exec('ALTER TABLE matches_rebuilt RENAME TO matches');
      db.exec('CREATE INDEX IF NOT EXISTS idx_matches_challenger ON matches(challenger_bot_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_matches_challenged ON matches(challenged_bot_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_matches_battle ON matches(battle_id)');
    }

    // 3) 建统一表族
    createUnifiedSchema();

    // 4) 拷贝数据（公开 id 原样保留）
    if (hasTable('legacy_bots')) {
      db.exec(`INSERT INTO players(game_id,id,account_id,name,avatar,current_version,rating,rp,wins,losses,draws,created_at)
        SELECT 'clawclash', id, account_id, name, avatar, current_version, rating, rp, wins, losses, draws, created_at FROM legacy_bots`);
      db.exec(`INSERT INTO player_api_keys(game_id,player_id,key_hash,key_prefix,key_plain,created_at)
        SELECT 'clawclash', bot_id, key_hash, key_prefix, key_plain, created_at FROM legacy_api_keys`);
      db.exec(`INSERT INTO player_code_versions(game_id,player_id,version,code,code_hash,notes,submitted_by,smoke_status,smoke_detail,created_at)
        SELECT 'clawclash', bot_id, version, code, code_hash, notes, submitted_by, smoke_status, smoke_detail, created_at FROM legacy_code_versions`);
      db.exec(`INSERT INTO hash_pairs(game_id,player_id,my_hash,opp_hash,used_count)
        SELECT 'clawclash', bot_id, my_hash, opp_hash, used_count FROM legacy_hash_pair_scores`);
      // 钳王战报：连主键 id 一并保留 → matches.battle_id 链接不变
      db.exec(`INSERT INTO battles(id,game_id,url_id,challenger_id,challenged_id,result,ch_rp_delta,cd_rp_delta,scored,played_at)
        SELECT id, 'clawclash', battle_url_id, challenger_bot_id, challenged_bot_id, result, ch_rp_delta, cd_rp_delta, scored, played_at FROM legacy_battles`);
    }
    if (hasTable('legacy_prisoner_bots')) {
      db.exec(`INSERT INTO players(game_id,id,account_id,name,avatar,current_version,rp,wins,losses,draws,created_at)
        SELECT 'prisoner', id, account_id, name, avatar, current_version, rp, wins, losses, draws, created_at FROM legacy_prisoner_bots`);
      db.exec(`INSERT INTO player_api_keys(game_id,player_id,key_hash,key_prefix,key_plain,created_at)
        SELECT 'prisoner', prisoner_id, key_hash, key_prefix, key_plain, created_at FROM legacy_prisoner_api_keys`);
      db.exec(`INSERT INTO player_code_versions(game_id,player_id,version,code,code_hash,notes,submitted_by,smoke_status,smoke_detail,created_at)
        SELECT 'prisoner', prisoner_id, version, code, code_hash, notes, submitted_by, smoke_status, smoke_detail, created_at FROM legacy_prisoner_code_versions`);
      db.exec(`INSERT INTO hash_pairs(game_id,player_id,my_hash,opp_hash,used_count)
        SELECT 'prisoner', prisoner_id, my_hash, opp_hash, used_count FROM legacy_prisoner_hash_pair_scores`);
      // 囚徒战报：通用列平移，游戏专属标量进 ext(JSON)、选择序列进 blob
      db.exec(`INSERT INTO battles(game_id,url_id,challenger_id,challenged_id,result,reason,ch_score,cd_score,
          ch_rp_delta,cd_rp_delta,scored,ch_code_version,cd_code_version,ch_code_hash,cd_code_hash,seed,ext,blob,played_at)
        SELECT 'prisoner', match_url_id, challenger_prisoner_id, challenged_prisoner_id, result, reason, ch_score, cd_score,
          ch_rp_delta, cd_rp_delta, scored, ch_code_version, cd_code_version, ch_code_hash, cd_code_hash, seed,
          json_object('actualRounds', actual_rounds, 'failure', json(failure_detail)), move_blob, played_at
        FROM legacy_prisoner_battles`);
    }

    db.exec('COMMIT');
    const n = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`[P3 迁移] 完成：players=${n('players')} keys=${n('player_api_keys')} versions=${n('player_code_versions')} battles=${n('battles')} hash_pairs=${n('hash_pairs')}（旧表已重命名为 legacy_* 留底）`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[P3 迁移] 失败，已回滚，库未改动：', e);
    throw e;
  }
}

if (hasTable('bots')) migrateLegacyToUnified();
else createUnifiedSchema();

// ---- 历史增量迁移：accounts.email_verified（早于本功能的库回填为已验证免打扰）----
const acctCols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
if (!acctCols.includes('email_verified')) {
  db.exec('ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
}

// ---- 邮箱验证码注册 v1.1：一次性迁移与持久状态 ----
const EMAIL_REGISTRATION_MIGRATION = 'email_code_registration_v1_1';
function migrateEmailCodeRegistration() {
  const canonicalOwners = new Map();
  for (const account of db.prepare('SELECT id,email FROM accounts').all()) {
    const canonical = String(account.email).trim().toLowerCase();
    const existing = canonicalOwners.get(canonical);
    if (existing !== undefined && existing !== account.id) {
      throw new Error(`邮箱规范化后冲突，账号 ${existing} 与 ${account.id} 需要人工处理`);
    }
    canonicalOwners.set(canonical, account.id);
  }

  db.exec('BEGIN');
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
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
CREATE INDEX IF NOT EXISTS idx_pending_expiry ON pending_registrations(expires_at);
CREATE TABLE IF NOT EXISTS registration_mail_attempts (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  source_ip         TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('reserved','sent','failed','unknown')),
  reserved_at       INTEGER NOT NULL,
  lease_expires_at  INTEGER NOT NULL,
  accepted_at       INTEGER,
  quota_day         TEXT,
  finished_at       INTEGER,
  CHECK(state <> 'sent' OR (accepted_at IS NOT NULL AND quota_day IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_regmail_day ON registration_mail_attempts(state, quota_day);
CREATE INDEX IF NOT EXISTS idx_regmail_email ON registration_mail_attempts(email, state, accepted_at);
CREATE INDEX IF NOT EXISTS idx_regmail_ip ON registration_mail_attempts(source_ip, state, quota_day);
CREATE INDEX IF NOT EXISTS idx_regmail_lease ON registration_mail_attempts(state, lease_expires_at);
`);
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(EMAIL_REGISTRATION_MIGRATION);
    if (!applied) {
      db.exec('UPDATE accounts SET email_verified=1 WHERE email_verified=0');
      db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)')
        .run(EMAIL_REGISTRATION_MIGRATION, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
migrateEmailCodeRegistration();

// ---- 工具函数 ----
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function codeHash(code) { return crypto.createHash('sha256').update(code.trim()).digest('hex').slice(0, 16); }
function generateKey() { return 'sk_' + crypto.randomBytes(24).toString('base64url'); }
function urlId() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

// ---- 账号 ----
const stmtInsertAccount = db.prepare('INSERT INTO accounts(nickname,email,password_hash,email_verified,created_at) VALUES(?,?,?,1,?)');
const stmtGetAccountByEmail = db.prepare('SELECT * FROM accounts WHERE canonical_email(email)=?');
const stmtGetAccountByNickname = db.prepare('SELECT * FROM accounts WHERE nickname=?');
const stmtGetAccountById = db.prepare('SELECT * FROM accounts WHERE id=?');

// ---- 邮箱验证码注册数据操作（全部同步短事务；不得在事务中等待网络或 scrypt）----
const stmtGetPendingRegistration = db.prepare('SELECT * FROM pending_registrations WHERE email=?');
const stmtDeletePendingRegistration = db.prepare('DELETE FROM pending_registrations WHERE email=? AND registration_id=?');
const stmtLatestAcceptedMail = db.prepare(`SELECT MAX(accepted_at) AS accepted_at
  FROM registration_mail_attempts WHERE email=? AND state='sent'`);
const stmtInsertMailReservation = db.prepare(`INSERT INTO registration_mail_attempts
  (id,email,source_ip,state,reserved_at,lease_expires_at) VALUES(?,?,?,'reserved',?,?)`);
const stmtFinishMailAttempt = db.prepare(`UPDATE registration_mail_attempts
  SET state=?, finished_at=? WHERE id=? AND state='reserved'`);
const stmtAcceptMailAttempt = db.prepare(`UPDATE registration_mail_attempts
  SET state='sent', accepted_at=?, quota_day=?, finished_at=? WHERE id=? AND state='reserved'`);
const stmtUpsertPendingRegistration = db.prepare(`INSERT INTO pending_registrations
  (email,registration_id,nickname,password_hash,code_hash,attempts,created_at,issued_at,expires_at,flow_expires_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(email) DO UPDATE SET
    registration_id=excluded.registration_id,nickname=excluded.nickname,password_hash=excluded.password_hash,
    code_hash=excluded.code_hash,attempts=excluded.attempts,created_at=excluded.created_at,
    issued_at=excluded.issued_at,expires_at=excluded.expires_at,flow_expires_at=excluded.flow_expires_at`);

function beginImmediate() { db.exec('BEGIN IMMEDIATE'); }
function rollbackQuietly() { try { db.exec('ROLLBACK'); } catch {} }

function getPendingRegistration(email) {
  return stmtGetPendingRegistration.get(email);
}

function deletePendingRegistration(email, registrationId) {
  return stmtDeletePendingRegistration.run(email, registrationId).changes > 0;
}

function cleanupRegistrationData(at, lockedEmails = []) {
  beginImmediate();
  try {
    let pendingSql = 'DELETE FROM pending_registrations WHERE (expires_at<=? OR flow_expires_at<=?)';
    const pendingArgs = [at, at];
    if (lockedEmails.length) {
      pendingSql += ` AND email NOT IN (${lockedEmails.map(() => '?').join(',')})`;
      pendingArgs.push(...lockedEmails);
    }
    const pendingDeleted = db.prepare(pendingSql).run(...pendingArgs).changes;
    const leasesReleased = db.prepare(`UPDATE registration_mail_attempts
      SET state='failed', finished_at=COALESCE(finished_at,?)
      WHERE state IN ('reserved','unknown') AND lease_expires_at<=?`).run(at, at).changes;
    const cutoff = at - 48 * 60 * 60 * 1000;
    const attemptsDeleted = db.prepare(`DELETE FROM registration_mail_attempts WHERE
      (state='sent' AND accepted_at<=?) OR
      (state IN ('failed','unknown') AND finished_at IS NOT NULL AND finished_at<=?)`)
      .run(cutoff, cutoff).changes;
    db.exec('COMMIT');
    return { pendingDeleted, leasesReleased, attemptsDeleted };
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

function reserveRegistrationMail({ id, email, sourceIp, reservedAt, leaseExpiresAt, quotaDay,
  emailLimit = 3, ipLimit = 10, globalLimit = 200, retryAfterSec }) {
  beginImmediate();
  try {
    db.prepare(`UPDATE registration_mail_attempts SET state='failed',finished_at=COALESCE(finished_at,?)
      WHERE state IN ('reserved','unknown') AND lease_expires_at<=?`).run(reservedAt, reservedAt);
    const sent = (where, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM registration_mail_attempts
      WHERE state='sent' AND quota_day=? AND ${where}`).get(quotaDay, ...args).n;
    const active = (where, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM registration_mail_attempts
      WHERE state IN ('reserved','unknown') AND lease_expires_at>? AND ${where}`).get(reservedAt, ...args).n;
    const sentEmail = sent('email=?', email);
    const sentIp = sent('source_ip=?', sourceIp);
    const sentGlobal = globalLimit === 0 ? 0 : sent('1=1');
    let failure;
    if (sentEmail >= emailLimit) failure = { reason: 'email_quota', retryAfterSec };
    else if (sentIp >= ipLimit) failure = { reason: 'ip_quota', retryAfterSec };
    else if (globalLimit !== 0 && sentGlobal >= globalLimit) failure = { reason: 'global_quota', retryAfterSec };
    else {
      const sameEmail = db.prepare(`SELECT state,lease_expires_at FROM registration_mail_attempts
        WHERE email=? AND state IN ('reserved','unknown') AND lease_expires_at>?
        ORDER BY lease_expires_at DESC LIMIT 1`).get(email, reservedAt);
      if (sameEmail) {
        failure = { reason: 'send_recovering', retryAfterSec: Math.max(1, Math.ceil((sameEmail.lease_expires_at - reservedAt) / 1000)) };
      } else if (sentEmail + active('email=?', email) >= emailLimit
        || sentIp + active('source_ip=?', sourceIp) >= ipLimit
        || (globalLimit !== 0 && sentGlobal + active('1=1') >= globalLimit)) {
        failure = { reason: 'send_reserved', retryAfterSec: 2 };
      }
    }
    if (failure) {
      db.exec('COMMIT');
      return { ok: false, ...failure };
    }
    stmtInsertMailReservation.run(id, email, sourceIp, reservedAt, leaseExpiresAt);
    db.exec('COMMIT');
    return { ok: true };
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

function finishRegistrationMail(id, state, at) {
  if (state !== 'failed' && state !== 'unknown') throw new Error('invalid mail terminal state');
  return { updated: stmtFinishMailAttempt.run(state, at, id).changes > 0 };
}

function pendingValues(pending) {
  return [pending.email, pending.registration_id, pending.nickname, pending.password_hash,
    pending.code_hash, pending.attempts, pending.created_at, pending.issued_at,
    pending.expires_at, pending.flow_expires_at];
}

function commitRegistrationMail({ id, email, acceptedAt, quotaDay, pending, expectedRegistrationId, now: at }) {
  beginImmediate();
  try {
    const accepted = stmtAcceptMailAttempt.run(acceptedAt, quotaDay, acceptedAt, id);
    if (!accepted.changes) throw new Error('mail reservation is no longer active');
    let outcome = { ok: true };
    const current = stmtGetPendingRegistration.get(email);
    const nicknameOwner = stmtGetAccountByNickname.get(pending.nickname);
    const emailOwner = stmtGetAccountByEmail.get(email);
    if (nicknameOwner) outcome = { ok: false, reason: 'conflict', field: 'nickname' };
    else if (emailOwner) outcome = { ok: false, reason: 'conflict', field: 'email' };
    else if (at >= pending.expires_at || at >= pending.flow_expires_at
      || (expectedRegistrationId !== undefined && current
        && current.registration_id === expectedRegistrationId
        && (at >= current.expires_at || at >= current.flow_expires_at))) {
      if (current && (!expectedRegistrationId || current.registration_id === expectedRegistrationId)
        && (at >= current.expires_at || at >= current.flow_expires_at)) {
        stmtDeletePendingRegistration.run(email, current.registration_id);
      }
      outcome = { ok: false, reason: 'expired' };
    } else if (expectedRegistrationId !== undefined
      && (!current || current.registration_id !== expectedRegistrationId)) {
      outcome = { ok: false, reason: 'registration_stale' };
    } else {
      stmtUpsertPendingRegistration.run(...pendingValues(pending));
      outcome.pending = stmtGetPendingRegistration.get(email);
    }
    db.exec('COMMIT');
    return outcome;
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

function recordIncorrectRegistrationCode({ email, registrationId, now: at }) {
  beginImmediate();
  try {
    const row = stmtGetPendingRegistration.get(email);
    let outcome;
    if (!row) outcome = { reason: 'missing' };
    else if (row.registration_id !== registrationId) outcome = { reason: 'stale' };
    else if (at >= row.expires_at || at >= row.flow_expires_at) {
      stmtDeletePendingRegistration.run(email, registrationId);
      outcome = { reason: 'expired' };
    } else if (row.attempts >= 4) {
      stmtDeletePendingRegistration.run(email, registrationId);
      outcome = { reason: 'exhausted', remaining: 0 };
    } else {
      const attempts = row.attempts + 1;
      db.prepare('UPDATE pending_registrations SET attempts=? WHERE email=? AND registration_id=?')
        .run(attempts, email, registrationId);
      outcome = { reason: 'incorrect', remaining: 5 - attempts };
    }
    db.exec('COMMIT');
    return outcome;
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

function consumePendingRegistration({ email, registrationId, now: at }) {
  beginImmediate();
  try {
    const row = stmtGetPendingRegistration.get(email);
    let outcome;
    if (!row) outcome = { ok: false, reason: 'missing' };
    else if (row.registration_id !== registrationId) outcome = { ok: false, reason: 'stale' };
    else if (at >= row.expires_at || at >= row.flow_expires_at) {
      stmtDeletePendingRegistration.run(email, registrationId);
      outcome = { ok: false, reason: 'expired' };
    } else {
      const nicknameOwner = stmtGetAccountByNickname.get(row.nickname);
      const emailOwner = stmtGetAccountByEmail.get(email);
      if (nicknameOwner || emailOwner) {
        stmtDeletePendingRegistration.run(email, registrationId);
        outcome = { ok: false, reason: 'conflict', field: nicknameOwner ? 'nickname' : 'email' };
      } else {
        stmtInsertAccount.run(row.nickname, email, row.password_hash, at);
        if (!stmtDeletePendingRegistration.run(email, registrationId).changes) throw new Error('pending registration was not consumed');
        outcome = { ok: true, account: stmtGetAccountByEmail.get(email) };
      }
    }
    db.exec('COMMIT');
    return outcome;
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

function getRegistrationCooldown(email) {
  const row = stmtLatestAcceptedMail.get(email);
  return row && row.accepted_at != null ? row.accepted_at : null;
}

function recoverRegistrationMailLeases(at) {
  beginImmediate();
  try {
    const recovered = db.prepare(`UPDATE registration_mail_attempts SET state='unknown',finished_at=?
      WHERE state='reserved' AND lease_expires_at>?`).run(at, at).changes;
    const released = db.prepare(`UPDATE registration_mail_attempts SET state='failed',finished_at=?
      WHERE state IN ('reserved','unknown') AND lease_expires_at<=?`).run(at, at).changes;
    db.exec('COMMIT');
    return { recovered, released };
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

// ============================================================
// gameStore(gameId, opts)：某游戏的全套数据访问（P2 store 接口的统一实现）。
// opts.rankTiebreak：同 RP 的次级排序 —— 'rating'（内部实力分，钳王）或 'id'（创建先后，默认）。
// 所有语句都以 game_id 约束；新增游戏直接 gameStore('<id>') 即得全套读写，零 schema 工作。
// ============================================================
function gameStore(gameId, opts = {}) {
  const g = gameId;
  const byRating = opts.rankTiebreak === 'rating';

  const sGetById = db.prepare('SELECT * FROM players WHERE game_id=? AND id=?');
  const sGetByAccount = db.prepare('SELECT * FROM players WHERE game_id=? AND account_id=?');
  const sGetByName = db.prepare('SELECT * FROM players WHERE game_id=? AND name=?');
  // 建号：id 取该游戏当前最大 id + 1（DatabaseSync 同步执行 + 单进程部署 → 无并发窗口）
  const sInsert = db.prepare(`INSERT INTO players(game_id,id,account_id,name,avatar,created_at)
    VALUES(?, (SELECT COALESCE(MAX(id),0)+1 FROM players WHERE game_id=?), ?, ?, ?, ?)`);
  const sUpdateAvatar = db.prepare('UPDATE players SET avatar=? WHERE game_id=? AND id=?');
  const sUpdateVersion = db.prepare('UPDATE players SET current_version=? WHERE game_id=? AND id=?');
  // 计分：rating 传 null 表示该游戏不维护内部分（保持原值）
  const sUpdateStats = db.prepare(`UPDATE players SET rating=COALESCE(?,rating), rp=?,
    wins=wins+?, losses=losses+?, draws=draws+? WHERE game_id=? AND id=?`);
  const sSearch = db.prepare(`
    SELECT p.id, p.name, p.avatar, p.rp, p.current_version, a.nickname
    FROM players p JOIN accounts a ON p.account_id=a.id
    WHERE p.game_id=? AND p.name LIKE ? ESCAPE '\\'
    ORDER BY p.rp DESC, p.id ASC LIMIT 20`);
  const sLeaderboard = db.prepare(`
    SELECT p.*, a.nickname FROM players p JOIN accounts a ON p.account_id=a.id
    WHERE p.game_id=? ORDER BY ${byRating ? 'p.rp DESC, p.rating DESC' : 'p.rp DESC, p.id ASC'} LIMIT 100`);
  // 当前排名：RP 高者在前；同 RP 按次级排序（rating 模式下并列 rating 视为同名次）
  const sRankPos = byRating
    ? db.prepare(`SELECT COUNT(*)+1 AS pos FROM players p,
        (SELECT rp, rating FROM players WHERE game_id=?1 AND id=?2) me
        WHERE p.game_id=?1 AND (p.rp > me.rp OR (p.rp = me.rp AND p.rating > me.rating))`)
    : db.prepare(`SELECT COUNT(*)+1 AS pos FROM players p,
        (SELECT rp FROM players WHERE game_id=?1 AND id=?2) me
        WHERE p.game_id=?1 AND (p.rp > me.rp OR (p.rp = me.rp AND p.id < ?2))`);

  const sInsertKey = db.prepare('INSERT INTO player_api_keys(game_id,player_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?,?)');
  const sDeleteKeys = db.prepare('DELETE FROM player_api_keys WHERE game_id=? AND player_id=?');
  const sKeyInfo = db.prepare('SELECT key_plain,key_prefix FROM player_api_keys WHERE game_id=? AND player_id=? ORDER BY id DESC LIMIT 1');
  const sByKey = db.prepare(`
    SELECT p.* FROM players p
    JOIN player_api_keys k ON k.game_id=p.game_id AND k.player_id=p.id
    WHERE k.key_hash=? AND p.game_id=? LIMIT 1`);

  const sInsertVersion = db.prepare(`INSERT INTO player_code_versions
    (game_id,player_id,version,code,code_hash,notes,submitted_by,smoke_status,smoke_detail,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const sGetVersion = db.prepare('SELECT * FROM player_code_versions WHERE game_id=? AND player_id=? AND version=?');
  // 历史遗留：早期"先存后测"流程的未通过记录会占用版本号，发布前清掉同号及以上的幽灵记录
  const sDeleteStale = db.prepare("DELETE FROM player_code_versions WHERE game_id=? AND player_id=? AND version>=? AND smoke_status<>'passed'");
  const sListVersions = db.prepare('SELECT id,player_id,version,code_hash,notes,submitted_by,smoke_status,created_at FROM player_code_versions WHERE game_id=? AND player_id=? ORDER BY version DESC LIMIT 50');
  const sLatestPassed = db.prepare("SELECT * FROM player_code_versions WHERE game_id=? AND player_id=? AND smoke_status='passed' ORDER BY version DESC LIMIT 1");

  const sInsertBattle = db.prepare(`INSERT INTO battles(game_id,url_id,challenger_id,challenged_id,result,reason,
      ch_score,cd_score,ch_rp_delta,cd_rp_delta,scored,ch_code_version,cd_code_version,ch_code_hash,cd_code_hash,seed,ext,blob,played_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sGetBattle = db.prepare('SELECT * FROM battles WHERE game_id=? AND url_id=?');
  const sListBattles = db.prepare(`
    SELECT bt.*, cb.name AS challenger_name, cd.name AS challenged_name,
      cb.avatar AS challenger_avatar, cd.avatar AS challenged_avatar
    FROM battles bt
    JOIN players cb ON cb.game_id=bt.game_id AND cb.id=bt.challenger_id
    JOIN players cd ON cd.game_id=bt.game_id AND cd.id=bt.challenged_id
    WHERE bt.game_id=? AND (bt.challenger_id=? OR bt.challenged_id=?)
    ORDER BY bt.played_at DESC LIMIT ?`);

  const sUpsertHashPair = db.prepare(`INSERT INTO hash_pairs(game_id,player_id,my_hash,opp_hash,used_count) VALUES(?,?,?,?,1)
    ON CONFLICT(game_id,player_id,my_hash,opp_hash) DO UPDATE SET used_count=used_count+1`);
  const sGetHashPair = db.prepare('SELECT * FROM hash_pairs WHERE game_id=? AND player_id=? AND my_hash=? AND opp_hash=?');

  // 独立函数而非对象方法：调用方可能把 store 展开进自己的对象，不依赖 this
  function createApiKey(playerId) {
    const key = generateKey();
    sInsertKey.run(g, playerId, hashKey(key), key.slice(0, 8), key, now());
    return key;
  }

  return {
    // ---- 身份 / 资产 ----
    getById: (id) => sGetById.get(g, id),
    getByAccount: (accountId) => sGetByAccount.get(g, accountId),
    getByName: (name) => sGetByName.get(g, name),
    getByApiKey: (key) => sByKey.get(hashKey(key), g),
    create(accountId, name, avatar) {
      sInsert.run(g, g, accountId, name, avatar || 'preset:1', now());
      return sGetByAccount.get(g, accountId);
    },
    createApiKey,
    rotateApiKey(playerId) {
      sDeleteKeys.run(g, playerId);
      return createApiKey(playerId);
    },
    keyInfo: (playerId) => sKeyInfo.get(g, playerId),
    updateAvatar: (playerId, avatar) => sUpdateAvatar.run(avatar, g, playerId),
    searchByName(q) {
      const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
      return sSearch.all(g, `%${escaped}%`);
    },

    // ---- 代码版本（先测后存：仅烟雾通过的代码才入库，入库即发布）----
    publish(playerId, version, code, notes, submittedBy) {
      const hash = codeHash(code);
      db.exec('BEGIN');
      try {
        sDeleteStale.run(g, playerId, version);
        sInsertVersion.run(g, playerId, version, code, hash, notes || null, submittedBy || null, 'passed', null, now());
        sUpdateVersion.run(version, g, playerId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sGetVersion.get(g, playerId, version);
    },
    getVersion: (playerId, version) => sGetVersion.get(g, playerId, version),
    listVersions: (playerId) => sListVersions.all(g, playerId),
    latestPassed: (playerId) => sLatestPassed.get(g, playerId),

    // ---- 榜单 / 排名 ----
    leaderboardRows: () => sLeaderboard.all(g),
    rankPosition(playerId) { const r = sRankPos.get(g, playerId); return r ? r.pos : null; },

    // ---- 战报（统一核心；游戏专属数据经 ext/blob 附带）----
    createBattle({ urlId: uid, challengerId, challengedId, result, reason = null, chScore = null, cdScore = null,
                   chRpDelta = null, cdRpDelta = null, scored = 1, chVer = null, cdVer = null,
                   chHash = null, cdHash = null, seed = null, ext = null, blob = null }) {
      const r = sInsertBattle.run(g, uid, challengerId, challengedId, result, reason,
        chScore, cdScore, chRpDelta, cdRpDelta, scored ? 1 : 0, chVer, cdVer, chHash, cdHash, seed,
        ext == null ? null : JSON.stringify(ext), blob, now());
      return r.lastInsertRowid;
    },
    getBattleByUrlId: (uid) => sGetBattle.get(g, uid),
    listBattles: (playerId, limit = 20) => sListBattles.all(g, playerId, playerId, limit),

    // ---- 反刷分 / 计分 ----
    getHashPair: (playerId, myHash, oppHash) => sGetHashPair.get(g, playerId, myHash, oppHash),
    recordHashPair: (playerId, myHash, oppHash) => sUpsertHashPair.run(g, playerId, myHash, oppHash),
    // rating 传 null = 该游戏不维护内部分
    updateStats: (playerId, rating, rp, wins, losses, draws) => sUpdateStats.run(rating, rp, wins, losses, draws, g, playerId),
  };
}

// ---- 公开 API ----
module.exports = {
  hashKey, codeHash, generateKey, urlId, now,

  // 账号
  createAccount(nickname, email, passwordHash) {
    stmtInsertAccount.run(nickname, email, passwordHash, now());
    return stmtGetAccountByEmail.get(email);
  },
  getAccountByEmail: (email) => stmtGetAccountByEmail.get(email),
  getAccountByNickname: (nickname) => stmtGetAccountByNickname.get(nickname),
  getAccountById: (id) => stmtGetAccountById.get(id),
  getPendingRegistration,
  deletePendingRegistration,
  cleanupRegistrationData,
  reserveRegistrationMail,
  finishRegistrationMail,
  commitRegistrationMail,
  recordIncorrectRegistrationCode,
  consumePendingRegistration,
  getRegistrationCooldown,
  recoverRegistrationMailLeases,

  // 按游戏的数据访问工厂
  gameStore,

  db, // 原始句柄：供各游戏建/查自己的私有表（如钳王 matches），平台层不感知其结构
};
