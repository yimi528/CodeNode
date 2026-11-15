'use strict';
const assert = require('node:assert/strict');
const { metrics, aggregate } = require('../eval/agent-eval-repeat.cjs');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const mixed = metrics(3, 2);
near(mixed[0].passAtK, 2 / 3);
near(mixed[0].passPowerK, 2 / 3);
near(mixed[1].passAtK, 1);
near(mixed[1].passPowerK, 1 / 3);
near(mixed[2].passAtK, 1);
near(mixed[2].passPowerK, 0);
assert.ok(metrics(3, 0).every(m => m.passAtK === 0 && m.passPowerK === 0));
assert.ok(metrics(3, 3).every(m => m.passAtK === 1 && m.passPowerK === 1));
for (const args of [[0, 0], [3, 4], [3, -1], [2.5, 1]]) assert.throws(() => metrics(...args));

function report(status = 'pass') {
  return {
    datasetVersion: 'test-v1', mode: 'model', model: 'fixture', git: { codeFingerprint: 'abc' },
    exitCode: status === 'fail' ? 1 : 0, harness: { selfChecks: [{ pass: true }] },
    taskQuality: /** @type {any} */ (undefined),
    tasks: [{ id: 'edit', assessment: /** @type {any} */ (undefined), required: true, status, checks: [{ pass: status === 'pass' }], failed: status === 'fail' ? ['outcome mismatch'] : [] }],
  };
}
let result = aggregate([report(), report(), report('fail')]);
assert.equal(result.passed, false);
near(result.means[1].passPowerK, 1 / 3);
assert.equal(result.tasks[0].failures[0].trial, 3);
result = aggregate([report(), report('skipped')]);
assert.equal(result.passed, false);
assert.equal(result.tasks[0].metrics, null);
assert.equal(result.means[0].eligibleTasks, 0);
assert.equal(result.means[0].passAtK, null);
assert.equal(aggregate([report(), report()]).passed, true);
const broken = report(); broken.harness.selfChecks = [];
assert.equal(aggregate([broken]).passed, false);
const crash = report(); crash.exitCode = 2;
assert.equal(aggregate([crash]).passed, false);
const changed = report(); changed.git.codeFingerprint = 'def';
assert.throws(() => aggregate([report(), changed]), /源码/);
changed.git.codeFingerprint = 'abc'; changed.model = 'other';
assert.throws(() => aggregate([report(), changed]), /配置/);
changed.model = 'fixture'; changed.tasks[0].id = 'different';
assert.throws(() => aggregate([report(), changed]), /任务集合/);
assert.throws(() => aggregate([]), /缺少报告/);
const offlineCoding = report();
offlineCoding.mode = 'offline';
offlineCoding.tasks[0].assessment = { track: 'coding', evidence: 'scripted-regression', family: 'math-cart', split: 'development' };
const offlineSummary = aggregate([offlineCoding, structuredClone(offlineCoding)]);
assert.equal(offlineSummary.assessmentGroups[0].evidence, 'scripted-regression');
assert.equal(offlineSummary.assessmentGroups.some(g => g.evidence === 'model-coding-outcome'), false);
assert.equal(aggregate([report()]).assessmentGroups[0].track, 'unclassified', '历史记录不得根据模型名猜测能力分类');
const reclassified = structuredClone(offlineCoding); reclassified.tasks[0].assessment.track = 'mechanism';
assert.throws(() => aggregate([offlineCoding, reclassified]), /证据分类/);
const changedContract = report(); changedContract.taskQuality = { contractHash: 'changed', grader: { sha256: 'new' } };
assert.throws(() => aggregate([report(), changedContract]), /契约/);

// Exercise the CLI's fail-closed path without making a model request.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-repeat-test-'));
try {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../eval/agent-eval-repeat.cjs'),
    '--trials=1', '--mode=model', '--task=multi-step-read-edit-verify', '--report-dir=' + temp],
  { encoding: 'utf8', env: { ...process.env, CODENODE_EVAL_API_KEY: '' }, timeout: 30000 });
  assert.equal(child.status, 1, child.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(temp, 'summary.json'), 'utf8'));
  assert.equal(summary.passed, false);
  assert.equal(summary.tasks[0].metrics, null);
  assert.equal(summary.tasks[0].skipped, 1);
  assert.equal(summary.runs[0].exitCode, 2);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('AGENT EVAL REPEAT: PASS (finite-sample estimators, missing evidence, harness failures, source/config drift)');
