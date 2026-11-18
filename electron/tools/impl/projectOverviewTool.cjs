/**
 * project_overview —— 项目画像族工具（工具面收敛 L2）。
 *
 * 合并自三个参数同构、安全签名完全一致的只读工具（见 docs/tool-consolidation.zh-CN.md §3 L2）：
 *   kind=info       ← project_info（构建系统 / 模块 / 入口 / 语言分布）
 *   kind=structure  ← analyze_project（逐文件结构摘要 import/class/function/变量）
 *   kind=review     ← code_review（规则静态审查：硬编码密钥 / 空指针 / 过长方法 / TODO）
 *
 * 为什么能合：三者都是 `readOnly / mutatesWorkspace=false / workspace.read / 无审批 / run 缓存`，
 * 参数也只差一个「查什么」。所以 `byKind` 里三个 kind 的签名完全一致 —— 这是**唯一可以放心
 * 整族合并**的一类（异构族必须靠 kind 级安全门，见 memory / web）。
 *
 * 显式排除 `scan_project`：它的签名是「只读但 mutatesWorkspace=true / capability=workspace.write」
 * （applyToWorkbench=true 会写画布）。并进来会让只读角色拿到写能力，或让 info/structure 也要求写权限。
 * 想并它必须先把 applyToWorkbench 移到 workbench_edit（kind=import_tree）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const projectInfo = require('./projectInfoTool.cjs');
const analyzeProject = require('./analyzeProjectTool.cjs');
const codeReview = require('./codeReviewTool.cjs');

const KINDS = Object.freeze(['info', 'structure', 'review']);

/** 旧 action 名 / 常见说法 → kind（模型写 `tree`、`analyze` 也能落到正确分支） */
const KIND_ALIASES = Object.freeze({
  info: 'info', project: 'info', detect: 'info',
  structure: 'structure', analyze: 'structure', files: 'structure', tree: 'structure',
  review: 'review', lint: 'review', audit: 'review',
});

function resolveKind(args) {
  const raw = String((args && args.kind) || '').trim().toLowerCase();
  if (!raw) return 'info';
  return KIND_ALIASES[raw] || raw;
}

const DESCRIPTION =
  '项目画像（只读，三种视图）。kind=info：构建系统/模块/入口候选/语言分布/文件数（默认）；' +
  'kind=structure：逐文件结构摘要（import/类/函数/变量），analyzeFiles/limitFiles 可控；' +
  'kind=review：规则静态审查（硬编码密钥、空指针风险、过长方法、TODO），用 code 或 path 指定目标。' +
  '用户在要求「看项目 / 分析项目 / 审查代码」时调用，结果可直接作为后续制作的依据。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: KINDS,
      description: 'info=工程信息（默认）；structure=逐文件结构摘要；review=规则静态审查',
    },
    path: { type: 'string', description: '项目根目录（info/structure）或待审查文件（review），缺省当前项目' },
    analyzeFiles: { type: 'boolean', description: 'kind=structure：是否逐文件提取结构摘要，默认 true' },
    limitFiles: { type: 'integer', description: 'kind=structure：最多分析的文件数，默认 200，上限 1000' },
    code: { type: 'string', description: 'kind=review：直接审查这段代码文本（与 path 二选一）' },
    maxMethodLines: { type: 'integer', description: 'kind=review：过长方法阈值，默认 200' },
  },
  required: [],
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'project_overview',
      version: '1',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      readOnly: true,
      idempotent: true,
      mutatesWorkspace: false,
      requiresConfirmation: false,
      requiredCapability: 'workspace.read',
      timeoutMs: 0,
      cachePolicy: { mode: 'run' },
      concurrencyPolicy: { parallelSafe: true },
      defaultKind: 'info',
      /** 三个 kind 的安全签名**完全一致** —— 整族只读，这是最安全的合并形态 */
      byKind: {
        info: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', effect: 'read', idempotent: true },
        structure: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', effect: 'read', idempotent: true },
        review: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', effect: 'read', idempotent: true },
      },
    },
    async (context, args) => {
      const kind = resolveKind(args);
      switch (kind) {
        case 'info':
          return projectInfo.execute(context, args);
        case 'structure':
          return analyzeProject.execute(context, args);
        case 'review':
          return codeReview.execute(context, args);
        default:
          return AgentToolResult.error(
            '未知 kind: ' + kind + '（可选 ' + KINDS.join('/') + '）',
            { code: 'ARG_SEMANTIC', tool: 'project_overview', kind },
          );
      }
    },
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['project_overview']);
}

module.exports = { register, resolveKind, KIND_ALIASES, KINDS };
