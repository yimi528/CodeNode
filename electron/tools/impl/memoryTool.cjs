/**
 * memory —— 长期记忆族工具（工具面收敛 L2）。
 *
 * 合并自两个**异构**工具：
 *   kind=save   ← remember（写：新增/取代槽位，需要确认）
 *   kind=search ← recall（读：检索有效记忆）
 *
 * 这是「必须靠 kind 级安全门」的典型例子：写入是 workspace.write + 需确认，检索是
 * workspace.read + 免确认。如果只按族级 descriptor 判定，只读角色会拿到写能力。
 * 所以 byKind 里 save 声明 readOnly=false / requiresConfirmation=WRITE，search 声明
 * readOnly=true / 免确认 —— descriptor.cjs 的 effectiveDescriptor 按本次 kind 解出。
 *
 * 参数并集：两个工具原有 `kind` 字段用于「记忆类型（note/preference/fact/decision）」，
 * 与本族的动作字段**同名冲突**。族动作改用 `action`，把 `kind` 留给记忆类型 ——
 * 旧调用（remember 的 kind=preference）通过别名翻译时会被搬进 `memoryKind`，见 KIND_ALIASES。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const memory = require('../../memory.cjs');
const { inferMemoryKind, memoryStatus } = require('../../memoryResolution.cjs');
const userMemory = require('../../userMemory.cjs');

const ACTIONS = Object.freeze(['save', 'search']);

/** 族动作字段是 `action`（避免与 remember 的记忆类型 `kind` 冲突）；兼容 action/op/mode */
function resolveAction(args) {
  const a = args || {};
  const raw = String(a.action || a.op || a.mode || '').trim().toLowerCase();
  if (!raw) return 'search';
  if (raw === 'remember' || raw === 'save' || raw === 'write' || raw === 'add') return 'save';
  if (raw === 'recall' || raw === 'search' || raw === 'read' || raw === 'find') return 'search';
  return raw;
}

function renderEntry(entry) {
  const state = memoryStatus(entry);
  const prefix = state === 'active' ? '' : '〔历史：' + state + '〕';
  return '- ' + prefix + (entry.key ? '[' + entry.key + (entry.value ? '=' + entry.value : '') + '] ' : '') + entry.content + ' [' + (entry.createdAt || '') + ']';
}

const DESCRIPTION =
  '长期记忆。action=save 写入一条记忆（相同 scope + key 是同一槽位，新值经确认后取代旧值；不填 key 则追加便笺）——' +
  '当前会话的临时要求不要 save。action=search 检索有效记忆（默认），scope=project/user/all，' +
  'includeHistory=true 可看已取代的版本。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS, description: 'save=写入记忆 / search=检索记忆（默认）' },
    content: { type: 'string', description: 'action=save 必填：记忆正文' },
    key: { type: 'string', description: 'action=save：稳定槽位名，如 package_manager；同槽位的新内容会取代旧内容' },
    memoryKind: { type: 'string', enum: ['note', 'preference', 'fact', 'decision'], description: 'action=save：记忆类型，默认 note' },
    value: { type: 'string', description: 'action=save：结构化当前值；偏好/配置建议填写，如 Python、pnpm' },
    validFrom: { type: 'string', description: 'action=save：用户明确给出生效时间时填写；否则留空' },
    tags: { type: 'array', items: { type: 'string' }, description: 'action=save：标签' },
    scope: { type: 'string', enum: ['project', 'user', 'all'], description: 'action=save：project（默认）/user（跨项目）；action=search：project/user/all' },
    query: { type: 'string', description: 'action=search 必填：检索词' },
    max: { type: 'integer', description: 'action=search：最多返回条数，默认 10' },
    includeHistory: { type: 'boolean', description: 'action=search：是否包含已取代的历史版本' },
  },
  required: [],
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'memory',
      version: '1',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      // 族级按**最保守**声明：写入是主要风险面，读取由 byKind 显式放宽
      readOnly: false,
      idempotent: false,
      mutatesWorkspace: true,
      // 族级不设门（save 的确认在工具体内做完，见 byKind 注释）
      requiresConfirmation: false,
      requiredCapability: 'workspace.write',
      timeoutMs: 30000,
      cachePolicy: { mode: 'none' },
      concurrencyPolicy: { parallelSafe: false },
      /** 判别字段是 action（`kind` 留给记忆类型 note/preference/fact/decision） */
      kindField: 'action',
      defaultKind: 'search',
      /** 异构族：写入与检索的安全语义在这里分开声明，执行时按 action 解出 */
      byKind: {
        /**
         * save 的确认**由工具体自己做**（`context.confirm` 里带着「将取代的旧值」等细节，
         * 比注册表门能给的文案更具体）。合并前 `remember` 就是这样做的（legacy register，
         * 没有注册表门）；这里如果也声明 WRITE，就会「门问一遍、进函数再问一遍」。
         */
        save: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'workspace.write', requiresConfirmation: false, effect: 'write' },
        search: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', requiresConfirmation: false, cachePolicy: 'none', effect: 'read', idempotent: true },
      },
    },
    async (context, args) => {
      const action = resolveAction(args);
      if (action === 'save') return runSave(context, args);
      if (action === 'search') return runSearch(context, args);
      return AgentToolResult.error('未知 action: ' + action + '（可选 ' + ACTIONS.join('/') + '）', { code: 'ARG_SEMANTIC', tool: 'memory', action });
    },
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['memory']);
}

