#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const protocol=require('../lib/eval-protocol.cjs');
const statistics=require('../lib/eval-statistics.cjs');
const {createLedger}=require('../lib/eval-transport.cjs');
const {runQualityChecks}=require('../lib/eval-quality.cjs');
const {reviewPack,validateReview}=require('../lib/eval-reviews.cjs');

function parse(argv) {
  const options=/** @type {Record<string,string>} */ ({});
  const allowed=new Set(['output','tasks','subset','trials','mode','kind','from','budget-ledger','max-tokens','model','base-url','arms','seed','isolation','grader-backend','plan','review','profile']);
  for(const arg of argv) {
    const match=/^--([a-z-]+)=(.*)$/.exec(arg);
    if(!match)throw Error('参数使用 --name=value 格式：'+arg);
    if(!allowed.has(match[1]))throw Error('未知参数：'+match[1]);
    options[match[1]]=match[2];
  }
  return options;
}
function sourceFiles(root=ROOT) {
  const result=[];
  function visit(relative) {
    const full=path.join(root,relative);
    if(!fs.existsSync(full))return;
    const stat=fs.lstatSync(full);
    if(stat.isSymbolicLink())throw Error('源码快照包含符号链接：'+relative);
    if(stat.isDirectory())for(const name of fs.readdirSync(full).sort())visit(relative+'/'+name);
    else if(/\.(?:cjs|mjs|ts|tsx|json|jsonc|css|md|py|toml)$/.test(relative)) result.push(relative);
  }
  for(const dir of ['electron','src','scripts','config','bin','benchmarks/codenode_benchmarks'])visit(dir);
  result.push('package.json','package-lock.json','LICENSE');
  return result.sort();
}
function freezeRuntime(directory) {
  const runtime=path.join(directory,'runtime');fs.mkdirSync(runtime,{recursive:true});
  const files=[];
  for(const relative of sourceFiles()) {
    const src=path.join(ROOT,relative),dest=path.join(runtime,relative);
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);
    files.push({path:relative,sha256:protocol.hash(fs.readFileSync(src))});
  }
  for(const packageName of ['@typescript/typescript6','@typescript/old','typescript']) {
    const source=path.join(ROOT,'node_modules',packageName);
    if(fs.existsSync(source))fs.cpSync(source,path.join(runtime,'node_modules',packageName),{recursive:true,dereference:true});
  }
  // Dependencies copied into this snapshot are immutable inputs as well.
  const dependencies=[];
  const scan=dir=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())scan(full);else if(entry.isFile())dependencies.push({path:path.relative(runtime,full).replaceAll('\\','/'),sha256:protocol.hash(fs.readFileSync(full))});}};
  scan(path.join(runtime,'node_modules'));
  return {directory:runtime,files:[...files,...dependencies],hash:protocol.hash([...files,...dependencies]),node:process.version,platform:process.platform,arch:process.arch};
}
function verifyRuntime(manifest) {
  for(const file of manifest.files)if(protocol.hash(fs.readFileSync(protocol.safePath(manifest.directory,file.path)))!==file.sha256)throw Error('冻结运行时漂移：'+file.path);
}
function datasetAt(runtime) { return require(path.join(runtime,'scripts/eval/agent-eval-tasks.cjs')); }
function prepare(options) {
  const output=path.resolve(options.output||path.join(ROOT,'out/evals/experiment-'+crypto.randomUUID()));
  if(fs.existsSync(output))throw Error('实验目录已存在，拒绝覆盖');
  const trials=Number(options.trials||2),tokenLimit=Number(options['max-tokens']||1000000),seed=Number(options.seed||1701);
  if(options.tasks&&options.subset)throw Error('tasks 与 subset 只能选一个');
  if(options.arms&&!['single','paired'].includes(options.arms))throw Error('arms 必须为 single 或 paired');
  if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295)throw Error('seed 必须是无符号 32 位整数');
  if(!Number.isInteger(trials)||trials<1||trials>20||!Number.isSafeInteger(tokenLimit)||tokenLimit<=0||tokenLimit>1000000)throw Error('试验次数或 token 上限无效；单实验最多 100 万 tokens');
  if(options.isolation&&!['local-process','harbor'].includes(options.isolation))throw Error('未知隔离类型');
  const profile=options.profile||'benchmark-controlled';
  if(!['benchmark-controlled','native-product'].includes(profile))throw Error('未知 profile');
  if(profile==='native-product'&&options.isolation!=='harbor')throw Error('native-product 必须使用 Harbor 原生 CLI 通道');
  const mode=options.mode||'offline';if(!['offline','model'].includes(mode))throw Error('mode 必须为 offline 或 model');
  const kind=options.kind||'pilot';if(!['pilot','confirmation'].includes(kind))throw Error('kind 必须为 pilot 或 confirmation');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const runtime=options.from?readPlan(path.resolve(options.from)).runtime:freezeRuntime(output),dataset=datasetAt(runtime.directory);
  const ids=options.tasks?options.tasks.split(','):dataset.modelSubsets[options.subset||'coding'];
  if(!Array.isArray(ids)||!ids.length)throw Error('任务清单为空或 subset 无效');
  const tasks=ids.map(id=>{const task=dataset.tasks.find(t=>t.id===id);if(!task)throw Error('未知任务：'+id);return task;});
  if(new Set(ids).size!==ids.length)throw Error('任务清单重复');
  if(kind==='confirmation'&&tasks.some(t=>t.evaluation.split!=='holdout'))throw Error('确认实验只允许保留集任务');
  const quality=require(path.join(runtime.directory,'scripts/lib/eval-quality.cjs')).runQualityChecks(tasks);if(!quality.pass)throw Error('任务质量检查失败');
  const arms=options.arms==='single'?['baseline']:['baseline','improved'];
  const random=statistics.rng(seed),schedule=[];
  for(let trial=1;trial<=trials;trial++)for(const task of tasks){const order=[...arms];if(random()<0.5)order.reverse();for(const arm of order)schedule.push({id:String(schedule.length+1).padStart(4,'0'),taskId:task.id,arm,trial});}
  const budgetLedger=options['budget-ledger']?path.resolve(options['budget-ledger']):path.join(output,'token-ledger.json');
  if(!options['budget-ledger'])createLedger(budgetLedger,tokenLimit);
  const budgetState=protocol.readJson(budgetLedger);
  if(!budgetState.ledgerId||budgetState.limit>1000000)throw Error('共享预算账本无效');
  const plan={schemaVersion:1,experimentId:crypto.randomUUID(),createdAt:new Date().toISOString(),kind,mode,seed,trials,tokenLimit:budgetState.limit,budgetLedger,budgetLedgerId:budgetState.ledgerId,
    model:options.model||process.env.CODENODE_EVAL_MODEL||'deepseek-chat',apiBase:options['base-url']||process.env.CODENODE_EVAL_BASE_URL||'https://api.deepseek.com',
    profile,isolation:options.isolation||'local-process',graderBackend:options['grader-backend']||(options.isolation==='harbor'?'docker':'process'),
    changedComponent:arms.length===2?'argv tool-guide example':'none',arms,schedule,
    estimand:'fixed-suite',primaryMetric:'first-shell-valid-contract',minimumEffect:0.05,maxRegression:0.05,
    stoppingRule:'fixed planned attempts; stop on unfunded reservations or two consecutive attempts without a completed model response',haltAfterUnavailable:2,
    runtime,quality,taskIds:ids,taskSpecs:tasks,taskHash:protocol.hash(tasks),
    environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:require('node:os').cpus()[0]?.model||'unknown',sharedHost:true},
    releaseRequirements:{independentReview:true,isolatedVerifier:true,completeCoverage:true},snapshotSourcesKnown:true};
  protocol.writeNew(path.join(output,'plan.json'),plan);
  protocol.writeNew(path.join(output,'plan.seal.json'),{sha256:protocol.hash(fs.readFileSync(path.join(output,'plan.json'))),createdAt:new Date().toISOString()});
  return {output,plan:path.join(output,'plan.json'),attempts:schedule.length};
}
function readPlan(file) {
  const plan=protocol.readJson(file);
  const seal=path.join(path.dirname(file),'plan.seal.json');
  if(fs.existsSync(seal)&&protocol.hash(fs.readFileSync(file))!==protocol.readJson(seal).sha256)throw Error('实验计划已被修改');
  plan.sealVerified=fs.existsSync(seal);
  if(plan.schemaVersion!==1||!Array.isArray(plan.schedule)||protocol.hash(plan.taskSpecs)!==plan.taskHash)throw Error('实验计划损坏');
  verifyRuntime(plan.runtime);
  const ledger=protocol.readJson(plan.budgetLedger);if(ledger.ledgerId!==plan.budgetLedgerId||ledger.limit!==plan.tokenLimit)throw Error('共享预算身份或额度漂移');
  return plan;
}
function loadRows(directory,plan) {
  return plan.schedule.map(entry=>{
    const stateFile=path.join(directory,'states',entry.id+'.json');
    const state=fs.existsSync(stateFile)?protocol.readJson(stateFile):{phase:'NOT_STARTED'};
    let record=null;
    if(state.reportFile&&fs.existsSync(state.reportFile))record=protocol.readJson(state.reportFile).tasks.find(t=>t.id===entry.taskId);
    return {...entry,state,record};
  });
}
function shellMetric(record) {
  if(!record?.evidence?.directory)return null;
  const file=path.join(record.evidence.directory,'native-result.json');if(!fs.existsSync(file))return null;
  const native=protocol.readJson(file);
  const call=native.result?.toolCalls?.find(c=>c.name==='execute_shell');if(!call)return null;
  return call.ok===false&&call.data?.code==='ARG_SCHEMA'?0:1;
}
function analyze(file) {
  const plan=readPlan(file),directory=path.dirname(file),rows=loadRows(directory,plan);
  const familyCounts={};for(const task of plan.taskSpecs)familyCounts[task.evaluation.family]=(familyCounts[task.evaluation.family]||0)+1;
  const comparison=statistics.compareTasks(plan.taskSpecs.map(task=>({taskId:task.id,family:task.evaluation.family,weight:1/familyCounts[task.evaluation.family],
    baseline:rows.filter(r=>r.taskId===task.id&&r.arm==='baseline').map(r=>shellMetric(r.record)),
    improved:rows.filter(r=>r.taskId===task.id&&r.arm==='improved').map(r=>shellMetric(r.record))})),{seed:plan.seed,minimumEffect:plan.minimumEffect,maxRegression:plan.maxRegression});
  for(const row of rows) {
    row.availability = !row.record ? 'not-started' : plan.mode==='offline' ? 'scripted' : row.record.modelSteps===0&&row.record.error ? 'no-completed-model-response' : 'model-response-recorded';
  }
  const byArm=Object.fromEntries(plan.arms.map(arm=>{const subset=rows.filter(r=>r.arm===arm);const counts=statistics.coverage(subset.map(r=>r.record||{protocol:{executionStatus:'NOT_STARTED',gradingStatus:'NOT_RUN',delivered:false}}),subset.length);return [arm,{...counts,modelEvidenceUnavailable:subset.filter(r=>r.availability==='no-completed-model-response').length}];}));
  const ledger=protocol.readJson(plan.budgetLedger);
  const taskIntervals=plan.taskSpecs.map(task=>({taskId:task.id,family:task.evaluation.family,split:task.evaluation.split,
    arms:Object.fromEntries(plan.arms.map(arm=>{const subset=rows.filter(r=>r.taskId===task.id&&r.arm===arm);const valid=subset.map(r=>shellMetric(r.record)).filter(v=>v!==null);const success=valid.reduce((n,v)=>n+v,0);return [arm,{planned:subset.length,firstShellObserved:valid.length,firstShellValid:success,wilson95:statistics.wilson(success,valid.length),delivered:subset.filter(r=>r.record?.protocol?.delivered).length}];}))}));
  const analysisHash=protocol.hash(Buffer.concat([fs.readFileSync(__filename),fs.readFileSync(path.resolve(__dirname,'../lib/eval-statistics.cjs'))]));
  const result={schemaVersion:1,analysis:{sourceHash:analysisHash,updatedAt:new Date().toISOString()},experimentId:plan.experimentId,kind:plan.kind,mode:plan.mode,primaryMetric:plan.primaryMetric,
    byArm,comparison,taskIntervals,budget:{scope:'shared-ledger',thisExperimentReported:ledger.attempts.filter(a=>rows.some(r=>r.record?.evidence?.trialId===a.identity)).reduce((n,a)=>n+(a.reported||0),0),limit:ledger.limit,charged:ledger.charged,reported:ledger.reported,pending:Object.values(ledger.reservations).reduce((n,v)=>n+Number(v),0),boundViolation:!!ledger.boundViolation},
    complete:rows.every(r=>r.state.phase==='FINISHED'),rows:rows.map(r=>({id:r.id,taskId:r.taskId,arm:r.arm,trial:r.trial,phase:r.state.phase,protocol:r.record?.protocol||null,availability:r.availability,reportFile:r.state.reportFile||null,firstShellValid:shellMetric(r.record)})),
    inference:'Fixed-suite diagnostic; small or saturated samples do not establish a generalized improvement.'};
  const previousFile=path.join(directory,'summary.json');
  if(fs.existsSync(previousFile)){const previous=protocol.readJson(previousFile);if(previous.analysis?.sourceHash!==analysisHash){const id=require('node:crypto').randomUUID();protocol.writeNew(path.join(directory,'analysis-history',id+'.json'),previous);if(fs.existsSync(path.join(directory,'summary.md')))fs.copyFileSync(path.join(directory,'summary.md'),path.join(directory,'analysis-history',id+'.md'));}}
  protocol.atomicJson(previousFile,result);
  const lines=['# CodeNode 评测实验报告','',`- 模式：${plan.mode}；类型：${plan.kind}；模型：${plan.model}`,
    `- 变化：${plan.changedComponent}；计划 ${rows.length} 次；隔离：${plan.isolation}`,
    `- token 上限 ${ledger.limit}；供应商已报告 ${ledger.reported}；保守计账 ${ledger.charged}；未结算预留 ${result.budget.pending}`,
    '- 未知计费不当作零；原始失败与未启动尝试均保留。离线结果不是模型能力证据。','',
    '| 组 | 计划 | 可评分产物 | 无完整模型响应 | 端到端交付 | 保守交付比例 |','| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(byArm).map(([arm,r])=>`| ${arm} | ${r.planned} | ${r.scored} | ${r.modelEvidenceUnavailable} | ${r.delivered} | ${r.conservativeDelivery} |`),'',
    '## 主指标比较','', '```json',JSON.stringify(comparison,null,2),'```','',
    '## 任务级覆盖和区间','', '```json',JSON.stringify(taskIntervals,null,2),'```','',
    '## 每次尝试','',...result.rows.map(r=>`- ${r.id} ${r.taskId} ${r.arm} trial=${r.trial}: ${r.phase}；${r.protocol?.gradingStatus||'NOT_RUN'}；${r.reportFile||'无结果'}`),''];
  fs.writeFileSync(path.join(directory,'summary.md'),lines.join('\n'));
  return result;
}
function run(file) {
  const directory=path.dirname(file),plan=readPlan(file),lock=path.join(directory,'run.lock');
  if(plan.mode==='model'&&!process.env.CODENODE_EVAL_API_KEY)throw Error('缺少显式评测凭据');
  const fd=fs.openSync(lock,'wx',0o600);
  try {
    let unavailable=0;
    for(const entry of plan.schedule) {
      verifyRuntime(plan.runtime);
      const stateFile=path.join(directory,'states',entry.id+'.json');
      if(fs.existsSync(stateFile))continue; // Unknown/incomplete attempts require explicit investigation, never another paid solve.
      const ledger=protocol.readJson(plan.budgetLedger);
      if(ledger.boundViolation||ledger.charged+Object.values(ledger.reservations).reduce((n,v)=>n+Number(v),0)>=ledger.limit)break;
      const reportDir=path.join(directory,'attempts',entry.id);fs.mkdirSync(reportDir,{recursive:true});
      protocol.atomicJson(stateFile,{phase:'RUNNING',startedAt:new Date().toISOString(),...entry});
      const args=[path.join(plan.runtime.directory,'scripts/eval/agent-eval.cjs'),'--mode='+plan.mode,'--task='+entry.taskId,'--report-dir='+reportDir,'--grader-backend='+plan.graderBackend];
      if(plan.mode==='model')args.push('--require-model','--token-ledger='+plan.budgetLedger);
      if(entry.arm==='improved')args.push('--argv-guide');
      const output=fs.openSync(path.join(reportDir,'runner.log'),'wx',0o600);
      let child;
      try { child=spawnSync(process.execPath,args,{cwd:plan.runtime.directory,stdio:['ignore',output,output],timeout:240000,
        env:{...process.env,CODENODE_EVAL_MODEL:plan.model,CODENODE_EVAL_BASE_URL:plan.apiBase}}); }
      finally {fs.closeSync(output);}
      const reports=fs.readdirSync(reportDir).filter(name=>/^agent-eval-.*\.json$/.test(name));
      const reportFile=reports.length===1?path.join(reportDir,reports[0]):null;
      protocol.atomicJson(stateFile,{phase:reportFile?'FINISHED':'UNKNOWN',finishedAt:new Date().toISOString(),exitCode:child.status,reportFile,error:child.error?String(child.error):null,...entry});
      const result=analyze(file);console.log(`${entry.id} ${entry.taskId} ${entry.arm}: exit=${child.status}, reported=${result.budget.reported}/${result.budget.limit}`);
      if(reportFile){const report=protocol.readJson(reportFile);if(JSON.stringify(report.tasks).includes('EVAL_TOKEN_BUDGET'))break;
        unavailable=report.tasks.some(t=>t.modelSteps===0&&t.error)?unavailable+1:0;
        if(plan.haltAfterUnavailable&&unavailable>=plan.haltAfterUnavailable)break;}
    }
    return analyze(file);
  } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
function gate(file,reviewFile) {
  const plan=readPlan(file),result=analyze(file),review=validateReview(plan.taskSpecs,reviewFile);
  const reasons=[];
  if(!plan.sealVerified)reasons.push('历史计划缺少运行前完整性封印');
  if(plan.mode!=='model')reasons.push('没有真实模型证据');
  if(plan.kind!=='confirmation')reasons.push('不是预注册的保留集确认实验');
  if(!result.complete)reasons.push('计划尝试不完整');
  if(!review.pass)reasons.push(review.reason);
  if(plan.graderBackend!=='docker')reasons.push('独立容器 verifier 未验证');
  if(plan.isolation!=='harbor')reasons.push('解题阶段未在 Harbor 隔离环境执行');
  if(Object.values(result.byArm).some(arm=>arm.modelEvidenceUnavailable>0))reasons.push('部分尝试没有完整模型响应，不能作为能力证据');
  if(Object.values(result.byArm).some(arm=>arm.delivered!==arm.planned))reasons.push('存在未验证交付或回归');
  if(result.budget.boundViolation)reasons.push('预算上界假设被违反');
  if(plan.arms.length===2&&result.comparison.decision!=='improvement-supported')reasons.push('统计证据不足以支持收益');
  const value={pass:reasons.length===0,reasons,review,checkedAt:new Date().toISOString()};
  protocol.atomicJson(path.join(path.dirname(file),'gate.json'),value);return value;
}
function main(argv) {
  const command=argv[0],options=parse(argv.slice(1));
  if(command==='doctor')return require('./eval-harbor.cjs').doctor();
  if(command==='export-harbor')return require('./eval-harbor.cjs').exportHarbor(path.resolve(options.plan));
  if(command==='prepare')return prepare(options);
  if(command==='review-pack'){const plan=readPlan(path.resolve(options.plan));return reviewPack(plan.taskSpecs,path.resolve(options.output));}
  if(!options.plan)throw Error('必须提供 --plan=PATH');
  const file=path.resolve(options.plan);
  if(command==='run')return readPlan(file).isolation==='harbor'?require('./eval-harbor.cjs').runHarbor(file):run(file);
  if(command==='analyze')return analyze(file);
  if(command==='gate')return gate(file,options.review&&path.resolve(options.review));
  throw Error('命令为 prepare、run、analyze、review-pack、gate');
}
if(require.main===module){Promise.resolve().then(()=>main(process.argv.slice(2))).then(result=>{console.log(JSON.stringify(result,null,2));if(result.pass===false)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={prepare,run,analyze,gate,readPlan,freezeRuntime,verifyRuntime,main};
