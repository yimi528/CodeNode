/**
 * descriptor.cjs —— 工具契约（ToolDescriptor）与旧实现的适配层
 *
 * 审查第 3 项：工具此前只有 `{name, description, inputSchema}`，能力/风险语义全靠散落的硬编码名单——
 * 缓存保活一份（`agent.cjs` 的 CACHEABLE_TOOLS）、画布结果免附加一份（SCALAR_BACKED_TOOLS）、
 * 变成类一份（MUTATION_TOOLS）、副作用分类一份（`sideEffects.cjs`）、角色白名单一份（`toolkit.cjs`）。
 * 同一个工具的「只读吗」在不同文件里各自维护，改一处漏一处。
 *
 * 本模块把这些语义收敛成**一份** descriptor，并让注册表能按声明执行：
 *   - `normalizeDescriptor()` 把任意输入补全成完整契约（缺省一律保守：未声明只读 = 可写）；
 *   - `descriptorForLegacy(name, description)` 为还没迁移的工具合成契约（从下面的名单反推）；
 *   - 名单（READ_ONLY/CACHEABLE/MUTATION/SCALAR_BACKED/CAPABILITY/LONG_RUNNING）是**唯一来源**，
 *     `agent.cjs`、`sideEffects.cjs` 从本模块取，不再各留一份。
 *
 * 契约字段（审查要求的 15 项）：
 *   name / version / description / inputSchema / outputSchema /
 *   readOnly / idempotent / mutatesWorkspace / requiresConfirmation / requiredCapability /
 *   timeoutMs / cachePolicy / retryPolicy / concurrencyPolicy / roleAllowlist
 */
'use strict';

const { normalizeOutputSchema } = require('./outputSchema.cjs');

/** 只读工具：可安全重复执行、结果可缓存、可在只读上下文里执行 */
const READ_ONLY_TOOLS = new Set([
  'scan_project', 'project_overview', 'read_file',
  'list_files', 'search_files', 'symbol_nav', 'ask_user',
  'retrieve_context', 'read_skill', 'view_image',
  // 语义上只读，但**故意不进缓存白名单**：画布/标量是权威读源，变更后必须立刻读到最新状态
  'poll_job', 'get_subagent_task',
  'inspect_subagent_retry',
  // 取消子任务（第 6 项）：只 abort 一个子代理，不改工作区；与 get_subagent_task 同类
  'cancel_subagent_task',
  // 下面这批判只影响**旧接口合成契约**（`register()` 用），真实族工具的语义由 byKind 决定：
  // 保留它们是为了「旧名注册的工具仍拿到合并前的契约」，别据此推断族工具的语义。
  'get_workbench_model', 'recall', 'query_scalars', 'find_definition', 'find_references',
  'get_callers', 'get_callees', 'list_directory', 'find_files', 'project_info', 'analyze_project', 'code_review',
]);
/**
 * 族工具（一个名字承载多个 kind）**没有**单一 readOnly 语义：真实判定在各自的 `byKind`。
 * 这个名单只是把「哪些名字是族」显式记下来，供审计/用例核对「族工具不该出现在按名定性的清单里」。
 * 注意与 READ_ONLY_TOOLS 尾部的历史条目并存：那里的条目只服务旧接口合成契约。
 */
const FAMILY_TOOLS = new Set(['memory', 'web', 'get_workbench_model', 'workbench_edit',
  'symbol_nav', 'list_files', 'project_overview',
  'delegate', 'subagent_read', 'subagent_control']);
/**
 * `retrieve_context` **不在此列**：它虽然用 `mode` 承载多种检索来源，但**安全语义只有一种**
 * （只读 / workspace.read / 免审批），不像 memory 那样读写混在一个名字里。
 * 把它算作族工具会逼着它声明 byKind，而它根本不需要 kind 级安全门。
 */

/**
 * 只读结果缓存白名单（缓存保活 = 只有这些工具执行后缓存继续有效，其余一律清空）。
 * 注意：这是在「谁能读」里再挑一层「结果不会因为别的东西变化而失效」的工具，
 * 所以 get_workbench_model / poll_job / recall 不在其中。
 */
/**
 * 结果可在同一个 run 内复用的只读工具（缓存白名单）。
 *
 * `ask_user` **故意不在里面**：它是交互输入，不是幂等读。此前它在白名单里，导致同一个 run 内
 * 同样的问题问第二次时**直接复用旧答案**（用户根本看不到第二次提问），而「再问一次」往往正是
 * 情况变了之后该做的事。它是唯一被排除的交互型工具，其余只读工具照旧缓存。
 */
