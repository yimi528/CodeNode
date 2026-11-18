/**
 * query_scalars —— **已并入 `retrieve_context`（mode=scalar / keys / prefix）**，
 * 见 docs/tool-consolidation.zh-CN.md L1。
 *
 * 本模块保留执行体 `execute`，供 retrieveContextTool 在「精确标量查询」路径上复用；
 * 不再注册独立工具。旧名 `query_scalars` 由 toolkit.registerLegacyAliases 登记成别名
 * （翻译成 retrieve_context + mode=scalar + prefix/query 参数），调用侧零改动。
 *
 * 两者本来就共享同一实现路径：retrieve_context 的 scalar 模式、keys 精确查与标量路由，
 * 与 query_scalars 的 key/prefix/query 三种查法用的是同一个标量库 API。安全签名也完全一致
 * （只读 / 不写 / workspace.read / 无审批）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

const VALUE_CHAR_CAP = 8000;

function serializeValue(value) {
  try {
    if (value == null) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const json = JSON.stringify(value);
    return json.length > VALUE_CHAR_CAP ? json.slice(0, VALUE_CHAR_CAP) + '…（已截断，用 key=node:<id>:<attr> 取单属性）' : json;
  } catch {
    return String(value);
  }
}

/**
 * 执行体：精确/前缀/语义查询本地标量库。
 * @param {any} context
 * @param {{key?: string, prefix?: string, query?: string, max?: number}} args
 */
async function execute(context, args) {
  const a = args || {};
  const store = context.scalars();
  if (!store) return AgentToolResult.error('本地标量库未启用（scalars.enabled=false 或没有工程上下文）');

  const key = String(a.key || '').trim();
  const prefix = String(a.prefix || '').trim();
  const query = String(a.query || '').trim();
  const max = Number.isFinite(a.max) && a.max > 0 ? Math.floor(a.max) : 50;
  const out = [];
  if (key) {
    for (const one of key.split(',')) {
      const k = one.trim();
      if (!k) continue;
      const hits = store.query({ key: k, max });
      for (const hit of hits) out.push(hit);
      if (out.length >= max) break;
    }
  }
  if (prefix) {
    const hits = store.query({ prefix, max: max - out.length });
    for (const hit of hits) out.push(hit);
  }
  if (query && typeof store.search === 'function') {
    const hits = store.search({ query, max: max - out.length, minScore: 15 });
    for (const hit of hits) {
      if (out.some((item) => item.key === hit.key)) continue;
      out.push(hit);
    }
  }
  if (out.length === 0) {
    return AgentToolResult.ok(
      '本地标量库无匹配。可用 prefix=node: 列出全部节点 key，或用 query 语义查询；' +
        '若画布尚未被任何画布工具读取/写入，节点属性还未入库。',
      { key: key || null, prefix: prefix || null, query: query || null, count: 0, items: [] }
    );
  }

  const lines = out.map((item) => {
    const value = serializeValue(item.value);
    const kind = item.kind ? '[' + item.kind + '] ' : '';
    const score = typeof item.score === 'number' ? ' score=' + item.score : '';
    return '- ' + item.key + ': ' + kind + value + score;
  });
  const text =
    '本地标量命中 ' + out.length + ' 条' +
    (query ? '（query=' + query + '）' : '') +
    (prefix ? '（prefix=' + prefix + '）' : '') +
    (key ? '（key=' + key + '）' : '') + '。\n' + lines.join('\n');
  return AgentToolResult.ok(text, {
    key: key || null,
    prefix: prefix || null,
    query: query || null,
    count: out.length,
    items: out.map((item) => ({ key: item.key, kind: item.kind || 'scalar', value: item.value, ts: item.ts || 0, exact: !!item.exact, score: typeof item.score === 'number' ? item.score : null })),
  });
}

module.exports = { execute, serializeValue, VALUE_CHAR_CAP };
