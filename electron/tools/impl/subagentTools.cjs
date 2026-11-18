/**
 * subagentTools.cjs —— 子代理工具的**族化装配**（工具面收敛 L3，见 docs/tool-consolidation.zh-CN.md §3 L3）。
 *
 * 问题：`SubagentManager.register` 原来一次性注册 8 个工具（delegate_task / delegate_tasks /
 * get_subagent_task / cancel_subagent_task / inspect_subagent_retry / retry_subagent_task /
 * merge_subagent_results / review_subagent_result），全开装配下 schema 合计约 2,300 tokens。
 *
 * 做法（**不动任何执行体**）：
 *   1. 先把原来的 8 个注册原封不动跑进一个**舞台注册表**（staging）—— 执行体与 schema 都在那里；
 *   2. 在真实注册表上注册 3 个族工具，每个按 `kind` 分发到舞台里的执行体；
 *   3. 把 8 个旧名登记成**别名**（不进 schema），调用侧零改动。
 *
 * 安全语义：族工具的 `byKind` **直接取自舞台里每个旧工具的 descriptor**
 * （readOnly / mutatesWorkspace / requiredCapability / requiresConfirmation / cachePolicy），
 * 所以合并前后逐字一致，不存在「合并顺手放宽了权限」。唯一的刻意修正：
 * `merge_subagent_results` 原来把能力写成 `shell.execute`（明显是复制粘贴的脏数据，
 * 它既不跑命令也不碰 shell），这里改成 `workspace.write` —— 它会把候选结果合入共享状态。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

/** 族定义：族名 → { kind → 旧工具名 }。kind 的取值就是模型要填的那个枚举。 */
const FAMILIES = Object.freeze([
  {
    name: 'delegate',
    description:
      '派发子代理任务（受角色工具权限约束）。kind=single 派一个（role/objective 必填）；' +
      'kind=batch 派一批（tasks 数组，等价于一次调用提交多个任务）。\n' +
      '单文件读取或一步可完成的问题由主 Agent 直接处理；独立探查、实现、验证或审查等多步工作再委派。' +
      'stageNodeId 可绑定画布 stage 节点；timeoutSeconds 是任务总时长（秒）；' +
      'builder 改文件优先用 isolation=worktree（只隔离项目文件，canvas 角色不支持）。' +
      '结果以短候选卡回到父上下文，完整结论用 subagent_read(kind=get, detail="full") 按页读取。',
    kinds: { single: 'delegate_task', batch: 'delegate_tasks' },
  },
  {
    name: 'subagent_read',
    description:
      '读子代理产出（只核对，不改状态）。kind=get 取任务信封与结论（detail=summary/full，full 按页展开，' +
      '会重算产物哈希做接收侧核验）；kind=inspect_retry 只读核对上次尝试的文件、副作用与重做额度，' +
      '返回可重做性与补偿计划指纹；kind=merge 归并多个任务的候选结果（可给 decisions 裁决冲突）。',
    kinds: { get: 'get_subagent_task', inspect_retry: 'inspect_subagent_retry', merge: 'merge_subagent_results' },
  },
  {
    name: 'subagent_control',
    description:
      '改变子代理任务状态（会写共享状态，需谨慎）。kind=cancel 中止任务；' +
      'kind=retry 显式重做（保留 taskId，新建 Attempt；须先用 inspect_retry 拿 executionId 与 planDigest）；' +
      'kind=review 审查并确认/撤回候选结果（confirm 需 confirmedSummary 与核验 note，' +
      'confirm_and_merge 会合入隔离工作树；哈希不符不能确认）。',
    kinds: { cancel: 'cancel_subagent_task', retry: 'retry_subagent_task', review: 'review_subagent_result' },
  },
]);

/** 旧名 → { family, kind }：别名表（不进 schema，只做翻译） */
const LEGACY_NAMES = Object.freeze({
  delegate_task: { family: 'delegate', kind: 'single' },
  delegate_tasks: { family: 'delegate', kind: 'batch' },
  get_subagent_task: { family: 'subagent_read', kind: 'get' },
  inspect_subagent_retry: { family: 'subagent_read', kind: 'inspect_retry' },
  merge_subagent_results: { family: 'subagent_read', kind: 'merge' },
  cancel_subagent_task: { family: 'subagent_control', kind: 'cancel' },
  retry_subagent_task: { family: 'subagent_control', kind: 'retry' },
  review_subagent_result: { family: 'subagent_control', kind: 'review' },
});

/** 描述太长会把 schema 撑大：族的 inputSchema 只复用**属性表**，成员描述不重复下发。 */
function unionProperties(staging, memberNames) {
  const properties = {};
  for (const name of memberNames) {
    const spec = staging.listTools().find((item) => item.name === name);
    if (!spec) continue;
    for (const [key, value] of Object.entries((spec.inputSchema && spec.inputSchema.properties) || {})) {
      const prior = properties[key];
      if (!prior || String((value && value.description) || '').length > String((prior && prior.description) || '').length) {
        properties[key] = value;
      }
    }
  }
  return properties;
}

