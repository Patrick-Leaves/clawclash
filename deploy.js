#!/usr/bin/env node
/**
 * Claw Clash 服务器端部署脚本 v1.0
 *
 * 用法（在服务器上、宝塔终端里执行）:
 *   cd /www/wwwroot/clawclash
 *   unzip -o <代码包.zip> deploy.js      # 先只解出本脚本
 *   node deploy.js <代码包.zip>          # 全自动部署
 *
 * 流程: 预检 → 备份数据库 → 备份密钥配置 → 制作回退包 → 停服 → 覆盖代码
 *       → 启动 → 体检（进程在线 + 接口 200 + 新指南标记命中）
 *       → 通过: 收尾归档; 失败: 自动回退到部署前版本
 *
 * 本地演练（不会碰任何线上服务）:
 *   CC_DRY_RUN=1 CC_APP_DIR=<假目录> CC_BACKUP_DIR=<假备份目录> node deploy.js <包.zip>
 *
 * 安全约束:
 * - 本脚本绝不修改 ecosystem.config.js / sixchess.db / public/avatars（它们不在代码包里，也不会被覆盖）。
 * - 回退包在停服之前生成并自检；自检不过则中止且不动服务。
 * - 体检不通过会自动回退，回退后仍不通过则打印人工处理指引。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_VERSION = '1.0';
const DRY = process.env.CC_DRY_RUN === '1';
const APP_DIR = process.env.CC_APP_DIR || __dirname;
const BACKUP_DIR = process.env.CC_BACKUP_DIR || '/root/backup';
const PM2_NAME = 'clawclash';
const HEALTH_URL = 'http://127.0.0.1:3000/api/games';
const GUIDE_URL = 'http://127.0.0.1:3000/games/darkchess/agent-guide';
// 只有新版本指南含这句话，用于确认新代码真的在跑。
// 以后若指南措辞变化：不改代码也可用环境变量覆盖（CC_GUIDE_MARKER='新的句子' node deploy.js 包.zip），
// 或直接把下面的默认值更新为当次新增的稳定短语。
const GUIDE_MARKER = process.env.CC_GUIDE_MARKER || '各有约 10 秒';

let stopped = false; // 是否已进入停服窗口（决定失败时是否自动回退）
let rollbackTar = '';
let zipPath = '';

// ---------- 小工具 ----------

function log(...a) { console.log(...a); }
function section(t) { log('\n===== ' + t + ' ====='); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function nowText() { return new Date().toLocaleString('zh-CN', { hour12: false }); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
  if (r.error) return { ok: false, code: -1, stdout: '', stderr: String(r.error.message || r.error) };
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function abort(msg) {
  log('\n【中止】' + msg);
  log('请把以上全部输出复制发回给 Claude（若此时网站打不开，也请说明）。');
  process.exit(2);
}

// ---------- 预检 ----------

async function preflight(zipArg) {
  section('预检（此阶段不做任何改动）');

  if (DRY) {
    log('[演练模式] 不会停服、不会动线上服务，仅验证备份/回退/覆盖逻辑。');
  } else {
    if (process.platform !== 'linux') abort('本脚本需要在服务器（Linux）上运行。');
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      abort('当前不是 root 用户。请在宝塔「终端」里以 root 身份运行。');
    }
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  log(`Node 版本: ${process.versions.node}`);
  if (nodeMajor < 22) {
    const m = `Node 版本过低（需要 22 及以上，当前 ${process.versions.node}）。`;
    if (DRY) log('[演练] 忽略: ' + m); else abort(m);
  }

  if (!DRY) {
    const v = run('pm2', ['-v']);
    if (!v.ok) abort('找不到 pm2 命令。');
    log(`PM2 版本: ${v.stdout.trim()}`);
  }

  for (const f of ['server.js', 'ecosystem.config.js', 'sixchess.db']) {
    if (!fs.existsSync(path.join(APP_DIR, f))) {
      abort(`应用目录里找不到 ${f}（${path.join(APP_DIR, f)}）。目录是不是不对？`);
    }
  }
  log(`应用目录: ${APP_DIR}（server.js / ecosystem.config.js / sixchess.db 均存在）`);

  if (!zipArg) abort('用法: node deploy.js <代码包.zip>');
  zipPath = zipArg;
  if (!path.isAbsolute(zipPath)) {
    if (!fs.existsSync(zipPath) && fs.existsSync(path.join(APP_DIR, zipPath))) {
      zipPath = path.join(APP_DIR, zipPath);
    }
  }
  if (!fs.existsSync(zipPath)) abort(`找不到代码包: ${zipArg}`);
  log(`代码包: ${zipPath}（${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB）`);

  const t = run('unzip', ['-t', zipPath]);
  if (!t.ok || !/No errors detected/i.test(t.stdout + t.stderr)) {
    abort('代码包完整性校验失败（可能上传不完整），请重新上传后再试。\n' + t.stdout + t.stderr);
  }
  log('代码包完整性: 通过');

  const zl = run('unzip', ['-Z1', zipPath]);
  const names = zl.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const need = ['server.js', 'deploy.js', 'platform/public_replay.js', 'games/darkchess/server.js', 'games/clawclash/server.js'];
  for (const n of need) {
    if (!names.includes(n)) abort(`代码包里缺少 ${n}，这不是一个完整的部署包。`);
  }
  const forbidden = names.find((n) => n === 'sixchess.db' || n === 'ecosystem.config.js' || n.startsWith('public/avatars/'));
  if (forbidden) abort(`代码包里意外包含 ${forbidden}（不该出现），请把输出发回给 Claude。`);
  log(`代码包内容: ${names.length} 个文件，关键文件齐全，且不含数据库/密钥/头像`);

  if (!DRY) {
    // 部署前指南标记（只提示，不拦截）
    const g = await fetchText(GUIDE_URL, 5000);
    if (g.status === 200) {
      const has = g.body.includes(GUIDE_MARKER);
      log(`部署前检查: 指南接口可访问，新版本标记=${has ? '已存在(注意：可能已经部署过)' : '不存在(符合预期)'}`);
    } else {
      log(`部署前检查: 指南接口暂时不可访问（${g.status || g.error}），继续。`);
    }
  }
}

// ---------- 备份 ----------

function backupDatabase() {
  section('[1/5] 备份数据库');
  if (DRY) {
    log('[演练] 跳过我 node /root/backup.js（真实部署时先备份，确认 integrity ok 才继续）');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, 'dry-backup.db'), 'dry');
    return '(演练用假备份)';
  }
  if (!fs.existsSync('/root/backup.js')) abort('找不到 /root/backup.js（数据库备份脚本）。');
  const r = run('node', ['/root/backup.js']);
  const out = (r.stdout + '\n' + r.stderr).trim();
  log(out);
  if (!r.ok || !/"integrity_check"\s*:\s*"ok"/.test(out)) {
    abort('数据库备份未成功或完整性校验未通过，已停止（服务未停）。');
  }
  const m = out.match(/\/root\/backup\/clawclash-[\w.-]+\.db/);
  return m ? m[0] : '(备份成功)';
}

function backupEcosystem() {
  section('[2/5] 备份密钥配置');
  const dest = path.join(BACKUP_DIR, `ecosystem-${stamp()}.txt`);
  fs.copyFileSync(path.join(APP_DIR, 'ecosystem.config.js'), dest);
  log(`已备份: ${dest}`);
  return dest;
}

function makeRollbackTar() {
  section('[3/5] 制作回退代码包（当前版本，出问题用来自动还原）');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  rollbackTar = path.join(BACKUP_DIR, `code-rollback-${stamp()}.tar.gz`);

  const args = [
    '--force-local', // 防御：路径含冒号时（仅测试环境）不要误判为远程主机
    '-czf', rollbackTar, '-C', APP_DIR,
    '--exclude=./sixchess.db',
    '--exclude=./sixchess.db-wal',
    '--exclude=./sixchess.db-shm',
    '--exclude=./ecosystem.config.js',
    '--exclude=./public/avatars',
    '--exclude=./.git',
    '--exclude=./node_modules',
    '--exclude=./.backup',
    '--exclude=*.log',
    '.',
  ];
  const r = run('tar', args);
  if (!r.ok) abort('打包回退包失败: ' + r.stderr);

  // 自检：回退包必须含 server.js，且绝不含数据库/密钥/头像
  const l = run('tar', ['--force-local', '-tzf', rollbackTar]);
  if (!l.ok) abort('回退包无法读取，已停止。');
  const names = l.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const problems = [];
  if (!names.some((n) => n === './server.js' || n === 'server.js')) problems.push('缺少 server.js');
  if (names.some((n) => n.includes('sixchess.db'))) problems.push('意外包含 sixchess.db');
  if (names.some((n) => /(^|\/)public\/avatars\//.test(n))) problems.push('意外包含 public/avatars');
  if (names.some((n) => n.endsWith('ecosystem.config.js'))) problems.push('意外包含 ecosystem.config.js');
  if (problems.length) abort('回退包自检失败: ' + problems.join('；') + '（服务未停）');

  const kb = (fs.statSync(rollbackTar).size / 1024).toFixed(0);
  log(`回退包: ${rollbackTar}（${kb} KB，${names.length} 个条目，自检通过）`);
  return rollbackTar;
}

// ---------- 部署 ----------

function pm2Online() {
  if (DRY) return true;
  const r = run('pm2', ['jlist']);
  try {
    const s = r.stdout;
    const arr = JSON.parse(s.slice(s.indexOf('[')));
    const p = arr.find((x) => x && x.name === PM2_NAME);
    return !!(p && p.pm2_env && p.pm2_env.status === 'online');
  } catch {
    return false;
  }
}

function stopService() {
  section('[4/5] 停服（停机窗口开始，网站将短暂无法访问）');
  if (DRY) { log('[演练] 跳过 pm2 stop'); stopped = true; return; }
  if (!pm2Online()) { log(`提示: ${PM2_NAME} 当前不在线，跳过停止步骤。`); stopped = true; return; }
  const r = run('pm2', ['stop', PM2_NAME]);
  if (!r.ok) abort('pm2 stop 失败: ' + (r.stderr || r.stdout));
  stopped = true;
  log('已停服。');
}

function extractPackage() {
  log('覆盖代码文件…');
  if (DRY) {
    log('[演练] 实际执行: unzip -q -o <包> -d ' + APP_DIR);
    const r = run('unzip', ['-q', '-o', zipPath, '-d', APP_DIR]);
    if (!r.ok) abort('演练解压失败: ' + r.stderr);
    // 演练里把 app 目录还原不了没关系（假目录）
    log('[演练] 覆盖完成（假目录）');
    return;
  }
  const r = run('unzip', ['-q', '-o', zipPath, '-d', APP_DIR]);
  if (!r.ok) throw new Error('unzip 失败: ' + (r.stderr || r.stdout));
  for (const f of ['server.js', 'platform/public_replay.js', 'games/darkchess/server.js']) {
    if (!fs.existsSync(path.join(APP_DIR, f))) throw new Error('覆盖后缺少 ' + f);
  }
  log('覆盖完成。');
}

function startService() {
  section('[5/5] 启动服务');
  if (DRY) { log('[演练] 跳过 pm2 startOrRestart'); return; }
  const r = run('pm2', ['startOrRestart', 'ecosystem.config.js', '--update-env'], { cwd: APP_DIR });
  if (!r.ok) throw new Error('pm2 启动失败: ' + (r.stderr || r.stdout));
  log(r.stdout.trim());
  const s = run('pm2', ['save']);
  if (!s.ok) log('提示: pm2 save 未成功（不影响本次运行，但建议稍后手动执行一次）。');
}

// ---------- 体检 ----------

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: '', error: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy(timeoutMs, requireMarker) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const online = pm2Online();
    const h = await fetchText(HEALTH_URL, 5000);
    let markerOk = !requireMarker;
    if (requireMarker && h.status === 200) {
      const g = await fetchText(GUIDE_URL, 5000);
      markerOk = g.status === 200 && g.body.includes(GUIDE_MARKER);
      last = `进程在线=${online}，接口=${h.status}，新指南标记=${markerOk ? '命中' : '未命中'}`;
    } else {
      last = `进程在线=${online}，接口=${h.status}`;
    }
    if (online && h.status === 200 && markerOk) return { ok: true, detail: last };
    await sleep(3000);
  }
  return { ok: false, detail: last };
}

// ---------- 回退 ----------

async function rollback(reason) {
  section('体检未通过，自动回退到部署前版本');
  log('原因: ' + reason);
  if (DRY) { log('[演练] 跳过回退'); return false; }
  try {
    run('pm2', ['stop', PM2_NAME]);
    const r = run('tar', ['--force-local', '-xzf', rollbackTar, '-C', APP_DIR]);
    if (!r.ok) throw new Error('解包回退包失败: ' + r.stderr);
    const s = run('pm2', ['startOrRestart', 'ecosystem.config.js'], { cwd: APP_DIR });
    if (!s.ok) throw new Error('回退后启动失败: ' + (s.stderr || s.stdout));
    run('pm2', ['save']);
    const h = await waitHealthy(45000, false); // 老版本没有新指南标记，只查进程与接口
    if (h.ok) {
      log('【回退成功】网站已恢复为部署前版本。');
      writeLastDeploy('失败-已自动回退', reason);
      return true;
    }
    log('【回退后仍异常】' + h.detail);
    log('请立刻把以上全部输出复制发回给 Claude。');
    log('人工恢复参考（按顺序）:');
    log('  1) pm2 logs clawclash --lines 100 --nostream');
    log('  2) pm2 startOrRestart ecosystem.config.js && pm2 save');
    return false;
  } catch (e) {
    log('【自动回退也失败了】' + e.message);
    log('请立刻把以上全部输出复制发回给 Claude，不要在服务器上做其他操作。');
    return false;
  }
}

// ---------- 收尾 ----------

function writeLastDeploy(result, extra) {
  try {
    const lines = [
      `时间: ${nowText()}`,
      `代码包: ${path.basename(zipPath)}`,
      `结果: ${result}`,
      extra ? `备注: ${extra}` : '',
      `回退包: ${rollbackTar}`,
    ].filter(Boolean);
    fs.writeFileSync(path.join(BACKUP_DIR, 'last-deploy.txt'), lines.join('\n') + '\n');
  } catch (e) { log('提示: 写 last-deploy.txt 失败: ' + e.message); }
}

function summarizeAndArchive(dbBackup, ecoBackup) {
  let archived = '';
  try {
    const dest = path.join(BACKUP_DIR, path.basename(zipPath));
    fs.copyFileSync(zipPath, dest);
    if (path.resolve(zipPath) !== path.resolve(dest)) fs.unlinkSync(zipPath);
    archived = dest;
  } catch (e) { log('提示: 归档代码包失败（不影响运行）: ' + e.message); }

  writeLastDeploy('成功');

  section('部署结果');
  log('结果: 【成功】网站已运行新版本。');
  log(`时间: ${nowText()}`);
  log(`数据库备份: ${dbBackup}`);
  log(`密钥备份:   ${ecoBackup}`);
  log(`回退包:     ${rollbackTar}`);
  if (archived) log(`代码包已归档: ${archived}`);
  log('');
  log('如以后需要手动回退，在宝塔终端执行:');
  log(`  tar -xzf ${rollbackTar} -C ${APP_DIR} && cd ${APP_DIR} && pm2 startOrRestart ecosystem.config.js && pm2 save`);
  log('');
  log('请把以上全部输出（含前面各步骤）复制发回给 Claude，以便核对线上状态。');
  log('==========');
}

// ---------- 主流程 ----------

async function main() {
  log(`Claw Clash 部署脚本 v${SCRIPT_VERSION}    ${nowText()}`);
  log(`应用目录: ${APP_DIR}`);
  log(`备份目录: ${BACKUP_DIR}`);

  await preflight(process.argv[2]);

  const dbBackup = backupDatabase();
  const ecoBackup = backupEcosystem();
  makeRollbackTar();

  let failReason = '';
  try {
    stopService();
    extractPackage();
    startService();

    section('体检（最多等 45 秒）');
    if (DRY) {
      log('[演练] 跳过体检与收尾');
      section('演练结果');
      log('演练完成: 预检 / 备份 / 回退包 / 解压 逻辑全部走通，未触碰线上服务。');
      return;
    }
    const h = await waitHealthy(45000, true);
    if (!h.ok) throw new Error('体检未通过（' + h.detail + '）');
    log('体检通过: ' + h.detail);

    summarizeAndArchive(dbBackup, ecoBackup);
  } catch (e) {
    failReason = String((e && e.message) || e);
    log('\n【部署过程中出现问题】' + failReason);
    if (stopped) {
      const ok = await rollback(failReason);
      if (!ok) process.exitCode = 3;
    } else {
      log('服务尚未被停止，未做任何改动。');
      process.exitCode = 2;
    }
  }
}

process.on('SIGINT', () => {
  log('\n\n【已中断】如果此时网站打不开，请重新运行本脚本，或把输出发回给 Claude 处理。');
  process.exit(130);
});

main().catch((e) => {
  log('\n【脚本异常】' + String((e && e.stack) || e));
  log('请把以上全部输出复制发回给 Claude。');
  process.exit(4);
});
