'use strict';
const assert=require('node:assert/strict');
const {nativeResult,executionStatus,availability}=require('../lib/eval-harbor-result.cjs');
const {verdict}=require('../lib/eval-protocol.cjs');
const message='HTTP 429: EVAL_TOKEN_BUDGET: insufficient remaining allowance';
const events=[{kind:'event',delta:{kind:'error',error:message}},{kind:'result',state:'FAILED',iterations:0}];
const result=nativeResult(events,{exception_info:{exception_message:'Command failed (exit 1)'}});
assert.equal(result.error,message,'wrapped native error takes precedence over the Harbor command wrapper');
assert.equal(executionStatus(result),'BUDGET_EXHAUSTED');
assert.equal(availability(result),'budget-not-funded');
assert.equal(verdict(executionStatus(result),'PASS','CLEAN'),false,'a valid patch does not imply completed delivery');
const completed=nativeResult([{kind:'result',state:'COMPLETED',iterations:2}]);
assert.equal(executionStatus(completed),'COMPLETED');assert.equal(availability(completed),'model-response-recorded');
const gradingFailure=nativeResult([{kind:'result',state:'COMPLETED',iterations:2}],{exception_info:{exception_message:'Verifier setup failed'}});
assert.equal(executionStatus(gradingFailure),'COMPLETED','a downstream verifier failure must not relabel completed agent execution');
const missing=nativeResult([{kind:'error',error:'Network failed'}]);
assert.equal(availability(missing),'no-completed-model-response');
const tool=nativeResult([{kind:'event',delta:{kind:'tool_result',toolCalls:[{name:'execute_shell',ok:true}]}},{kind:'result',state:'COMPLETED'}]);
assert.equal(tool.toolCalls.length,1);
assert.equal(executionStatus(nativeResult([],{exception_info:{exception_type:'AgentTimeoutError'}}),{exception_info:{exception_type:'AgentTimeoutError'}}),'BUDGET_EXHAUSTED');
{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const protocol=require('../lib/eval-protocol.cjs');
  const {reanalyze}=require('../eval/reanalyze-harbor.cjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-archived-analysis-'));
  const input=path.join(root,'input'),originalFetch=global.fetch;
  let requests=0;global.fetch=async()=>{requests++;throw Error('Reanalysis must not call models');};
  try {
    const task=/** @type {any} */ (require('../eval/coding-tasks.cjs')[0]),source='/ci/live';
    const trial=protocol.createTrial(path.join(input,'confirmation/evidence'),task,{mode:'model'});
    for(const event of events)trial.append('events.jsonl',event);
    trial.save('native-result.json',{result:nativeResult(events)});
    trial.collect(task.fixture,task.fixture,{fixture:task.fixture,behaviorCases:task.behaviorCases});
    trial.save('verifier-environment.json',{verified:true,network:{enforced:true,networkMode:'none'}});
    const trialPath=source+'/confirmation/evidence/trials/'+trial.trialId;
    const status={executionStatus:'UNKNOWN',gradingStatus:'FAIL',integrityStatus:'CLEAN',delivered:false};
    protocol.atomicJson(path.join(input,'confirmation/attempts/0001/report.json'),{tasks:[{id:task.id,protocol:status,evidence:{directory:trialPath}}]});
    const frozen=path.join(input,'confirmation/runtime/frozen.cjs');fs.mkdirSync(path.dirname(frozen),{recursive:true});fs.writeFileSync(frozen,'synthetic frozen source');
    const schedule=[{id:'0001',taskId:task.id,arm:'baseline',trial:1},{id:'0002',taskId:task.id,arm:'improved',trial:1}];
    const plan={experimentId:'synthetic',model:'synthetic',arms:['baseline','improved'],seed:1,taskSpecs:[task],taskHash:protocol.hash([task]),schedule,
      budgetLedger:source+'/token-ledger.json',runtime:{directory:source+'/confirmation/runtime',sourceCommit:'a'.repeat(40),files:[{path:'frozen.cjs',sha256:protocol.hash(fs.readFileSync(frozen))}]}};
    const planFile=path.join(input,'confirmation/plan.json');protocol.atomicJson(planFile,plan);
    protocol.atomicJson(path.join(input,'confirmation/plan.seal.json'),{sha256:protocol.hash(fs.readFileSync(planFile))});
    protocol.atomicJson(path.join(input,'ci-source.json'),{sourceCommit:plan.runtime.sourceCommit});
    const summary=path.join(input,'confirmation/summary.json');
    protocol.atomicJson(summary,{experimentId:plan.experimentId,budget:{charged:1},rows:[
      {...schedule[0],phase:'FINISHED',reportFile:source+'/confirmation/attempts/0001/report.json',protocol:status,firstShellValid:null},
      {...schedule[1],phase:'NOT_STARTED',reportFile:null,protocol:null,firstShellValid:null},
    ]});
    const before=protocol.hash(fs.readFileSync(summary));
    const corrected=reanalyze(input,path.join(root,'new-analysis'));
    assert.equal(corrected.rows[0].protocol.executionStatus,'BUDGET_EXHAUSTED');
    assert.equal(corrected.rows[0].availability,'budget-not-funded');
    assert.equal(corrected.rows[1].phase,'NOT_STARTED');assert.equal(corrected.byArm.baseline.budgetBlocked,1);
    assert.equal(corrected.gradesUnchanged,true);assert.equal(corrected.modelRequests,0);assert.equal(requests,0);
    assert.equal(protocol.hash(fs.readFileSync(summary)),before,'original report must remain unchanged');
    const {calibrate}=require('../eval/calibrate-trace-metrics.cjs');
    const calibrated=calibrate(input,path.join(root,'new-metrics'));
    assert.equal(calibrated.gradesUnchanged,true);assert.equal(calibrated.originalEndpointPreserved,true);
    assert.equal(calibrated.modelRequests,0);assert.equal(requests,0);
    assert.equal(calibrated.groups.baseline.observed,0,'no shell call is not a successful shell call');
    assert.equal(calibrated.groups.improved.planned,1,'unstarted attempts remain in the denominator');
    trial.save('native-result.json',{result:{toolCalls:[{name:'execute_shell',ok:true}]}});
    assert.throws(()=>calibrate(input,path.join(root,'inconsistent-metrics')),/disagree/);
    assert.throws(()=>reanalyze(input,path.join(input,'overwrite')),/outside/);
    fs.appendFileSync(planFile,' ');assert.throws(()=>reanalyze(input,path.join(root,'tampered')),/seal/);
    assert.equal(fs.existsSync(path.join(root,'tampered')),false);
  } finally {global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
}
console.log('HARBOR RESULT: PASS (wrapped errors, budget vs service classification, unchanged grading and separate delivery)');
