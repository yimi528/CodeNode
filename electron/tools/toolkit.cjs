/**
 * AgentToolkit：装配默认工具注册表 + 按配置过滤（复刻原版 AgentToolkit）。
 *
 * 配置支持（agent.properties）：
 *   tools.allowed   = read_file,write_file,...   （白名单，空=全部允许）
 *   tools.deny      = execute_shell               （黑名单）
 *   tools.enabled   = true/false                  （总开关，默认 true）
 */
'use strict';

const { AgentToolRegistry } = require('./registry.cjs');
const { registerProjectExtensions } = require('./extensions.cjs');
// 角色契约（白名单 / 是否只读 / 授予的能力 / 角色提示）的唯一来源 —— 见 tools/roles.cjs。
// 本文件只做「按角色裁剪注册表」这件事，不再自己维护一份角色语义。
const roles = require('./roles.cjs');
// 工具面分层（阶段 A / P0-1）：profile 名单与「按任务裁剪」的确定性判定
const profiles = require('./profiles.cjs');

/** @type {Record<string, readonly string[]>} 兼容旧导入：角色 → 工具白名单（从 roles.cjs 派生） */
const ROLE_TOOLS = Object.freeze(
  Object.fromEntries(roles.ROLE_NAMES.map((name) => [name, roles.roleTools(name) || []])),
);

/**
 * 内置工具（工具面收敛后的清单，顺序即下发顺序）。
 *
 * 合并关系见 docs/tool-consolidation.zh-CN.md：
 *   L1 吸收：bulk_edit / write_analysis_md / save_project → workbench_edit（kind=…）
 *            query_scalars → retrieve_context（mode=scalar / keys / prefix）
 *            ui_control → get_workbench_model（view=…）+ workbench_edit（create）
 *   L2 同构族：find_definition/references/callers/callees → symbol_nav
 *              find_files/list_directory → list_files
 *              project_info/analyze_project/code_review → project_overview
 *              remember/recall → memory
 *              fetch_url/web_search/dify_call → web
 *   旧名以**别名**保留（registerLegacyAliases），调用侧零改动、不占上下文。
 */
const BUILTINS = [
  require('./impl/getWorkbenchModelTool.cjs'),
  require('./impl/workbenchEditTool.cjs'),
  require('./impl/scanProjectTool.cjs'),
  require('./impl/readFileTool.cjs'),
  require('./impl/writeFileTool.cjs'),
  require('./impl/editFileTool.cjs'),
  require('./impl/listFilesTool.cjs'),
  require('./impl/searchFilesTool.cjs'),
  require('./impl/symbolNavigationTool.cjs'),
  require('./impl/executeShellTool.cjs'),
  require('./impl/projectOverviewTool.cjs'),
  require('./impl/askUserTool.cjs'),
  require('./impl/webTool.cjs'),
  require('./impl/retrieveContextTool.cjs'),
  require('./impl/memoryTool.cjs'),
  // 任务清单（对照 Codex 的 update_plan）：模型自己写下「分几步、现在在哪一步」。
  // 它不是工作区写操作（mutatesWorkspace=false），但也不是只读缓存项 —— 见 impl/updatePlanTool.cjs。
  require('./impl/updatePlanTool.cjs'),
  // Skill 正文按需读取（渐进披露）：system prompt 只放索引，正文由模型自己调这个工具取
  require('./impl/readSkillTool.cjs'),
  // 看图（对照 Codex 的 view_image）：把项目内的图片附到对话里，让模型真的看到画面
  require('./impl/viewImageTool.cjs'),
  // 工作树隔离（对照 Codex/Claude Code）：create/list/remove，只在 .codenode/worktrees/ 下动手
  require('./impl/worktreeTool.cjs'),
];
// 注意：`discover_tools`（工具面分层的取回入口）**故意不在这里** —— 它只在真的裁剪了工具面时才注册
// （见 registerDiscoverTool）。理由：`agent.tool_profile=off` 时请求体必须与没有这个功能**逐字节一致**，
// 而进 BUILTINS 会让它无条件多出一个工具 schema（约 60 tokens/轮）。

/**
 * 旧工具名 →（族工具 + kind / 默认参数）。**别名不是工具**：不进 `listTools()`、不进 schema。
 *
 * 为什么必须有：`roles.cjs` 的角色白名单、`profiles.cjs` 的 PROFILE_TOOLS、几十个用例、
 * 以及模型历史消息里调过的旧名都还在用这些名字。别名让它们继续可用，而上下文只付新工具的 schema。
 */
