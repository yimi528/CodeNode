/**
 * write_analysis_md —— **已并入 `workbench_edit`（kind=write_analysis）**，见 docs/tool-consolidation.zh-CN.md L1。
 *
 * 本模块只保留执行体（`execute`），供 workbenchEditTool 的族分发复用；不再注册独立工具。
 * 旧名由 toolkit.registerLegacyAliases 登记成别名，调用时翻译成 workbench_edit + kind=write_analysis，
 * 安全语义（workspace.write / requiresConfirmation=WRITE）由 byKind 承接。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot, summarizeContentForConfirm } = require('./shared.cjs');
const { atomicWriteFile } = require('../../atomicFile.cjs');
const { nodeToScalarRecords } = require('../../scalars/index.cjs');

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function generateArchitecture(model) {
  if (!model) return '';
  const lines = [];
  lines.push('# 项目架构');
  lines.push('');
  const stats = model.stats();
  lines.push('> 画布共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线。');
  lines.push('');
  for (const n of model.nodes()) {
    const d = n.data || {};
    lines.push('- **[' + (n.type || 'node') + '] ' + (d.label || n.id) + '**（' + (d.status || 'pending') + '）');
    if (d.goal) lines.push('  - 目标：' + d.goal);
    if (d.prompt) lines.push('  - 说明：' + d.prompt);
    if (d.filePath) lines.push('  - 文件：' + d.filePath);
  }
  return lines.join('\n');
}

/** 执行体（族分发调用）；参数与合并前的 write_analysis_md 完全一致 */
async function execute(context, args) {
  const name = stringArg(args, 'name', '项目分析');
  let content = stringArg(args, 'content', '');
  if (!content) {
    const regenerate = args.regenerate !== false;
    if (regenerate) {
      const model = context.model();
      if (!model) return AgentToolResult.error('当前没有可用的工作台模型');
      content = generateArchitecture(model);
    }
  }
  if (!content.trim()) return AgentToolResult.error('没有可写入的分析内容（content 为空且无法自动生成架构）');
  const relativePath = stringArg(args, 'relativePath', 'analysis/' + Date.now() + '.md');

  const what = '写入分析文档 ' + relativePath + '（' + content.length + ' 字符）并创建文件节点';
  // #10：带上内容摘要 —— 只给字符数时用户看不出写的是什么
  const ok = await context.confirm(ConfirmationLevel.WRITE, what, '将分析内容写入 ' + relativePath + '，并在画布创建引用该文件的节点。\n' + summarizeContentForConfirm(content));
  if (!ok) return AgentToolResult.error('已取消写入');

  const root = path.resolve(context.projectRoot());
  const target = resolveInRoot(root, relativePath);
  if (!target) return AgentToolResult.error('路径越过项目边界');
  try {
    if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
    // #23：与 write_file / edit_file 统一走原子替换（临时文件 + fsync + rename）
    atomicWriteFile(target, content, 'utf-8');
  } catch (e) {
    return AgentToolResult.error('写入失败：' + ((e && e.message) || e));
  }

  let nodeId = '';
  await context.mutateWorkbench((model) => {
    const node = model.addNode('file', {
      label: name,
      status: 'pending',
      filePath: relativePath,
      prompt: '分析文档：' + relativePath,
      accent: '#f97316',
    }, 120, 120);
    nodeId = node.id;
  });
  if (!nodeId) return AgentToolResult.error('没有创建分析节点（工作台不可用）');
  const model = context.model();
  const node = model ? model.byId(nodeId) : null;
  const stored = node ? context.storeScalars(nodeToScalarRecords(node)) : 0;
  context.audit('write_analysis_md name=' + name + ' path=' + relativePath + ' chars=' + content.length);
  return AgentToolResult.ok('已写入分析节点 ' + name + '（' + content.length + ' 字符）→ ' + nodeId + (stored > 0 ? '（属性已入本地标量库）' : ''), {
    nodeId,
    name,
    relativePath,
    chars: content.length,
    preview: content.length > 400 ? content.slice(0, 400) + '…' : content,
  });
}

module.exports = { execute, generateArchitecture };
