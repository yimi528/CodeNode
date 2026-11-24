'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../../electron/agent.cjs');
const { RequestBudget } = require('../../electron/requestBudget.cjs');
const { planWrapUp, finishBudgetWork } = require('../../electron/budgetWrapUp.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const { installScriptedModel } = require('../lib/scripted-model.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-budget-wrapup-'));
fs.writeFileSync(path.join(root, 'large.txt'), 'DATA'.repeat(2500));
const suggestion = JSON.stringify({ remaining: ['核对验收条件'], nextSteps: ['运行针对性测试'] });

async function run(options = {}) {
  const budget = options.budget || new RequestBudget(14000);
  const signal = new AbortController();
  const stub = installScriptedModel([
    { toolCalls: [{ name: 'read_file', args: { path: 'large.txt' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    options.response || { content: suggestion, usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } },
  ], { loopLast: false });
  const context = new AgentToolContext({ projectRoot: root, signal: signal.signal, audit: () => {} });
  const checkpoints = [], deltas = [];
  context.checkpointMessages = (...args) => checkpoints.push(args);
  const cfg = { model: 'fixture', apiBase: 'http://scripted.local', apiKey: 'synthetic', maxTokens: 1024,
    requestBudget: budget, externalVerification: true, reliability: { maxAttempts: 3, streamMaxAttempts: 2, retryBaseMs: 1 },
    limits: { maxToolIterations: 5, budgetWrapUp: options.enabled !== false }, context: { enabled: false },
    compaction: { enabled: false }, compression: { enabled: false }, grounding: options.grounding };
  try {
    const result = await agent.runAgentChat({ cfg, messages: [{ role: 'system', content: '测试任务' }, { role: 'user', content: '检查文件并完成修改' }],
      tools: { registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] }), context },
      signal: signal.signal, onDelta: delta => { deltas.push(delta); if (options.cancel && delta.kind === 'budget_wrapup') signal.abort(); } });
    return { result, seen: stub.seen, budget, checkpoints, deltas };
  } finally { stub.restore(); }
}

(async () => {
  const happy = await run();
  assert.equal(happy.result.state, 'LIMIT_REACHED'); assert.equal(happy.result.stopReason, 'token_limit');
  assert.equal(happy.seen.length, 2); assert.equal(happy.seen[1].hasTools, false);
  assert.equal(happy.result.toolCalls.length, 1); assert.deepEqual(happy.result.wrapUp.suggestions, JSON.parse(suggestion));
  assert.match(happy.result.content, /任务未完成/); assert.match(happy.result.content, /不能据此声明测试通过/);
  assert.equal(happy.budget.used, 340); assert.equal(happy.budget.reserved, 0);
  assert.equal(happy.result.usage.total_tokens, 340);
  assert.ok(happy.checkpoints.some(c => c[1] === 'budget_wrapup'));
  assert.ok(happy.deltas.some(d => d.kind === 'limit_reached' && d.wrapUp));
  const invalid = await run({ response: { content: '全部完成，所有测试通过。' } });
  assert.equal(invalid.result.wrapUp.suggestions, null); assert.doesNotMatch(invalid.result.content, /所有测试通过/);
  const failed = await run({ response: { httpStatus: 500 } });
  assert.equal(failed.seen.length, 2, 'No retry or fallback is allowed for the closing request');
  assert.equal(failed.result.state, 'LIMIT_REACHED'); assert.ok(failed.result.wrapUp);
  assert.equal(failed.budget.reserved, 0); assert.ok(failed.budget.unknownSettlements > 0);
  assert.ok(failed.budget.used <= failed.budget.limit);
  const unwantedTool = await run({ response: { toolCalls: [{ name: 'write_file', args: { path: 'unexpected.txt', content: 'bad' } }] } });
  assert.equal(unwantedTool.result.toolCalls.length, 1); assert.equal(fs.existsSync(path.join(root, 'unexpected.txt')), false);
  assert.equal(unwantedTool.result.wrapUp.suggestions, null);
  const cancelled = await run({ cancel: true });
  assert.equal(cancelled.seen.length, 1); assert.equal(cancelled.result.aborted, true);
  const disabled = await run({ enabled: false });
  assert.equal(disabled.result.wrapUp, undefined); assert.equal(disabled.result.state, 'COMPLETED');
  const ample = await run({ budget: new RequestBudget(1000000) });
  assert.equal(ample.result.wrapUp, undefined); assert.equal(ample.seen[1].hasTools, true);

  const record = { name: 'execute_shell', ok: false, result: 'test failed', data: { command: 'npm test', exitCode: 1 }, failure: { code: 'TEST_FAILED' } };
  const messages = [{ role: 'user', content: '任务' }, { role: 'assistant', content: 'x'.repeat(20000) }];
  const parent = new RequestBudget(100);
  const child = new RequestBudget(1000000, { parent });
  const cfg = { model: 'fixture', maxTokens: 1024, limits: { budgetWrapUp: true }, requestBudget: child };
  assert.equal(planWrapUp(cfg, messages, [], [record], null).canSend, false);
  let calls = 0;
  const local = await finishBudgetWork({ cfg, messages, tools: [], toolCalls: [record], verification: { status: 'stale', verified: false },
    chat: async () => { calls++; throw new Error('must not send'); }, makeWrapUp: agent.buildLimitWrapUp,
    emitTrace: () => {}, finalizeState: require('../../electron/agentState.cjs').describeOutcome, modelTurns: 1 });
  assert.equal(calls, 0); assert.match(local.content, /stale/); assert.equal(local.wrapUp.verification.verified, false);
  assert.equal(local.wrapUp.failed[0].code, 'TEST_FAILED'); assert.equal(parent.used, 0);
  const exhausted = await finishBudgetWork({ cfg, messages, toolCalls: [record], forced: true, stopReason: 'token_limit',
    checkpoint: () => { throw new Error('disk unavailable'); }, emitTrace: () => {}, makeWrapUp: agent.buildLimitWrapUp,
    finalizeState: require('../../electron/agentState.cjs').describeOutcome, modelTurns: 1 });
  assert.equal(exhausted.state, 'LIMIT_REACHED'); assert.ok(exhausted.wrapUp, 'Checkpoint failures must not discard handoff evidence');
  const costLimited = new RequestBudget(14000, { costLimitUsd: 0.000001, prices: { fixture: { in: 100, out: 100 } } });
  const cost = await run({ budget: costLimited });
  assert.equal(cost.seen.length, 0); assert.equal(cost.result.stopReason, 'cost_limit'); assert.ok(cost.result.wrapUp);
  assert.equal(costLimited.used, 0); assert.equal(costLimited.reserved, 0);
  const cancelledCost = await run({ cancel: true, budget: new RequestBudget(14000, { costLimitUsd: 0.000001, prices: { fixture: { in: 100, out: 100 } } }) });
  assert.equal(cancelledCost.result.aborted, true); assert.equal(cancelledCost.seen.length, 0);
  const strict = await run({ grounding: { mode: 'enforce' } });
  assert.equal(strict.result.state, 'LIMIT_REACHED'); assert.match(strict.result.content, /任务未完成/);
  console.log('BUDGET WRAPUP: PASS (one tool-free request, factual fallback, accounting, parent/cost caps, cancellation, checkpoint)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
