'use strict';

const agentBackends = require('../backends/index.cjs');
const backendSettings = require('../backends/settings.cjs');
const backendConfig = require('../../config/agent.backends.json');

function register(ctx) {
  const { ipcMain, userDataDir, activeRequests, agent, sandbox } = ctx;
  ipcMain.handle('agent:backend-save', async (_event, projectRoot, scope, input, options) => {
    try {
      if (activeRequests.size) return { ok: false, error: 'Agent 正在运行，请结束后修改后端' };
      return { ok: true, ...backendSettings.write(projectRoot, userDataDir(), scope, input, options || {}) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('agent:backend-status', async (_event, projectRoot, input) => {
    try {
      const saved = backendSettings.read(projectRoot, userDataDir());
      const checkedSettings = input == null ? saved.settings : backendSettings.normalize(input);
      const runtimeRoot = projectRoot || userDataDir();
      const cfg = agent.loadConfig(runtimeRoot);
      const basePolicy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot: runtimeRoot, userDataDir: userDataDir() });
      const sandboxPolicy = sandbox.externalAgentPolicy(basePolicy, { projectRoot: runtimeRoot, access: checkedSettings.sandbox });
      const backend = agentBackends.createBackend(checkedSettings.backend, checkedSettings);
      return { ok: true, ...saved, checkedSettings, capabilities: await backend.health({ projectRoot: runtimeRoot, sandboxPolicy }).finally(() => backend.close()) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('agent:backend-control', async (_event, projectRoot, input, method, params) => {
    let backend;
    try {
      if (activeRequests.size) throw new Error('请先结束当前 Agent 任务');
      const settings = backendSettings.normalize(input);
      if (!backendConfig.acpBackends.includes(settings.backend)) throw new Error('当前后端不是 ACP');
      if (!['inspect', 'authenticate', 'logout', 'session/list', 'session/delete', 'session/close'].includes(method)) throw new Error('不支持的管理方法');
      backend = agentBackends.createBackend(settings.backend, settings);
      if (['session/delete', 'session/close'].includes(method) && typeof params?.sessionId !== 'string') throw new Error('缺少会话编号');
      const runtimeRoot = projectRoot || userDataDir(), cfg = agent.loadConfig(runtimeRoot);
      const basePolicy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot: runtimeRoot, userDataDir: userDataDir() });
      const sandboxPolicy = sandbox.externalAgentPolicy(basePolicy, { projectRoot: runtimeRoot, access: settings.sandbox });
      return { ok: true, value: await backend.control(method, params || {}, { projectRoot: runtimeRoot, sandboxPolicy }) };
    } catch (error) { return { ok: false, error: error.message }; }
    finally { await backend?.close(); }
  });
}

module.exports = { register };
