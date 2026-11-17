#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const protocol=require('../lib/eval-protocol.cjs');
const statistics=require('../lib/eval-statistics.cjs');
const native=require('../lib/eval-harbor-result.cjs');
const toolMetrics=require('../lib/eval-tool-metrics.cjs');

// Reclassify archived events only. Never relocate by editing a sealed plan,
// launch an agent/verifier, overwrite a grade, or replace the original report.
function reanalyze(input,output) {
  input=path.resolve(input);output=path.resolve(output);
  if(output===input||output.startsWith(input+path.sep)||fs.existsSync(output))throw Error('Analysis requires a new directory outside the original evidence');
  const inputs=[];
  const bytes=relative=>{const file=protocol.safePath(input,relative),data=fs.readFileSync(file);inputs.push({path:relative,sha256:protocol.hash(data)});return data;};
  const json=relative=>JSON.parse(bytes(relative).toString('utf8'));
  const planBytes=bytes('confirmation/plan.json'),plan=JSON.parse(planBytes.toString('utf8'));
  if(plan.primaryMetricVersion!=null&&!['legacy-arg-schema-v1',toolMetrics.VERSION].includes(plan.primaryMetricVersion))throw Error('Unsupported primary metric version');
  if(json('confirmation/plan.seal.json').sha256!==protocol.hash(planBytes)||protocol.hash(plan.taskSpecs)!==plan.taskHash)throw Error('Original plan seal mismatch');
  const sourceRoot=path.posix.dirname(plan.budgetLedger);
  const relative=original=>{
    const rel=path.posix.relative(sourceRoot,original);
    protocol.safePath(input,rel);return rel;
  };
  const original=json('confirmation/summary.json'),source=json('ci-source.json');
  if(source.sourceCommit!==plan.runtime.sourceCommit||original.experimentId!==plan.experimentId)throw Error('Original source identity mismatch');
  for(const file of plan.runtime.files)if(protocol.hash(bytes(relative(plan.runtime.directory)+'/'+file.path))!==file.sha256)throw Error('Frozen source hash mismatch');
  const rows=plan.schedule.map(entry=>{
    const row=original.rows.find(r=>r.id===entry.id);
    if(!row||row.taskId!==entry.taskId||row.arm!==entry.arm)throw Error('Original schedule coverage mismatch');
    if(!row.reportFile)return {...row};
    const report=json(relative(row.reportFile)),task=report.tasks?.[0];
    if(task?.id!==entry.taskId)throw Error('Task report identity mismatch');
    const dir=relative(task.evidence.directory);
    const verified=protocol.verifyTrial(protocol.safePath(input,dir));
    if(verified.identity.taskId!==entry.taskId)throw Error('Trial identity mismatch');
    bytes(dir+'/artifact-manifest.json');bytes(dir+'/snapshots.json');bytes(dir+'/grading-contract.json');
    const environment=json(dir+'/verifier-environment.json');
    if(!environment.verified||environment.network?.networkMode!=='none'||!environment.network?.enforced)throw Error('Missing enforced verifier isolation');
    const events=bytes(dir+'/events.jsonl').toString('utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const final=native.nativeResult(events);
    const status={...task.protocol,executionStatus:native.executionStatus(final)};
    status.delivered=protocol.verdict(status.executionStatus,status.gradingStatus,status.integrityStatus);
    const shell=final.toolCalls.find(c=>c.name==='execute_shell');
    const outcome=shell&&toolMetrics.classify(shell);
    const accepted=outcome&&toolMetrics.acceptance(outcome);
    const firstShellValid=plan.primaryMetricVersion===toolMetrics.VERSION
      ? !shell||accepted===null?null:accepted?1:0
      : shell?(shell.ok===false&&shell.data?.code==='ARG_SCHEMA'?0:1):null;
    if(firstShellValid!==row.firstShellValid)throw Error('Unexpected primary metric drift');
    return {...row,originalProtocol:row.protocol,protocol:status,availability:native.availability(final),
      firstShellValid,
      error:final.error,gradingUnchanged:status.gradingStatus===task.protocol.gradingStatus};
  });
  const byArm=Object.fromEntries(plan.arms.map(arm=>{const subset=rows.filter(r=>r.arm===arm);return [arm,{
    ...statistics.coverage(subset.map(r=>({protocol:r.protocol||{executionStatus:'NOT_STARTED',gradingStatus:'NOT_RUN',delivered:false}})),subset.length),
    budgetBlocked:subset.filter(r=>r.availability==='budget-not-funded').length,
    modelEvidenceUnavailable:subset.filter(r=>r.availability==='no-completed-model-response').length,
  }];}));
  const familyCounts={};for(const task of plan.taskSpecs)familyCounts[task.evaluation.family]=(familyCounts[task.evaluation.family]||0)+1;
  const comparison=statistics.compareTasks(plan.taskSpecs.map(task=>({taskId:task.id,family:task.evaluation.family,weight:1/familyCounts[task.evaluation.family],
    baseline:rows.filter(r=>r.taskId===task.id&&r.arm==='baseline').map(r=>r.firstShellValid),
    improved:rows.filter(r=>r.taskId===task.id&&r.arm==='improved').map(r=>r.firstShellValid)})),{seed:plan.seed,minimumEffect:plan.minimumEffect,maxRegression:plan.maxRegression});
  const sourceHash=protocol.hash(Buffer.concat([fs.readFileSync(__filename),fs.readFileSync(require.resolve('../lib/eval-harbor-result.cjs')),fs.readFileSync(require.resolve('../lib/eval-statistics.cjs')),fs.readFileSync(require.resolve('../lib/eval-tool-metrics.cjs'))]));
  const result={schemaVersion:1,analysisId:crypto.randomUUID(),analysisSourceHash:sourceHash,createdAt:new Date().toISOString(),
    sourceExperimentId:plan.experimentId,sourceCommit:source.sourceCommit,model:plan.model,profile:plan.profile,
    modelRequests:0,originalEvidenceUnchanged:true,gradesUnchanged:rows.every(r=>!r.reportFile||r.gradingUnchanged),
    complete:rows.every(r=>r.phase==='FINISHED'),byArm,comparison,budget:original.budget,rows,inputs,
    releaseApproved:false,reviewStatus:'pending',inference:'Fixed-suite replication; incomplete funding and small samples do not establish a benefit.'};
  fs.mkdirSync(output,{recursive:true});protocol.writeNew(path.join(output,'summary.json'),result);
  fs.writeFileSync(path.join(output,'summary.md'),[
    '# Harbor archived-event reanalysis','',`Source commit: ${result.sourceCommit}; model: ${result.model}.`,
    'Model requests: 0. Original evidence and verifier grades are unchanged. Human review remains pending.','',
    '| Arm | Planned | Started | Delivered | Budget blocked | No model response |','| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(byArm).map(([arm,r])=>`| ${arm} | ${r.planned} | ${r.started} | ${r.delivered} | ${r.budgetBlocked} | ${r.modelEvidenceUnavailable} |`),'',
    `Comparison: ${comparison.decision}. Complete: ${result.complete}. Release approved: false.`,
    'Budget-denied attempts are not service outages or evidence of coding failure. Unstarted attempts remain in the planned denominator.','',
    ...rows.map(r=>`- ${r.id}: ${r.protocol?.executionStatus||'NOT_STARTED'} / ${r.protocol?.gradingStatus||'NOT_RUN'} / ${r.availability}`),'',
  ].join('\n'));
  return result;
}
if(require.main===module){try{
  const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const match=/^--(input|output)=(.+)$/.exec(arg);if(!match)throw Error('Use --input=DIR --output=NEW_DIR');return [match[1],match[2]];}));
  if(!options.input||!options.output)throw Error('Input and output are required');
  const result=reanalyze(options.input,options.output);console.log(JSON.stringify({analysisId:result.analysisId,complete:result.complete,modelRequests:0,byArm:result.byArm,comparison:result.comparison.decision},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={reanalyze};