const CACHEABLE_TOOLS = new Set([
  'scan_project', 'project_overview', 'read_file',
  'list_files', 'search_files',
  // 技能正文也是「同一 run 内不会变」的只读内容 → 同参重复读走缓存（不刷新别的缓存）
  'read_skill',
  'view_image',
]);

/** 会改变画布模型 / 文件 / 工程状态的工具（语义清单，供文档与并行冲突判定引用） */
const MUTATION_TOOLS = new Set([
  'workbench_edit', 'write_file', 'edit_file',
  'memory',
  'delegate_task', 'delegate_tasks', 'review_subagent_result',
  'retry_subagent_task',
]);

/**
 * 「条件写入者」：默认只读（结果可缓存），但带某个可选参数时会改工作台。
 * 它们的 mutatesWorkspace 必须为 true —— 只读上下文里若无角色白名单授予就该被拦下。
 */
const CONDITIONAL_MUTATORS = new Set(['scan_project']);

/** 结果里的 [data] 不再附加进上下文（数据已落到本地标量库，避免把画布大字段发到云端） */
const SCALAR_BACKED_TOOLS = new Set([
  'get_workbench_model', 'workbench_edit',
]);

/**
 * 同参数重复执行效果相同的写工具（可安全重试）：
 * 按内容写入/整体保存是幂等的；而 workbench_edit（新建节点拿新 id）、memory（追加记忆）不是。
 */
const IDEMPOTENT_WRITES = new Set(['write_file', 'edit_file']);

/** 能力声明（S3 只用于「网络被策略切断时拒绝」，完整能力裁决在 S7） */
const CAPABILITY_BY_TOOL = Object.freeze({
  read_file: 'workspace.read',
  list_files: 'workspace.read',
  search_files: 'workspace.read',
  symbol_nav: 'workspace.read',
  project_overview: 'workspace.read',
  get_workbench_model: 'workspace.read',
  retrieve_context: 'workspace.read',
  read_skill: 'workspace.read',
  view_image: 'workspace.read',
  // scan_project 默认只读，但带 applyToWorkbench 参数时会写画布 → 能力上按写处理（fail-closed）
  scan_project: 'workspace.write',
  get_subagent_task: 'workspace.read',
  cancel_subagent_task: 'subagent.delegate',
  poll_job: 'shell.execute',
  write_file: 'workspace.write',
  edit_file: 'workspace.write',
  workbench_edit: 'workspace.write',
  /**
   * 族工具的能力**不是常量**：memory 的 search 要 workspace.read、save 要 workspace.write；
   * web 的三种都是 network.request；get_workbench_model 读画布是 read、视口动作是 ui.interact。
   * 这里给的是**族级最保守值**（供没有 byKind 的降级路径用），真实裁决在 effectiveDescriptor。
   */
  memory: 'workspace.write',
  web: 'network.request',
  execute_shell: 'shell.execute',
  worktree: 'workspace.write',
  ask_user: 'ui.interact',
  delegate_task: 'subagent.delegate',
  delegate_tasks: 'subagent.delegate',
  inspect_subagent_retry: 'subagent.inspect',
  retry_subagent_task: 'subagent.delegate',
  review_subagent_result: 'subagent.delegate',
  // ---- 以下只服务**旧接口合成契约**（register() 按名单反推）：合并前的名字必须仍映射到
  //      原来的能力，否则旧名注册的工具会拿到错误的能力门（例如 fetch_url 丢了 network.request）。
  fetch_url: 'network.request',
  web_search: 'network.request',
  dify_call: 'network.request',
  save_project: 'project.save',
  ui_control: 'ui.interact',
  remember: 'workspace.write',
  recall: 'workspace.read',
  bulk_edit: 'workspace.write',
  write_analysis_md: 'workspace.write',
});

/** 自管超时的工具（内部已有秒级超时 / 合法长任务）：timeoutMs = 0 表示注册表不加超时 */
const SELF_TIMED_TOOLS = Object.freeze({
  execute_shell: 0,
  poll_job: 0,
  delegate_task: 0,
  delegate_tasks: 0,
  retry_subagent_task: 0,
  retrieve_context: 0,
  scan_project: 0,
  project_overview: 0,
  list_files: 0,
  symbol_nav: 0,
  web: 0,
  workbench_edit: 0,
});

/** 注册表兜底超时（毫秒）；工具显式声明的 timeoutMs 优先，0 = 不加限制 */
const DEFAULT_TIMEOUT_MS = 120000;

const CAPABILITIES = Object.freeze([
  'workspace.read', 'workspace.write', 'project.save',
  'shell.execute', 'network.request', 'ui.interact', 'subagent.delegate',
]);

