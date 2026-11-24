'use strict';
const path = require('node:path');
const backendConfig = require('../config/agent.backends.json');

function turnOptions(payload) {
  if (!payload || payload.resumeRunId || payload.nodeId || payload.autoAdvanceClaimId) return undefined;
  const overrides = payload.composerOverrides;
  const mode = overrides?.approvalMode;
  if (mode === undefined) return overrides;
  if (!['request', 'assist', 'full', 'custom'].includes(mode)) throw new Error('未知的操作审批方式');
  const { autoExecuteTools, externalAccess, ...rest } = overrides;
  if (mode === 'custom') return rest;
  return { ...rest, autoExecuteTools: mode === 'assist', externalAccess: 'workspace-write' };
}

function locked(config) {
  return config?.mode === 'strict' || !!config?.requireFilesystem ||
    [config?.maxProcesses, config?.maxMemoryMB, config?.cpuSeconds].some(value => Number(value) > 0);
}

function canAssistWrite(mode, relativePath) {
  // Only CodeNode's own validated text write can qualify. Protocol request labels
  // cannot establish either what an external process will do or where it will write.
  const parts = relativePath.split('/');
  return mode === 'assist' && /\.(?:txt|md)$/i.test(relativePath) &&
    parts.every(part => part && !part.startsWith('.') && !['node_modules', 'vendor'].includes(part.toLowerCase())) &&
    !/^(?:agents|claude|gemini|skill)\.md$/i.test(path.posix.basename(relativePath));
}

async function authorizeFullAccess(backend, root) {
  const { dialog } = require('electron');
  const result = await dialog.showMessageBox({
    type: 'warning', title: '完全访问权限', message: '允许本次运行访问本机文件和网络？',
    detail: `${backendConfig.labels[backend] || backend} 将在当前系统账户下运行，文件访问范围可超出项目 ${root}。`,
    buttons: ['取消', '允许本次运行'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return result.response === 1;
}

module.exports = { turnOptions, locked, canAssistWrite, authorizeFullAccess };
