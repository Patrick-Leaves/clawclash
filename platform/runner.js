'use strict';
// 子进程：执行不可信对局/烟雾/试玩，与 Web/DB 进程隔离。
// 父进程经 IPC 下发一个任务 { game, kind, ...payload }，按游戏注册表分发到
// games/<id>/index.js（manifest）的 tasks[kind]，跑完回传结果即退出（fork-per-task）。
// 安全：本进程 env 已被父进程剥离机密；games/registry 只加载子进程安全的 manifest
// （不含 db/auth）。vm 逃逸后仍可读放行目录——须靠 OS 级隔离兜底（见 SECURITY.md）。
const { manifests } = require('../games/registry');

function handle(task) {
  const game = manifests[task.game];
  if (!game) throw new Error('unknown game: ' + task.game);
  const fn = game.tasks && game.tasks[task.kind];
  if (!fn) throw new Error(`unknown task: ${task.game}:${task.kind}`);
  return fn(task);
}

process.on('message', (task) => {
  let out;
  try { out = { ok: true, result: handle(task) }; }
  catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
  try { process.send(out, () => process.exit(0)); }
  catch { process.exit(1); }
});

// 兜底：父进程若迟迟不下发任务，自退避免悬挂
setTimeout(() => process.exit(0), 120000).unref();
