/**
 * bulk_edit —— **已并入 `workbench_edit`（kind=bulk_create_nodes / bulk_create_files /
 * bulk_create_assets / bulk_delete_nodes）**，见 docs/tool-consolidation.zh-CN.md L1。
 *
 * 本模块只保留执行体与确认文案生成器，供 workbenchEditTool 的族分发复用；不再注册独立工具。
 * 旧名 `bulk_edit` 由 toolkit.registerLegacyAliases 登记成别名，旧的 action 名会被翻译成对应 kind
 * （安全语义仍是 HIGH 级确认，由 byKind 承接 —— 与合并前的内部 HIGH 确认一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, summarizeContentForConfirm } = require('./shared.cjs');
const { atomicWriteFile } = require('../../atomicFile.cjs');
const { nodeToScalarRecords } = require('../../scalars/index.cjs');

const MAX_BATCH = 200;

function storeNodeScalars(context, ids) {
  const model = context.model();
  if (!model) return 0;
  const records = [];
  for (const id of ids) {
    const node = model.byId(id);
    if (node) records.push(...nodeToScalarRecords(node));
  }
  return context.storeScalars(records);
}

function removeNodeScalars(context, ids) {
  const store = context.scalars();
  if (!store) return 0;
  let removed = 0;
  for (const id of ids) {
    if (store.remove('node:' + id)) removed++;
    removed += store.removePrefix('node:' + id + ':');
  }
  return removed;
}

function intArg(args, key, fallback) {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.floor(args[key]) : fallback;
}

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function nodeIds(args) {
  const ids = [];
  const single = args.nodeId;
  if (single != null && String(single).trim() !== '') ids.push(String(single));
  if (Array.isArray(args.nodeIds)) {
    for (const item of args.nodeIds) {
      if (item != null && String(item).trim() !== '') ids.push(String(item));
    }
  }
  return ids;
}

function listSize(args) {
  return Array.isArray(args.list) ? args.list.length : 0;
}

function describe(action, args) {
  switch (action) {
    case 'create_nodes':
      return '批量创建 ' + intArg(args, 'count', 1) + ' 个工作台节点';
    case 'create_files':
      return '批量写入 ' + listSize(args) + ' 个文件';
    case 'create_assets':
      return '批量创建 ' + listSize(args) + ' 个文件节点';
    case 'delete_nodes':
      return '批量删除 ' + nodeIds(args).length + ' 个工作台节点';
    default:
      return '执行批量操作 ' + action;
  }
}

function detailFor(action, args) {
  const sb = [];
  sb.push('Agent 请求执行：' + describe(action, args) + '。');
  if (action === 'create_files' && Array.isArray(args.list)) {
    sb.push('将写入的文件：');
    let shown = 0;
    for (const item of args.list) {
      if (item && typeof item === 'object') {
        const content = item.content == null ? '' : String(item.content);
        // #10：只列路径而不给内容，用户无法判断写进去的是什么 —— 每条给长度 + 预览
        sb.push('  - ' + String(item.path || '') + '（' + content.length + ' 字符）');
        const firstLine = content.split('\n').find((line) => line.trim().length > 0) || '';
        if (firstLine.trim()) sb.push('    首行：' + (firstLine.length > 160 ? firstLine.slice(0, 160) + '…' : firstLine.trim()));
        shown++;
        if (shown >= 20) {
          sb.push('  …共 ' + args.list.length + ' 个文件');
          break;
        }
      }
    }
    // 单个文件时给完整摘要（多文件时逐条预览已经足够，再多会淹掉对话框）
    if (args.list.length === 1 && args.list[0] && typeof args.list[0] === 'object') {
      sb.push(summarizeContentForConfirm(args.list[0].content == null ? '' : String(args.list[0].content)));
    }
  } else if (action === 'delete_nodes') {
    sb.push('删除的节点数：' + nodeIds(args).length + '（此操作不可撤销，请确认）');
  }
  return sb.join('\n');
}

async function createNodes(context, args) {
  const count = Math.max(1, Math.min(MAX_BATCH, intArg(args, 'count', 1)));
  const baseName = stringArg(args, 'name', '节点');
  const prompt = stringArg(args, 'prompt', '说明这个节点应完成的工作');
  const connect = args.connect === true;
  const ids = [];
  await context.mutateWorkbench((model) => {
    const created = [];
    for (let i = 0; i < count; i++) {
      const node = model.addNode('task', { label: count === 1 ? baseName : baseName + (i + 1), status: 'pending', prompt }, 120 + (i % 10) * 40, 120 + Math.floor(i / 10) * 90);
      created.push(node);
      ids.push(node.id);
    }
    if (connect) {
      for (let i = 0; i + 1 < created.length; i++) model.connect(created[i], created[i + 1]);
    }
  });
  context.audit('bulk_edit create_nodes count=' + count);
  const stored = storeNodeScalars(context, ids);
  const note = stored > 0 ? '；节点属性已入本地标量库（' + stored + ' 条，需要时用 query_scalars key=node:<id>）' : '';
  return AgentToolResult.ok('已批量创建 ' + ids.length + ' 个节点' + note, { action: 'create_nodes', nodeIds: ids, count: ids.length });
}

async function createFiles(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  if (list.length === 0) return AgentToolResult.error('缺少 list（要写入的文件列表）');
  const root = path.resolve(context.projectRoot());
  const written = [];
  const errors = [];
  let n = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      n++;
      continue;
    }
    const relative = String(item.path || '').trim();
    const content = item.content == null ? '' : String(item.content);
    if (!relative) {
      errors.push('第 ' + (n + 1) + ' 项缺 path');
      n++;
      continue;
    }
    const target = resolveInRoot(root, relative);
    if (!target) {
      errors.push('路径越过项目边界: ' + relative);
      n++;
      continue;
    }
    try {
      if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
      const editing = require('../../safeEditing.cjs');
      const before = editing.snapshot(target);
      editing.validateCandidate(relative, before.text, content, context.editingConfig ? context.editingConfig() : require('../../../config/ui.editing.json').defaults, before.existed);
      // #23：与 write_file / edit_file 统一走原子替换（临时文件 + fsync + rename）——
      // 裸 writeFileSync 在中途崩溃/断电时会把文件截成半截且没有 .bak。
      atomicWriteFile(target, content, 'utf-8', { expectedSha256: before.sha256 });
      written.push(relative);
      context.notifyFileChange(relative, before.existed ? 'modify' : 'create', content.length + ' 字节');
    } catch (e) {
      errors.push(relative + ': ' + ((e && e.message) || e));
    }
    n++;
  }
  context.audit('bulk_edit create_files written=' + written.length + ' errors=' + errors.length);
  if (written.length === 0) return AgentToolResult.error('写入失败：' + errors.join('；'));
  const data = { action: 'create_files', written, count: written.length };
  if (errors.length) data.errors = errors;
  return AgentToolResult.ok('已批量写入 ' + written.length + ' 个文件' + (errors.length ? '，失败 ' + errors.length + ' 项' : ''), data);
}

async function createAssets(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  if (list.length === 0) return AgentToolResult.error('缺少 list（资产列表）');
  const ids = [];
  await context.mutateWorkbench((model) => {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const relative = String(item.path || '').trim();
      if (!relative) continue;
      const name = relative.includes('/') ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
      const node = model.addNode('file', { label: name, status: 'pending', filePath: relative }, 200, 200 + ids.length * 40);
      ids.push(node.id);
    }
  });
  context.audit('bulk_edit create_assets count=' + ids.length);
  const stored = storeNodeScalars(context, ids);
  const note = stored > 0 ? '；节点属性已入本地标量库' : '';
  return AgentToolResult.ok('已批量创建 ' + ids.length + ' 个文件节点' + note, { action: 'create_assets', nodeIds: ids, count: ids.length });
}

async function deleteNodes(context, args) {
  const ids = nodeIds(args);
  if (ids.length === 0) return AgentToolResult.error('缺少 nodeIds');
  const deleted = [];
  const errors = [];
  await context.mutateWorkbench((model) => {
    for (const id of ids) {
      const node = model.byId(id);
      if (!node) {
        errors.push('节点不存在: ' + id);
        continue;
      }
      model.removeNode(node);
      deleted.push(id);
    }
  });
  context.audit('bulk_edit delete_nodes count=' + deleted.length);
  const removed = removeNodeScalars(context, deleted);
  const note = removed > 0 ? '；已同步清理本地标量 ' + removed + ' 条' : '';
  if (deleted.length === 0) return AgentToolResult.error('删除失败：' + errors.join('；'));
  const data = { action: 'delete_nodes', deleted, count: deleted.length };
  if (errors.length) data.errors = errors;
  return AgentToolResult.ok('已批量删除 ' + deleted.length + ' 个节点' + note + (errors.length ? '，失败 ' + errors.length + ' 项' : ''), data);
}

module.exports = { createNodes, createFiles, createAssets, deleteNodes, detailFor, describe, MAX_BATCH };
