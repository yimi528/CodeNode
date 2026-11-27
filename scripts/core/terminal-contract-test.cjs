'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs');
const sandbox = require('../../electron/sandbox.cjs');
const { matchesCurrentFile } = require('../../electron/tools/readFileCache.cjs');
const { resourceKeysFor } = require('../../electron/tools/leases.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-contract-')), app = path.join(root, 'app');
  const old = process.env.CODENODE_BENCHMARK_CONTAINER;
  fs.mkdirSync(app); fs.mkdirSync(path.join(root, 'other')); fs.writeFileSync(path.join(root, 'other', 'data.txt'), 'external');
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: app, ragEnabled: false,
    toolsAllowed: ['execute_shell', 'poll_job', 'write_file', 'edit_file', 'read_file', 'search_files', 'find_files', 'list_directory'] });
  const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: app, userDataDir: app });
  const host = new AgentToolContext({ projectRoot: app, sandbox: policy, confirm: async () => true });
  const exec = (args, context = host) => registry.execute('execute_shell', args, context);
  try {
    assert.throws(() => new AgentToolContext({ projectRoot: app, accessRoot: root }), /expansion/);
    assert.equal((await exec({ command: 'node --version | tail -1' })).ok, false);
    assert.equal((await exec({ mode: 'shell', command: 'echo nope' })).ok, false);
    assert.equal((await exec({ command: 'ls' })).ok, false);
    const literal = ['', 'a b', "single'quote", 'double"quote', '|', '2>&1', '&&', '$HOME', '\\'];
    const args = { mode: 'argv', program: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...literal] };
    const result = await exec(args);
    assert.equal(result.ok, true, result.text); assert.equal(result.data.exitCode, 0); assert.deepEqual(JSON.parse(result.data.output), literal);
    assert.equal((await exec({ ...args, command: 'node --version' })).ok, false);
    assert.equal((await exec({ ...args, cwd: '..' })).ok, false);
    const deny = new AgentToolContext({projectRoot:app,sandbox:policy,confirm:async()=>false});
    for (const code of ['require("fs").writeFileSync("/outside-test/blocked.txt","x")',"require('fs').writeFileSync('/outside-test/blocked.txt','x')"]) {
      const blocked = await exec({mode:'argv',program:'node',args:['-e',code]},deny);
      assert.equal(blocked.data.code,'PATH_OUT_OF_ROOT',blocked.text);
    }
    const offline = new AgentToolContext({projectRoot:app,sandbox:sandbox.resolvePolicy({mode:'off',network:'deny'},{projectRoot:app}),confirm:async()=>false});
    assert.equal((await exec({mode:'argv',program:'node',args:['-e','fetch("https://fixture.invalid")']},offline)).data.code,'PERMISSION_DENIED');
    process.env.CODENODE_BENCHMARK_CONTAINER = '1';
    const controller = new AbortController();
    const context = new AgentToolContext({ projectRoot: app, accessRoot: root, benchmarkContainer: true, sandbox: policy, signal: controller.signal, confirm: async () => true });
    const sh = await exec({ command: "printf '%s\\n' 'a b' \"c d\" | head -1 > 'result file.txt' && cat 'result file.txt'" }, context);
    assert.equal(sh.ok, true, sh.text); assert.equal(sh.data.exitCode, 0); assert.equal(sh.data.output, 'a b\n');
    assert.equal(sh.data.executionMode, 'shell'); assert.equal(path.resolve(sh.data.cwd), app);
    assert.equal(fs.readFileSync(path.join(app, 'result file.txt'), 'utf8'), 'a b\n');
    const changed = await exec({ mode: 'shell', command: 'pwd', cwd: '../other' }, context);
    assert.equal(changed.data.cwd, path.join(root, 'other'));
    assert.equal((await exec({ command: 'pwd' }, context)).data.cwd, app);
    const written = await registry.execute('write_file', { path: 'parallel_linear.py', content: 'x = 1\n' }, context);
    assert.equal(written.ok, true, written.text); assert.equal(fs.existsSync(path.join(app, 'parallel_linear.py')), true); assert.equal(fs.existsSync(path.join(root, 'parallel_linear.py')), false);
    const external = path.join(root, 'other', 'data.txt');
    const read = await registry.execute('read_file', { path: external }, context);
    assert.equal(read.ok, true, read.text); assert.equal(await matchesCurrentFile(context, { path: external }, read), true);
    fs.writeFileSync(external, 'modified'); assert.equal(await matchesCurrentFile(context, { path: external }, read), false);
    const options = { projectRoot: app, accessRoot: root };
    assert.deepEqual(resourceKeysFor('write_file', { path: 'parallel_linear.py' }, options), resourceKeysFor('write_file', { path: path.join(app, 'parallel_linear.py') }, options));
    fs.symlinkSync(os.tmpdir(), path.join(app, 'escape'));
    assert.equal((await registry.execute('write_file', { path: 'escape/denied.txt', content: 'no' }, context)).ok, false);
    fs.writeFileSync(path.join(app, '.env'), 'SECRET=fixture'); fs.symlinkSync(path.join(app, '.env'), path.join(app, 'innocent.txt'));
    assert.equal((await registry.execute('read_file', { path: 'innocent.txt' }, context)).ok, false);
    assert.equal((await registry.execute('write_file', { path: '.codenode/approvals.json', content: '{}' }, context)).ok, false);
    const bg = await exec({ command: "printf 'background'", async: true, cwd: '../other' }, context);
    assert.equal(bg.ok, true, bg.text);
    const done = await registry.execute('poll_job', { jobId: bg.data.jobId, waitSeconds: 1 }, context);
    assert.equal(done.data.exitCode, 0, done.text); assert.equal(done.data.cwd, path.join(root, 'other')); assert.equal(done.data.output, 'background');
    const cancel = exec({ mode: 'argv', program: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] }, context);
    setTimeout(() => controller.abort(), 50);
    assert.equal((await cancel).ok, false);
    console.log('TERMINAL CONTRACT: PASS (literal argv, POSIX shell, cwd/access boundary, cache, leases, background and cancellation)');
  } finally {
    if (old == null) delete process.env.CODENODE_BENCHMARK_CONTAINER; else process.env.CODENODE_BENCHMARK_CONTAINER = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