const CONFIRMATION_LEVELS = Object.freeze(['LOW', 'WRITE', 'HIGH']);

/**
 * 族工具（instrumental consolidation）的 `kind` 级契约。
 *
 * 为什么需要：合并把「一个工具名 = 一种安全语义」变成「一个工具名 = N 种」。
 * `remember`(写) 与 `recall`(读) 并成 `memory` 后，descriptor 只能有一个 `readOnly` ——
 * 只读角色会因此拿到写能力（或反之丢失写权限）。所以安全语义必须下沉到 `kind`：
 *   `execute()` 在拿到 args 之后用 `byKind[args.kind]` 覆盖 descriptor 的判定字段。
 *
 * 纪律（fail-closed）：
 *   1. 声明了 `byKind` 的族，**未登记的 kind 一律按最保守取值**（读类族按「会写」处理、
 *      需要能力的族按「需要写」处理、要求审批的族按「HIGH」处理）；
 *   2. 只有显式登记为只读的 kind 才算只读 —— 不做「默认沿用族级 readOnly」的推断；
 *   3. `byKind` 只覆盖**判定字段**（readOnly/mutatesWorkspace/requiredCapability/
 *      requiresConfirmation/cachePolicy/sideEffects），不覆盖 inputSchema（schema 必须保持
 *      一份，否则等于没合并）。
 */

/** 缓存策略归一：接受 `'run'` 或 `{mode:'run'}`；未声明时只读默认 run、写默认 none */
function cachesMode(value, readOnly) {
  const raw = typeof value === 'string' ? value : (value && value.mode);
  if (['none', 'run', 'ttl'].includes(raw)) return raw;
  return readOnly ? 'run' : 'none';
}

/** 单个 kind 的契约形状（未给的字段继承族级 descriptor） */
function normalizeKindContract(kind, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  return Object.freeze({
    readOnly: p.readOnly === true,
    // 只读 kind 默认不改工作区；写 kind 默认改
    mutatesWorkspace: p.mutatesWorkspace === undefined ? p.readOnly !== true : p.mutatesWorkspace === true,
    requiredCapability: CAPABILITIES.includes(p.requiredCapability) ? p.requiredCapability : 'workspace.write',
    requiresConfirmation: CONFIRMATION_LEVELS.includes(p.requiresConfirmation)
      ? p.requiresConfirmation
      : p.requiresConfirmation === true ? 'WRITE' : false,
    // cachePolicy 既接受 `'run'` 这种字符串，也接受 `{mode:'run'}` —— 两种写法都别静默忽略
    cachePolicy: cachesMode(p.cachePolicy, p.readOnly === true),
    /** 副作用类别（sideEffects.cjs 的分类口径）：read / write / unknown */
    effect: ['read', 'write', 'unknown'].includes(p.effect) ? p.effect : (p.readOnly === true ? 'read' : 'unknown'),
    /** 该 kind 的副作用是否幂等（同参重复执行安全）。写 kind 默认 false（保守） */
    idempotent: p.idempotent === true,
  });
}

/**
 * 声明一个族工具的 kind 表。键 = kind 名；值 = 该 kind 的安全语义。
 * 返回值是冻结对象，适合直接塞进 descriptor.byKind。
 * @param {Record<string, any>} table
 * @returns {Readonly<Record<string, any>>}
 */
function normalizeByKind(table) {
  if (!table || typeof table !== 'object') return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [kind, patch] of Object.entries(table)) {
    const name = String(kind || '').trim();
    if (!name) continue;
    out[name] = normalizeKindContract(name, patch);
  }
  return Object.freeze(out);
}

/**
 * 按 `kind` 解出**这次调用**真正的安全语义。
 *
 * @param {any} descriptor 族工具的 descriptor（可能没有 byKind）
 * @param {any} args 本次调用参数
 * @returns {any} 用于执行门判定的 descriptor 视图
 */
