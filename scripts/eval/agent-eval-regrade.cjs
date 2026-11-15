#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { verifyTrial, writeNew, safePath, hash, readJson } = require('../lib/eval-protocol.cjs');
const { gradeCoding } = require('../lib/coding-grader.cjs');

function regrade(directory, options = /** @type {any} */ ({})) {
  const original = verifyTrial(directory);
  if (!original.contract.behaviorCases?.length) throw Error('本地重评仅支持声明完整行为契约的 CJS 任务；其他任务使用原 Harbor recovery');
  if (options.expectedContractHash && hash(original.contract) !== options.expectedContractHash) throw Error('重评契约不匹配');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-regrade-'));
  try {
    for (const [file, content] of Object.entries(original.snapshots.after)) {
      const full = safePath(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content);
    }
    const outcome = gradeCoding(root, original.contract, { backend: options.backend || original.contract.graderBackend || 'process' });
    const gradeId = crypto.randomUUID();
    const grades=path.join(directory,'grades');
    const initial=fs.existsSync(grades)?fs.readdirSync(grades).find(id=>{const file=path.join(grades,id,'result.json');if(!fs.existsSync(file))return false;return ['initial','harbor-original'].includes(readJson(file).source);}):null;
    const prior = options.parentGradeId || initial || null;
    if (prior && !fs.existsSync(safePath(directory, 'grades/' + prior + '/result.json'))) throw Error('父评分不存在');
    const graderHash = hash(Buffer.concat(['coding-grader.cjs','coding-candidate.cjs'].map(name=>fs.readFileSync(path.resolve(__dirname,'../lib',name)))));
    const record = { schemaVersion: 1, gradeId, parentTrialId: original.identity.trialId, parentGradeId: prior,
      reason: options.reason || '对冻结产物独立复评', source: 'regrade', modelRequests: 0, graderHash,
      artifactManifestHash: hash(fs.readFileSync(path.join(directory, 'artifact-manifest.json'))),
      gradingStatus: outcome.status || (outcome.pass ? 'PASS' : 'FAIL'), outcome, createdAt: new Date().toISOString() };
    writeNew(path.join(directory, 'grades', gradeId, 'result.json'), record);
    return record;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    const directory = process.argv[2]; if (!directory) throw Error('用法：agent-eval-regrade.cjs TRIAL_DIR [process|docker]');
    const options=/** @type {any} */ ({});
    for(const arg of process.argv.slice(3)){if(['process','docker'].includes(arg))options.backend=arg;else if(arg.startsWith('--parent-grade='))options.parentGradeId=arg.slice(15);else if(arg.startsWith('--reason='))options.reason=arg.slice(9);else throw Error('未知重评参数：'+arg);}
    const result = regrade(path.resolve(directory), options);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.gradingStatus === 'PASS' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { regrade };
