'use strict';
// 父进程侧：常驻 runner 子进程池（P1 执行层）。预 fork POOL_SIZE 个 runner，任务经 IPC
// 逐个派发、任务间进程不退出——消掉 fork-per-task 的每任务冷启动（Node 启动 + 引擎
// require，实测 ~50–100ms/次），高频挑战/烟雾/试玩不再靠 fork 风暴打满 CPU。
// 隔离与旧版完全一致：env 白名单剥离机密 + Node 权限模型 + 可选降权（RUNNER_UID/GID）。
// 注意：仍非完整 RCE 防护（权限模型不拦网络出站）——生产须叠加 OS 级隔离，见 SECURITY.md。
//
// 跨任务污染防线（常驻进程相对 fork-per-task 的新增风险）：
//   1) 用户代码每任务都在全新 vm 上下文里编译执行（各游戏 sandbox.js），绝不复用；
//   2) 任务超时/执行异常/进程意外退出 → 该 worker 直接 SIGKILL 处决并补充新进程；
//   3) 正常任务累计 RECYCLE_AFTER 次后主动换新，防内存膨胀与隐性全局状态累积。
//
// 任务统一为 run(gameId, kind, payload, ownerKey)：硬超时取游戏 manifest 的 limits[kind]，
// worker 按 { game, kind } 分发到 games/<id>/index.js 的 tasks——新增游戏无需改本文件。
const { fork } = require('child_process');
const path = require('path');
const { manifests } = require('../games/registry'); // 子进程安全 manifest（仅取 limits，不触 db）

const RUNNER = path.join(__dirname, 'runner.js');
const GAMES_DIR = path.join(__dirname, '..', 'games');

const POOL_SIZE = Math.max(1, Math.min(16, +process.env.RUNNER_POOL_SIZE || 4)); // 常驻 worker 数
const MAX_QUEUE = 16;      // 等待队列上限（在跑之外），超出回 busy
const MAX_PER_OWNER = 2;   // 单账号/IP 未完成任务（在跑 + 排队）上限，防单个来源占满池
const RECYCLE_AFTER = 200; // 每 worker 处理任务数上限，达到后换新进程

// Node 权限模型（Node ≥22 稳定）：给不可信子进程加一道进程内闸门，作为 OS 级隔离之下的纵深防御。
// 即便 vm 逃逸拿到真实的 fs / child_process，越权操作也会在 C++ 层被拒（ERR_ACCESS_DENIED）：
//   --permission              开启权限模型 → 默认拒绝 fs 写、child_process、worker、原生插件
//   --allow-fs-read=<dirs>    只放行读取 platform/（runner 入口）与 games/（各游戏引擎），
//     均为本仓库代码、非机密。app 根目录下的 ecosystem.config.js（含 SESSION_SECRET）与
//     sixchess.db 都在放行目录之外 → 逃逸后也读不到；不放行任何 fs 写、child_process/worker。
// 网络出站权限模型「不」拦截，仍须靠部署侧防火墙禁止子进程对外连接（见 SECURITY.md）。
// 兜底开关：极端不兼容时设 CHILD_PERMISSION=off 可关闭本闸门回退，无需改代码。
const CHILD_PERMISSION = process.env.CHILD_PERMISSION !== 'off';
const PERMISSION_ARGS = ['--permission', `--allow-fs-read=${__dirname}`, `--allow-fs-read=${GAMES_DIR}`];

// 可选：以专用低权限用户运行 runner 子进程（仅 POSIX）。设 RUNNER_UID（必要时 RUNNER_GID）为目标
// 用户的数字 id（`id -u clawbot` / `id -g clawbot`）。这样即可用 iptables owner 匹配禁掉「该用户」的
// 网络出站——权限模型不拦网络，须靠这层堵住逃逸后的数据外带/打内网（见 SECURITY.md）。
// 前置条件：主进程有权 setuid（生产 PM2 以 root 跑）；目标用户须能读 platform/、games/ 与 node 可执行文件。
// Windows 不支持 setuid → 自动跳过，不影响本地开发。
const posix = process.platform !== 'win32';
const RUNNER_UID = posix && Number.isInteger(+process.env.RUNNER_UID) && process.env.RUNNER_UID !== '' ? +process.env.RUNNER_UID : undefined;
const RUNNER_GID = posix && Number.isInteger(+process.env.RUNNER_GID) && process.env.RUNNER_GID !== '' ? +process.env.RUNNER_GID : undefined;

// 子进程 env 白名单：仅保留 OS/Node 运行必需项，剥离 SESSION_SECRET、SMTP 等机密
const ENV_WHITELIST = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS'];
function childEnv() {
  const e = {};
  for (const k of ENV_WHITELIST) if (process.env[k] !== undefined) e[k] = process.env[k];
  return e;
}