function effectiveDescriptor(descriptor, args) {
  const d = descriptor || {};
  const table = d.byKind;
  if (!table) return d;
  // 判别字段默认是 `kind`；个别族用别的字段名（get_workbench_model 用 view，
  // 因为它同时要保留「读画布」的语义），由 descriptor.kindField 指定。
  const field = String(d.kindField || 'kind');
  /**
   * 缺省 kind：族工具的**文档化默认动作**（如 memory 不带 action 就是检索）。
   * 没有它就等于「不带 kind 的合法调用被当成未登记 kind → fail-closed 要求审批」，
   * 与执行体的实际默认行为不一致（实测：memory{query} 被要求审批）。
   */
  const raw = String((args && args[field]) || d.defaultKind || '').trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(table, raw) ? table[raw] : null;
  if (known) {
    return {
      ...d,
      readOnly: known.readOnly,
      // 只读 kind 之所以不写，是因为它连时间戳/审计都不落 —— 与族级声明无关
      mutatesWorkspace: known.mutatesWorkspace,
      requiredCapability: known.requiredCapability,
      requiresConfirmation: known.requiresConfirmation,
      /**
       * **必须同步强制位**：注册表门 3 的判据是 `confirmationEnforced === true`，
       * 而它是由族级 `declareContract` 算出来的。kind 级声明如果要审批却不同步这一位，
       * 结果就是「声明了审批但从不真的问」—— 合并最危险的 fail-open
       * （实测：get_workbench_model(view=focus) 继承族级 false，视口动作直接跳过审批）。
       */
      confirmationEnforced: known.requiresConfirmation ? true : d.confirmationEnforced === true,
      cachePolicy: { ...(d.cachePolicy || {}), mode: known.cachePolicy },
      idempotent: known.idempotent ? true : d.idempotent,
      sideEffect: known.effect,
      kind: raw,
      kindRegistered: true,
    };
  }
  // fail-closed：未登记的 kind 按最保守取值，绝不放行只读/免审批路径
  return {
    ...d,
    readOnly: false,
    mutatesWorkspace: true,
    requiredCapability: 'workspace.write',
    requiresConfirmation: d.requiresConfirmation === 'HIGH' ? 'HIGH' : 'WRITE',
    confirmationEnforced: true,
    cachePolicy: { ...(d.cachePolicy || {}), mode: 'none' },
    idempotent: false,
    sideEffect: 'unknown',
    kind: raw,
    kindRegistered: false,
  };
}

