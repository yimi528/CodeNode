'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, "../..");
const { LocalRagIndex, getProjectIndex, invalidateProjectIndex, clearIndexCache } = require(path.join(moduleRoot, 'electron/rag/index.cjs'));
const { queryNavigation } = require(path.join(moduleRoot, 'electron/rag/symbolNavigation.cjs'));
const { AgentToolContext } = require(path.join(moduleRoot, 'electron/tools/context.cjs'));
const toolkit = require(path.join(moduleRoot, 'electron/tools/toolkit.cjs'));
const descriptorLib = require(path.join(moduleRoot, 'electron/tools/descriptor.cjs'));
const { classify } = require(path.join(moduleRoot, 'electron/sideEffects.cjs'));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-symbols-'));
  const indexes = [];
  const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
  try {
    write('a.ts', '// Unicode 注释\r\nexport function go(value: number) { return value + 1; }\r\nexport default function primary() { return go(1); }\r\n');
    write('b.ts', 'export function go() { return 99; }\n');
    write('use.ts', "import { go as run } from './a';\nimport * as api from './a';\nimport main from './a';\nexport function caller() { return run(1) + api.go(2) + main(); }\nexport function shadow(run: () => number) { return run(); }\nexport function shadowNamespace(api: any) { return api.go(3); }\nexport const callback = () => run(4);\n");
    write('classes.ts', 'export class First { one() { return this.two(); } two() { return 1; } }\nexport class Second { two() { return 2; } }\nexport function dynamic(x: any) { return x.two(); }\n');
    write('common.cjs', 'function ping() { return 5; }\nmodule.exports = { ping };\n');
    write('consume.cjs', "const { ping: pong } = require('./common.cjs');\nfunction call() { return pong(); }\nmodule.exports = { call };\n");
    write('only-call.js', 'external();\n');
    write('.env.ts', 'export function secretFunction() { return 1; }\n');
    write('nested.ts', "import { go } from './a';\nexport function outer() { [1].map(() => go(1)); }\n");
    write('broken.ts', 'export function broken( {\n');
    const config = { indexWorker: true, embedProvider: 'none' };
    const sync = new LocalRagIndex(root, { ...config, indexWorker: false }); indexes.push(sync);
    const worker = new LocalRagIndex(root, config); indexes.push(worker);
    sync.refresh(); await worker.refreshAsync(false);
    const query = (operation, args) => queryNavigation(worker.fileCache, operation, args);
    const go = query('find_definition', { symbol: 'go' });
    assert.equal(go.count, 2); assert.equal(go.ambiguous, true);
    assert.equal(query('find_definition', { symbol: 'Go' }).count, 0, 'Symbols must remain case sensitive');
    const scoped = query('find_definition', { symbol: 'go', path: 'a.ts', line: 2 });
    assert.equal(scoped.count, 1); assert.equal(scoped.results[0].startLine, 2);
    assert.equal(scoped.results[0].column, 1); assert.match(scoped.results[0].sourceSha256, /^sha256:[a-f0-9]{64}$/);
    const incoming = query('get_callers', { symbol: 'go', path: 'a.ts' });
    assert.equal(incoming.results.filter((site) => site.path === 'use.ts' && site.owner.symbol === 'caller').length, 2);
    assert.ok(!incoming.results.some((site) => site.owner?.symbol === 'shadow'), 'Parameter must shadow the import alias');
    assert.ok(!incoming.results.some((site) => site.owner?.symbol === 'shadowNamespace'), 'Parameter must shadow the namespace');
    assert.ok(incoming.results.some((site) => site.owner?.symbol === 'callback'));
    assert.ok(!incoming.results.some((site) => site.owner?.symbol === 'outer'), 'Anonymous callbacks must not be attributed to their enclosing function');
    assert.ok(incoming.results.some((site) => site.owner?.symbol.startsWith('<anonymous@')));
    assert.equal(query('find_definition', { symbol: 'secretFunction' }).count, 0, 'Sensitive files must remain excluded');
    assert.equal(query('get_callers', { symbol: 'go', path: 'b.ts' }).count, 0, 'Same name in a different module must not receive alias calls');
    const outgoing = query('get_callees', { symbol: 'caller', path: 'use.ts' });
    assert.equal(outgoing.count, 3); assert.ok(outgoing.results.every((site) => site.resolution === 'import'));
    assert.equal(outgoing.results.find((site) => site.symbol === 'main').candidates[0].symbol, 'primary');
    assert.ok(query('find_references', { symbol: 'go', path: 'a.ts' }).count >= incoming.count);
    const method = query('find_definition', { symbol: 'First.two', path: 'classes.ts' });
    assert.equal(method.count, 1, 'Methods in one-line classes retain their own positions');
    const methodCalls = query('get_callers', { symbol: 'First.two' });
    assert.ok(methodCalls.results.some((site) => site.receiver === 'this' && site.candidates[0].qualifiedSymbol === 'First.two'));
    assert.ok(methodCalls.results.some((site) => site.receiver === 'x' && site.resolution === 'name-only' && site.ambiguous));
    assert.equal(query('get_callees', { symbol: 'dynamic' }).results[0].candidateCount, 2);
    assert.equal(query('get_callers', { symbol: 'ping', path: 'common.cjs' }).results[0].owner.symbol, 'call');
    assert.ok(worker.fileCache.get('only-call.js').navigation.references.some((site) => site.symbol === 'external'));
    assert.ok(worker.fileCache.get('broken.ts').navigation.parseErrors > 0);
    for (const operation of ['find_definition', 'find_references', 'get_callers', 'get_callees']) {
      const args = { symbol: 'go' };
      assert.deepEqual(queryNavigation(sync.fileCache, operation, args), query(operation, args), 'Worker and sync navigation must agree');
    }
    const first = query('get_callers', { symbol: 'go', path: 'a.ts', maxResults: 1 });
    assert.equal(first.results.length, 1); assert.equal(first.nextOffset, 1);
    const second = query('get_callers', { symbol: 'go', path: 'a.ts', maxResults: 1, offset: first.nextOffset });
    assert.notDeepEqual(first.results, second.results);
    write('a.ts', '\n\nexport function go(value: number) { return value + 2; }\n');
    worker.invalidate('a.ts'); await worker.refreshAsync(false);
    const changed = query('find_definition', { symbol: 'go', path: 'a.ts' });
    assert.equal(changed.results[0].startLine, 3); assert.notEqual(changed.sourceVersions['a.ts'], scoped.sourceVersions['a.ts']);
    fs.unlinkSync(path.join(root, 'b.ts')); await worker.refreshAsync(false);
    assert.equal(query('find_definition', { symbol: 'go' }).count, 1, 'Deleted definitions must disappear');

    const registry = toolkit.buildDefaultRegistryWithConfig({ toolProfile: 'off' });
    const context = new AgentToolContext({ projectRoot: root, ragConfig: config, readOnly: true, capabilities: ['workspace.read'] });
    // 工具面收敛 L2：四个符号工具合并成 `symbol_nav`（kind 决定查哪种关系）
    for (const kind of ['definition', 'references', 'callers', 'callees']) {
      const descriptor = descriptorLib.effectiveDescriptor(registry.descriptorOf('symbol_nav'), { kind });
      assert.equal(descriptor.readOnly, true); assert.equal(descriptor.mutatesWorkspace, false);
      assert.equal(descriptor.cachePolicy.mode, 'none'); assert.equal(classify('symbol_nav', { kind }), 'read');
      const result = await registry.execute('symbol_nav', { kind, symbol: 'go', path: 'a.ts' }, context);
      assert.equal(result.ok, true, result.text); assert.equal(result.data.approximate, true);
      assert.ok(result.data.limitations.includes('read_file')); assert.equal(result.data.index.parseErrorFiles, 1);
      assert.ok(registry.toOpenAiTools().some((tool) => tool.function.name === 'symbol_nav'));
      for (const role of ['explorer', 'builder', 'verifier', 'reviewer']) {
        assert.ok(toolkit.buildDefaultRegistryWithConfig({ role, toolProfile: 'off' }).contains('symbol_nav'), role + ' has navigation');
      }
    }
    // 旧名仍是别名（模型历史消息 / 用例里的旧名照旧可用）
    assert.equal((await registry.execute('find_definition', { symbol: 'go', path: 'a.ts' }, context)).ok, true);
    assert.equal((await registry.execute('find_definition', { symbol: 'go', path: '../outside' }, context)).ok, false);
    assert.equal((await registry.execute('find_definition', { symbol: 'go', line: 2 }, context)).ok, false);
    assert.equal((await registry.execute('find_definition', { symbol: 'go', maxResults: 101 }, context)).ok, false);
    assert.equal((await registry.execute('find_definition', { symbol: 'missing' }, context)).data.count, 0);
    const denied = toolkit.buildDefaultRegistryWithConfig({ toolsDeny: ['find_definition'] });
    assert.equal(denied.contains('symbol_nav'), false);
    const disabled = toolkit.buildDefaultRegistryWithConfig({ ragEnabled: false });
    assert.equal(disabled.contains('symbol_nav'), true);
    assert.equal(disabled.contains('retrieve_context'), true);
    const noRag = new AgentToolContext({ projectRoot: root, ragConfig: { ...config, enabled: false } });
    assert.equal((await disabled.execute('symbol_nav', { kind: 'definition', symbol: 'go' }, noRag)).ok, true);
    const profiles = toolkit.profiles;
    const normal = profiles.resolveToolProfiles({ prompt: '修复功能' });
    assert.ok(!profiles.namesForProfiles(normal.profiles, registry.listTools().map((tool) => tool.name)).includes('symbol_nav'));
    const navigation = profiles.resolveToolProfiles({ prompt: '查符号 go 的调用链' });
    assert.ok(profiles.namesForProfiles(navigation.profiles, registry.listTools().map((tool) => tool.name)).includes('symbol_nav'));
    toolkit.registerDiscoverTool(registry);
    registry.setExposure(profiles.namesForProfiles(normal.profiles, registry.listTools().map((tool) => tool.name)));
    assert.equal(registry.isExposed('symbol_nav'), false);
    const discovered = await registry.execute('discover_tools', { query: 'symbol' }, context);
    assert.equal(discovered.ok, true, discovered.text); assert.equal(registry.isExposed('symbol_nav'), true);
    const controller = new AbortController(); controller.abort();
    const cancelled = new AgentToolContext({ projectRoot: root, ragConfig: config, signal: controller.signal });
    assert.equal((await registry.execute('find_definition', { symbol: 'go' }, cancelled)).ok, false);
    const cached = getProjectIndex(root, config); indexes.push(cached);
    write('a.ts', 'export function newer() { return 3; }\n'); invalidateProjectIndex(root, 'a.ts');
    assert.equal((await registry.execute('find_definition', { symbol: 'go', path: 'a.ts' }, context)).data.count, 0);
    console.log('SYMBOL NAVIGATION: PASS (AST locations, alias/default/CommonJS imports, shadowing, ambiguous members, worker parity, pagination, mutation/deletion, tool contracts and permissions)');
  } finally {
    for (const index of indexes) index.close(); clearIndexCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
