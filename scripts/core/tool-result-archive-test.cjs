'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createArchive, MARKER, DIRECTORY } = require('../../electron/toolResultArchive.cjs');
const agent = require('../../electron/agent.cjs');
const toolkit = require('../../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../../electron/tools/context.cjs');
const { installScriptedModel } = require('../lib/scripted-model.cjs');
const { estimateInputTokens } = require('../../electron/requestBudget.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-archive-'));
const body = Array.from({ length: 180 }, (_, i) => 'line ' + i + ': ' + 'ARCHIVE-ORIGINAL '.repeat(10)).join('\n');
const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });

async function run(enabled) {
  fs.writeFileSync(path.join(root, 'big.txt'), body);
  fs.writeFileSync(path.join(root, 'small.txt'), 'RECENT MUST STAY EXACT');
  const stub = installScriptedModel([
    { toolCalls: [{ id: 'big', name: 'read_file', args: { path: 'big.txt', maxChars: 48000 } }] },
    { toolCalls: [{ id: 'small', name: 'read_file', args: { path: 'small.txt' } }] },
    { toolCalls: [{ id: 'retrieve', name: 'read_file', args: { path: 'big.txt', maxChars: 48000 } }] },
    { content: '完成' },
  ], { loopLast: false });
  const fetch = global.fetch;
  let snapshotPath;
  global.fetch = async (url, init) => {
    if (stub.calls === 2 && enabled) {
      const messages = JSON.parse(String(init.body)).messages;
      const snapshot = messages.find(m => m.tool_call_id === 'big');
      assert.ok(snapshot.content.startsWith(MARKER));
      const metadata = JSON.parse(snapshot.content.slice(MARKER.length).split('\n')[0]);
      snapshotPath = metadata.path;
      assert.equal(metadata.sourceSha256, 'sha256:' + createHash('sha256').update(body).digest('hex'));
      assert.match(messages.find(m => m.tool_call_id === 'small').content, /RECENT MUST STAY EXACT/);
      // Retrieval must return the historical bytes even after the workspace file changes.
      fs.writeFileSync(path.join(root, 'big.txt'), 'CURRENT DIFFERENT VERSION');
      stub.state.script[2].toolCalls[0].args.path = snapshotPath;
    }
    return fetch(url, init);
  };
  try {
    const result = await agent.runAgentChat({ cfg: {
      apiBase: 'http://scripted.local', apiKey: 'synthetic', model: 'fixture', maxTokens: 1024,
      reliability: { maxAttempts: 1 }, limits: { maxToolIterations: 5, maxTotalTokens: 1000000 },
      context: { enabled: false, archiveResults: enabled, keepRecentMessages: 1 },
      compaction: { enabled: false }, compression: { enabled: false }, rag: { enabled: false },
    }, messages: [{ role: 'system', content: 'Read and verify.' }, { role: 'user', content: '检查文件' }],
    tools: { registry, context: new AgentToolContext({ projectRoot: root, audit: () => {} }) } });
    assert.equal(result.error, undefined);
    assert.match(result.toolCalls[0].result, /ARCHIVE-ORIGINAL/);
    if (enabled) {
      assert.match(result.toolCalls[2].result, /ARCHIVE-ORIGINAL/);
      assert.doesNotMatch(result.toolCalls[2].result, /CURRENT DIFFERENT VERSION/);
      assert.equal(result.toolCalls[2].data.nextOffset, null);
      assert.equal(fs.readFileSync(path.join(root, snapshotPath), 'utf8'), stub.seen[1].messages.find(m => m.tool_call_id === 'big').content);
    }
    return stub.seen;
  } finally { stub.restore(); }
}