function toPositiveInt(value) {
  // 注意：null / undefined / '' 必须返回 null（= 未声明），不能落到 Number(null)=0 ——
  // 0 在本契约里表示「显式不设超时」，混淆两者会让注册表兜底超时静默失效。
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * 把任意输入补全成完整契约。**缺省一律保守**：
 * 未声明 readOnly 就按可写处理（fail-closed），未声明 idempotent 就按「不可安全重试」处理。
 * @param {any} input
 * @returns {any} 完整 descriptor
 */
function normalizeDescriptor(input) {
  const d = input || {};
  const name = String(d.name || '').trim();
  if (!name) throw new Error('descriptor 缺少 name');
  const readOnly = d.readOnly === true;
  const timeout = d.timeoutMs === undefined ? null : toPositiveInt(d.timeoutMs);
  const requiresConfirmation = d.requiresConfirmation === true
    ? 'WRITE'
    : CONFIRMATION_LEVELS.includes(d.requiresConfirmation)
      ? d.requiresConfirmation
      : false;
  const capability = CAPABILITIES.includes(d.requiredCapability) ? d.requiredCapability : 'workspace.read';
  const cacheMode = d.cachePolicy && ['none', 'run', 'ttl'].includes(d.cachePolicy.mode) ? d.cachePolicy.mode : null;
  return {
    name,
    version: String(d.version || '1'),
    description: String(d.description || ''),
    inputSchema: d.inputSchema == null ? null : d.inputSchema,
    // Success/partial payload contract: validates AgentToolResult.data. null/'none'
    // preserve legacy tools; unsupported assertions fail before the tool can run.
    outputSchema: normalizeOutputSchema(d.outputSchema),
    readOnly,
    // 未声明时：只读工具视为幂等（重放安全），写工具视为不幂等
    idempotent: d.idempotent === undefined ? readOnly : d.idempotent === true,
    mutatesWorkspace: d.mutatesWorkspace === undefined ? !readOnly : d.mutatesWorkspace === true,
    requiresConfirmation,
    // 只有显式注册的 descriptor 才会被注册表强制询问；旧 register() 合成的契约不改变既有行为
    confirmationEnforced: d.confirmationEnforced === true || d.explicit === true ? requiresConfirmation !== false : false,
    requiredCapability: capability,
    // 0 = 不加超时；未声明用注册表兜底
    timeoutMs: timeout === null ? null : timeout,
    cachePolicy: {
      mode: cacheMode || (readOnly ? 'run' : 'none'),
      ttlMs: toPositiveInt(d.cachePolicy && d.cachePolicy.ttlMs),
    },
    retryPolicy: {
      maxAttempts: toPositiveInt(d.retryPolicy && d.retryPolicy.maxAttempts) || (readOnly ? 2 : 1),
      backoff: d.retryPolicy && d.retryPolicy.backoff === 'exponential' ? 'exponential' : 'none',
      retryOn: Array.isArray(d.retryPolicy && d.retryPolicy.retryOn) ? d.retryPolicy.retryOn.slice() : [],
    },
    concurrencyPolicy: {
      // 只读 + 可缓存 = 同轮并行安全；写工具默认串行（并行调度在 S6 落地）
      parallelSafe: d.concurrencyPolicy && d.concurrencyPolicy.parallelSafe !== undefined
        ? d.concurrencyPolicy.parallelSafe === true
        : readOnly && CACHEABLE_TOOLS.has(name),
      mutexKey: null,
    },
    // null = 由 ROLE_TOOLS 决定（toolkit.filterByRole 负责），显式给了就按显式来
    roleAllowlist: Array.isArray(d.roleAllowlist) ? d.roleAllowlist.slice() : null,
    /**
     * 族工具（合并后一个名字承载多个动作）的 `kind` 级安全语义；null = 普通单义工具。
     * 执行时由 `effectiveDescriptor(descriptor, args)` 解出这次调用真正的 readOnly/审批/能力。
     * @type {Readonly<Record<string, any>>|null}
     */
    byKind: normalizeByKind(d.byKind),
    /** 族工具的判别字段名（默认 'kind'；get_workbench_model 用 'view'，memory 用 'action'） */
    kindField: d.byKind && typeof d.kindField === 'string' && d.kindField.trim() ? d.kindField.trim() : (d.byKind ? 'kind' : null),
    /** 不传判别字段时的默认 kind（必须与执行体的默认分支一致） */
    defaultKind: d.byKind && typeof d.defaultKind === 'string' && d.defaultKind.trim() ? d.defaultKind.trim() : null,
    source: d.explicit === true ? 'explicit' : 'legacy',
  };
}

/**
 * 为尚未迁移的工具（走旧 register(name, desc, schema, executor)）合成契约。
 * @param {string} name
 * @param {string} description
 * @param {any} inputSchema
 */
function descriptorForLegacy(name, description, inputSchema) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  // 未登记的外部工具（项目扩展 / MCP）按最保守的能力处理：它会执行外部命令
  const capability = CAPABILITY_BY_TOOL[name] || (readOnly ? 'workspace.read' : 'shell.execute');
  const timeout = Object.prototype.hasOwnProperty.call(SELF_TIMED_TOOLS, name) ? SELF_TIMED_TOOLS[name] : null;
  return normalizeDescriptor({
    name,
    description,
    inputSchema,
    readOnly,
    idempotent: readOnly || IDEMPOTENT_WRITES.has(name),
    mutatesWorkspace: !readOnly || CONDITIONAL_MUTATORS.has(name),
    requiredCapability: capability,
    timeoutMs: timeout,
    // 旧 register() 不做注册表级确认（工具自己内部确认的照旧），避免行为突变
    requiresConfirmation: false,
    cachePolicy: { mode: CACHEABLE_TOOLS.has(name) ? 'run' : 'none' },
    concurrencyPolicy: { parallelSafe: readOnly && CACHEABLE_TOOLS.has(name) },
    explicit: false,
  });
}

/** 人类可读摘要（UI / 审计 / 文档共用） */
function describeDescriptor(descriptor) {
  const d = descriptor || {};
  return {
    name: d.name,
    version: d.version,
    readOnly: d.readOnly === true,
    idempotent: d.idempotent === true,
    mutatesWorkspace: d.mutatesWorkspace === true,
    requiresConfirmation: d.requiresConfirmation || false,
    requiredCapability: d.requiredCapability,
    timeoutMs: d.timeoutMs == null ? null : d.timeoutMs,
    cacheMode: (d.cachePolicy || {}).mode || 'none',
    parallelSafe: !!((d.concurrencyPolicy || {}).parallelSafe),
    source: d.source || 'legacy',
  };
}

module.exports = {
  READ_ONLY_TOOLS,
  FAMILY_TOOLS,
  CONDITIONAL_MUTATORS,
  CACHEABLE_TOOLS,
  MUTATION_TOOLS,
  SCALAR_BACKED_TOOLS,
  IDEMPOTENT_WRITES,
  CAPABILITY_BY_TOOL,
  SELF_TIMED_TOOLS,
  DEFAULT_TIMEOUT_MS,
  CAPABILITIES,
  CONFIRMATION_LEVELS,
  normalizeDescriptor,
  descriptorForLegacy,
  describeDescriptor,
  // 族工具（工具面收敛）：kind 级安全语义 —— 见 docs/tool-consolidation.zh-CN.md §5 规则 1
  normalizeByKind,
  effectiveDescriptor,
};
