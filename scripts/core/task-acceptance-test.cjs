'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TaskAcceptance, freezeContract } = require('../../electron/taskAcceptance.cjs');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs'), sandbox = require('../../electron/sandbox.cjs');
const { installScriptedModel } = require('../lib/scripted-model.cjs');
const agent = require('../../electron/agent.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-acceptance-'));
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['execute_shell', 'write_file', 'read_file'] });
  const controller = new AbortController();
  const context = new AgentToolContext({ projectRoot: root, confirm: async () => true, signal: controller.signal,
    sandbox: sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: root }) });
  const tools = { registry, context };
  const artifact = { version: 1, artifacts: [{ id: 'deliverable', path: 'output.txt', maxBytes: 5 }] };
  const options = acceptance => ({ cfg: { acceptance }, tools, signal: controller.signal });
  try {
    assert.throws(() => freezeContract({ version: 1, artifacts: [{ id: 'a', path: 'x', maxByte: 5 }] }), /未知字段/);
    const runner = new TaskAcceptance(options(artifact));
    artifact.artifacts[0].maxBytes = 999;
    await runner.check(); assert.equal(runner.report.status, 'failed');
    fs.writeFileSync(path.join(root, 'output.txt'), '123456'); await runner.check(); assert.equal(runner.report.status, 'failed');
    fs.writeFileSync(path.join(root, 'output.txt'), '12345'); await runner.check(); assert.equal(runner.report.status, 'passed');
    fs.writeFileSync(path.join(root, 'output.txt'), '54321'); assert.equal(runner.freshness().status, 'stale');
    const noContract = new TaskAcceptance(options(null)); assert.equal((await noContract.check()).status, 'unconfigured'); assert.equal(noContract.blocked(), false);
    fs.writeFileSync(path.join(root, 'value.txt'), 'bad');
    const contract = { version: 1, checks: [{ id: 'public-example', inputs: ['value.txt'], execution: { mode: 'argv', program: process.execPath,
      args: ['-e', 'if(require("fs").readFileSync("value.txt","utf8")!=="good"){console.error("public counterexample");process.exit(1)}'] },
      reproduce: { exitCode: 1, outputIncludes: 'public counterexample' } }] };
    const regression = new TaskAcceptance(options(contract)); await regression.initialize();
    assert.equal(regression.baselines.get('public-example').status, 'passed');
    await regression.check(); assert.equal(regression.report.status, 'failed'); assert.equal(regression.report.checks[1].toolOk, true); assert.equal(regression.report.checks[1].exitCode, 1);
    fs.writeFileSync(path.join(root, 'value.txt'), 'good'); await regression.check(); assert.equal(regression.report.status, 'passed');
    assert.equal(regression.report.checks.every(check => !!check.evidenceId), true);
    fs.writeFileSync(path.join(root, 'value.txt'), 'bad'); assert.equal(regression.freshness().status, 'stale');
    const mutation = new TaskAcceptance(options({version:1,checks:[{id:'mutation',inputs:['value.txt'],execution:{mode:'argv',program:process.execPath,args:['-e','require("fs").writeFileSync("value.txt","changed")']}}]}));
    await mutation.check(); assert.equal(mutation.report.status,'stale');
    const unknown = new TaskAcceptance(options({version:1,checks:[{id:'unknown',inputs:['link.txt'],execution:{mode:'argv',program:process.execPath,args:['-e','process.exit(0)']}}]}));
    fs.symlinkSync(path.join(root,'value.txt'),path.join(root,'link.txt'));
    await unknown.check(); assert.equal(unknown.report.status,'unknown');
    const exhausted = new TaskAcceptance({...options(contract),cfg:{acceptance:contract,limits:{maxTotalToolCalls:1}}});
    await exhausted.initialize(); await exhausted.check(); assert.equal(exhausted.report.verified,false); assert.equal(exhausted.calls,1);
    const denied = new TaskAcceptance({ ...options(contract), cfg: { acceptance: contract, tools: { toolsDeny: ['execute_shell'] } } });
    await denied.initialize(); await denied.check(); assert.equal(denied.report.verified, false); assert.equal(denied.calls, 0);

    async function run(script, acceptance, extra = {}, onDelta = null) {
      const fetch = installScriptedModel(script, { loopLast: true });
      const deltas = [];
      try {
        const result = await agent.runAgentChat({ cfg: { apiBase: 'http://scripted.local/v1', apiKey: 'fixture', model: 'scripted', maxTokens: 1024,
          reliability: { maxAttempts: 1 }, limits: { maxTotalTokens: 100000, maxToolIterations: 8 }, externalVerification: true,
          compression: { enabled: false }, rag: { enabled: false }, tools: {}, acceptance, ...extra },
          messages: [{ role: 'system', content: 'local fixture' }, { role: 'user', content: 'write required output' }], tools, signal: controller.signal, onDelta: delta => { deltas.push(delta); onDelta?.(delta); } });
        return { result, calls: fetch.calls, deltas, seen: fetch.seen };
      } finally { fetch.restore(); }
    }
    fs.rmSync(path.join(root, 'output.txt'));
    const required = { version: 1, artifacts: [{ id: 'required', path: 'output.txt', maxBytes: 5 }] };
    const failed = await run([{ content: 'all tests passed' }], required);
    assert.equal(failed.result.state, 'FAILED'); assert.equal(failed.result.stopReason, 'task_acceptance_failed'); assert.equal(failed.calls, 2); assert.equal(failed.result.taskAcceptance.verified, false); assert.match(failed.result.content,/验收未通过/); assert.ok(JSON.stringify(failed.seen).includes('任务验收契约'));
    const fixed = await run([{ content: 'done' }, { toolCalls: [{ id: 'write', name: 'write_file', args: { path: 'output.txt', content: 'ok' } }] }, { content: 'done' }], required);
    assert.equal(fixed.result.state, 'COMPLETED', fixed.result.error); assert.equal(fixed.result.taskAcceptance.status, 'passed'); assert.equal(fixed.calls, 3);
    fs.rmSync(path.join(root,'output.txt'));
    const budget = new (require('../../electron/requestBudget.cjs').RequestBudget)(1000000);
    const limited = await run([{content:'done'}],required,{requestBudget:budget},delta=>{if(delta.kind==='content')budget.limit=1;});
    assert.equal(limited.calls,1); assert.equal(limited.result.state,'LIMIT_REACHED'); assert.equal(limited.result.taskAcceptance.verified,false);
    const commandRun = await run([{content:'done'}],{version:1,checks:[{id:'simple-command',inputs:['value.txt'],execution:{mode:'argv',program:process.execPath,args:['-e','process.exit(0)']}}]});
    assert.equal(commandRun.result.state,'COMPLETED',commandRun.result.error);
    assert.equal(commandRun.deltas.some(delta=>delta.kind==='state_violation'),false);
    assert.ok(commandRun.deltas.some(delta=>delta.kind==='state'&&delta.state==='WAITING_TOOL'));
    fs.writeFileSync(path.join(root,'value.txt'),'bad');
    const reproduced = await run([{toolCalls:[{id:'fix',name:'write_file',args:{path:'value.txt',content:'good'}}]},{content:'done'}],contract);
    assert.equal(reproduced.result.state,'COMPLETED',reproduced.result.error);
    assert.equal(reproduced.result.taskAcceptance.checks[0].phase,'before');
    assert.equal(reproduced.deltas.some(delta=>delta.kind==='state_violation'),false);
    const plain = await run([{ content: 'done' }], null); assert.equal(plain.result.taskAcceptance.status, 'unconfigured'); assert.equal(plain.calls, 1);
    // A cancelled verification cannot start another command or model request.
    controller.abort();
    const calls = regression.calls; await regression.check(controller.signal); assert.equal(regression.report.status, 'cancelled'); assert.equal(regression.calls, calls);
    console.log('TASK ACCEPTANCE: PASS (frozen contract, artifacts, explicit counterexample, evidence freshness, denial, repair and completion gate)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
