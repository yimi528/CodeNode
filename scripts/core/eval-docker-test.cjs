'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {gradeCoding}=require('../lib/coding-grader.cjs');
const task=/** @type {any} */ (require('../eval/coding-tasks.cjs')[0]);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-docker-grade-'));
try{
  function write(files){for(const [file,text]of Object.entries(files)){const full=path.join(root,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);}}
  write({...task.fixture,...task.reference});
  const correct=gradeCoding(root,task,{backend:'docker'});
  assert.equal(correct.status,'PASS',JSON.stringify(correct));
  write({'src/math.cjs':"console.log('CODING ACCEPTANCE PASS');process.exit(0);\n"});
  const forged=gradeCoding(root,task,{backend:'docker'});
  assert.equal(forged.pass,false);assert.notEqual(forged.status,'ERROR',JSON.stringify(forged));
  console.log('DOCKER VERIFIER: PASS (read-only candidate, no network, unprivileged worker, positive and forged-output negative)');
}finally{fs.rmSync(root,{recursive:true,force:true});}
