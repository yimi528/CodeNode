'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { StdioRpc } = require('../../electron/backends/stdioRpc.cjs');
const { AcpBackend } = require('../../electron/backends/acp.cjs');
const {BackendPort}=require('../../electron/backends/backendPort.cjs');
const { BuiltinBackend } = require('../../electron/backends/index.cjs');
const settings = require('../../electron/backends/settings.cjs');
const external = require('../../electron/backends/runExternal.cjs');
const runStore = require('../../electron/runStore.cjs');
const { capture, compare } = require('../../electron/backends/workspaceDiff.cjs');
const { launchEnvironment } = require('../../electron/backends/network.cjs');
const sandbox = require('../../electron/sandbox.cjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-backends-')));
const userData = path.join(root, '.userdata');
const fixture = path.join(__dirname, '../fixtures/acp-workflow.cjs');
const preambleFixture = path.join(__dirname, '../fixtures/acp-preamble.cjs');
for (const liveScript of ['agent-backend-live-smoke.cjs', 'agent-backend-live-workflow.cjs']) {
  const source=fs.readFileSync(path.join(__dirname, '../tools', liveScript), 'utf8');
  assert.match(source, /filter\(arg=>arg\.startsWith\('--backends='\)\)\.at\(-1\)/,
    `${liveScript} must let the explicit trailing --backends flag override the npm default`);
}
assert.match(fs.readFileSync(path.join(__dirname,'../tools/agent-backend-live-smoke.cjs'),'utf8'),/args:\[\.\.\.\(config\.defaultArgs\[name\]\|\|\[\]\)\]/,
  'live smoke must launch each backend with its declared default ACP arguments');