(async () => {
  const baseline = await run(false);
  const archived = await run(true);
  const before = estimateInputTokens(baseline[2].messages, baseline[2].tools);
  const after = estimateInputTokens(archived[2].messages, archived[2].tools);
  assert.ok(after < before / 2, 'Older full body is replaced before the next request');
  const snapshotMessage = structuredClone(archived[2].messages.find(m => m.tool_call_id === 'big'));
  assert.deepEqual(archived[2].messages.map(m => [m.role, m.tool_call_id, m.tool_calls]), baseline[2].messages.map(m => [m.role, m.tool_call_id, m.tool_calls]), 'Tool call/result pairing remains unchanged');
  assert.equal(require('../../electron/contextBudget.cjs').isTrimmed(snapshotMessage.content), true, 'Hard trimming must preserve retrieval pointers');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshotMessage)), snapshotMessage, 'Checkpoint roundtrip retains pointer');

  const makeHistory = () => [{ role: 'system', content: 'sys' },
    { role: 'assistant', tool_calls: [{ id: 'old' }] }, { role: 'tool', name: 'execute_shell', tool_call_id: 'old', content: body },
    { role: 'assistant', tool_calls: [{ id: 'new' }] }, { role: 'tool', content: 'LATEST' }];
  const record = { ok: true, name: 'execute_shell', args: '{}', callId: 'old', data: { command: 'test', exitCode: 0 } };
  async function reclaim(testRoot, enabled, ok = true, available = registry) {
    const archive = createArchive(testRoot, { enabled, keepRecent: 1 });
    const messages = makeHistory();
    archive.track(messages[2], { ...record, ok });
    return { stats: await archive.reclaim(messages, available), messages, archive };
  }
  assert.equal((await reclaim(root, false)).messages[2].content, body, 'Rollback keeps original body');
  assert.equal((await reclaim(root, true, false)).messages[2].content, body, 'Failures stay exact');
  assert.equal((await reclaim(root, true, true, { toOpenAiTools: () => [] })).messages[2].content, body, 'No retrieval tool means no archive');
  const quotaArchive = createArchive(root, { enabled: true, keepRecent: 1 });
  /** @type {Array<any>} */
  const quotaMessages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 17; i++) {
    const message = { role: 'tool', content: String(i).padStart(4, '0') + 'Q'.repeat(1024 * 1024 - 4) };
    quotaMessages.push(message); quotaArchive.track(message, record);
  }
  quotaMessages.push({ role: 'assistant', tool_calls: [{ id: 'latest' }] }, { role: 'tool', content: 'LATEST' });
  assert.equal((await quotaArchive.reclaim(quotaMessages, registry)).archived, 16, 'Per-run quota is bounded at 16 MiB');
  assert.equal(quotaMessages[17].content.length, 1024 * 1024, 'Over-quota result stays intact');
  const oversized = makeHistory(); oversized[2].content = 'X'.repeat(2 * 1024 * 1024 + 1);
  const sizeArchive = createArchive(root, { enabled: true, keepRecent: 1 });
  sizeArchive.track(oversized[2], record);
  assert.equal((await sizeArchive.reclaim(oversized, registry)).archived, 0, 'Files larger than read_file limit stay intact');
  const blocked = path.join(root, 'blocked');
  fs.mkdirSync(blocked); fs.writeFileSync(path.join(blocked, '.codenode'), 'blocked');
  const failed = await reclaim(blocked, true);
  assert.equal(failed.stats.failed, 1); assert.equal(failed.messages[2].content, body, 'Disk failure retains original');
  const stored = await reclaim(root, true);
  assert.equal(stored.stats.archived, 1);
  assert.equal((await stored.archive.reclaim(stored.messages, registry)).archived, 0, 'Idempotent');
  const recoveredMessages = makeHistory();
  recoveredMessages[1].tool_calls = [{ id: 'old', type: 'function', function: { name: 'execute_shell', arguments: '{}' } }];
  const recoveredArchive = createArchive(root, { enabled: true, keepRecent: 1 });
  assert.equal((await recoveredArchive.reclaim(recoveredMessages, registry)).archived, 1, 'A fresh run restores success evidence from the durable journal');
  assert.ok(recoveredMessages[2].content.startsWith(MARKER));
  const checkpoint = require('../../electron/runCheckpoint.cjs');
  const history = makeHistory();
  history[1].tool_calls = [{ id: 'old', type: 'function', function: { name: 'execute_shell', arguments: '{}' } }];
  history[3].tool_calls = [{ id: 'new', type: 'function', function: { name: 'read_file', arguments: '{"path":"small.txt"}' } }];
  history[4] = { role: 'tool', name: 'read_file', tool_call_id: 'new', content: 'LATEST' };
  createArchive(root, { enabled: true, keepRecent: 1 }).track(history[2], record);
  checkpoint.saveMessages(root, 'archive-real-checkpoint', history);
  const persisted = checkpoint.lastMessages(checkpoint.readCheckpoints(root, 'archive-real-checkpoint'));
  assert.equal(persisted[2].content.length, 6000);
  const restoredStats = await createArchive(root, { enabled: true, keepRecent: 1 }).reclaim(persisted, registry);
  assert.equal(restoredStats.archived, 1, 'Actual truncated checkpoints recover their original body from the durable raw snapshot');
  assert.equal(restoredStats.savedChars, 6000 - persisted[2].content.length, 'Savings use the actual checkpoint context size');
  const restoredMeta = JSON.parse(persisted[2].content.slice(MARKER.length).split('\n')[0]);
  assert.equal(fs.readFileSync(path.join(root, restoredMeta.path), 'utf8'), body);
  for (const suffix of ['TAIL_A', 'TAIL_B']) {
    const collision = makeHistory();
    collision[1].tool_calls = [{ id: 'old', type: 'function', function: { name: 'execute_shell', arguments: '{}' } }];
    collision[3].tool_calls = history[3].tool_calls;
    collision[4] = history[4]; collision[2].content = 'P'.repeat(7000) + suffix.repeat(500);
    createArchive(root, { enabled: true, keepRecent: 1 }).track(collision[2], record);
    checkpoint.saveMessages(root, suffix, collision);
  }
  for (const suffix of ['TAIL_A', 'TAIL_B']) {
    const collision = checkpoint.lastMessages(checkpoint.readCheckpoints(root, suffix));
    assert.equal((await createArchive(root, { enabled: true, keepRecent: 1 }).reclaim(collision, registry)).archived, 1);
    const data = JSON.parse(collision[2].content.slice(MARKER.length).split('\n')[0]);
    assert.equal(fs.readFileSync(path.join(root, data.path), 'utf8'), 'P'.repeat(7000) + suffix.repeat(500), 'Identical checkpoint prefixes cannot mix different historical tails');
  }
  const failedShell = createArchive(root, { enabled: true, keepRecent: 1 }), failedHistory = makeHistory();
  failedShell.track(failedHistory[2], { ...record, data: { exitCode: 1 } });
  assert.equal((await failedShell.reclaim(failedHistory, registry)).archived, 0, 'Nonzero shell exit remains verbatim even when transport ok is true');
  const hash = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(root, DIRECTORY, hash + '.txt'), 'corrupt');
  const corrupt = await reclaim(root, true);
  assert.equal(corrupt.stats.failed, 1); assert.equal(corrupt.messages[2].content, body, 'Existing corrupt file cannot become a valid reference');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(stored.archive.reclaim(makeHistory(), registry, cancelled.signal), { name: 'AbortError' });
  console.log('TOOL RESULT ARCHIVE: PASS ' + JSON.stringify({ before, after, historicalBytesRetrieved: true, failureKeepsBody: true }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
