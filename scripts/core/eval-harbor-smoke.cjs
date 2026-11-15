'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {prepare}=require('../eval/eval-system.cjs');
const {runHarbor,doctor}=require('../eval/eval-harbor.cjs');
const {readJson}=require('../lib/eval-protocol.cjs');

async function main(){
  const ready=doctor();assert.equal(ready.pass,true,JSON.stringify(ready));
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-harbor-evaluation-'));
  let passed=false;
  try{
    const created=prepare({output:path.join(parent,'experiment'),tasks:'coding-timeout-default',trials:'1',arms:'single',mode:'offline',isolation:'harbor'});
    const result=await runHarbor(created.plan);
    assert.equal(result.complete,true);assert.equal(result.byArm.baseline.delivered,1);assert.equal(result.budget.reported,0);
    const report=readJson(result.rows[0].reportFile);
    const network=readJson(path.join(report.tasks[0].evidence.directory,'verifier-environment.json'));
    assert.equal(network.verified,true);assert.equal(network.network.networkMode,'none');assert.ok(network.network.containerId);
    passed=true;
    console.log('HARBOR EVALUATION SMOKE: PASS (native CodeNode in agent container, separate verifier, artifact transfer, scripted broker, zero external model calls)');
  }finally{if(passed)fs.rmSync(parent,{recursive:true,force:true});else console.error('Harbor failure artifacts preserved at '+parent);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
