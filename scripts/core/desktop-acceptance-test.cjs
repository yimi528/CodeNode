'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configure}=require('../../electron/desktopAcceptance.cjs');
const {TaskAcceptance}=require('../../electron/taskAcceptance.cjs');
const runStore=require('../../electron/runStore.cjs');
const {AgentToolContext}=require('../../electron/tools/context.cjs');
const toolkit=require('../../electron/tools/toolkit.cjs'),sandbox=require('../../electron/sandbox.cjs');
const agent=require('../../electron/agent.cjs');
(async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codenode-desktop-acceptance-')));
 try{
  fs.writeFileSync(path.join(root,'value.txt'),'bad');
  fs.writeFileSync(path.join(root,'verify.cjs'),`if(require('fs').readFileSync('value.txt','utf8')!=='good'){console.error('public example');process.exit(1)}`);
  const value={version:1,artifacts:[{id:'file',path:'value.txt'}],checks:[{id:'test',execution:{mode:'argv',program:process.execPath,args:['verify.cjs']},inputs:['value.txt','verify.cjs'],reproduce:{exitCode:1,outputIncludes:'public example'}}]};
  const cfg=configure(agent.loadConfig(root),root,value);value.artifacts[0].path='different.txt';assert.equal(cfg.acceptance.artifacts[0].path,'value.txt');
  assert.throws(()=>configure({},root,{version:1,artifacts:[{id:'out',path:'../escape.txt'}]}),/路径越界/);
  assert.throws(()=>configure({},root,{version:1,checks:[{id:'sh',execution:{mode:'shell',command:'echo ok'},inputs:['.']}]}),/仅支持/);
  assert.throws(()=>configure({},root,{version:1,checks:[{id:'x',execution:{mode:'argv',program:'node',args:[]},inputs:[]}]}),/inputs/);
  const policy=sandbox.resolvePolicy({mode:'off'},{projectRoot:root,userDataDir:root});
  const context=new AgentToolContext({projectRoot:root,confirm:async()=>true,sandbox:policy,signal:new AbortController().signal});
  const tools={registry:toolkit.buildDefaultRegistryWithConfig({projectRoot:root,ragEnabled:false}),context};
  runStore.startRun(root,'original',{});cfg.costRunId='original';
  const before=new TaskAcceptance({cfg,tools});await before.initialize();assert.equal(before.baselines.get('test').status,'passed');
  fs.writeFileSync(path.join(root,'value.txt'),'good');
  const resumedCfg=configure({...cfg},root,null,'original');assert.equal(resumedCfg.acceptance.artifacts[0].path,'value.txt');
  assert.throws(()=>configure({},root,{version:1,artifacts:[{id:'changed',path:'value.txt'}]},'original'),/沿用原运行/);
  const resumed=new TaskAcceptance({cfg:resumedCfg,tools});await resumed.initialize();assert.equal(resumed.calls,0,'resume must not rerun the red baseline against already fixed code');
  await resumed.check();assert.equal(resumed.report.status,'passed');
  fs.writeFileSync(path.join(root,'value.txt'),'changed');assert.equal(resumed.freshness().status,'stale');
  // External adapters use the same acceptance runner, independent of their text claims.
  const {runExternal}=require('../../electron/backends/runExternal.cjs');
  const factory=success=>()=>Object.fromEntries([...['describe','start','health','status','cancel','respondAuthorization','respondInput','close'].map(key=>[key,async()=>({})]),
   ['subscribe',()=>()=>{}],['submit',async input=>{assert.match(input.prompt,/任务验收契约/);if(success)fs.writeFileSync(path.join(root,'external.txt'),'ok');return{state:'COMPLETED',content:'claimed done'};}]
  ]);
  const externalCfg=configure({...cfg,editing:{autoVerify:false},costRunId:undefined},root,{version:1,artifacts:[{id:'external',path:'external.txt'}]});
  const input={projectRoot:root,prompt:'deliver',settings:{backend:'codex',sandbox:'workspace-write'},cfg:externalCfg,sandboxPolicy:policy,signal:new AbortController().signal,onDelta:()=>{},confirm:async()=>true,toolRegistry:tools.registry,toolContext:context};
  const failed=await runExternal({...input,requestId:'external-fail'},{createBackend:factory(false)});assert.equal(failed.state,'FAILED',failed.error);assert.equal(failed.taskAcceptance.status,'failed');
  const passed=await runExternal({...input,requestId:'external-pass'},{createBackend:factory(true)});assert.equal(passed.state,'COMPLETED',passed.error);assert.equal(passed.taskAcceptance.status,'passed');
  console.log('DESKTOP ACCEPTANCE: PASS (validation, frozen request, scope boundary, red baseline resume, stale evidence, external pass/fail)');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
