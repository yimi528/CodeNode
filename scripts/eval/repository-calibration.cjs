#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const protocol=require('../lib/eval-protocol.cjs');
const ROOT=path.resolve(__dirname,'../..');

function git(repo,args) {
 const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'}});
 if(result.status!==0)throw Error('Repository preparation failed ('+args[0]+'): '+String(result.error||result.stderr).slice(0,1200));
 return result.stdout;
}
function transform(text,changes,file) {
 for(const change of changes.filter(c=>c.path===file)){
  if(text.split(change.from).length!==2)throw Error('Calibration mutation drift: '+file);
  text=text.replace(change.from,change.to);
 }
 return text;
}
function verdict(result,nonce,id,failurePattern) {
 const output=String(result.stdout||'')+'\n'+String(result.stderr||'');
 const receipt=String(result.stdout||'').split('\n').filter(line=>line.startsWith('REPOSITORY_ACCEPTANCE '+nonce+' '));
 if(result.error)return {status:'ERROR',detail:String(result.error)};
 if(result.status===0){
  let payload;try{payload=receipt.length===1?JSON.parse(receipt[0].slice(('REPOSITORY_ACCEPTANCE '+nonce+' ').length)):null;}catch{}
  return payload?.id===id&&Number.isInteger(payload.checks)&&payload.checks>0
   ?{status:'PASS',checks:payload.checks}:{status:'FAIL',detail:'Exit zero or stdout success marker is not a completed acceptance receipt'};
 }
 return new RegExp(failurePattern).test(output)?{status:'FAIL',detail:output.slice(-2000)}:{status:'ERROR',detail:'Failure did not reproduce the declared contract: '+output.slice(-2000)};
}
function calibrate(repository,output,ids) {
 repository=path.resolve(repository);output=path.resolve(output);
 if(fs.existsSync(output))throw Error('Use a new output directory');
 const registry=protocol.readJson(path.join(ROOT,'config/repository-eval-calibration.json'));
 const tasks=ids?registry.tasks.filter(t=>ids.includes(t.id)):registry.tasks;
 if(!tasks.length||ids&&(new Set(ids).size!==ids.length||tasks.length!==ids.length))throw Error('Unknown or duplicate repository task');
 const statusBefore=git(repository,['status','--porcelain']);
 const dependencyRoot=fs.realpathSync(path.join(ROOT,'node_modules'));
 const results=[];
 for(const task of tasks){
  if(task.admission.modelEligible!==false||task.admission.review!=='unreviewed')throw Error('This runner only calibrates trusted development sources');
  for(const commit of [task.baseCommit,task.referenceCommit,task.equivalentCommit].filter(Boolean)){
   if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Full source commit required');git(repository,['cat-file','-e',commit+'^{commit}']);
  }
  if(!/^[a-z-]+$/.test(task.checker))throw Error('Invalid checker ID');
  const checker=path.join(__dirname,'repository-checks',task.checker+'.cjs');
  const variants=[{id:'initial',expected:'FAIL',commit:task.baseCommit,changes:[]},
   {id:'reference',expected:'PASS',commit:task.referenceCommit,changes:[]},
   {id:'equivalent',expected:'PASS',commit:task.equivalentCommit||task.referenceCommit,changes:task.equivalent},
   {id:'wrong-repair',expected:'FAIL',commit:task.referenceCommit,changes:task.wrong},
   {id:'forged-success',expected:'FAIL',commit:task.referenceCommit,changes:[],earlyExit:true}];
  const observations=[];
  for(const variant of variants){
   const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-repository-calibration-')),workspace=path.join(temp,'workspace');fs.mkdirSync(workspace);
   try{
    const archive=path.join(temp,'source.tar');git(repository,['archive','--format=tar','--output='+archive,task.baseCommit,
      'electron','scripts/lib','config','package.json','package-lock.json','LICENSE']);
    const untar=spawnSync('tar',['-xf',archive,'-C',workspace],{encoding:'utf8',timeout:30000});if(untar.status!==0)throw Error('Archive extraction failed');
    const sourceFiles=[];
    for(const file of task.paths){
     const target=protocol.safePath(workspace,file);const original=git(repository,['show',variant.commit+':'+file]);
     const content=(variant.earlyExit&&file===task.paths[0]?"console.log('PASS');process.exit(0);\n":'')+transform(original,variant.changes,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
     sourceFiles.push({path:file,sha256:protocol.hash(content)});
    }
    if(fs.existsSync(path.join(workspace,'node_modules')))throw Error('Unexpected dependencies in frozen source');
    fs.symlinkSync(dependencyRoot,path.join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir');
    const nonce=crypto.randomUUID();
    const wrapper="global.fetch=async()=>{throw Error('NETWORK_DISABLED_FOR_CALIBRATION')};(async()=>{const r=await require(process.env.EVAL_TRUSTED_CHECKER)(process.cwd());console.log('REPOSITORY_ACCEPTANCE '+process.env.EVAL_RECEIPT_NONCE+' '+JSON.stringify({id:process.env.EVAL_TASK_ID,checks:r.checks}));})().catch(e=>{console.error(e);process.exitCode=1;});";
    const result=spawnSync(process.execPath,['-e',wrapper],{cwd:workspace,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
     env:{...require('../../electron/envPolicy.cjs').safeEnvironment({},[]),CODENODE_HOME:path.join(temp,'home'),
      EVAL_TRUSTED_CHECKER:checker,EVAL_RECEIPT_NONCE:nonce,EVAL_TASK_ID:task.id}});
    observations.push({variant:variant.id,expected:variant.expected,...verdict(result,nonce,task.id,task.failure),sourceFiles,
     checkerSha256:protocol.hash(fs.readFileSync(checker))});
   }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }
  results.push({id:task.id,family:task.family,provenance:task.provenance,repository:task.repository,baseCommit:task.baseCommit,
   snapshotScope:['electron','scripts/lib','config','package.json','package-lock.json','LICENSE'],
   referenceCommit:task.referenceCommit,admission:task.admission,pass:observations.every(r=>r.status===r.expected),observations});
 }
 if(git(repository,['status','--porcelain'])!==statusBefore)throw Error('Source working tree changed during calibration');
 const value={schemaVersion:1,calibrationId:crypto.randomUUID(),createdAt:new Date().toISOString(),
  evidenceType:'trusted-historical-source-calibration',modelRequests:0,modelEvaluationAdmitted:false,
  calibrationSourceSha256:protocol.hash(fs.readFileSync(__filename)),registrySha256:protocol.hash(fs.readFileSync(path.join(ROOT,'config/repository-eval-calibration.json'))),
  isolation:'process; trusted registered variants only; not an untrusted-code sandbox',
  sourceWorkingTreeStatusUnchanged:true,node:process.version,platform:process.platform,arch:process.arch,dependencyLockSha256:protocol.hash(fs.readFileSync(path.join(ROOT,'package-lock.json'))),
  pass:results.every(r=>r.pass),tasks:results,reviewStatus:'pending',releaseApproved:false};
 fs.mkdirSync(output,{recursive:true});protocol.writeNew(path.join(output,'summary.json'),value);
 fs.writeFileSync(path.join(output,'summary.md'),['# Historical repository calibration','',
  'This is development calibration of trusted historical code, not a model capability score. No model calls. Human review pending.','',
  '| Task | Initial | Reference | Equivalent | Wrong repair | Forged success | Calibration |','| --- | --- | --- | --- | --- | --- | --- |',
  ...results.map(t=>`| ${t.id} | ${t.observations.map(o=>o.status).join(' | ')} | ${t.pass?'PASS':'FAIL'} |`),'',
  'Model admission is blocked: self-hosted reference exposure, process execution, and independent review require separate resolution.',''].join('\n'));
 return value;
}
if(require.main===module){try{const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const m=/^--(repository|output|tasks)=(.+)$/.exec(arg);if(!m)throw Error('Use --repository=PATH --output=NEW_DIR [--tasks=ID,...]');return [m[1],m[2]];}));
 if(!args.output)throw Error('Output required');const result=calibrate(args.repository||ROOT,args.output,args.tasks?.split(','));console.log(JSON.stringify({pass:result.pass,tasks:result.tasks.map(t=>({id:t.id,pass:t.pass,variants:t.observations.map(o=>({id:o.variant,status:o.status,detail:o.detail}))})),modelRequests:0},null,2));if(!result.pass)process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={calibrate,verdict,transform};
