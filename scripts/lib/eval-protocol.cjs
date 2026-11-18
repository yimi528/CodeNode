'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => typeof item !== 'function')
    .map(([key, item]) => [key, /api.?key|authorization|cookie|password|credential|access.?token|refresh.?token/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function writeNew(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safePath(root, relative) {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(relative)) throw Error('无效产物路径');
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw Error('产物路径越界');
  for (let part = full; part !== path.resolve(root); part = path.dirname(part)) if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) throw Error('产物路径包含符号链接');
  return full;
}
function classifyExecution(result = /** @type {any} */ ({}), flags = /** @type {any} */ ({})) {
  if (flags.setupError) return 'INFRA_ERROR';
  if (flags.deadlineExceeded || flags.watchdog || ['token_limit','iteration_limit','tool_call_limit','cost_limit','request_limit','timeout'].includes(result.stopReason) || result.state === 'LIMIT_REACHED') return 'BUDGET_EXHAUSTED';
  if (result.aborted || result.state === 'CANCELLED') return 'CANCELLED';
  if (result.error) return 'AGENT_ERROR';
  return result.state === 'COMPLETED' || result.finishReason === 'stop' ? 'COMPLETED' : 'UNKNOWN';
}
function verdict(executionStatus, gradingStatus, integrityStatus, contract = /** @type {any} */ ({})) {
  return gradingStatus === 'PASS' && integrityStatus === 'CLEAN' &&
    (executionStatus === 'COMPLETED' || contract.allowBudgetArtifact === true && executionStatus === 'BUDGET_EXHAUSTED');
}
function createTrial(root, task, identity, secrets = []) {
  const trialId = crypto.randomUUID();
  const directory = path.join(root, 'trials', trialId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) => atomicJson(path.join(directory, name), redact(value, secrets));
  writeNew(path.join(directory, 'identity.json'), redact({ schemaVersion: 1, trialId, taskId: task.id, startedAt: new Date().toISOString(), ...identity }, secrets));
  save('execution.json', { phase: 'PREPARING', executionStatus: 'NOT_STARTED', gradingStatus: 'NOT_RUN', integrityStatus: 'UNKNOWN' });
  return {
    trialId, directory, save,
    append(name, value) { fs.appendFileSync(path.join(directory, name), JSON.stringify(redact(value, secrets)) + '\n', { mode: 0o600 }); },
    collect(before, after, contract) {
      // Candidate bytes are never silently changed: redaction would invalidate regrading.
      const text = JSON.stringify({ before, after, contract });
      if (secrets.some(secret => secret && text.includes(secret))) throw Object.assign(Error('产物包含模型凭据，拒绝归档和重评'),{code:'EVAL_SECRET_ARTIFACT'});
      writeNew(path.join(directory, 'snapshots.json'), { before, after });
      writeNew(path.join(directory, 'grading-contract.json'), contract);
      const files = ['snapshots.json', 'grading-contract.json'].map(name => ({ path: name, sha256: hash(fs.readFileSync(path.join(directory, name))) }));
      save('artifact-manifest.json', { schemaVersion: 1, collectedAt: new Date().toISOString(), complete: true, files });
    },
  };
}
function verifyTrial(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('证据目录不能是符号链接');
  const manifest = readJson(safePath(directory, 'artifact-manifest.json'));
  if (manifest.complete !== true || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('产物不完整，不能重评');
  const seen = new Set();
  for (const item of manifest.files) {
    if (seen.has(item.path)) throw Error('重复产物');
    seen.add(item.path);
    if (hash(fs.readFileSync(safePath(directory, item.path))) !== item.sha256) throw Error('产物哈希不匹配：' + item.path);
  }
  for (const name of ['snapshots.json', 'grading-contract.json']) if (!seen.has(name)) throw Error('缺少重评输入：' + name);
  return { identity: readJson(safePath(directory, 'identity.json')), snapshots: readJson(safePath(directory, 'snapshots.json')), contract: readJson(safePath(directory, 'grading-contract.json')) };
}
module.exports = { hash, redact, atomicJson, writeNew, readJson, safePath, classifyExecution, verdict, createTrial, verifyTrial };