const fixtureRpcOptions = [];
class FixtureRpc extends StdioRpc {
  constructor(command, args, cwd, options = {}) {
    fixtureRpcOptions.push(options);
    super(process.execPath, [fixture], cwd, { ...options, spawn: (_file, _args, spawnOptions) => spawn(process.execPath, [fixture], spawnOptions) });
  }
}
const selected = { ...settings.config.defaults, backend: 'codex', executable: process.execPath, sandbox: 'workspace-write' };
const create = () => new BackendPort('codex',selected,new AcpBackend(selected,{StdioRpc:FixtureRpc}));
const cfg = { editing: { autoVerify: true, blockOnFailure: true, lintCommand: 'node -e "process.exit(0)"', testCommand: 'node math.test.cjs' } };
function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      let value;
      try { value = predicate(); } catch {}
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(check, 10);
    };
    check();
  });
}
async function main() {
  const network = await launchEnvironment({ platform: 'win32', env: {}, readProxy: async () => ({ enabled: 1, server: '127.0.0.1:7890', bypass: '<local>;*.example.local' }) });
  assert.equal(network.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(network.proxySource, 'windows-system');
  assert.match(network.env.NO_PROXY, /localhost/); assert.match(network.env.NO_PROXY, /\.example.local/);
  const inherited = await launchEnvironment({ platform: 'win32', env: { HTTPS_PROXY: 'http://explicit:8080', NO_PROXY: 'private.local' }, readProxy: async () => { throw new Error('must not read system'); } });
  assert.equal(inherited.env.HTTPS_PROXY, 'http://explicit:8080'); assert.equal(inherited.env.NO_PROXY, 'private.local');
  const separate = await launchEnvironment({ platform: 'win32', env: {}, readProxy: async () => ({ enabled: 1, server: 'http=127.0.0.1:8080;https=127.0.0.1:8443' }) });
  assert.equal(separate.env.HTTP_PROXY, 'http://127.0.0.1:8080/'); assert.equal(separate.env.HTTPS_PROXY, 'http://127.0.0.1:8443/');
  /** @type {any} */
  let guardedLaunch = null;
  const rpcPolicy = { mode: 'best-effort', externalAgent: true, capabilities: { backend: 'fixture', isolation: { lifetime: true, filesystem: true } } };
  const guardedRpc = new StdioRpc(process.execPath, [fixture], root, { policy: rpcPolicy,
    guardedInteractiveSpawn: (spec, options) => { guardedLaunch = { spec, options }; return spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } });
  await guardedRpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'isolation-test', version: '1' } });
  await guardedRpc.close();
  assert(guardedLaunch, 'StdioRpc did not call guardedInteractiveSpawn');
  assert.equal(guardedLaunch?.options.policy, rpcPolicy, 'StdioRpc must launch external runtimes through guardedInteractiveSpawn');
  const preambleRpc = new StdioRpc(process.execPath, [preambleFixture], root);
  const preambleResult = await preambleRpc.request('initialize', { protocolVersion: 1 });
  assert.equal(preambleResult.protocolVersion, 1, 'bounded startup preamble must not break ACP initialization');
  assert.equal((await preambleRpc.request('ping', {})).pong, true, 'bounded stdout status after initialization must not desynchronize JSON-RPC');
  assert.match(preambleRpc.stderrTail.join('\n'), /stdout noise.*Rich status after initialize/);
  assert.equal(require('../../config/agent.backends.json').maxStdoutNoiseLines, 512);
  assert.equal(require('../../config/agent.backends.json').maxStdoutNoiseBytes, 262144);
  await preambleRpc.close();
  console.log('BACKEND TEST STAGE: proxy/settings');
  assert.equal(settings.read(root, userData).settings.backend, 'builtin');
  settings.write(root, userData, 'machine', selected);
  const handlers=new Map();
  const ipcMain={handle:(name,handler)=>handlers.set(name,handler)},agentIpc=require('../../electron/ipc/agent.cjs');
  agentIpc.register({ipcMain,userDataDir:()=>userData});
  require('../../electron/ipc/backend.cjs').register({ipcMain,userDataDir:()=>userData,activeRequests:agentIpc.activeRequests,
    agent:require('../../electron/agent.cjs'),sandbox:require('../../electron/sandbox.cjs')});
  const storedBytes=fs.readFileSync(path.join(userData,'backend.json'),'utf8');
  const preview=await handlers.get('agent:backend-status')({},root,{...settings.config.defaults,backend:'builtin'});
  assert.equal(preview.ok,true);assert.equal(preview.capabilities.backend,'builtin','connection check uses unsaved selected settings instead of saved Codex');
  assert.equal(preview.settings.backend,'codex');assert.equal(preview.checkedSettings.backend,'builtin');
  assert.equal(fs.readFileSync(path.join(userData,'backend.json'),'utf8'),storedBytes,'connection check never overwrites saved settings');
  assert.equal((await handlers.get('agent:backend-status')({},root,{...selected,backend:'openclaw',args:['acp','--token','secret']})).ok,false,'preview rejects credential-bearing args before starting a runtime');
  settings.write(root, userData, 'project', { ...selected, sandbox: 'read-only' });
  assert.equal(settings.read(root, userData).settings.sandbox, 'read-only');
  settings.write(root, userData, 'project', null);
  assert.equal(settings.read(root, userData).settings.sandbox, 'workspace-write');
  assert.throws(() => settings.normalize({ ...selected, sandbox: 'danger-full-access' }));
  assert.throws(() => settings.normalize({ ...selected, backend: 'openclaw', args: ['acp', '--token', 'sample-secret'] }), /不能保存明文密钥/);
  assert.throws(() => settings.normalize({ ...selected, backend: 'openclaw', args: ['acp', '--password=sample-secret'] }), /不能保存明文密钥/);
  const agent = require('../../electron/agent.cjs');
  const original = agent.runAgentChat;
  const value = /** @type {any} */ ({ content: 'unchanged', usage: { total_tokens: 9 }, state: 'COMPLETED' });
  let count = 0;
  agent.runAgentChat = async input => { count++; assert.equal(input.cfg.test, true); return value; };
  try { assert.equal(await require('../../electron/backends/index.cjs').createBackend('builtin').submit({ cfg: { test: true } }), value); assert.equal(count, 1); }
  finally { agent.runAgentChat = original; }
  console.log('BACKEND TEST STAGE: builtin delegation');
  const probe=create();try{assert.equal((await probe.health({projectRoot:root})).available,true);}finally{await probe.close();}
  console.log('BACKEND TEST STAGE: Codex capabilities');
  const readOnlyRoot = path.join(root, 'readonly-project'); fs.mkdirSync(readOnlyRoot);
  const readOnly = new AcpBackend({ ...selected, sandbox: 'read-only' }, {StdioRpc:FixtureRpc});
  const deniedEvents = [];
  await readOnly.run({ projectRoot: readOnlyRoot, prompt: 'resume-edit', confirm: async () => true, onDelta: event => deniedEvents.push(event) });
  assert.equal(fs.existsSync(path.join(readOnlyRoot, 'math.cjs')), false, 'Read-only must decline escalation even after a dialog accepts');
  assert(deniedEvents.some(event => event.kind === 'backend_approval' && event.phase === 'denied'));
  console.log('BACKEND TEST STAGE: read-only permission');
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  fs.writeFileSync(path.join(root, 'math.test.cjs'), "require('assert').strictEqual(require('./math.cjs')(2,3),5);\n");
  const events = []; const controller = new AbortController();
  const fakeCaps = { platform: 'fixture', backend: 'sandbox-exec', isolation: { lifetime: true, processCount: false, memory: false, cpu: false, filesystem: true, network: true }, detail: 'fixture' };
  const sandboxPolicy = sandbox.resolvePolicy({ mode: 'best-effort', network: 'deny' }, { projectRoot: root, userDataDir: userData, capabilities: fakeCaps });
  const common = { projectRoot: root, settings: selected, cfg, history: [], canvasSummary: 'task → end', sandboxPolicy,
    sessionId: 'canvas-session', onDelta: event => {
      events.push(event);
      if (event.kind === 'start' || event.kind === 'backend_approval' || (event.kind === 'state' && ['RUNNING','WAITING_USER','CANCELLED'].includes(event.state))) {
        console.log('BACKEND TEST EVENT: ' + event.kind + (event.phase ? ':' + event.phase : '') + (event.state ? ':' + event.state : ''));
      }
    } };
  const firstPending = external.runExternal({ ...common, requestId: 'first', prompt: 'interrupt-test', signal: controller.signal,
    confirm: async () => false }, { createBackend: create });
  await waitFor(() => events.some(event => event.kind === 'backend_approval' && event.phase === 'denied'), 'Codex fixture did not request and receive a denial');
  await waitFor(() => external.sessionFromRun(root, 'first')?.session?.sessionId === 'acp-workflow', 'Codex turn handle was not persisted before cancellation');
  controller.abort();
  const first = await firstPending;
  assert.equal(first.state, 'CANCELLED');
  assert.equal(first.aborted, true);
  assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
  assert(events.some(e => e.kind === 'backend_approval' && e.phase === 'denied'));
  assert(!events.some(e => e.kind === 'command'), 'Protocol fields must not overwrite host event kind');
  assert(fixtureRpcOptions.some(options => options.policy?.externalAgent === true && options.policy.network === 'inherit'), 'External runtime policy was not passed to the ACP transport');
  const isolationEvent = events.find(event => event.kind === 'backend_info' && event.info?.externalAgentIsolation);
  assert.equal(isolationEvent.info.externalAgentIsolation.filesystemIsolation, true);
  assert.equal(isolationEvent.info.externalAgentIsolation.osSandboxEnforcedByCodeNode, true);
  console.log('BACKEND TEST STAGE: cancelled run persisted');
  const record = external.sessionFromRun(root, 'first');
  assert.equal(record.session.sessionId,'acp-workflow');assert.equal(record.session.protocol,'acp');
  const plan = external.resumePlan(root, 'first', new Set());
  assert.equal(plan.requiresReview, true);
  const review = await external.runExternal({ ...common, requestId: 'review', prompt: 'resume-edit', resumeRunId: 'first', confirm: async () => true }, { createBackend: create });
  assert.equal(review.needsReview, true);
  console.log('BACKEND TEST STAGE: review gate');
  let checks = 0;
  const resumed = await external.runExternal({ ...common, requestId: 'resumed', prompt: 'resume-edit', resumeRunId: 'first', resumeForce: true,
    confirm: async () => true }, { createBackend: create, verifyRun: async (hook) => {
      checks++; const output = execFileSync(process.execPath, hook.command.startsWith('node -e') ? ['-e', 'process.exit(0)'] : ['math.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
      return { ok: true, output, exitCode: 0 };
    } });
  assert.equal(resumed.ok, true); assert.equal(resumed.reply, '修改完成');
  assert.equal(resumed.usage.total_tokens, 13, 'ACP usage should remain per-turn');
  assert.equal(resumed.codeVerification.verified, true); assert.equal(checks, 2);
  console.log('BACKEND TEST STAGE: resumed run verified');
  assert(resumed.changes.files.some(file => file.path === 'math.cjs' && file.before !== file.after));
  assert.equal(resumed.costUnknown, true);
  const duplicate = await external.runExternal({ ...common, requestId: 'resumed', prompt: 'resume-edit', confirm: async () => true }, { createBackend: create });
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已有执行记录/);
  // A completed model turn cannot admit downstream work when independent
  // validation fails. Change real inputs so another validation is required.
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  const rejected = await external.runExternal({ ...common, requestId: 'verification-failed', prompt: 'resume-edit',
    confirm: async () => true }, { createBackend: create,
    verifyRun: async () => ({ ok: false, output: 'independent check failed', exitCode: 1 }) });
  assert.equal(rejected.ok, false); assert.equal(rejected.stopReason, 'verification_unavailable');
  assert.equal(rejected.codeVerification.verified, false);
  fs.writeFileSync(path.join(root, 'math.cjs'), 'module.exports = (a,b) => a - b;\n');
  const outOfScope = await external.runExternal({ ...common, requestId: 'goal-scope-violation', prompt: 'resume-edit', goalWriteScope: ['docs'],
    confirm: async () => true }, { createBackend: create, verifyRun: async () => ({ ok: true, output: 'passes', exitCode: 0 }) });
  assert.equal(outOfScope.ok, false); assert.equal(outOfScope.stopReason, 'goal_scope_violation');
  console.log('BACKEND TEST STAGE: scope violation');
  assert.deepEqual(outOfScope.goalScopeViolations, ['math.cjs']);
  assert.match(fs.readFileSync(path.join(root, 'math.cjs'), 'utf8'), /module\.exports/, 'out-of-scope changes stay available for review');
  assert.equal(runStore.summarizeRun(runStore.readRun(root, 'resumed')).stateHistoryValid, true);
  const calls = fs.readFileSync(path.join(root, '.codenode/fixture-rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.some(c=>c.method==='session/load'));assert(calls.some(c=>c.method==='session/cancel'));assert.equal(calls.find(c=>c.method==='session/new').params.cwd,root);
  const disconnected = await external.runExternal({ ...common, requestId: 'disconnected', sessionId: 'other', prompt: 'disconnect-test', confirm: async () => false }, { createBackend: create });
  assert.equal(disconnected.stopReason, 'backend_result_unknown');
  const blocked = await external.runExternal({ ...common, requestId: 'blocked', prompt: 'resume-edit', resumeRunId: 'disconnected', resumeForce: true, confirm: async () => true }, { createBackend: create });
  assert.equal(blocked.ok, false); assert.match(blocked.error, /仍在运行/);
  console.log('BACKEND TEST STAGE: disconnect and duplicate guard');
  const before = capture(root); fs.writeFileSync(path.join(root, 'new.txt'), 'new'); fs.unlinkSync(path.join(root, 'math.cjs'));
  const files = compare(before, capture(root)).files;
  assert(files.some(f => f.path === 'new.txt' && f.kind === 'added'));
  assert(files.some(f => f.path === 'math.cjs' && f.kind === 'deleted'));
  console.log('AGENT BACKENDS: PASS (real RPC transport, denial, confirmed interruption, persisted resume, unknown-result guard, file fingerprints, independent tests, cumulative usage, settings scopes, builtin delegation)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-backends-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries:10, retryDelay:200 });
});
