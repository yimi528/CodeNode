/**
 * 联网搜索工具：原生适配常见供应商，同时保留自建 SearxNG 与自定义 GET JSON 端点。
 * 未启用时工具不注册；API Key 由主进程安全存储提供，不进入模型上下文。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { request } = require('../../publicHttp.cjs');

const PROVIDERS = Object.freeze(['searxng', 'tavily', 'brave', 'serper', 'google', 'custom']);
const DEFAULT_ENDPOINTS = Object.freeze({
  searxng: '',
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  serper: 'https://google.serper.dev/search',
  google: 'https://customsearch.googleapis.com/customsearch/v1',
  custom: '',
});
const DEFAULTS = Object.freeze({ provider: 'searxng', backend: 'searxng', maxResults: 5, timeoutMs: 15000, maxBytes: 512 * 1024, networkAllowed: false });

function asBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return value === true || String(value).trim().toLowerCase() === 'true';
}

/** 接受旧 properties、agent.loadConfig() 的 webSearch 字段与设置页结构。 */
function parseWebSearchConfig(cfg) {
  const source = cfg || {};
  const structured = source.webSearch && typeof source.webSearch === 'object' ? source.webSearch : source;
  const enabled = asBool(structured.enabled ?? source['web_search.enabled']);
  const rawProvider = String(structured.provider || structured.backend || source['web_search.provider'] || source['web_search.backend'] || DEFAULTS.provider).trim().toLowerCase();
  const provider = PROVIDERS.includes(rawProvider) ? rawProvider : DEFAULTS.provider;
  const endpoint = String(structured.endpoint || source['web_search.endpoint'] || DEFAULT_ENDPOINTS[provider] || '').trim();
  const apiKey = String(structured.apiKey || source['web_search.api_key'] || '').trim();
  const engineId = String(structured.engineId || source['web_search.engine_id'] || '').trim();
  const maxResults = Math.min(20, Math.max(1, Number(structured.maxResults || source['web_search.max_results']) || DEFAULTS.maxResults));
  const timeoutMs = Math.min(60000, Math.max(1000, Number(structured.timeoutMs || source['web_search.timeout_ms']) || DEFAULTS.timeoutMs));
  const networkAllowed = asBool(structured.networkAllowed ?? source['web_search.network_allowed']);
  const problems = [];
  if (enabled && !endpoint) problems.push('web_search.enabled=true 但没有配 web_search.endpoint');
  if (endpoint && !/^https?:\/\//i.test(endpoint)) problems.push('web_search.endpoint 必须以 http:// 或 https:// 开头');
  if (endpoint && /^https?:\/\//i.test(endpoint)) {
    try { const url = new URL(endpoint); if (url.username || url.password) problems.push('web_search.endpoint 不能包含账号或密码'); }
    catch { problems.push('web_search.endpoint 不是有效 URL'); }
  }
  if (enabled && !['searxng', 'custom'].includes(provider) && !apiKey) problems.push(provider + ' 搜索需要 API Key');
  if (enabled && provider === 'google' && !engineId) problems.push('Google Programmable Search 需要搜索引擎 ID（cx）');
  return { enabled, provider, backend: provider, endpoint, apiKey, engineId, maxResults, timeoutMs, networkAllowed, problems };
}

/** 各家响应统一成 title/url/snippet。 */
function normalizeResults(payload, limit, provider = 'custom') {
  const list = Array.isArray(payload) ? payload
    : provider === 'brave' && Array.isArray(payload?.web?.results) ? payload.web.results
    : provider === 'serper' && Array.isArray(payload?.organic) ? payload.organic
    : Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.items) ? payload.items : null;
  if (!list) return null;
  return list.slice(0, limit).map(item => {
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || item.link || item.href || '').trim();
    const title = String(item.title || item.name || url || '').trim();
    const snippet = String(item.content || item.snippet || item.description || item.text || '').trim();
    if (!url && !title) return null;
    return { title, url, snippet };
  }).filter(Boolean);
}

function buildQueryUrl(config, query, limit = config.maxResults || DEFAULTS.maxResults) {
  const encoded = encodeURIComponent(query);
  if (config.endpoint.includes('{query}')) return config.endpoint.split('{query}').join(encoded);
  const separator = config.endpoint.includes('?') ? '&' : '?';
  const provider = config.provider || config.backend;
  if (provider === 'searxng') return config.endpoint + separator + 'q=' + encoded + '&format=json';
  if (provider === 'google') return config.endpoint + separator + 'q=' + encoded + '&key=' + encodeURIComponent(config.apiKey) + '&cx=' + encodeURIComponent(config.engineId) + '&num=' + Math.min(10, limit);
  return config.endpoint + separator + 'q=' + encoded;
}

