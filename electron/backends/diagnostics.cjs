'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config/agent.backends.json');
const { resolveCommand } = require('./stdioRpc.cjs');

const checked = new Map();
function key(settings,scope='') { let root=scope?path.resolve(scope):'';try{if(root)root=fs.realpathSync(root);}catch{}return JSON.stringify([root,settings.backend,settings.executable||config.commands[settings.backend],settings.args||[],settings.model||'',settings.sandbox||'read-only',settings.home||'',settings.acp||{}]); }
// A historical task result is evidence of that exact backend/version/platform only.
function validationEvidence(name, version, platform = process.platform) {
  const file = path.join(__dirname, '../../docs/validation/backend-live-2026-10-18.json');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (record.backend !== name || record.platform !== platform || !version || record.version !== version) return null;
  if (record.acpCheck !== 'pass' || record.readOnlySmoke?.state !== 'COMPLETED' || record.fileWorkflow?.verified !== true) return null;
  return { date: record.date, platform: record.platform, version: record.version, source: 'docs/validation/backend-live-2026-10-18.json', coverage: ['连接', '只读任务', '文件修改与独立测试'], incomplete: ['取消与恢复', '权限拒绝'] };
}
/** @param {any} settings @param {any} capabilities */
function describe(settings, capabilities = null, scope = '') {
  let checkedAt=null;
  if (capabilities) {checkedAt=new Date().toISOString();checked.set(key(settings,scope),{capabilities,checkedAt});}
  else {const prior=checked.get(key(settings,scope));capabilities=prior?.capabilities||null;checkedAt=prior?.checkedAt||null;}
  const backend = settings.backend;
  const command = settings.executable || config.commands[backend];
  let installed = backend === 'builtin', executable = null, installError = '';
  if (!installed) {
    try { if (!command) throw Error('尚未配置启动命令'); executable = resolveCommand(command).command; installed = true; }
    catch (error) { installError = error.message; }
  }
  const evidence = validationEvidence(backend, capabilities?.version);
  const isolation = capabilities?.externalAgentIsolation;
  const state = !installed ? 'not-installed' : capabilities?.available === false ? 'unavailable' : backend === 'builtin' ? 'builtin' : evidence ? 'task-validated' : capabilities?.available ? 'protocol-validated' : 'not-checked';
  const labels = { 'not-installed': '未安装或命令不可用', unavailable: '连接不可用', builtin: '内置执行器', 'task-validated': '真实任务部分验证通过', 'protocol-validated': '仅协议验证通过', 'not-checked': '已安装，连接未检测' };
  const error = installError || capabilities?.error || '';
  const fixes = !installed ? ['安装对应 Agent 或适配器后，填写本机启动命令和参数。', '安装和登录由你在本机终端完成；这里不会自动下载。'] : capabilities?.available === false ? [
    /sandbox|isola|沙箱|隔离|filesystem/i.test(error) ? '当前隔离条件未满足。检查系统隔离工具及执行设置；Windows 缺少文件隔离时不能宣称安全可用。' : /auth|login|credential|认证|登录/i.test(error) ? '在 Agent 自身终端完成登录，再重新检测连接。' : '核对命令、启动参数及 Agent 服务状态，再重新检测。',
  ] : backend === 'builtin' ? ['选择已连接的模型后即可发送任务。'] : ['检测连接后，再用只读任务和小范围文件任务验证当前配置。'];
  return { backend, installed, executable, state, label: labels[state], error, fixes, evidence, isolation: isolation || null, experimental: backend !== 'builtin', checkedAt };
}
module.exports = { describe, validationEvidence };
