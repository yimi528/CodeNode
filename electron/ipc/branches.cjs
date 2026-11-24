'use strict';
const path = require('node:path');
const branches = require('../conversationBranches.cjs');
function register({ ipcMain, activeRequests, agent, sandbox, userDataDir }) {
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, root, ...args) => {
    try {
      if (!root) throw Error('请先打开 Git 项目');
      if (activeRequests.size) throw Error('请先结束正在运行的任务，再操作会话方案');
      const cfg = agent.loadConfig(root);
      let policy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot: root, userDataDir: userDataDir() });
      const owner=await branches.ownerOf(root,{policy});
      policy=sandbox.resolvePolicy({...cfg.sandbox,allowWrite:[...(cfg.sandbox.allowWrite||[]),path.join(owner,'.git'),path.join(owner,'.codenode')]},{projectRoot:root,userDataDir:userDataDir()});
      return { ok: true, value: await action(root, ...args, { policy }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle('branches:list', (root, options) => branches.list(root, options));
  handle('branches:checkpoint', (root, input, options) => branches.checkpoint(root, input, options));
  handle('branches:fork', (root, checkpointId, name, options) => branches.fork(root, checkpointId, name, options));
  handle('branches:context', (root, context, options) => branches.saveContext(root, context, options));
  handle('branches:compare', (root, id, options) => branches.compare(root, id, options));
  handle('branches:preview-adopt', (root, id, options) => branches.previewAdopt(root, id, options));
  handle('branches:adopt', (root, id, preview, options) => branches.adopt(root, id, preview, options));
  handle('branches:archive', (root, id, options) => branches.archive(root, id, options));
}
module.exports = { register };