function buildRequest(config, query, limit) {
  const provider = config.provider || config.backend || 'custom';
  /** @type {Record<string,string>} */
  const headers = { accept: 'application/json' };
  let method = 'GET', body = null, url = buildQueryUrl(config, query, limit);
  if (provider === 'tavily') {
    method = 'POST'; headers['content-type'] = 'application/json'; url = config.endpoint;
    body = JSON.stringify({ api_key: config.apiKey, query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false });
  } else if (provider === 'brave') {
    headers['x-subscription-token'] = config.apiKey;
    url += (url.includes('?') ? '&' : '?') + 'count=' + limit;
  } else if (provider === 'serper') {
    method = 'POST'; headers['content-type'] = 'application/json'; headers['x-api-key'] = config.apiKey; url = config.endpoint;
    body = JSON.stringify({ q: query, num: limit });
  } else if ((provider === 'custom' || provider === 'searxng') && config.apiKey) {
    headers.authorization = 'Bearer ' + config.apiKey;
  }
  return { provider, url, method, headers, body };
}

async function performSearch(config, query, limit, options = {}) {
  const spec = buildRequest(config, query, limit);
  const response = await request(spec.url, {
    method: spec.method,
    headers: spec.headers,
    body: spec.body,
    signal: options.signal,
    timeoutMs: config.timeoutMs,
    maxBytes: DEFAULTS.maxBytes,
    // 本地 SearxNG / 企业中转站是用户明确配置的端点；仍固定 DNS 解析结果以防 rebinding。
    allowPrivateHosts: spec.provider === 'searxng' || spec.provider === 'custom',
  });
  let payload;
  try { payload = JSON.parse(response.text); }
  catch { throw Object.assign(new Error('搜索后端应答不是 JSON（provider=' + spec.provider + '）：' + String(response.text || '').slice(0, 120)), { code: 'INVALID_JSON' }); }
  const results = normalizeResults(payload, limit, spec.provider);
  if (results === null) throw Object.assign(new Error('搜索后端应答里没有 results 数组或可识别的供应商结果（provider=' + spec.provider + '）：' + JSON.stringify(payload).slice(0, 160)), { code: 'INVALID_SHAPE' });
  return { provider: spec.provider, results };
}

function register(registry) {
  registry.register('web_search', '联网搜索：返回标题、链接和摘要，用于查文档、错误与版本信息。', {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 600, description: '搜索词' },
      maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条' },
    },
    required: ['query'],
  }, async (context, args) => {
    const query = String(args?.query || '').trim();
    if (!query) return AgentToolResult.error('缺少 query');
    const config = typeof context.webSearchConfig === 'function' ? context.webSearchConfig() : null;
    if (!config?.enabled || !config.endpoint) return AgentToolResult.error('web_search 未启用或未配置后端', { code: 'ARG_SCHEMA', tool: 'web_search' });
    const policy = typeof context.sandbox === 'function' ? context.sandbox() : null;
    const networkDenied = context.exec?.networkDenied === true || (!context.exec && policy?.network === 'deny' && config.networkAllowed !== true);
    if (networkDenied) return AgentToolResult.error('联网搜索需要出网，但当前 sandbox.network=deny 且尚未获得 web_search 独立联网授权（请在“设置 → 联网搜索”中开启）', { code: 'NETWORK_DENIED', tool: 'web_search' });
    const limit = Math.min(20, Math.max(1, Number(args?.maxResults || config.maxResults)));
    try {
      const searched = await performSearch(config, query, limit, { signal: context.signal && context.signal() });
      if (!searched.results.length) return AgentToolResult.ok('搜索「' + query + '」没有返回结果（后端：' + searched.provider + '）。', { query, backend: searched.provider, count: 0, results: [] });
      const lines = searched.results.map((item, index) => index + 1 + '. ' + item.title + (item.url ? '\n   ' + item.url : '') + (item.snippet ? '\n   ' + item.snippet.replace(/\s+/g, ' ').slice(0, 300) : ''));
      return AgentToolResult.ok('搜索「' + query + '」（后端：' + searched.provider + '，' + searched.results.length + ' 条）\n' + lines.join('\n'), { query, backend: searched.provider, count: searched.results.length, results: searched.results });
    } catch (error) {
      return AgentToolResult.error('搜索失败：' + String(error?.message || error), { code: 'FATAL_FAILURE', tool: 'web_search', backend: config.provider || config.backend });
    }
  });
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ['web_search']);
}

module.exports = { register, parseWebSearchConfig, normalizeResults, buildQueryUrl, buildRequest, performSearch, PROVIDERS, DEFAULT_ENDPOINTS, DEFAULTS };
