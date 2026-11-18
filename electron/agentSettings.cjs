'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const ui = require('../config/ui.agent.json');
function parseAutoExecution(properties = {}) {
  return properties['tools.confirm_writes'] == null ? ui.defaults.autoExecuteTools
    : String(properties['tools.confirm_writes']).trim().toLowerCase() === 'false';
}
function canAutoExecute(name, args = {}) {
  if (!ui.ordinaryWriteTools.includes(name)) return false;
  /**
   * workbench_edit 是**族工具**：只有「普通画布编辑」与 kind=write_analysis 属于免打扰范围；
   * bulk_*（批量建删/批量写文件）与 save_project（整体覆盖工程文件）保持必问 ——
   * 与合并前 bulk_edit 内部 HIGH 确认、save_project 声明 requiresConfirmation=WRITE 一致。
   */
  if (name === 'workbench_edit') {
    const kind = String(args.kind || '').trim().toLowerCase();
    if (kind === 'write_analysis') return true;
    if (kind) return false;
    const operations = Array.isArray(args.operations) && args.operations.length ? args.operations : [args];
    return operations.every(operation => operation && ui.ordinaryCanvasActions.includes(String(operation.action || 'create').toLowerCase()));
  }
  // memory 是族工具：只有 action=save 是写（search 是纯读，本来也不需要审批）
  if (name === 'memory') return String(args.action || '').trim().toLowerCase() === 'save';
  return true;
}
function writeSettings(root, input) {
  if (!input || typeof input.autoExecuteTools !== 'boolean') throw new Error('普通工具自动执行选项必须是布尔值');
  const directory = path.join(path.resolve(root), '.codenode');
  const file = path.join(directory, 'agent.properties');
  for (const target of [directory, file]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('设置路径不可为符号链接');
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = before.split(/\r?\n/).filter(line => !/^\s*tools\.confirm_writes\s*=/.test(line));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('tools.confirm_writes=' + String(!input.autoExecuteTools));
  atomicWriteFile(file, lines.join('\n') + '\n');
  return { autoExecuteTools: input.autoExecuteTools };
}
module.exports = { parseAutoExecution, canAutoExecute, writeSettings };
