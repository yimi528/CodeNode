/**
 * list_files —— 列文件族工具（工具面收敛 L2）。
 *
 * 合并自两个参数同构、安全签名完全一致的只读工具：
 *   kind=glob ← find_files（按 glob 模式查文件）
 *   kind=dir  ← list_directory（列目录内容）
 *
 * 为什么能合：两者都只读、都在 `workspace.read`、都用 run 缓存、都跳过构建/缓存目录、
 * 都支持 offset 分页 —— 差别只是「用模式匹配还是直接列目录」。参数并集里 `pattern`/`recursive`
 * 各自只对一种 kind 有意义，描述里写清楚了。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveToolPath } = require('../paths.cjs');
const { shouldSkipDir } = require('../toolFiles.cjs');
const { globToRegExp, isCancelled } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');

const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1000;
const MAX_MODEL_OUTPUT_CHARS = 19500;
const MAX_ENTRIES = 2000;

const KINDS = Object.freeze(['glob', 'dir']);

/** 旧工具名 / 常见说法 → kind */
const KIND_ALIASES = Object.freeze({
  glob: 'glob', find: 'glob', files: 'glob', pattern: 'glob', search: 'glob',
  dir: 'dir', directory: 'dir', list: 'dir', ls: 'dir',
});

function resolveKind(args) {
  const raw = String((args && args.kind) || '').trim().toLowerCase();
  if (!raw) return 'dir';
  return KIND_ALIASES[raw] || raw;
}

const DESCRIPTION =
  '列文件（只读，两种视图）。kind=glob：按 glob 模式查找文件（pattern 必填，如 **/*.ts）；' +
  'kind=dir：列出目录内容（path 缺省根目录，recursive=true 递归）。两者都跳过构建/缓存目录、' +
  '都支持 offset 分页（glob 用 maxResults，dir 单页最多 ' + MAX_ENTRIES + ' 项）。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS, description: 'glob=按通配查文件 / dir=列目录（默认）' },
    pattern: { type: 'string', description: 'kind=glob 必填：glob 模式，如 **/*.java' },
    path: { type: 'string', description: 'kind=dir：项目内相对目录，缺省根目录' },
    recursive: { type: 'boolean', description: 'kind=dir：是否递归列出，默认 false' },
    maxResults: { type: 'integer', description: 'kind=glob：最多返回条数，默认 100，单次最多 1000' },
    offset: { type: 'integer', description: '分页起点，默认 0' },
  },
  required: [],
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'list_files',
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
      defaultKind: 'dir',
      byKind: {
        glob: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', effect: 'read', idempotent: true },
        dir: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', effect: 'read', idempotent: true },
      },
    },
    async (context, args) => {
      const kind = resolveKind(args);
      if (kind === 'glob') return runGlob(context, args);
      if (kind === 'dir') return runDir(context, args);
      return AgentToolResult.error('未知 kind: ' + kind + '（可选 ' + KINDS.join('/') + '）', { code: 'ARG_SEMANTIC', tool: 'list_files', kind });
    },
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['list_files']);
}

