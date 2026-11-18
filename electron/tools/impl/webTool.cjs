/**
 * web —— 出网族工具（工具面收敛 L2）。
 *
 * 合并自三个**异构**工具：
 *   kind=fetch  ← fetch_url（抓取网页文本）
 *   kind=search ← web_search（联网搜索，需配置后端）
 *   kind=dify   ← dify_call（调 Dify 应用，HIGH 审批）
 *
 * 三者都声明 `network.request`（门 2 在网络被切断时统一拒绝），但审批级别不同：
 * `dify_call` 原来是 HIGH，其余两个是免审批。所以 byKind 必须分开声明 ——
 * 否则要么 Dify 失去 HIGH 审批，要么普通抓取被迫每次问用户。
 *
 * 装配注意：web_search / dify_call 只在对应开关打开时才有意义。本族**总是注册**（fetch 是
 * 基础能力），但 kind=search/dify 在开关关闭时返回明确的「未启用」失败，而不是让工具消失 ——
 * 这样 schema 里始终只有一份 web，也不会出现「模型调了一个不存在的工具」。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { fetchPublicText } = require('../../publicHttp.cjs');
const webSearchModule = require('./webSearchTool.cjs');
const difyModule = require('./difyCallTool.cjs');

const KINDS = Object.freeze(['fetch', 'search', 'dify']);

function resolveKind(args) {
  const raw = String((args && args.kind) || '').trim().toLowerCase();
  if (!raw) return 'fetch';
  if (raw === 'url' || raw === 'get' || raw === 'read') return 'fetch';
  if (raw === 'web_search' || raw === 'google') return 'search';
  if (raw === 'dify_call' || raw === 'workflow' || raw === 'chat') return 'dify';
  return raw;
}

const DESCRIPTION =
  '出网（三种动作）。kind=fetch：抓取公网 HTTP/HTTPS 文本（最多 1MiB，限时 30 秒）；' +
  'kind=search：联网搜索，返回标题/链接/摘要（需在设置里配置搜索后端）；' +
  'kind=dify：调用项目显式配置的已发布 Dify 工作流或聊天应用（输入会发送到 Dify，执行前需确认）。' +
  '三者都需要网络权限。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS, description: 'fetch=抓网页（默认）/search=联网搜索/dify=调 Dify' },
    url: { type: 'string', maxLength: 2048, description: 'kind=fetch：要抓取的 URL' },
    maxChars: { type: 'integer', minimum: 100, maximum: 50000, description: 'kind=fetch：最多返回字符数，默认 5000' },
    query: { type: 'string', maxLength: 8000, description: 'kind=search：搜索词（必填）；kind=dify 聊天应用：用户问题' },
    maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'kind=search：最多返回几条' },
    inputs: { type: 'object', description: 'kind=dify：映射到 Dify 应用的输入变量' },
    conversationId: { type: 'string', maxLength: 200, description: 'kind=dify 聊天应用：会话 ID，首次调用留空' },
  },
  required: [],
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'web',
      version: '1',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      // 族级取最保守：出网族里 dify 需要 HIGH 审批
      readOnly: false,
      idempotent: false,
      mutatesWorkspace: false,
      requiresConfirmation: 'HIGH',
      requiredCapability: 'network.request',
      timeoutMs: 0,
      cachePolicy: { mode: 'none' },
      concurrencyPolicy: { parallelSafe: false },
      defaultKind: 'fetch',
      /** 异构族：三个动作的审批级别不同，必须分开声明 */
      byKind: {
        fetch: { readOnly: false, mutatesWorkspace: false, requiredCapability: 'network.request', requiresConfirmation: false, effect: 'unknown' },
        search: { readOnly: false, mutatesWorkspace: false, requiredCapability: 'network.request', requiresConfirmation: false, effect: 'unknown' },
        dify: { readOnly: false, mutatesWorkspace: false, requiredCapability: 'network.request', requiresConfirmation: 'HIGH', effect: 'unknown' },
      },
    },
    async (context, args) => {
      const kind = resolveKind(args);
      if (kind === 'fetch') return runFetch(context, args);
      if (kind === 'search') return webSearchModule.execute(context, args);
      if (kind === 'dify') return difyModule.execute(context, args);
      return AgentToolResult.error('未知 kind: ' + kind + '（可选 ' + KINDS.join('/') + '）', { code: 'ARG_SEMANTIC', tool: 'web', kind });
    },
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['web']);
}

/** kind=fetch（原 fetch_url 实现，逐字保留行为） */
async function runFetch(context, args) {
  if (!args.url) return AgentToolResult.error('kind=fetch 需要 url');
  try {
    const result = await fetchPublicText(args.url, { signal: context.signal?.() });
    const maxChars = args.maxChars || 5000;
    const truncated = result.text.length > maxChars;
    return AgentToolResult.ok(result.text.slice(0, maxChars), {
      url: result.url, chars: result.text.length, bytes: result.bytes, truncated,
    });
  } catch (error) {
    return AgentToolResult.error('抓取失败：' + error.message);
  }
}

module.exports = { register, resolveKind, KINDS, runFetch };
