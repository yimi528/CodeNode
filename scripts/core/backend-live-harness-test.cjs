'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { approvedPath, createApproval } = require('../tools/agent-backend-live-workflow.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-live-harness-'));
(async()=>{try {
  const realRoot = fs.realpathSync(root);
  assert.equal(approvedPath(root, path.join(realRoot, 'math.cjs')), 'math.cjs', 'realpath aliases must remain inside the temporary project');
  assert.equal(approvedPath(root, path.join(path.dirname(realRoot), 'outside.cjs')), '', 'outside paths must remain denied');

  const counters = { approved: 0, denied: 0, requests: [] };
  const approve = createApproval(root, counters);
  const hermesEdit = JSON.stringify({ subject: {}, toolCall: { kind: 'edit', title: 'Approve edit', rawInput: { tool: 'write_file', arguments: { path: path.join(realRoot, 'math.cjs'), content: 'ok' } }, content: [{ type: 'diff', path: path.join(realRoot, 'math.cjs') }] } });
  assert.equal(await approve('HIGH', 'hermes ACP 权限请求', hermesEdit), true, 'nested Hermes edit shape must approve the one allowed file');
  const outsideEdit = JSON.stringify({ subject: {}, toolCall: { kind: 'edit', rawInput: { tool: 'patch', arguments: { path: path.join(path.dirname(realRoot), 'outside.cjs') } } } });
  assert.equal(await approve('HIGH', 'hermes ACP 权限请求', outsideEdit), false, 'nested edit outside scope must be denied');
  const command = JSON.stringify({ subject: { kind: 'execute' }, toolCall: { kind: 'execute', title: 'Run shell', rawInput: { tool: 'terminal', arguments: { command: 'node bad.js' } } } });
  assert.equal(await approve('HIGH', 'hermes ACP 权限请求', command), false, 'explicit command permission must be denied');
  assert.deepEqual({ approved: counters.approved, denied: counters.denied }, { approved: 1, denied: 2 });
  assert.equal(counters.requests[0].file, 'math.cjs');
  console.log('BACKEND LIVE HARNESS: PASS (explicit override, canonical paths, nested Hermes edits, command/outside denial)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}})().catch(error=>{console.error(error);process.exitCode=1;});
