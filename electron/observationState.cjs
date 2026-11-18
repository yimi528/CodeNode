/**
 * 工具结果回灌：Tool Adapter -> run 内 Blackboard reducer -> Observation 视口。
 * reducer 只使用工具的结构化结果和固定映射，不发额外模型请求，也不写长期存储。
 */
'use strict';

const DOMAINS = Object.freeze(['diagnostics', 'files', 'canvas', 'context', 'plan', 'execution', 'web', 'coordination', 'other']);
const LABELS = Object.freeze({
  diagnostics: '错误与部分结果',
  files: '文件与项目', canvas: '画布与标量', context: '检索与记忆', plan: '计划',
  execution: '命令与任务', web: '网络资料', coordination: '协作与用户输入', other: '其他工具',
});
const NOTE_PREFIX = '【工具观察汇总】';

const DOMAIN_BY_TOOL = Object.freeze({
  scan_project: 'files', project_overview: 'files', read_file: 'files',
  list_files: 'files', search_files: 'files', symbol_nav: 'files',
  write_file: 'files', edit_file: 'files', view_image: 'files',
  get_workbench_model: 'canvas', workbench_edit: 'canvas', retrieve_context: 'canvas',
  memory: 'context', read_skill: 'context',
  update_plan: 'plan',
  execute_shell: 'execution', poll_job: 'execution', worktree: 'execution',
  web: 'web',
  ask_user: 'coordination', delegate_task: 'coordination', delegate_tasks: 'coordination',
  get_subagent_task: 'coordination', cancel_subagent_task: 'coordination',
});
/**
 * 旧名 → 族名：工具面收敛后 run 记录里可能同时存在新旧两种名字（历史消息、别名调用）。
 * 回灌归域必须两种都认，否则旧名会落到 `other`，观察视口里的分组就错位了。
 */
const LEGACY_DOMAIN_ALIASES = Object.freeze({
  project_info: 'project_overview', analyze_project: 'project_overview', code_review: 'project_overview',
  find_files: 'list_files', list_directory: 'list_files',
  find_definition: 'symbol_nav', find_references: 'symbol_nav', get_callers: 'symbol_nav', get_callees: 'symbol_nav',
  query_scalars: 'retrieve_context',
  remember: 'memory', recall: 'memory',
  bulk_edit: 'workbench_edit', write_analysis_md: 'workbench_edit', save_project: 'workbench_edit',
  ui_control: 'get_workbench_model',
  fetch_url: 'web', web_search: 'web', dify_call: 'web',
});

function parseConfig(cfg = {}) {
  const value = Number(cfg['agent.observation.budget_chars']);
  return {
    enabled: cfg['agent.observation.enabled'] == null || String(cfg['agent.observation.enabled']).toLowerCase() !== 'false',
    budgetChars: Number.isFinite(value) ? Math.max(400, Math.min(20000, Math.floor(value))) : 2400,
  };
}

