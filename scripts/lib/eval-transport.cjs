'use strict';
const fs = require('node:fs');
const { atomicJson, readJson, redact } = require('./eval-protocol.cjs');
const crypto = require('node:crypto');

function createLedger(file, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw Error('总 token 上限必须是正整数');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, ledgerId: crypto.randomUUID(), limit, charged: 0, reported: 0, reservations: {}, attempts: [] }), { flag: 'wx', mode: 0o600 });
}
function update(file, fn) {
  const lock = file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600); // Contention fails closed; never bypass a budget lock.
  try { const ledger = readJson(file); const result = fn(ledger); atomicJson(file, ledger); return result; }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function reserve(file, tokens, identity) {
  return update(file, ledger => {
    const pending = Object.values(ledger.reservations).reduce((n, v) => n + Number(v), 0);
    if (ledger.charged + pending + tokens > ledger.limit) throw Object.assign(Error('EVAL_TOKEN_BUDGET: 总预算不足以发出下一请求'), { code: 'EVAL_TOKEN_BUDGET' });
    const id = crypto.randomUUID(); ledger.reservations[id] = tokens;
    ledger.attempts.push({ id, identity, reserved: tokens, state: 'pending', startedAt: new Date().toISOString() });
    return id;
  });
}
function settle(file, id, usage) {
  update(file, ledger => {
    if (!Object.hasOwn(ledger.reservations, id)) throw Error('预算预留不存在');
    const reserved = ledger.reservations[id];
    const known = Number.isSafeInteger(usage) && usage >= 0;
    ledger.charged += known ? Math.max(usage, 0) : reserved;
    ledger.reported += known ? usage : 0;
    const attempt = ledger.attempts.find(a => a.id === id);
    Object.assign(attempt, { state: known ? 'reported' : 'unknown-billing', reported: known ? usage : null, charged: known ? usage : reserved });
    delete ledger.reservations[id];
    if (known && usage > reserved) ledger.boundViolation = true;
  });
}
function usageFrom(text) {
  let usage = null;
  for (const line of [text, ...text.split('\n').filter(s => s.startsWith('data:')).map(s => s.slice(5).trim())]) {
    try { const value = JSON.parse(line); if (Number.isSafeInteger(value.usage?.total_tokens)) usage = value.usage.total_tokens; }
    catch {}
  }
  return usage;
}
function responseMetadata(text) {
  let metadata={model:null,responseId:null,systemFingerprint:null};
  for(const line of [text,...text.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trim())]) {
    try {const value=JSON.parse(line);if(value.model)metadata.model=value.model;if(value.id)metadata.responseId=value.id;if(value.system_fingerprint)metadata.systemFingerprint=value.system_fingerprint;} catch {}
  }
  return metadata;
}
function instrumentFetch(delegate, writer, options = /** @type {any} */ ({})) {
  return async (url, init) => {
    let body; try { body = JSON.parse(String(init?.body || '{}')); } catch { body = {}; }
    const llm = !!body.model && (Array.isArray(body.messages) || body.input != null);
    if (!llm) return delegate(url, init);
    const address = String(url?.url || url);
    if (options.apiBase && !address.startsWith(options.apiBase.replace(/\/+$/, '') + '/')) throw Error('EVAL_ENDPOINT: 模型请求超出已声明端点');
    const maxOutput = Number(body.max_tokens || body.max_completion_tokens || 4096);
    if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0) throw Error('无效生成预算');
    // UTF-8 bytes conservatively bound byte-level tokenization, with an extra envelope allowance.
    const reservation = Buffer.byteLength(JSON.stringify(body), 'utf8') + maxOutput + 16384;
    const ticket = options.ledger ? reserve(options.ledger, reservation, writer.trialId) : null;
    writer.append('requests.jsonl', { at: new Date().toISOString(), url: address, body, reservedTokens: ticket ? reservation : null });
    let settled = false;
    const finish = (usage,metadata=null) => { if (!settled) { settled = true; writer.append('requests.jsonl',{kind:'response-usage',requestId:ticket,usage:usage??null,observed:metadata}); if (ticket) settle(options.ledger, ticket, usage); } };
    try {
      const response = await delegate(url, init);
      writer.append('requests.jsonl', { responseStatus: response.status, requestId: ticket, at: new Date().toISOString() });
      if (!response.body) { finish(null); return response; }
      const reader = response.body.getReader(); let collected = '';
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish(usageFrom(collected),responseMetadata(collected)); controller.close(); return; }
            if (collected.length < 8 * 1024 * 1024) collected += Buffer.from(next.value).toString('utf8');
            if (collected.includes('data: [DONE]')) finish(usageFrom(collected),responseMetadata(collected));
            controller.enqueue(next.value);
          } catch (error) { finish(null); controller.error(error); }
        },
        async cancel(reason) { finish(null,responseMetadata(collected)); await reader.cancel(reason); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { writer.append('requests.jsonl',{kind:'transport-error',at:new Date().toISOString(),code:error.cause?.code||error.code||error.name,message:String(error.message)}); finish(null); throw error; }
  };
}
module.exports = { createLedger, reserve, settle, usageFrom, instrumentFetch, redact };
