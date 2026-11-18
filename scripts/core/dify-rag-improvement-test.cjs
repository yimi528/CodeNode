'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fileChangeReview } = require("../../electron/tools/fileChangeReview.cjs");
const ragSettings = require("../../electron/ragSettings.cjs");
const descriptorLib = require("../../electron/tools/descriptor.cjs");
// 工具面收敛：dify_call 已并入 web(kind=dify)，模块只导出执行体 execute
const { execute: difyExecute } = require("../../electron/tools/impl/difyCallTool.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const cnode = require("../../electron/cnode.cjs");
const { GraphModel } = require("../../electron/tools/GraphModel.cjs");

async function main() {
  const review = fileChangeReview('', 'hello', false);
  assert.equal(review.removedLines, 0);
  assert.equal(review.addedLines, 1);
  assert.match(review.diff, /\+hello/);
  const template = { kind: 'workflow', tools: ['retrieve_context'], models: [], paths: ['src/main.ts'] };
  const decoded = cnode.decodeCnode(cnode.encodeCnode({ graph: { nodes: [], edges: [] }, manifest: { name: 'test template', template } }));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.manifest.template, template);
  /** @type {any} */ let editHandler;
  require("../../electron/tools/impl/workbenchEditTool.cjs").register({
    register(name, _description, _schema, fn) { if (name === 'workbench_edit') editHandler = fn; },
    declareContract() { return true; },
  });
  assert.ok(editHandler);
  const graph = new GraphModel({ root: { nodes: [], edges: [] } });
  const edited = await editHandler({ model: () => graph, mutateWorkbench: async (fn) => { fn(graph); return true; }, storeScalars: () => 0 }, { action: 'create', id: 'task-a', name: 'A', type: 'task' });
  assert.equal(edited.ok, true);
  assert.equal(edited.data.review.changes[0].kind, 'added');
  assert.equal(edited.data.review.changes[0].nodeId, 'task-a');

  /**
   * 工具面收敛（L2）：`dify_call` 并入族工具 `web`（kind=dify）。
   * 判据从「配置关了就不注册」改成「按 kind 解出的契约」——族里 fetch 一直在，
   * 但 dify 这个 kind 的 HIGH 审批与 network.request 能力必须逐字不变。
   */
  const contract = descriptorLib.effectiveDescriptor(toolkit.buildDefaultRegistryWithConfig({ difyEnabled: true }).descriptorOf('web'), { kind: 'dify' });
  assert.equal(contract.requiredCapability, 'network.request');
  assert.equal(contract.requiresConfirmation, 'HIGH');
  const aliasTarget = toolkit.buildDefaultRegistryWithConfig({ difyEnabled: false }).listAliases().find((a) => a.name === 'dify_call');
  assert.equal(aliasTarget.family, 'web');
  assert.equal(aliasTarget.kind, 'dify');

  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ url: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/embeddings') res.end(JSON.stringify({ embedding: Array(256).fill(0) }));
    else if (req.url === '/v1/workflows/run') res.end(JSON.stringify({ task_id: 'task-1', data: { id: 'run-1', status: 'succeeded', outputs: { answer: 'ok' } } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-improvement-'));
  try {
    const local = ragSettings.normalizedSettings({ provider: 'local', backend: 'memory', dim: 4096 }, {});
    assert.equal((await ragSettings.checkSettings(local)).ok, true);
    const semantic = ragSettings.normalizedSettings({ provider: 'ollama', backend: 'memory', dim: 256, model: 'test', base }, {});
    assert.deepEqual(await ragSettings.checkSettings(semantic), { ok: true, dimension: 256, mode: 'semantic' });
    assert.equal((await ragSettings.checkSettings({ ...semantic, dim: 512 })).ok, false);
    fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codenode', 'agent.properties'), 'tools.enabled=true\nrag.embed_provider=local\n');
    ragSettings.writeSettings(root, semantic, {});
    const text = fs.readFileSync(path.join(root, '.codenode', 'agent.properties'), 'utf8');
    assert.match(text, /tools.enabled=true/);
    assert.match(text, /rag.embed_provider=ollama/);
    assert.equal((text.match(/rag.embed_provider=/g) || []).length, 1);

    fs.appendFileSync(path.join(root, '.codenode', 'agent.properties'), `dify.enabled=true\ndify.base=${base}/v1\ndify.api_key=test-secret\ndify.kind=workflow\n`);
    /** @type {any} */ let handler = difyExecute;
    assert.ok(handler);
    const audit = [];
    const result = await handler({ projectRoot: () => root, signal: () => null, audit: (entry) => audit.push(entry) }, { inputs: { subject: 'demo' } });
    assert.equal(result.ok, true);
    assert.equal(result.data.output.answer, 'ok');
    assert.equal(calls.at(-1).url, '/v1/workflows/run');
    assert.equal(calls.at(-1).authorization, 'Bearer test-secret');
    assert.equal(calls.at(-1).body.inputs.subject, 'demo');
    assert.ok(result.data.elapsedMs >= 0);
    assert.ok(audit.some((entry) => entry.includes('status=succeeded')));
    console.log('DIFY / RAG IMPROVEMENT TEST: PASS');
  } finally {
    server.close();
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-improvement-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