const LEGACY_ALIASES = Object.freeze([
  // ---- L1：吸收进 workbench_edit ----
  // bulk_edit 用 action 承载四个后果不同的动作 → 按 action 决定 kind（安全语义也不同：都是 HIGH）
  {
    name: 'bulk_edit', family: 'workbench_edit', kind: 'bulk_create_nodes',
    kindFromArgs: {
      create_nodes: 'bulk_create_nodes',
      create_files: 'bulk_create_files',
      create_assets: 'bulk_create_assets',
      delete_nodes: 'bulk_delete_nodes',
    },
    note: '批量动作按原 action 分流到对应 kind',
  },
  { name: 'write_analysis_md', family: 'workbench_edit', kind: 'write_analysis' },
  { name: 'save_project', family: 'workbench_edit', kind: 'save_project' },
  // ---- L1：吸收进 retrieve_context ----
  { name: 'query_scalars', family: 'retrieve_context', kind: '', defaults: { mode: 'scalar' } },
  // ---- L1：吸收进 get_workbench_model（视口动作）----
  // ui_control 的 action 就是 view 的取值：把 action 搬进 view
  { name: 'ui_control', family: 'get_workbench_model', kind: '', actionToView: true },
  // ---- L2：同构族 ----
  { name: 'find_definition', family: 'symbol_nav', kind: 'definition' },
  { name: 'find_references', family: 'symbol_nav', kind: 'references' },
  { name: 'get_callers', family: 'symbol_nav', kind: 'callers' },
  { name: 'get_callees', family: 'symbol_nav', kind: 'callees' },
  { name: 'find_files', family: 'list_files', kind: 'glob' },
  { name: 'list_directory', family: 'list_files', kind: 'dir' },
  { name: 'project_info', family: 'project_overview', kind: 'info' },
  { name: 'analyze_project', family: 'project_overview', kind: 'structure' },
  { name: 'code_review', family: 'project_overview', kind: 'review' },
  { name: 'remember', family: 'memory', kind: '', defaults: { action: 'save' } },
  { name: 'recall', family: 'memory', kind: '', defaults: { action: 'search' } },
  { name: 'fetch_url', family: 'web', kind: 'fetch' },
  { name: 'web_search', family: 'web', kind: 'search' },
  { name: 'dify_call', family: 'web', kind: 'dify' },
]);

/** 把旧名别名装进注册表（buildDefaultRegistry 末尾调用，所有入口共用） */
function registerLegacyAliases(registry) {
  for (const alias of LEGACY_ALIASES) {
    registry.registerAlias(alias.name, {
      family: alias.family,
      kind: alias.kind || '',
      defaults: alias.defaults || null,
      kindFromArgs: alias.kindFromArgs || null,
      actionToView: alias.actionToView === true,
      note: alias.note || '',
    });
  }
  return registry;
}

function buildDefaultRegistry() {
  const registry = new AgentToolRegistry();
  for (const mod of BUILTINS) {
    mod.register(registry);
  }
  // 旧名别名（工具面收敛）：不进 schema，只在 execute 时翻译成「族 + kind」
  registerLegacyAliases(registry);
  return declareSemantics(registry);
}

/**
 * 把每个工具的语义**显式**写进契约（S3「24 个工具逐个迁移」的收口）。
 *
 * descriptor.cjs 的名单是唯一来源，legacy 合成契约的字段值同样来自它 —— 这里只是把结果
 * 固化成 `explicit: true` 的声明（source 从 'legacy' 变 'explicit'，字段值逐字不变）。
 * 特别注意 `requiresConfirmation` **原样传递**：补声明不能顺手给写工具加一道审批，
 * 行为变化只允许来自显式配置（tools.confirm_writes）。
 */
function declareSemantics(registry) {
  for (const descriptor of registry.listDescriptors()) {
    registry.declareContract(descriptor.name, {
      readOnly: descriptor.readOnly,
      idempotent: descriptor.idempotent,
      mutatesWorkspace: descriptor.mutatesWorkspace,
      requiresConfirmation: descriptor.requiresConfirmation,
      requiredCapability: descriptor.requiredCapability,
      timeoutMs: descriptor.timeoutMs,
      cachePolicy: descriptor.cachePolicy,
      concurrencyPolicy: descriptor.concurrencyPolicy,
      // 族工具的 kind 级安全语义必须一起带过去：漏掉它 = 合并后所有 kind 退回族级判定
      // （memory 的 search 会被当成写、get_workbench_model 的 full 会被当成非只读）。
      byKind: descriptor.byKind,
      kindField: descriptor.kindField,
    });
  }
  return registry;
}

/**
 * 注册 `discover_tools`（工具面分层 / P0-1 的取回入口）。**只在裁剪真的生效时调用** ——
 * 未裁剪时它没有可发现的工具，多注册一个 schema 纯属白付固定开销。
 * 必须在 `filterByConfig` **之前**调用：用户的 `tools.allowed/deny` 是显式白/黑名单，照旧说了算。
 */
function registerDiscoverTool(registry) {
  require('./impl/discoverToolsTool.cjs').register(registry);
  return registry;
}

