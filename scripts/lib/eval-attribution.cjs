'use strict';
const {hash}=require('./eval-protocol.cjs');
function attribute(result, checks, protocol) {
  const observations=[],hypotheses=[],calls=result.toolCalls||[],seen=new Map();
  for(let i=0;i<calls.length;i++) {
    const call=calls[i],evidence={file:'native-result.json',pointer:'/result/toolCalls/'+i};
    if(call.ok===false&&['ARG_SCHEMA','INVALID_ARGS'].includes(call.data?.code||call.failure?.code))observations.push({category:'tool-argument-rejection',tool:call.name,evidence});
    if(call.data?.exitCode!=null&&call.data.exitCode!==0)observations.push({category:'command-nonzero-exit',exitCode:call.data.exitCode,evidence,interpretation:'诊断事实，不自动视为任务失败'});
    if(call.data?.code==='EVAL_TEMPORARY_FAILURE')observations.push({category:'injected-tool-failure',recovered:calls.slice(i+1).some(c=>c.name===call.name&&c.ok),evidence});
    const signature=hash([call.name,call.args,call.ok,call.data?.sourceSha256,call.data?.sha256,call.data?.exitCode,call.result]);
    if(seen.has(signature))observations.push({category:'identical-tool-result',previousIndex:seen.get(signature),evidence,interpretation:'需要结合缓存和目的判断，不自动认定空转'});
    seen.set(signature,i);
  }
  if(protocol.integrityStatus==='VIOLATION')observations.push({category:'protected-state-violation',evidence:{file:'snapshots.json',pointer:'/after'}});
  if(protocol.executionStatus==='BUDGET_EXHAUSTED')observations.push({category:'budget-stop',evidence:{file:'execution.json',pointer:'/executionStatus'}});
  if(protocol.gradingStatus==='FAIL'&&checks.some(c=>c.type==='coding-behavior'&&!c.pass))hypotheses.push({category:'implementation-or-grader-mismatch',confirmation:'unconfirmed',evidence:{file:'native-result.json',pointer:'/checks'}});
  return {schemaVersion:1,observations,hypotheses,humanConfirmation:'pending'};
}
module.exports={attribute};
