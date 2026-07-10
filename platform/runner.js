'use strict';
// 常驻子进程：执行不可信对局/烟雾/试玩，与 Web/DB 进程隔离（P1 执行层）。
// 父进程（platform/execpool.js 的常驻池）经 IPC 逐个下发任务 { id, game, kind, ...payload }，
// 按游戏注册表分发到 games/<id>/index.js（manifest）的 tasks[kind]，回传 { id, ok, result|error }
// 后继续等待下一个任务——任务间不退出；超时处决、异常/额度回收换新均由父进程管理。
// 安全：本进程 env 已被父进程剥离机密；games/registry 只加载子进程安全的 manifest（不含 db/auth）；
// 用户代码每任务都在全新 vm 上下文编译执行（各游戏 sandbox.js），任务之间不共享沙箱。
// vm 逃逸后仍可读放行目录——须靠权限模型 + OS 级隔离兜底（见 SECURITY.md）。
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
  try { out = { id: task && task.id, ok: true, result: handle(task) }; }
  catch (e) { out = { id: task && task.id, ok: false, error: String((e && e.message) || e) }; }
  try { process.send(out); }
  catch { process.exit(1); } // IPC 已断（父进程亡）→ 自退
});

// 父进程退出 → IPC 断开 → 立即自退，绝不留孤儿常驻进程
process.on('disconnect', () => process.exit(0));
