'use strict';

const VERSION='tool-outcome-v2';
const POLICY=new Set(['PROGRAM_NOT_ALLOWED','EXECUTION_MODE_DENIED','CWD_OUT_OF_ROOT','PATH_OUT_OF_ROOT','PERMISSION_DENIED','APPROVAL_REQUIRED','APPROVAL_DENIED']);
const ARGUMENT=new Set(['ARG_SCHEMA','ARG_INVALID_JSON','INVALID_TOOL_ARGUMENTS','ARG_SEMANTIC','CWD_NOT_FOUND']);
function classify(call) {
  const data=call.data||{},raw=call.failure?.code||data.failureCode||data.code||null;
  const text=String(call.result??call.text??call.failure?.message??'');
  let code=raw,source='structured-code';
  // Historical ARG_SCHEMA conflated whitelist and mode policy. These are exact
  // implementation messages, not guesses from arbitrary shell stdout.
  if(call.ok===false&&raw==='ARG_SCHEMA') {
    if(/^命令不在白名单[:：]/.test(text)){code='PROGRAM_NOT_ALLOWED';source='legacy-exact-message';}
    else if(/^shell 模式仅在 POSIX 评测容器启用/.test(text)){code='EXECUTION_MODE_DENIED';source='legacy-exact-message';}
    else if(/^cwd 不存在或越过授权边界/.test(text))return {version:VERSION,code:'LEGACY_CWD_AMBIGUOUS',originalCode:raw,dimension:'unknown',source:'ambiguous-legacy-message'};
  }
  let dimension;
  if(call.ok===false&&POLICY.has(code))dimension='policy';
  else if(call.ok===false&&ARGUMENT.has(code))dimension='argument';
  else if(call.ok===false&&['BUDGET_EXCEEDED','EVAL_TOKEN_BUDGET'].includes(code))dimension='budget';
  else if(call.ok===false&&code==='CANCELLED')dimension='cancel';
  else if(data.timedOut||code==='TIMEOUT')dimension='timeout';
  else if(call.ok===false&&(code==='SHELL_START_FAILED'||code==='SYSTEM_ERROR'))dimension='infrastructure';
  else if(Number.isInteger(data.exitCode)&&data.exitCode!==0){dimension='execution';code='PROCESS_EXIT_NONZERO';source='exit-code';}
  else if(call.ok===false)dimension='unknown';
  else dimension=call.ok===true?'none':'unknown';
  return {version:VERSION,code,originalCode:raw,dimension,source};
}
function acceptance(outcome) {
  if(['argument','policy'].includes(outcome.dimension))return false;
  if(['none','execution','timeout'].includes(outcome.dimension)||outcome.code==='SHELL_START_FAILED')return true;
  // Cancellation, budget checks and unexpected infrastructure errors may happen
  // before schema/policy validation. Their absence of rejection proves nothing.
  return null;
}
function summarize(calls) {
  const first=calls.find(c=>c.name==='execute_shell');
  const failure=first?classify(first):null;
  return {version:VERSION,calls:calls.length,firstShell:first?{
    callId:first.callId||null,classification:failure,
    // Shape acceptance is not inferred from a missing ARG_SCHEMA; it remains
    // unknown for unclassified historical failures.
    argumentAccepted:failure.dimension==='argument'?false:failure.dimension==='policy'||acceptance(failure)===true?true:null,
    policyAccepted:failure.dimension==='policy'?false:acceptance(failure)===true?true:null,
    invocationAccepted:acceptance(failure),
  }:null,failures:calls.filter(c=>c.ok===false||Number.isInteger(c.data?.exitCode)&&c.data.exitCode!==0).map(c=>({tool:c.name,callId:c.callId||null,...classify(c)}))};
}
module.exports={VERSION,classify,summarize,acceptance};
