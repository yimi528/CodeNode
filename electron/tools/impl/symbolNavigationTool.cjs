/**
 * symbol_nav —— 符号导航族工具（工具面收敛 L2）。
 *
 * 合并自四个**完全同构**的只读工具（见 docs/tool-consolidation.zh-CN.md §3 L2）：
 *   kind=definition ← find_definition
 *   kind=references ← find_references
 *   kind=callers    ← get_callers
 *   kind=callees    ← get_callees
 *
 * 为什么能合：四者的 inputSchema 逐字相同、安全签名逐字相同（readOnly / 不写 / workspace.read /
 * 无审批 / read 副作用），只有「查哪个关系」不同 —— 连参数都不用并集，只需加一个 kind。
 * 四份 schema 合计 865 tokens，合成一份 184，是本方案单笔最大的 schema 收益。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { AgentToolResult } = require('../result.cjs');
const { getProjectIndex } = require('../../rag/index.cjs');
const { queryNavigation } = require('../../rag/symbolNavigation.cjs');
const { resolveInRoot, isCancelled } = require('./shared.cjs');

const LIMITATIONS = '仅支持当前索引范围内的 TS/JS 静态候选，不做类型检查；动态调用、重导出、复杂 require 绑定及复杂接收者可能无法解析。name-only/member-candidate 不能证明实际调用关系。未命中不证明不存在；请 read_file 深读原文。';

const KINDS = Object.freeze(['definition', 'references', 'callers', 'callees']);

/** 旧工具名 / 常见说法 → kind */
const KIND_ALIASES = Object.freeze({
  definition: 'definition', def: 'definition', define: 'definition',
  references: 'references', refs: 'references', usage: 'references',
  callers: 'callers', caller: 'callers', who_calls: 'callers',
  callees: 'callees', callee: 'callees', calls: 'callees',
});

function resolveKind(args) {
  const raw = String((args && args.kind) || '').trim().toLowerCase();
  if (!raw) return 'definition';
  return KIND_ALIASES[raw] || raw;
}

const DESCRIPTION =
  '符号导航（TS/JS 静态候选）。kind=definition 定位符号定义；kind=references 查引用位置；' +
  'kind=callers 查谁调用它；kind=callees 查它调用了谁。symbol 必填（区分大小写，可写 Class.method）；' +
  'path/line 用于消除同名歧义；结果为定位候选，需 read_file 核实；支持 offset 分页。' +
    LIMITATIONS;

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: KINDS,
      description: 'definition=定义（默认）/references=引用/callers=调用者/callees=被调用者',
    },
    symbol: { type: 'string', minLength: 1, maxLength: 300, description: '符号名或限定名，区分大小写' },
    path: { type: 'string', maxLength: 1000, description: '目标定义所在的项目内文件或目录' },
    line: { type: 'integer', minimum: 1, description: '目标定义内部行号；与 path 一起用于消除歧义' },
    maxResults: { type: 'integer', minimum: 1, maximum: 100, description: '每页结果数，默认 40，最多 100' },
    offset: { type: 'integer', minimum: 0, description: '分页起点，默认 0' },
  },
  required: ['symbol'],
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'symbol_nav',
      version: '1',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      readOnly: true,
      idempotent: true,
      mutatesWorkspace: false,
      requiresConfirmation: false,
      requiredCapability: 'workspace.read',
      timeoutMs: 0,
      cachePolicy: { mode: 'none' },
      concurrencyPolicy: { parallelSafe: true },
      defaultKind: 'definition',
      // 四个 kind 的安全签名完全一致（只读、无审批）—— 整族同一个取值即可
      byKind: {
        // cachePolicy 显式写 none：符号查询每次都重算索引版本，复用旧结果会给出过期的引用位置
        definition: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', cachePolicy: 'none', effect: 'read', idempotent: true },
        references: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', cachePolicy: 'none', effect: 'read', idempotent: true },
        callers: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', cachePolicy: 'none', effect: 'read', idempotent: true },
        callees: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', cachePolicy: 'none', effect: 'read', idempotent: true },
      },
    },
    async (context, args) => {
      if (isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
      const symbol = String(args.symbol || '').trim();
      if (!symbol) return AgentToolResult.error('symbol 不能为空');
      const kind = resolveKind(args);
      if (!KINDS.includes(kind)) {
        return AgentToolResult.error('未知 kind: ' + kind + '（可选 ' + KINDS.join('/') + '）', { code: 'ARG_SEMANTIC', tool: 'symbol_nav', kind });
      }
      const root = path.resolve(context.projectRoot());
      let scope = '';
      if (args.path) {
        const full = resolveInRoot(root, args.path);
        if (!full) return AgentToolResult.error('路径越过项目边界或不可访问');
        if (!fs.existsSync(full)) return AgentToolResult.error('目标路径不存在：' + args.path);
        scope = path.relative(root, full).split(path.sep).join('/');
      }
      if (args.line && !scope) return AgentToolResult.error('line 必须与具体文件 path 一起使用');
      if (args.line && !fs.statSync(path.join(root, scope)).isFile()) return AgentToolResult.error('line 需要具体文件 path');
      const config = context.ragConfig();
      try {
        const index = getProjectIndex(root, { ...config, enabled: true, embedProvider: 'none', vectorStore: 'memory', rerankUrl: '' });
        const stats = await index.refreshAsync(false, context.signal());
        if (isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
        /** @type {any} */
        const result = queryNavigation(index.fileCache, kind, { ...args, symbol, path: scope });
        result.index = {
          indexedFiles: stats.indexedFiles, skippedFiles: stats.skippedFiles,
          truncated: stats.truncated,
          parseErrorFiles: [...index.fileCache.values()].filter((entry) => entry.navigation?.parseErrors).length,
        };
        result.limitations = LIMITATIONS;
        result.kind = kind;
        context.audit('symbol_nav ' + kind + ' symbol=' + symbol + ' count=' + result.count);
        const text = JSON.stringify(result);
        return AgentToolResult.ok(text, result, { modelContent: text });
      } catch (error) {
        if (error.name === 'AbortError' || isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
        return AgentToolResult.error('符号查询失败：' + error.message);
      }
    },
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['symbol_nav']);
}

module.exports = { register, resolveKind, KIND_ALIASES, KINDS, LIMITATIONS };
