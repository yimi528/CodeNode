'use strict';

const fs = require('fs');
const { readWorkflowRun } = require('./runStore.cjs');
const { SideEffectLedger, ledgerPath } = require('./sideEffects.cjs');

function relativeFile(value) {
  const file = typeof value === 'string' ? value.replace(/\\/g, '/').replace(/^\.\//, '') : '';
  return file && file.length <= 512 && !/^[\/]|^[A-Za-z]:|[\0\r\n]/.test(file) &&
    file.split('/').every(segment => segment && segment !== '.' && segment !== '..') ? file : null;
}

function ledgerChanges(root, runId) {
  const stat = fs.lstatSync(ledgerPath(root, runId), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) return [];
  const records = new SideEffectLedger({ projectRoot: root, scopeRunId: runId }).recordsForRollback();
  const latest = new Map();
  for (const record of records) {
    if (record.phase !== 'committed' || record.ok === false || !record.postStateDigest) continue;
    const previous = latest.get(record.path);
    if (!previous || String(record.committedAt || '') >= String(previous.committedAt || '')) latest.set(record.path, record);
  }
  return [...latest.values()].flatMap(record => {
    const existed = record.beforeImage?.existed;
    const deleted = record.postStateDigest === 'absent';
    if (existed === false && deleted) return [];
    return [{ path: record.path, kind: deleted ? 'deleted' : existed === false ? 'added' : 'modified' }];
  });
}

/** Read historical evidence without scanning, hashing, or opening workspace source files. */
function readStageEvidence(root, workflowId, attempt, inputs) {
  const events = readWorkflowRun(root, workflowId, attempt);
  const newestFirst = [...events].reverse();
  const finish = newestFirst.find(event => event.type === 'run_finish');
  const runId = finish?.runId || null;
  const persisted = newestFirst.find(event => event.type === 'backend_changes')?.changes || finish?.changes;
  const raw = Array.isArray(persisted?.files) ? persisted.files : runId ? ledgerChanges(root, runId) : [];
  const files = new Map();
  const reverted = new Set(events.filter(event => event.type === 'rollback_applied')
    .flatMap(event => Array.isArray(event.applied) ? event.applied : [])
    .map(item => relativeFile(item?.path)));
  for (const item of raw) {
    const file = relativeFile(item?.path);
    if (!file) continue;
    const kind = ['added', 'modified', 'deleted'].includes(item.kind) ? item.kind : 'modified';
    files.set(file, { path: file, kind, reverted: reverted.has(file) });
  }
  const checks = Array.isArray(finish?.codeVerification?.checks) ? finish.codeVerification.checks : [];
  return {
    attemptId: attempt.id,
    runId,
    phase: attempt.phase,
    output: attempt.output || '',
    upstream: inputs.map(item => item.id),
    files: [...files.values()].slice(0, 200),
    fileCount: files.size,
    changesComplete: persisted?.complete === true && raw.length === files.size,
    verification: checks.length ? {
      passed: checks.filter(check => check?.status === 'passed').length,
      failed: checks.filter(check => check?.status === 'failed').length,
      total: checks.length,
      historical: reverted.size > 0,
    } : null,
  };
}

module.exports = { readStageEvidence };
