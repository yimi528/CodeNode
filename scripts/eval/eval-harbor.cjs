'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const protocol=require('../lib/eval-protocol.cjs');
const {startBroker}=require('../lib/eval-broker.cjs');
const {validateLedger}=require('../lib/eval-transport.cjs');
const importedNative=require('../lib/eval-harbor-result.cjs');
const ROOT=path.resolve(__dirname,'../..');
const python=process.env.CODENODE_BENCHMARK_PYTHON||path.join(ROOT,'benchmarks/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');

function doctor() {
  const docker=spawnSync('docker',['version','--format','{{.Server.Version}}'],{encoding:'utf8',timeout:15000});
  const sdk=spawnSync(python,['-c','import importlib.metadata; from harbor.models.task.config import VerifierConfig; assert "environment_mode" in VerifierConfig.model_fields; print(importlib.metadata.version("harbor"))'],{encoding:'utf8',timeout:15000});
  return {pass:docker.status===0&&sdk.status===0,docker:docker.status===0?docker.stdout.trim():'unavailable',harbor:sdk.status===0?sdk.stdout.trim():'unavailable',
    reason:docker.status===0?null:'需要可用的 Docker daemon；不会回退为宿主执行'};
}
function exportHarbor(planFile) {
  const {readPlan}=require('./eval-system.cjs');const plan=readPlan(planFile);
  const output=path.join(path.dirname(planFile),'harbor');
  if(fs.existsSync(output))return verifyExport(output,planFile);
  const run=spawnSync(python,['-m','codenode_benchmarks.evaluation','export','--plan',planFile,'--output',output],{
    encoding:'utf8',timeout:120000,env:{...process.env,PYTHONPATH:path.join(plan.runtime.directory,'benchmarks')}});
  if(run.status!==0)throw Error('Harbor 任务导出失败：'+String(run.error || run.stderr || ('exit='+run.status+', signal='+run.signal)).slice(0,2000));
  return verifyExport(output,planFile);
}
function verifyExport(output,planFile) {
  const file=path.join(output,'export.json'),value=protocol.readJson(file);
  if(value.planSha256!==protocol.hash(fs.readFileSync(planFile))||!Array.isArray(value.files)||!value.files.length)throw Error('Harbor 导出缺少完整性清单或来自其他计划，请新建实验');
  for(const item of value.files)if(protocol.hash(fs.readFileSync(protocol.safePath(output,item.path)))!==item.sha256)throw Error('Harbor 导出产物漂移：'+item.path);
  const seal=path.join(output,'export.seal.json');
  if(fs.existsSync(seal)&&protocol.readJson(seal).sha256!==protocol.hash(fs.readFileSync(file)))throw Error('Harbor 导出清单漂移');
  if(!fs.existsSync(seal))protocol.writeNew(seal,{sha256:protocol.hash(fs.readFileSync(file))});
  return value;
}
function snapshots(root) {
  const result={};let bytes=0;
  function visit(relative){
    const full=path.join(root,relative);const stat=fs.lstatSync(full);
    if(stat.isSymbolicLink())throw Error('候选产物存在符号链接');
    if(stat.isDirectory()){for(const name of fs.readdirSync(full)){if(name!=='.codenode')visit(relative?relative+'/'+name:name);}return;}
    if(!stat.isFile()||(bytes+=stat.size)>16*1024*1024)throw Error('候选产物类型或大小无效');
    result[relative]=fs.readFileSync(full,'utf8');
  }
  visit('');return result;
}
async function runHarbor(planFile) {
  const {readPlan,analyze,verifyRuntime}=require('./eval-system.cjs');
  const plan=readPlan(planFile),directory=path.dirname(planFile);
  if(plan.mode==='model'&&!process.env.CODENODE_EVAL_API_KEY)throw Error('Missing explicit evaluation credential');
  const readiness=doctor();if(!readiness.pass)throw Error(JSON.stringify(readiness));
  const exported=exportHarbor(planFile);
  const buildxConfig=path.join(directory,'buildx');fs.mkdirSync(buildxConfig,{recursive:true});
  const lock=path.join(directory,'run.lock'),fd=fs.openSync(lock,'wx',0o600);
  try {
    let unavailable=0;
    for(const entry of plan.schedule) {
      verifyRuntime(plan.runtime);
      const stateFile=path.join(directory,'states',entry.id+'.json');if(fs.existsSync(stateFile))continue;
      const ledger=protocol.readJson(plan.budgetLedger),balance=validateLedger(ledger);
      if(plan.mode==='model'&&(ledger.boundViolation||balance.pending||balance.remaining<16385))break;
      const task=plan.taskSpecs.find(t=>t.id===entry.taskId),secrets=[process.env.CODENODE_EVAL_API_KEY||''];
      const writer=protocol.createTrial(path.join(directory,'evidence'),task,{mode:plan.mode,isolation:'harbor',profile:plan.profile,agent:plan.runtime.hash},secrets);
      const broker=await startBroker(writer,{model:plan.model,apiBase:plan.apiBase,apiKey:secrets[0],ledger:plan.budgetLedger,mockTask:plan.mode==='offline'?task:null});
      secrets.push(broker.token);
      const output=path.join(directory,'attempts',entry.id);fs.mkdirSync(output,{recursive:true});
      const jobs=path.join(output,'harbor-jobs');
      protocol.atomicJson(stateFile,{phase:'RUNNING',...entry,startedAt:new Date().toISOString()});
      writer.save('execution.json',{phase:'SOLVING',executionStatus:'UNKNOWN',gradingStatus:'NOT_RUN',integrityStatus:'UNKNOWN'});
      const args=['-m','codenode_benchmarks.evaluation','run-one','--export',path.join(directory,'harbor/export.json'),'--task',task.id,
        '--output',jobs,'--model',plan.model,'--base-url','http://host.docker.internal:'+broker.port+'/v1'];
      if(entry.arm==='improved')args.push('--argv-guide');
      let status;
      try {
        status=await new Promise((resolve,reject)=>{
          const child=spawn(python,args,{env:{...process.env,BUILDX_CONFIG:buildxConfig,CODENODE_EVAL_API_KEY:'',CODENODE_API_KEY:broker.token,PYTHONPATH:path.join(plan.runtime.directory,'benchmarks')}});
          const log=fs.createWriteStream(path.join(output,'runner.log'),{flags:'wx',mode:0o600});
          for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log.write(protocol.redact(String(chunk),secrets)));
          child.once('error',reject);child.once('close',code=>{log.end();resolve(code);});
        });
      } finally {await broker.close();}
      const imported=fs.existsSync(path.join(jobs,'import.json'))?protocol.readJson(path.join(jobs,'import.json')):null;
      if(!imported?.results?.length){protocol.atomicJson(stateFile,{phase:'UNKNOWN',exitCode:status,...entry});continue;}
      const resultFile=imported.results[0],nativeTrial=path.dirname(resultFile),raw=protocol.readJson(resultFile);
      const nativeFile=path.join(nativeTrial,'agent/codenode.jsonl');
      const events=fs.existsSync(nativeFile)?fs.readFileSync(nativeFile,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}):[];
      const final=importedNative.nativeResult(events,raw);
      for(const event of events)writer.append('events.jsonl',event);
      const candidate=path.join(nativeTrial,'artifacts/candidate');
      const after=fs.existsSync(candidate)?snapshots(candidate):{};
      const integrity=!fs.existsSync(candidate)?'UNKNOWN':Object.entries(task.fixture).filter(([file])=>!file.startsWith('src/')).every(([file,text])=>after[file]===text)?'CLEAN':'VIOLATION';
      const reward=raw.verifier_result?.rewards?.reward;
      const state={executionStatus:importedNative.executionStatus(final,raw),gradingStatus:reward===1?'PASS':reward===0?'FAIL':'ERROR',integrityStatus:integrity};
      const networkFile=path.join(nativeTrial,'verifier-network.json');
      const network=fs.existsSync(networkFile)?protocol.readJson(networkFile):null;
      if(network?.enforced!==true||network.networkMode!=='none')state.gradingStatus='ERROR';
      writer.save('verifier-environment.json',{network,verified:network?.enforced===true&&network.networkMode==='none'});
      const result={modelSteps:final.iterations||0,error:final.error||[...events].reverse().find(e=>e.kind==='error')?.error||raw.exception_info?.exception_message||null,id:task.id,title:task.title,category:task.category,status:state.gradingStatus==='PASS'&&integrity==='CLEAN'?'pass':'fail',
        assessment:{...task.evaluation,evidence:plan.mode==='offline'?'scripted-regression':'model-coding-outcome'},
        protocol:{...state,delivered:protocol.verdict(state.executionStatus,state.gradingStatus,integrity)},
        evidence:{trialId:writer.trialId,directory:writer.directory},metrics:{tokens:final.usage?.total_tokens||0,mode:plan.mode},originalReward:reward??null};
      writer.collect(task.fixture,after,{schemaVersion:1,taskId:task.id,fixture:task.fixture,behaviorCases:task.behaviorCases,evaluation:task.evaluation,graderBackend:'docker'});
      writer.save('native-result.json',{result:final,before:task.fixture,after});
      writer.save('effective-config.json',{isolation:'harbor',verifierIsolation:'separate',resources:{cpus:1,memory_mb:1024,verifierMemory_mb:512},context:events.find(e=>e.kind==='benchmark_context'),runtime:exported.runtime});
      writer.save('execution.json',{phase:'FINISHED',...result.protocol});
      writer.save('grades/'+require('node:crypto').randomUUID()+'/result.json',{source:'harbor-original',originalReward:reward??null,...result.protocol});
      const reportFile=path.join(output,'agent-eval-harbor.json');
      protocol.writeNew(reportFile,{datasetVersion:'harbor-coding-v1',mode:plan.mode,model:plan.model,tasks:[result],rawResult:resultFile,exitCode:result.status==='pass'?0:1});
      protocol.atomicJson(stateFile,{phase:'FINISHED',exitCode:status,reportFile,...entry});
      console.log(`${entry.id} ${task.id} ${entry.arm}: reward=${reward}`);analyze(planFile);
      unavailable=result.modelSteps===0&&result.error?unavailable+1:0;
      if(plan.mode==='model'&&(String(result.error||'').includes('EVAL_TOKEN_BUDGET')||unavailable>=(plan.haltAfterUnavailable||2)))break;
    }
    return analyze(planFile);
  } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
module.exports={doctor,exportHarbor,verifyExport,runHarbor};