/** 按配置过滤工具（tools.enabled / tools.allowed / tools.deny）。 */
function filterByConfig(registry, config) {
  const cfg = config || {};
  if (cfg.toolsEnabled === false) {
    for (const spec of registry.listTools()) registry.unregister(spec.name);
    return registry;
  }
  const allowed = cfg.toolsAllowed || null; // null 或空 = 全部允许
  const deny = cfg.toolsDeny || [];
  /**
   * 白/黑名单里可能写着**旧工具名**（用户 `.codenode/agent.properties` 的 `tools.allowed`
   * 是显式配置，合并前写的 `find_files` 不该突然失效）。别名不是注册工具，
   * 直接比对会把这些名字当「不存在的工具」丢掉 → 这里先把名单沿别名展开成族名。
   */
  const expandAliases = (list) => {
    const out = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const name = String(raw || '').trim();
      if (!name) continue;
      out.add(name);
      const alias = registry.aliases && registry.aliases.get(name);
      if (alias) out.add(alias.family);
    }
    return out;
  };
  const allowedSet = allowed && allowed.length > 0 ? expandAliases(allowed) : null;
  const denySet = expandAliases(deny);
  for (const spec of registry.listTools()) {
    /**
     * `retrieve_context` 现在是**检索 + 标量库**唯一的入口（收编了 query_scalars）。
     * 所以 `ragEnabled=false` 只裁掉文件检索能力，工具本身必须留着 —— 否则画布节点的精确属性
     * （prompt/goal/members）就没人能读了。关闭体现在 `mode=file/vector` 分支上（那两条需要索引）。
     *
     * 注意这里**只**声明「RAG 关了」，不 `continue` 跳过下面的名单过滤：`tools.allowed`
     * 是显式白名单（用户配置 / 用例 / 角色契约都可能给），跳过它等于让白名单静默多出一个工具。
     * 2026-11-18：正是这个 `continue` 让 `toolsAllowed:['read_file']` 也拿到了
     * `retrieve_context`（工具面 +800 字符），把「压缩后仍然超窗」的用例顶成假红。
     */
    if (spec.name === 'retrieve_context' && cfg.ragEnabled === false) {
      registry.declareContract('retrieve_context', { ragDisabled: true });
    }
    /**
     * 联网：`web` 是**族**（fetch/search/dify）。fetch 是不依赖任何后端的公网抓取，按原来的口径它
     * 一直可用；search/dify 在开关关闭时由 kind 分支返回明确失败。所以族本身保持注册
     * （`tools.deny` / `tools.allowed` 仍按族名生效，旧名会被别名展开）。
     */
    if (denySet.has(spec.name)) {
      registry.unregister(spec.name);
      continue;
    }
    if (allowedSet && !allowedSet.has(spec.name)) {
      registry.unregister(spec.name);
    }
  }
  return registry;
}

function buildDefaultRegistryWithConfig(config) {
  const cfg = config || {};
  const registry = buildDefaultRegistry();
  // S7：确认策略三态随配置下发（true = 声明了 requiresConfirmation 的工具全部强制审批；
  // false = 全部关闭；未配置 = 沿用各工具 descriptor 自带的判定，兼容既有行为）
  if (cfg.toolsConfirmWrites !== undefined) {
    registry.confirmWrites = cfg.toolsConfirmWrites === true ? true : cfg.toolsConfirmWrites === false ? false : undefined;
  }
  // 跨 Agent 资源租约（P3）：**同一个 run 内的所有注册表（主代理 + 每个子代理）必须共享同一个实例**，
  // 否则各建一份 = 谁也没锁住谁。实例由 ipc 按 run 创建后传进来。
  if (cfg.leases) registry.leases = cfg.leases;
  if (cfg.projectRoot) registerProjectExtensions(registry, cfg.projectRoot);
  if (cfg.role) filterByRole(registry, cfg.role);
  // CLI 等独立入口也可在配置过滤前注册取回入口，再应用与桌面相同的工具分层。
  if (cfg.discoverTools === true) registerDiscoverTool(registry);
  return filterByConfig(registry, cfg);
}

/**
 * 按角色裁剪注册表：白名单与能力集都来自 tools/roles.cjs（唯一来源）。
 * `registry.roleCapabilities` 是注册表只读门的判据 —— 角色契约里显式授予的能力，
 * 允许越过「只读上下文不得执行写工具」这道门（verifier 的 execute_shell 就是这种情况）。
 */
function filterByRole(registry, role) {
  if (!role || role === 'supervisor') {
    registry.allowedTools = null;
    registry.roleCapabilities = null;
    return registry;
  }
  const allowed = ROLE_TOOLS[role];
  if (!allowed) {
    for (const spec of registry.listTools()) registry.unregister(spec.name);
    registry.allowedTools = new Set();
    registry.roleCapabilities = new Set();
    return registry;
  }
  const allowedSet = new Set(allowed);
  for (const spec of registry.listTools()) {
    if (!allowedSet.has(spec.name)) registry.unregister(spec.name);
  }
  registry.allowedTools = allowedSet;
  registry.roleCapabilities = new Set(roles.roleCapabilities(role));
  return registry;
}

module.exports = {
  buildDefaultRegistry,
  filterByConfig,
  filterByRole,
  buildDefaultRegistryWithConfig,
  declareSemantics,
  BUILTINS,
  ROLE_TOOLS,
  registerDiscoverTool,
  /** 工具面分层（阶段 A / P0-1）：profile 名单与确定性路由都在 tools/profiles.cjs（唯一来源） */
  profiles,
};
