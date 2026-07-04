'use strict';
// 游戏注册表（子进程安全）：只聚合各游戏的 manifest（games/<id>/index.js）。
// manifest 绝不 require db/auth 等服务端资源——runner 子进程也会加载本文件，
// 若混入 db 会在子进程里打开 SQLite、并被权限模型拦读库文件。
// 服务端适配（games/<id>/server.js，含 db 访问与路由形态）由 server.js 另行按 id 加载。
//
// 新增一款游戏 = 新建 games/<id>/ 目录（index.js manifest + server.js 服务端适配 + engine/ + guide.js），
// 然后在下面登记 id。平台代码（platform/、server.js）无需改动。
const ids = ['clawclash', 'prisoner'];

const manifests = {};
for (const id of ids) manifests[id] = require('./' + id);

module.exports = { ids, manifests };
