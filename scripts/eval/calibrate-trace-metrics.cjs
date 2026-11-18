#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const protocol=require('../lib/eval-protocol.cjs');
const metrics=require('../lib/eval-tool-metrics.cjs');
const {reanalyze}=require('./reanalyze-harbor.cjs');
const {nativeResult}=require('../lib/eval-harbor-result.cjs');

function calibrate(input,output) {
  // The existing replay validates plan/source/candidate/isolation and preserves
  // the original endpoint. Add new diagnostics alongside it, never replace it.
  const result=reanalyze(input,output),root=path.resolve(input),plan=protocol.readJson(path.join(root,'confirmation/plan.json'));
  const origin=path.posix.dirname(plan.budgetLedger),inputs=[];
  const rows=result.rows.map(row=>{
    if(!row.reportFile)return {...row,metrics:null};
    const relative=path.posix.relative(origin,row.reportFile),file=protocol.safePath(root,relative),report=protocol.readJson(file);
    const trial=report.tasks[0].evidence.directory;
    const nativeFile=protocol.safePath(root,path.posix.relative(origin,trial)+'/native-result.json');
    const bytes=fs.readFileSync(nativeFile);inputs.push({path:path.relative(root,nativeFile),sha256:protocol.hash(bytes)});
    const calls=JSON.parse(bytes.toString('utf8')).result.toolCalls||[];
    const eventsFile=protocol.safePath(root,path.posix.relative(origin,trial)+'/events.jsonl');
    const eventCalls=nativeResult(fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))).toolCalls;
    if(protocol.hash(calls)!==protocol.hash(eventCalls))throw Error('Native tool calls disagree with archived events');
    return {id:row.id,taskId:row.taskId,arm:row.arm,originalFirstShellValid:row.firstShellValid,
      protocol:row.protocol,metrics:metrics.summarize(calls)};
  });
  const groups=Object.fromEntries(plan.arms.map(arm=>{const data=rows.filter(r=>r.arm===arm),observed=data.filter(r=>r.metrics?.firstShell);
    return [arm,{planned:data.length,observed:observed.length,argumentAccepted:observed.filter(r=>r.metrics.firstShell.argumentAccepted===true).length,
      policyRejected:observed.filter(r=>r.metrics.firstShell.classification.dimension==='policy').length,
      invocationAccepted:observed.filter(r=>r.metrics.firstShell.invocationAccepted).length,
      unknown:observed.filter(r=>r.metrics.firstShell.classification.dimension==='unknown').length}];}));
  const sourceHash=protocol.hash(Buffer.concat([fs.readFileSync(__filename),fs.readFileSync(require.resolve('../lib/eval-tool-metrics.cjs'))]));
  const value={schemaVersion:1,analysisId:crypto.randomUUID(),parentAnalysisId:result.analysisId,sourceHash,metricVersion:metrics.VERSION,
    originalEndpointPreserved:true,gradesUnchanged:result.gradesUnchanged,rawEvidenceUnchanged:true,modelRequests:0,releaseApproved:false,reviewStatus:'pending',groups,rows,inputs};
  protocol.writeNew(path.join(output,'tool-metrics.json'),value);
  fs.writeFileSync(path.join(output,'tool-metrics.md'),['# Tool metric calibration','',
    'Zero model requests. Original primary endpoint, scores and source evidence are preserved. These are versioned diagnostic axes, not a new confirmatory result.','',
    '| Arm | Observed first calls | Argument accepted | Policy rejected | Invocation accepted | Unknown |','| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(groups).map(([arm,g])=>`| ${arm} | ${g.observed} | ${g.argumentAccepted} | ${g.policyRejected} | ${g.invocationAccepted} | ${g.unknown} |`),'',
    'PROGRAM_NOT_ALLOWED concerns the execution policy, not JSON syntax. Nonzero process exit is separate from tool invocation success.','',
    'Human review remains pending; no capability-release approval is granted.',''].join('\n'));
  return value;
}
if(require.main===module){try{const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const m=/^--(input|output)=(.+)$/.exec(arg);if(!m)throw Error('Use --input=DIR --output=NEW_DIR');return [m[1],m[2]];}));
  if(!options.input||!options.output)throw Error('Input and output required');const r=calibrate(options.input,options.output);console.log(JSON.stringify({analysisId:r.analysisId,modelRequests:r.modelRequests,groups:r.groups},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={calibrate};
