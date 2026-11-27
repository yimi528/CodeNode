'use strict';
const assert=require('node:assert/strict');
const {verdict,transform}=require('../eval/repository-calibration.cjs');
assert.equal(verdict({status:0,stdout:'PASS',stderr:''},'nonce','task','CONTRACT').status,'FAIL');
assert.equal(verdict({status:0,stdout:'',stderr:''},'nonce','task','CONTRACT').status,'FAIL','process.exit(0) is not acceptance');
const receipt='REPOSITORY_ACCEPTANCE nonce '+JSON.stringify({id:'task',checks:3});
assert.equal(verdict({status:0,stdout:receipt,stderr:''},'nonce','task','CONTRACT').status,'PASS');
assert.equal(verdict({status:0,stdout:receipt+'\n'+receipt,stderr:''},'nonce','task','CONTRACT').status,'FAIL');
assert.equal(verdict({status:0,stdout:receipt,stderr:''},'other','task','CONTRACT').status,'FAIL');
assert.equal(verdict({status:1,stdout:'',stderr:'CONTRACT: assertion failed'},'nonce','task','CONTRACT').status,'FAIL');
assert.equal(verdict({status:1,stdout:'',stderr:'MODULE_NOT_FOUND'},'nonce','task','CONTRACT').status,'ERROR','setup failures are not evidence that the bug reproduced');
assert.equal(verdict({status:null,error:Error('timed out')},'nonce','task','CONTRACT').status,'ERROR');
assert.equal(transform('old',[{path:'file',from:'old',to:'new'}],'file'),'new');
assert.throws(()=>transform('missing',[{path:'file',from:'old',to:'new'}],'file'),/drift/);
assert.throws(()=>transform('old old',[{path:'file',from:'old',to:'new'}],'file'),/drift/);
const registry=require('../../config/repository-eval-calibration.json');
assert.equal(registry.tasks.length,4);assert.equal(new Set(registry.tasks.map(t=>t.family)).size,4);
for(const t of registry.tasks){assert.equal(t.admission.modelEligible,false);assert.equal(t.admission.review,'unreviewed');assert.match(t.baseCommit,/^[a-f0-9]{40}$/);assert.match(t.referenceCommit,/^[a-f0-9]{40}$/);}
console.log('REPOSITORY CALIBRATION: PASS (false success, malformed receipt, setup separation, mutation drift and no model admission)');
