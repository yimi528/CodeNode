'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGuard, PREFIX } = require('../../electron/noProgressGuard.cjs');
const agent = require('../../electron/agent.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const { installScriptedModel } = require('../lib/scripted-model.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-no-progress-'));
fs.writeFileSync(path.join(root, 'app.js'), 'const value = 1;\n');
fs.writeFileSync(path.join(root, 'a.txt'), 'READ-EVIDENCE\n');
const canonical = raw => {
  const parsed = JSON.parse(raw || '{}');
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))));
};
function harness(extra = {}) {
  const events = [], messages = [{ role: 'user', content: '完成任务' }], records = [];
  const guard = createGuard({ root, limits: { noProgressDetection: true, noProgressRounds: 2 }, canonicalArgs: canonical,
    emitTrace: e => events.push(e), ...extra });
  return { events, messages, records, step(record, epoch = 'same') { records.push(record); guard.update(messages, records, epoch); },
    warnings() { return events.filter(e => e.kind === 'no_progress_detected'); } };
}
const read = (result = 'same', args = '{}') => ({ name: 'read_file', args, ok: true, result, data: {} });
const shell = () => ({ name: 'execute_shell', args: '{"command":"npm test"}', ok: true, result: 'test fails', data: { output: 'same error', exitCode: 1 } });

async function run(enabled) {
  const script = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [{ id: 'read-' + i, name: 'read_file', args: { path: 'a.txt' } }] }));
  const stub = installScriptedModel([...script, { content: '完成' }], { loopLast: false });
  const events = [];
  try {
    const result = await agent.runAgentChat({ cfg: { apiBase: 'http://scripted.local', apiKey: 'synthetic', model: 'fixture', maxTokens: 1024,
      reliability: { maxAttempts: 1 }, limits: { maxToolIterations: 10, noProgressDetection: enabled, noProgressRounds: 2 },
      externalVerification: true, compaction: { enabled: false }, compression: { enabled: false }, context: { enabled: false } },
      messages: [{ role: 'system', content: 'Test' }, { role: 'user', content: '完成任务' }],
      tools: { registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] }),
        context: new AgentToolContext({ projectRoot: root, audit: () => {} }) }, onDelta: e => events.push(e) });
    return { result, seen: stub.seen, events };
  } finally { stub.restore(); }
}

(async () => {
  const h = harness(); h.step(read('same', '{"a":1,"b":2}')); h.step(read('same', '{"b":2,"a":1}'));
  assert.equal(h.warnings().length, 0); h.step(read('same', '{"a":1,"b":2}'));
  assert.equal(h.warnings().length, 1, 'Repeated parameters/results, including canonical ordering, trigger a hint');
  for (let i = 0; i < 10; i++) h.step(read('same', '{"a":1,"b":2}'));
  assert.equal(h.warnings().length, 2); assert.equal(h.messages.filter(m => m.content.startsWith(PREFIX)).length, 1);
  assert.equal(require('../../electron/compaction.cjs').isMachineInjectedUserMessage(h.messages.at(-1).content), true);
  const cycles = harness(); for (const s of ['A', 'B', 'A', 'B']) cycles.step(read(s, JSON.stringify({ probe: s })));
  assert.equal(cycles.warnings().length, 1, 'Alternating known actions do not evade detection');
  const newEvidence = harness(); for (let i = 0; i < 10; i++) newEvidence.step(read('result-' + i));
  assert.equal(newEvidence.warnings().length, 0);
  const waiting = harness(); for (let i = 0; i < 8; i++) waiting.step({ name: 'poll_job', args: '{}', ok: true, result: 'same', data: { status: 'running' } });
  assert.equal(waiting.warnings().length, 0);
  for (let i = 0; i < 8; i++) waiting.step({ name: 'get_subagent_task', args: '{}', ok: true, result: 'same', data: { task: { status: 'pending' } } });
  assert.equal(waiting.warnings().length, 0);
  const writes = harness();
  for (let i = 0; i < 8; i++) writes.step({ name: 'write_file', args: '{}', ok: true, result: 'written', data: { path: 'app.js', sha256: String(i % 2) } });
  assert.equal(writes.warnings().length, 0, 'Actual version changes count even when alternating between known versions');
  const changed = harness(); changed.step(shell()); changed.step(shell());
  fs.writeFileSync(path.join(root, 'app.js'), 'const value = 2;\n'); changed.step(shell()); changed.step(shell());
  assert.equal(changed.warnings().length, 0, 'The same test after code changes gets a fresh observation baseline');
  changed.step(shell()); assert.equal(changed.warnings().length, 1);
  changed.step({ ...shell(), data: { output: 'test now passes', exitCode: 0 } });
  assert.equal(changed.warnings().length, 1, 'Changed test result resets stagnation');
  assert.match(changed.messages.at(-1).content, /计数已重置/);
  const unknown = harness({ snapshot: () => ({ complete: false, fingerprint: 'unknown' }) });
  for (let i = 0; i < 8; i++) unknown.step(shell()); assert.equal(unknown.warnings().length, 0);
  const steer = harness(); steer.step(read()); steer.step(read()); steer.step(read(), 'new-user-direction');
  assert.equal(steer.warnings().length, 0);
  const interact = harness(); for (let i = 0; i < 6; i++) interact.step({ name: 'ask_user', args: '{}', ok: true, result: 'same answer' });
  assert.equal(interact.warnings().length, 0);
  const configured = require('../../electron/agentRuntimeConfig.cjs').parseLimitsConfig;
  assert.equal(configured({}).noProgressDetection, false); assert.equal(configured({}).noProgressRounds, 3);
  assert.equal(configured({ 'agent.no_progress.enabled': 'true' }).noProgressDetection, true);
  assert.equal(configured({ 'agent.no_progress.enabled': 'false # experiment off' }).noProgressDetection, false);
  assert.equal(configured({ 'agent.no_progress.enabled': 'false' }).noProgressDetection, false);
  assert.equal(configured({ 'agent.no_progress.rounds': '100' }).noProgressRounds, 20);
  const error = harness(); for (let i = 0; i < 3; i++) error.step({ name: 'read_file', args: '{}', ok: false, result: 'missing', failure: { code: 'NOT_FOUND' } });
  assert.equal(error.warnings().length, 1);
  const controller = new AbortController(); const cancelled = harness({ signal: controller.signal }); controller.abort();
  for (let i = 0; i < 4; i++) cancelled.step(read()); assert.equal(cancelled.events.length, 0);
  const on = await run(true), off = await run(false);
  assert.equal(on.result.state, 'COMPLETED'); assert.equal(on.seen.length, off.seen.length); assert.equal(on.result.toolCalls.length, 6);
  assert.equal(on.events.filter(e => e.kind === 'no_progress_detected').length, 2);
  assert.equal(off.events.filter(e => e.kind === 'no_progress_detected').length, 0);
  assert.ok(on.seen[3].messages.some(m => m.content?.startsWith(PREFIX)), 'Hint is actually sent to the next model request');
  assert.ok(off.seen.every(request => request.messages.every(m => !m.content?.startsWith(PREFIX))));
  console.log('NO PROGRESS: PASS (bounded strategy hints, cycles, new evidence, code changes, waits, cancellation, real tool loop)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
