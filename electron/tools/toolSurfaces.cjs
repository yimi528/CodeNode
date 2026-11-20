'use strict';

const { families, projectSpec, selectors } = require('./actionRoutes.cjs');
const { CONFIRMATION_LEVELS } = require('./descriptor.cjs');
const listFiles = require('./listFilesSurface.cjs');

// Only the model-facing entry points merge. Authorization, outputs and execution
// continue to use the original per-action descriptors.
const labels = {
  file_ops: {
    read: '读取 UTF-8 文本或 PDF/DOCX/XLSX/PPTX，可分页', write: '新建或整体覆盖，可校验哈希并备份',
    edit: '精确替换，原文须唯一；occurrence=0 表示全部', image: '把项目图片附到对话（PNG/JPEG/WebP/GIF，≤4MB）',
  },
  terminal: {
    run: '在项目目录执行白名单命令；async=true 返回 jobId，用 poll 轮询',
    poll: '按 jobId 读取进度和输出，可等待或分页',
  },
  symbol_nav: { definition:'定义', references:'引用', callers:'谁调用它', callees:'它调用谁' },
  project_overview: { info:'工程概况', scan:'扫描目录树和语言分布，可选写入画布', structure:'逐文件结构摘要', review:'静态规则审查' },
  web: { fetch:'抓取网页文本', search:'联网搜索', dify:'调用已配置的 Dify 应用' },
  memory: { search:'查长期记忆', save:'经确认保存长期记忆' },
  delegate: { single:'派发一个子任务', batch:'批量派发子任务' },
  subagent_read: { get:'读取子任务', inspect_retry:'查看重做条件', merge:'归并候选结果' },
  subagent_control: { cancel:'取消任务', retry:'重做任务', review:'审查候选结果' },
  get_workbench_model: { full:'读完整画布', counts:'只读统计', view_all:'适配视图', focus:'聚焦节点',
    zoom:'缩放', pan:'平移', resize:'调整窗口', toggle_panel:'切换面板', new_content:'新增界面内容' },
  workbench_edit: { edit:'编辑画布（operations 可批量执行）', save_project:'保存工程', write_analysis:'写入分析文档',
    bulk_create_nodes:'批量建节点', bulk_create_files:'批量写文件', bulk_create_assets:'批量建文件节点', bulk_delete_nodes:'批量删节点' },
  retrieve_context: { auto:'自动检索', file:'文件文本检索', vector:'向量检索', hybrid:'混合检索',
    scalar:'标量相关性检索', exact:'按键、前缀或关键词查标量' },
};

function mergeProperty(existing, incoming) {
  if (!existing || JSON.stringify(existing) === JSON.stringify(incoming)) return incoming;
  if (existing.type !== incoming.type) return { anyOf: [existing, incoming] };
  const merged = { type: existing.type, description: existing.description || incoming.description };
  if (existing.enum && incoming.enum) merged.enum = [...new Set([...existing.enum, ...incoming.enum])];
  if (existing.items && incoming.items) merged.items = mergeProperty(existing.items, incoming.items);
  if (existing.properties && JSON.stringify(existing.properties) === JSON.stringify(incoming.properties)) {
    merged.properties = existing.properties;
  }
  return merged;
}

function publishedDescriptor(name, descriptors, permitsAction) {
  if (name === listFiles.NAME) return listFiles.descriptorFor(descriptors);
  const { field, fallback, actions } = families.get(name);
  const allowed = [...actions].filter(([kind, route]) => descriptors.has(route.executor) &&
    (name === 'workbench_edit' && kind === 'edit'
      ? selectors(route.executor).some(id => permitsAction(route.executor, id))
      : permitsAction(route.executor, route.id)));
  if (!allowed.length) return null;
  const actionHints = [];
  const properties = {};
  const outputs = new Set();
  let alwaysRequired;
  for (const [kind, route] of allowed) {
    const descriptor = descriptors.get(route.executor);
    const input = projectSpec(descriptor, permitsAction)?.inputSchema;
    const fields = { ...(input?.properties || {}) };
    delete fields[field];
    if (route.legacyField) delete fields[route.legacyField];
    if (name === 'memory' && fields.kind) {
      fields.memoryKind = fields.kind;
      delete fields.kind;
    }
    const required = (input?.required || []).filter(key => Object.hasOwn(fields, key));
    const alternatives = input?.anyOf?.map(option => option.required?.join('/')).filter(Boolean);
    const hint = (required.length ? '，必填 ' + required.join('/') : '') +
      (alternatives?.length ? '，还需 ' + alternatives.join(' 或 ') : '');
    actionHints.push(kind + '：' + (labels[name]?.[kind] || descriptor.description) + hint);
    alwaysRequired = alwaysRequired ? alwaysRequired.filter(key => required.includes(key)) : required;
    for (const [key, value] of Object.entries(fields)) properties[key] = mergeProperty(properties[key], value);
    if (descriptor.outputSchema) outputs.add(descriptor.outputSchema);
  }
  const members = allowed.map(([, route]) => descriptors.get(route.executor));
  const approvalLevels = members.map(member => member.requiresConfirmation);
  const kinds = allowed.map(([kind]) => kind);
  return {
    ...members[0],
    name,
    readOnly: members.every(member => member.readOnly),
    idempotent: members.every(member => member.idempotent),
    mutatesWorkspace: members.some(member => member.mutatesWorkspace),
    requiresConfirmation: [...CONFIRMATION_LEVELS].reverse().find(level => approvalLevels.includes(level)) || false,
    description: actionHints.join('；') + (kinds.includes(fallback) ? '。默认 ' + fallback : ''),
    inputSchema: {
      type:'object',
      properties: { [field]:{type:'string',enum:kinds}, ...properties },
      required: kinds.includes(fallback) ? alwaysRequired : [field, ...alwaysRequired],
      additionalProperties:false,
    },
    outputSchema: outputs.size < 2 ? [...outputs][0] || null : { anyOf:[...outputs] },
  };
}
module.exports = { publishedDescriptor };