/** action=save（原 remember 实现，逐字保留行为） */
async function runSave(context, args) {
  const content = String(args.content || '').trim();
  if (!content) return AgentToolResult.error('action=save 需要 content');
  const scope = String(args.scope || 'project') === 'user' ? 'user' : 'project';
  const key = String(args.key || '').trim();
  const data = scope === 'user' ? userMemory.readUserMemory() : memory.readMemory(context.projectRoot());
  if (!data.ok) return AgentToolResult.error(data.error, { code: data.code, scope, file: data.file });
  const inferred = inferMemoryKind(data.entries, key, scope, args.memoryKind || args.kind);
  if (!inferred.ok) return AgentToolResult.error(inferred.error, { code: inferred.code, scope });
  const kind = inferred.kind;
  const prior = key ? memory.currentSlot(data.entries, { key, kind }, scope) : null;
  const previous = prior ? '将同槽位旧记忆「' + String(prior.content || '').slice(0, 160) + '」取代为：\n' : '';
  const valueDetail = args.value ? '结构化值：' + String(args.value).slice(0, 80) + '\n' : '';
  const ok = await context.confirm(ConfirmationLevel.WRITE,
    scope === 'user' ? '保存一条用户级（跨项目）长期记忆' : '保存一条项目长期记忆',
    (previous + valueDetail + content).slice(0, 400));
  if (!ok) return AgentToolResult.error('已取消保存记忆');
  const input = {
    key, kind, value: args.value, content, validFrom: args.validFrom,
    confirmedAt: new Date().toISOString(), tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
    source: 'remember_tool',
    sourceRef: (context.exec && context.exec.runId) || (typeof context.runId === 'function' ? context.runId() : context.runId) || '',
    sourceMessageId: (context.exec && context.exec.sourceMessageId) ||
      (typeof context.sourceMessageId === 'function' ? context.sourceMessageId() : context.sourceMessageId) || '',
  };
  const options = key ? { expectedRecordId: prior && prior.id || '' } : {};
  if (scope === 'user') {
    const added = userMemory.addUserMemory(input, options);
    if (!added.ok) return AgentToolResult.error('保存用户级记忆失败：' + (added.error || ''), { code: added.code, scope: 'user', file: added.file });
    context.audit('memory.save(user) ' + added.id + (added.duplicate ? ' duplicate' : '') +
      (added.replacedIds.length ? ' superseded=' + added.replacedIds.join(',') : ''));
    const evictionNote = added.evicted ? '\n用户级记忆超出上限，已淘汰最旧 ' + added.evicted + ' 条。' : '';
    return AgentToolResult.ok((added.duplicate ? '已有同样的用户级记忆：' : added.replacedIds.length ? '已更新用户级记忆：' : '已保存用户级记忆：') + content.slice(0, 120) + evictionNote,
      { id: added.id, scope: 'user', duplicate: !!added.duplicate, version: added.version,
        replacedIds: added.replacedIds, total: added.entries, evicted: added.evicted, evictedIds: added.evictedIds });
  }
  const added = memory.addProjectMemory(context.projectRoot(), input, options);
  if (!added.ok) return AgentToolResult.error('保存项目记忆失败：' + added.error, { code: added.code, scope: 'project', file: added.file });
  context.audit('memory.save ' + added.id + (added.duplicate ? ' duplicate' : '') + (added.replacedIds.length ? ' superseded=' + added.replacedIds.join(',') : ''));
  return AgentToolResult.ok((added.duplicate ? '已有同样的项目记忆：' : added.replacedIds.length ? '已更新项目记忆：' : '已保存长期记忆：') + content.slice(0, 120),
    { id: added.id, scope: 'project', duplicate: !!added.duplicate, version: added.version,
      replacedIds: added.replacedIds, total: added.total, evicted: added.evicted, evictedIds: added.evictedIds });
}