/** 从舞台里的旧 descriptor 抄出 kind 级安全语义（合并前后逐字一致） */
function kindContractFrom(staging, memberName, overrides) {
  const descriptor = staging.descriptorOf(memberName);
  if (!descriptor) return null;
  const contract = {
    readOnly: descriptor.readOnly === true,
    mutatesWorkspace: descriptor.mutatesWorkspace === true,
    requiredCapability: descriptor.requiredCapability,
    requiresConfirmation: descriptor.requiresConfirmation || false,
    cachePolicy: (descriptor.cachePolicy || {}).mode || 'none',
    idempotent: descriptor.idempotent === true,
  };
  return { ...contract, ...(overrides || {}) };
}

/**
 * 把 8 个旧工具收敛成 3 个族工具装进真实注册表。
 * @param {any} registry 真实注册表
 * @param {any} staging 舞台注册表（已装好 8 个旧工具）
 * @param {{roleGuide?: string}} [options] 派活对照表（角色 → 负责哪类工作），拼进 delegate 的描述
 */
function registerSubagentFamilies(registry, staging, options = {}) {
  const roleGuide = String((options && options.roleGuide) || '').trim();
  for (const family of FAMILIES) {
    const kindNames = Object.keys(family.kinds);
    const memberNames = Object.values(family.kinds);
    const byKind = {};
    for (const [kind, member] of Object.entries(family.kinds)) {
      // merge 的能力修正在这里（见文件头注释：原来是 shell.execute 的脏数据）
      const override = kind === 'merge' ? { requiredCapability: 'workspace.write' } : null;
      byKind[kind] = kindContractFrom(staging, member, override) || { readOnly: false, mutatesWorkspace: true, requiredCapability: 'workspace.write' };
    }
    // 族级取**最保守**：任一个 kind 会写，族级就算写（未登记 kind 的 fail-closed 兜底也走这里）
    const anyWrite = kindNames.some((kind) => byKind[kind].readOnly !== true || byKind[kind].mutatesWorkspace === true);
    const highestConfirm = kindNames.some((kind) => byKind[kind].requiresConfirmation === 'HIGH');
    // 派活对照表必须留在 delegate 的描述里：主代理据此判断「这类工作交给哪个角色」，
    // 它属于语义而不属于 schema —— 裁掉它 Agent 就会拿 explorer 去改代码。
    const description = family.name === 'delegate' && roleGuide
      ? family.description + '\n按工作类型选角色：\n' + roleGuide
      : family.description;
    registry.registerDescriptor(
      {
        name: family.name,
        version: '1',
        description,
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: kindNames, description: '要执行的动作（见工具描述）' },
            ...unionProperties(staging, memberNames),
          },
          // 只在 kind 上强制：成员的必填项各不相同（single 要 role/objective、batch 要 tasks），
          // 用同一个必填集会让模型为了凑参数选错 kind。
          required: ['kind'],
        },
        readOnly: !anyWrite,
        idempotent: false,
        mutatesWorkspace: anyWrite,
        requiresConfirmation: highestConfirm ? 'HIGH' : (anyWrite ? 'WRITE' : false),
        requiredCapability: anyWrite ? 'workspace.write' : 'workspace.read',
        timeoutMs: 0,
        cachePolicy: { mode: 'none' },
        concurrencyPolicy: { parallelSafe: false },
        byKind,
      },
      async (context, args) => {
        const kind = String((args && args.kind) || '').trim().toLowerCase();
        const memberName = family.kinds[kind];
        if (!memberName) {
          return AgentToolResult.error(
            '未知 kind: ' + (kind || '(空)') + '（可选 ' + kindNames.join('/') + '）',
            { code: 'ARG_SEMANTIC', tool: family.name, kind },
          );
        }
        const tool = staging.tools.get(memberName);
        if (!tool || typeof tool.executor !== 'function') {
          return AgentToolResult.error('子代理工具未装配：' + memberName, { code: 'SYSTEM_ERROR', tool: family.name, kind });
        }
        // 执行体逐字复用（含它自己的确认、核验、审计逻辑）
        return tool.executor(context, args);
      },
    );
  }
  // 旧名别名：模型历史消息 / 角色白名单 / 用例里的旧名照样能用，但**不占 schema**
  for (const [legacy, target] of Object.entries(LEGACY_NAMES)) {
    registry.registerAlias(legacy, { family: target.family, kind: target.kind });
  }
  // 族工具的输出契约 = 成员契约的分支并集（见 builtInOutputSchemas 里的 anyOfMembers）
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, FAMILIES.map((family) => family.name));
  return registry;
}

module.exports = { registerSubagentFamilies, FAMILIES, LEGACY_NAMES };