/** kind=glob（原 find_files 实现，逐字保留行为） */
async function runGlob(context, args) {
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return AgentToolResult.error('kind=glob 需要 pattern（如 **/*.ts）');
  const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
    ? Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(args.maxResults)))
    : DEFAULT_MAX_RESULTS;
  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  const root = path.resolve(context.projectRoot());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在：' + root);
  try {
    // 主线程先校验一次模式：worker 内抛错只会变成「任务失败」，提示不如这里清楚
    globToRegExp(pattern);
  } catch {
    return AgentToolResult.error('无效的 glob 模式：' + pattern);
  }
  // P7 收口：遍历放进 worker 线程 —— 同步遍历会冻住 Electron 主进程，且单次同步 fs
  // 调用（statSync 撞上挂住的网络盘）不可中断；terminate 才能真正杀掉它。
  const outcome = await fsRunner.runFsTask(
    'findFiles',
    // 多收一条哨兵结果，确保整页刚好填满时也能提示用户继续分页。
    { root, pattern, limit: offset + max + 1, shouldStop: () => isCancelled(context) },
    { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
  );
  if (outcome.cancelled || outcome.timedOut) {
    return AgentToolResult.failure('CANCELLED', '查找已取消（用户停止），结果不完整（已找到 ' + outcome.progress + ' 个文件）。', {
      cancelled: true,
      partial: outcome.progress,
    });
  }
  if (outcome.mode === 'sync-fallback') {
    context.audit('list_files glob worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
  }
  const found = outcome.result.files;
  const total = found.length;
  if (total === 0) return AgentToolResult.ok('未找到匹配文件', { count: 0, offset: 0, files: [] });
  const page = found.slice(offset, offset + max);
  if (page.length === 0) {
    return AgentToolResult.ok('找到 ' + total + ' 个文件，但 offset=' + offset + ' 超出范围（共 ' + total + ' 条）', { count: total, offset, files: [] });
  }
  const visiblePage = [];
  let visibleChars = 0;
  for (const file of page) {
    let visible = String(file);
    if (visible.length > MAX_MODEL_OUTPUT_CHARS - 200) {
      visible = visible.slice(0, MAX_MODEL_OUTPUT_CHARS - 240) + '…（路径过长，未完整显示）';
    }
    if (visibleChars + visible.length + 1 > MAX_MODEL_OUTPUT_CHARS && visiblePage.length) break;
    visiblePage.push(visible);
    visibleChars += visible.length + 1;
  }
  const nextOffset = offset + visiblePage.length;
  const truncated = total > nextOffset;
  const shownRange = (offset + 1) + '-' + nextOffset;
  // A1（审计 §4 P0-2）：文件列表**只发一份** —— 下面这段文本里已经是完整列表 + 分页游标。
  const text =
    (truncated ? '已找到至少 ' : '找到 ') + total +
    (truncated ? ' 个文件，显示第 ' + shownRange + ' 条（用 offset=' + nextOffset + ' 继续）：' : ' 个文件：') +
    '\n' + visiblePage.join('\n');
  return AgentToolResult.ok(text, { count: total, offset, nextOffset, files: page }, { modelContent: text });
}

/** kind=dir（原 list_directory 实现，逐字保留行为） */
async function runDir(context, args) {
  let p = String(args.path || '').trim();
  if (!p) p = '.';
  const recursive = args.recursive === true;
  const dir = resolveToolPath(context, p);
  if (!dir) return AgentToolResult.error('路径越过项目边界');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return AgentToolResult.error('目录不存在：' + p);

  const lines = [];
  const collect = (base, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const it of entries) {
      const childAbs = path.join(base, it.name);
      const childRel = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) {
        if (shouldSkipDir(it.name)) continue;
        lines.push(childRel + '/');
        if (recursive && depth < 12) collect(childAbs, childRel, depth + 1);
      } else {
        lines.push(childRel);
      }
    }
  };
  collect(dir, p === '.' ? '' : p, 0);

  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  const truncated = lines.length > offset + MAX_ENTRIES;
  const start = Math.min(offset, lines.length);
  const shown = truncated ? lines.slice(start, start + MAX_ENTRIES) : lines.slice(start);
  const header =
    '目录 ' + (p === '.' ? '/' : p) +
    '（共 ' + lines.length + ' 项，显示第 ' + (start + 1) + '-' + (start + shown.length) + ' 项' +
    (truncated ? '，用 offset=' + (start + MAX_ENTRIES) + ' 继续' : '') + '）';
  return AgentToolResult.ok(shown.length === 0 ? header + '（空）' : header + '\n' + shown.join('\n'), {
    count: lines.length,
    offset: start,
    path: p,
  });
}

module.exports = { register, resolveKind, KIND_ALIASES, KINDS, runGlob, runDir };
