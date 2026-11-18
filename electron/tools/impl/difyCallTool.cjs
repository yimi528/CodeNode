/**
 * dify_call —— **已并入 `web`（kind=dify）**，见 docs/tool-consolidation.zh-CN.md L2。
 *
 * 本模块保留执行体 `execute`（供 webTool 的族分发复用）与 endpointFor。
 * HIGH 级审批由 webTool 的 `byKind.dify.requiresConfirmation='HIGH'` 承接 —— 与合并前一致。
 */
'use strict';

const crypto = require('crypto');
const { AgentToolResult } = require('../result.cjs');
const { request } = require('../../publicHttp.cjs');

function endpointFor(base, kind) {
  const url = new URL(String(base || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    throw new Error('Dify 地址应为不含凭据、查询参数的 HTTP(S) /v1 API 地址');
  }
  return url.href.replace(/\/+$/, '') + (kind === 'chat' ? '/chat-messages' : '/workflows/run');
}

async function execute(context, args) {
  const a = args || {};
  const cfg = require('../../agent.cjs').loadConfig(context.projectRoot()).dify;
  if (!cfg || !cfg.enabled) return AgentToolResult.failure('PERMISSION_DENIED', 'Dify 未启用；在项目 .codenode/agent.properties 配置 dify.enabled/base/api_key', { tool: 'web' });
  if (!['workflow', 'chat'].includes(cfg.kind)) return AgentToolResult.error('dify.kind 必须是 workflow 或 chat');
  const inputs = a.inputs && typeof a.inputs === 'object' && !Array.isArray(a.inputs) ? a.inputs : {};
  const query = String(a.query || '').trim();
  if (cfg.kind === 'chat' && !query) return AgentToolResult.error('聊天应用需要 query');
  const user = 'codenode-' + crypto.createHash('sha256').update(context.projectRoot()).digest('hex').slice(0, 12);
  const payload = cfg.kind === 'chat'
    ? { inputs, query, response_mode: 'blocking', user, ...(a.conversationId ? { conversation_id: String(a.conversationId) } : {}) }
    : { inputs, response_mode: 'blocking', user };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 32768) return AgentToolResult.error('Dify 输入超过 32 KiB 上限');
  let endpoint;
  try { endpoint = endpointFor(cfg.base, cfg.kind); }
  catch (error) { return AgentToolResult.error(String(error && error.message || error)); }
  const started = Date.now();
  const audit = (status) => context.audit('dify_call kind=' + cfg.kind + ' inputKeys=' + Object.keys(inputs).join(',').slice(0, 240) + ' status=' + status + ' elapsedMs=' + (Date.now() - started));
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body,
      signal: context.signal && context.signal(),
      timeoutMs: 60000,
      maxBytes: 1024 * 1024,
      allowPrivateHosts: true,
    });
    let parsed;
    try { parsed = JSON.parse(response.text); }
    catch { audit('invalid_json'); return AgentToolResult.failure('FATAL_FAILURE', 'Dify 返回的不是 JSON', { kind: cfg.kind, elapsedMs: Date.now() - started }); }
    const run = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    const status = String(run.status || (cfg.kind === 'chat' ? 'succeeded' : 'unknown'));
    const elapsedMs = Date.now() - started;
    const output = cfg.kind === 'chat' ? parsed.answer : run.outputs;
    const data = {
      kind: cfg.kind,
      inputKeys: Object.keys(inputs),
      inputs,
      query: cfg.kind === 'chat' ? query : undefined,
      output,
      elapsedMs,
      status,
      taskId: parsed.task_id || null,
      runId: run.id || parsed.workflow_run_id || null,
      conversationId: parsed.conversation_id || null,
      error: run.error || parsed.message || null,
    };
    if (status !== 'succeeded' || output == null) {
      audit(status);
      return AgentToolResult.failure('FATAL_FAILURE', 'Dify 执行失败：' + String(data.error || '未返回成功输出'), data);
    }
    audit('succeeded');
    const rendered = typeof output === 'string' ? output : JSON.stringify(output);
    const resultText = 'Dify ' + cfg.kind + ' 成功（' + elapsedMs + 'ms）\n' + rendered.slice(0, 16000) + (rendered.length > 16000 ? '\n…（已截断）' : '');
    return AgentToolResult.ok(resultText, data, { modelContent: resultText });
  } catch (error) {
    audit('failed');
    return AgentToolResult.failure('FATAL_FAILURE', 'Dify 调用失败：' + String(error && error.message || error).slice(0, 300), { kind: cfg.kind, inputKeys: Object.keys(inputs), elapsedMs: Date.now() - started });
  }
}

module.exports = { execute, endpointFor };
