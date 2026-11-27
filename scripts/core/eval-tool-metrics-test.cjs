'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const metrics=require('../lib/eval-tool-metrics.cjs');
const failures=require('../../electron/tools/failures.cjs');
const toolkit=require('../../electron/tools/toolkit.cjs'),sandbox=require('../../electron/sandbox.cjs');
const {AgentToolContext}=require('../../electron/tools/context.cjs');

async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-tool-outcomes-'));
 try{
  const policy=sandbox.resolvePolicy({mode:'off'},{projectRoot:root,userDataDir:root});sandbox.setDefaultPolicy(policy);
  const context=new AgentToolContext({projectRoot:root,confirm:async()=>true,sandbox:policy,signal:new AbortController().signal});
  const registry=toolkit.buildDefaultRegistryWithConfig({projectRoot:root,ragEnabled:false,toolsAllowed:['execute_shell','poll_job']});
  const invoke=args=>registry.execute('execute_shell',args,context);
  const denied=await invoke({mode:'argv',program:'ls',args:[]});
  assert.equal(denied.data.code,'PROGRAM_NOT_ALLOWED');assert.equal(denied.failure.category,'permission');
  assert.equal(denied.failure.retryable,false);assert.equal(denied.failure.userActionRequired,false);
  assert.ok(denied.data.allowedPrograms.includes('node'));assert.ok(!denied.data.allowedPrograms.includes('ls'));
  assert.equal(failures.classifyFailure(denied).known,true);
  assert.equal((await invoke({mode:'shell',command:'true'})).data.code,'EXECUTION_MODE_DENIED');
  assert.equal(failures.classifyFailure(await invoke({mode:'argv',program:'node',args:'bad'})).code,'ARG_SCHEMA');
  assert.equal((await invoke({mode:'argv',program:'node',args:[],cwd:'absent'})).data.code,'CWD_NOT_FOUND');
  assert.equal((await invoke({mode:'argv',program:'node',args:[],cwd:'../outside'})).data.code,'CWD_OUT_OF_ROOT');
  const missing=await invoke({mode:'argv',program:path.join(root,'absent','node'),args:['-e','0']});
  assert.equal(missing.data.code,'SHELL_START_FAILED');
  const background=await invoke({mode:'argv',program:path.join(root,'absent','node'),args:[],async:true});
  const polled=background.ok?await registry.execute('poll_job',{jobId:background.data.jobId,waitSeconds:1},context):background;
  assert.equal(polled.data.code,'SHELL_START_FAILED','asynchronous spawn failure keeps the same category');
  const nonzero=await invoke({mode:'argv',program:process.execPath,args:['-e','process.exit(7)']});
  assert.equal(nonzero.ok,true);assert.equal(nonzero.data.exitCode,7,'tool invocation and command outcome are separate');
  assert.equal(metrics.classify(nonzero).dimension,'execution');
  const historic={name:'execute_shell',ok:false,result:'命令不在白名单：ls',data:{code:'ARG_SCHEMA'}};
  assert.equal(metrics.classify(historic).dimension,'policy');assert.equal(metrics.classify(historic).source,'legacy-exact-message');
  assert.equal(metrics.summarize([historic]).firstShell.argumentAccepted,true);
  assert.equal(metrics.summarize([historic]).firstShell.invocationAccepted,false);
  assert.equal(metrics.classify({...historic,ok:true}).dimension,'none','stdout text cannot override a successful structured result');
  assert.equal(metrics.classify({...historic,result:'参数不符合 schema'}).dimension,'argument');
  assert.equal(metrics.classify({...historic,result:'cwd 不存在或越过授权边界'}).dimension,'unknown','ambiguous old cwd is not guessed');
  assert.equal(metrics.summarize([{name:'execute_shell',ok:false,data:{code:'NEW_UNKNOWN_CODE'}}]).firstShell.invocationAccepted,null);
  assert.equal(metrics.summarize([]).firstShell,null);
  for(const code of ['CANCELLED','BUDGET_EXCEEDED','SYSTEM_ERROR']) {
    const first=metrics.summarize([{name:'execute_shell',ok:false,data:{code}}]).firstShell;
    assert.equal(first.argumentAccepted,null,code+' can occur before validation');
    assert.equal(first.invocationAccepted,null);
  }
  const evidence=path.join(root,'evidence');fs.mkdirSync(evidence);
  assert.throws(()=>require('../eval/eval-system.cjs').shellMetric(null,'unknown-future-metric'),/Unsupported/);
  fs.writeFileSync(path.join(evidence,'native-result.json'),JSON.stringify({result:{toolCalls:[{name:'execute_shell',ok:false,data:{code:'PROGRAM_NOT_ALLOWED'}}]}}));
  const {shellMetric}=require('../eval/eval-system.cjs');
  assert.equal(shellMetric({evidence:{directory:evidence}},metrics.VERSION),0,'renaming a policy error must not turn an unsuccessful invocation into success');
  assert.equal(shellMetric({evidence:{directory:evidence}}),1,'the historical endpoint remains explicitly versioned');
  context.benchmarkContainer=()=>{throw Error('synthetic internal failure');};
  assert.equal((await invoke({mode:'argv',program:'node',args:[]})).data.code,'SYSTEM_ERROR','unexpected internals are not schema errors');
  console.log('TOOL OUTCOMES: PASS (real policy, schema, cwd, spawn, exit, legacy migration and unknown boundaries)');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
