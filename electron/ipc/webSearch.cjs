'use strict';

const settings = require('../webSearchSettings.cjs');

function register(ctx) {
  const { ipcMain, userDataDir, agent, activeRequests } = ctx;
  ipcMain.handle('agent:web-search-check', async (_event, projectRoot, input) => {
    try { return await settings.checkSettings(userDataDir(), input, agent.loadConfig(projectRoot)); }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  });
  ipcMain.handle('agent:web-search-save', async (_event, projectRoot, input) => {
    try {
      if (activeRequests.size) return { ok: false, error: 'Agent 正在运行，请在任务结束后修改联网搜索设置' };
      return { ok: true, settings: settings.writeSettings(userDataDir(), input, agent.loadConfig(projectRoot)) };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  });
}

module.exports = { register };