function parseArgs(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function resourceKey(name, args, callId) {
  const n = LEGACY_DOMAIN_ALIASES[name] || name;
  if (n === 'update_plan') return 'plan';
  if (n === 'get_workbench_model') return 'workbench:model';
  if (n === 'workbench_edit') {
    // workbench_edit 现在也承载 save_project / write_analysis / bulk_* —— 各自的资源键不同
    const kind = String((args && args.kind) || '').toLowerCase();
    if (kind === 'save_project') return 'workbench:save';
    if (kind === 'write_analysis') return 'workbench:analysis:' + String((args && args.relativePath) || '');
    return 'workbench:' + (kind || 'edit');
  }
  if (n === 'project_overview' || n === 'scan_project') {
    return 'project:' + n + ':' + String((args && args.kind) || '');
  }
  if (n === 'read_file' || n === 'view_image') {
    const path = args.path || args.filePath || args.file;
    if (typeof path === 'string' && path) return n + ':' + path + ':' + String(args.offset || args.startLine || 0);
  }
  if (n === 'retrieve_context' && typeof args.key === 'string') return 'scalar:' + args.key;
  return 'call:' + callId;
}

/** 将具体工具记录适配为统一的 State Patch。 */
function adaptToolResult(record, content) {
  const name = String((record && record.name) || 'unknown');
  const callId = String((record && record.callId) || '');
  const args = parseArgs(record && record.args);
  const unsettled = record && (record.ok === false || record.partial);
  const canonicalName = LEGACY_DOMAIN_ALIASES[name] || name;
  const domain = unsettled ? 'diagnostics' : DOMAIN_BY_TOOL[canonicalName] || 'other';
  const key = unsettled ? 'call:' + callId : resourceKey(name, args, callId);
  return {
    domain, key, operation: key.startsWith('call:') ? 'append' : 'replace', callId,
    value: {
      name, callId, ok: record && record.ok !== false, partial: !!(record && record.partial),
      args, data: record && record.data, failure: record && record.failure,
      content: String(content || ''),
    },
  };
}

function createBlackboard() {
  return { revision: 0, domains: Object.fromEntries(DOMAINS.map((domain) => [domain, new Map()])), lastPatches: [] };
}

/** 按 assistant 声明的工具顺序应用 patch；同资源 replace，独立结果 append。 */
function reduceToolResults(state, patches) {
  const board = state || createBlackboard();
  const applied = [];
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch || !board.domains[patch.domain]) continue;
    const target = board.domains[patch.domain];
    board.revision += 1;
    const entry = { ...patch.value, key: patch.key, version: board.revision, operation: patch.operation };
    target.set(patch.key, entry);
    applied.push({ domain: patch.domain, key: patch.key, version: board.revision, callId: patch.callId });
  }
  board.lastPatches = applied;
  return board;
}

function excerpt(content, limit) {
  const text = String(content || '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).slice(0, 3).join(' / ') || '（工具未返回文本）';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** 从最新 Blackboard 中只取本轮触及的资源，生成下一轮主模型的观察视口。 */
function synthesizeObservation(state, options = {}) {
  const board = state || createBlackboard();
  const touched = board.lastPatches || [];
  const budgetChars = Number(options.budgetChars) || 2400;
  const latest = new Map();
  for (const patch of touched) {
    const value = board.domains[patch.domain].get(patch.key);
    if (value) latest.set(patch.domain + '\u0000' + patch.key, { domain: patch.domain, value });
  }
  // 失败优先，然后按状态版本从新到旧；预算不足时优先给主模型最需处理的信息。
  const entries = [...latest.values()].sort((a, b) =>
    Number(a.value.ok !== false && !a.value.partial) - Number(b.value.ok !== false && !b.value.partial) ||
    b.value.version - a.value.version,
  );
  const lines = [NOTE_PREFIX + ' Blackboard v' + board.revision + '；本轮更新 ' + touched.length + ' 项。完整结果见对应 tool 消息。'];
  const perItem = Math.max(36, Math.min(240, Math.floor((budgetChars - 120) / Math.max(1, entries.length)) - 70));
  let omitted = 0;
  for (const { domain, value } of entries) {
    const status = value.ok === false ? '失败' : value.partial ? '部分成功' : '成功';
    const code = value.failure && value.failure.code ? ' · ' + value.failure.code : '';
    const line = '- ' + LABELS[domain] + ' [' + value.callId + ' · ' + value.name + ' · ' + status + code + '] ' + excerpt(value.content, perItem);
    if (lines.join('\n').length + line.length + 60 > budgetChars) { omitted += 1; continue; }
    lines.push(line);
  }
  if (omitted) lines.push('（视口省略 ' + omitted + ' 项；完整结果见对应 tool 消息。）');
  return lines.join('\n');
}

module.exports = { NOTE_PREFIX, parseConfig, adaptToolResult, createBlackboard, reduceToolResults, synthesizeObservation };