/** action=search（原 recall 实现，逐字保留行为） */
async function runSearch(context, args) {
  const query = String(args.query || '').trim();
  if (!query) return AgentToolResult.error('action=search 需要 query');
  const scope = ['user', 'all'].includes(String(args.scope || '')) ? String(args.scope) : 'project';
  const limit = Number(args.max) || 10;
  const includeHistory = args.includeHistory === true;
  if (scope === 'user' || scope === 'all') {
    const userData = userMemory.readUserMemory();
    if (!userData.ok) return AgentToolResult.error(userData.error, { code: userData.code, scope: 'user', file: userData.file });
    if (scope === 'user') {
      const pickedUser = memory.selectRelevant(userData.entries, query, { limit, scope: 'user', includeHistory });
      const lines = pickedUser.entries.map(renderEntry);
      if (!lines.length) return AgentToolResult.ok('没有匹配的用户级记忆', { entries: [], matched: false, scope });
      const fallbackNote = pickedUser.matched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
      return AgentToolResult.ok('【用户级（跨项目）记忆】\n' + fallbackNote + lines.join('\n'),
        { entries: pickedUser.entries, matched: pickedUser.matched, scope });
    }
    const dataAll = memory.readMemory(context.projectRoot());
    if (!dataAll.ok) return AgentToolResult.error(dataAll.error, { code: dataAll.code, scope: 'project', file: dataAll.file });
    const projectActive = memory.resolveMemory(dataAll.entries, { scope: 'project' }).entries;
    const excludedSlots = includeHistory ? [] : projectActive.map(memory.memorySlot).filter(Boolean);
    const pickedUser = memory.selectRelevant(userData.entries, query, { limit, scope: 'user', includeHistory, excludedSlots });
    const pickedProject = memory.selectRelevant(dataAll.entries, query, { limit, scope: 'project', includeHistory });
    const anyMatched = pickedProject.matched || pickedUser.matched;
    const shownProject = anyMatched && !pickedProject.matched ? [] : pickedProject.entries;
    const shownUser = anyMatched && !pickedUser.matched ? [] : pickedUser.entries;
    const lines = shownUser.map(renderEntry);
    const projectLines = shownProject.map(renderEntry);
    if (!lines.length && !projectLines.length) return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, scope });
    const fallbackNote = anyMatched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
    return AgentToolResult.ok(
      fallbackNote + '【项目记忆】\n' + (projectLines.join('\n') || '（无）') + '\n【用户级（跨项目）记忆】\n' + (lines.join('\n') || '（无）'),
      { entries: [...shownProject, ...shownUser], matched: anyMatched, scope },
    );
  }
  const data = memory.readMemory(context.projectRoot());
  if (!data.ok) return AgentToolResult.error(data.error, { code: data.code, scope: 'project', file: data.file });
  // 第 5 项：与 system prompt 的记忆注入共用同一套打分口径（memory.selectRelevant），
  // 避免「工具按关键词、注入按时间」两套语义给出不一样的结果。
  const picked = memory.selectRelevant(data.entries, query, { limit, scope: 'project', includeHistory });
  if (!picked.entries.length) {
    return AgentToolResult.ok('没有匹配的长期记忆', { entries: [], matched: false, terms: picked.terms });
  }
  // 一个词都没命中时，退回「最近保存的记忆」必须**显式说明**，否则模型会把它当成检索结果用
  const head = picked.matched ? '' : '没有关键词匹配；以下是最近保存的记忆（未按查询检索）：\n';
  return AgentToolResult.ok(
    head + picked.entries.map(renderEntry).join('\n'),
    { entries: picked.entries, matched: picked.matched, terms: picked.terms },
  );
}

module.exports = { register, resolveAction, ACTIONS };