// ---- 池状态 ----
const workers = new Set(); // { child, job, tasksDone, dying, spawnedAt }
const queue = [];          // { id, task, hardMs, ownerKey, resolve, reject, timer }
const perOwner = new Map();
let nextJobId = 1;

function releaseOwner(ownerKey) {
  if (!ownerKey) return;
  const n = (perOwner.get(ownerKey) || 1) - 1;
  if (n <= 0) perOwner.delete(ownerKey); else perOwner.set(ownerKey, n);
}

// 结束 worker 当前任务（成败均经此收尾；err 为空即成功）
function settle(w, err, result) {
  const job = w.job;
  if (!job) return;
  w.job = null;
  w.tasksDone++;
  clearTimeout(job.timer);
  releaseOwner(job.ownerKey);
  if (err) job.reject(err); else job.resolve(result);
}

// 处决并补员：超时（事件循环可能被死循环占死，只能杀）/ 执行异常 / 任务额度用尽
function retire(w) {
  if (w.dying) return;
  w.dying = true;
  try { w.child.kill('SIGKILL'); } catch {}
}

function addWorker() {
  const forkOpts = { env: childEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] };
  if (CHILD_PERMISSION) forkOpts.execArgv = PERMISSION_ARGS; // 关闭时继承父进程默认，不加权限闸门
  if (RUNNER_UID !== undefined) forkOpts.uid = RUNNER_UID;   // POSIX 且已配置时降权到专用用户
  if (RUNNER_GID !== undefined) forkOpts.gid = RUNNER_GID;
  const w = { child: fork(RUNNER, [], forkOpts), job: null, tasksDone: 0, dying: false, spawnedAt: Date.now() };
  // 不让空闲池撑住父进程事件循环：父进程可自然退出（IPC 断开后 runner 自退，不留孤儿）
  w.child.unref();
  if (w.child.channel) w.child.channel.unref();
  w.child.on('message', (msg) => {
    const job = w.job;
    if (!job || !msg || msg.id !== job.id) return; // 迟到/错位消息：该任务已按超时或异常收尾
    if (msg.ok) settle(w, null, msg.result);
    else settle(w, Object.assign(new Error(msg.error || '执行失败'), { execError: true }));
    if (!msg.ok || w.tasksDone >= RECYCLE_AFTER) retire(w); // 异常或额度用尽 → 换新进程
    else pump();
  });
  w.child.on('exit', () => {
    workers.delete(w);
    const abnormal = !w.dying && w.job; // 非处决且带着任务退出 = 真异常
    if (w.job) settle(w, new Error('子进程提前退出'));
    if (abnormal) console.error('[execpool] worker 异常退出，已补充新进程');
    // 快速崩溃（起来 <1s 且没干过活）退避 1s 再补，防 spawn 风暴
    const fastCrash = Date.now() - w.spawnedAt < 1000 && w.tasksDone === 0;
    if (fastCrash) setTimeout(() => { addWorker(); pump(); }, 1000).unref();
    else { addWorker(); pump(); }
  });
  w.child.on('error', () => {}); // spawn 失败随 exit 事件统一处理
  workers.add(w);
  return w;
}

function pump() {
  while (queue.length) {
    let idle = null;
    for (const w of workers) if (!w.job && !w.dying && w.child.connected) { idle = w; break; }
    if (!idle) return;
    const job = queue.shift();
    idle.job = job;
    job.timer = setTimeout(() => { settle(idle, Object.assign(new Error('执行超时'), { timeout: true })); retire(idle); }, job.hardMs);
    try { idle.child.send(job.task); }
    catch (e) { settle(idle, e); retire(idle); }
  }
}

// 预热：启动即建满池（runner 在 spawn 时就已 require 完全部游戏引擎，首个任务零冷启动）
for (let i = 0; i < POOL_SIZE; i++) addWorker();

// 统一入口：硬超时取自游戏 manifest 的 limits[kind]
function run(gameId, kind, payload, ownerKey) {
  const game = manifests[gameId];
  const hardMs = game && game.limits && game.limits[kind];
  if (!hardMs) return Promise.reject(new Error(`未注册的执行任务: ${gameId}:${kind}`));
  const ownerCount = ownerKey ? (perOwner.get(ownerKey) || 0) : 0;
  if (queue.length >= MAX_QUEUE || (ownerKey && ownerCount >= MAX_PER_OWNER)) {
    return Promise.reject(Object.assign(new Error('执行繁忙，请稍后重试'), { busy: true }));
  }
  if (ownerKey) perOwner.set(ownerKey, ownerCount + 1);
  return new Promise((resolve, reject) => {
    const id = nextJobId++;
    queue.push({ id, task: { id, game: gameId, kind, ...payload }, hardMs, ownerKey, resolve, reject, timer: null });
    pump();
  });
}

module.exports = { run };
