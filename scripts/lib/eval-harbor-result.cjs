'use strict';
const protocol=require('./eval-protocol.cjs');

function nativeResult(events, raw=/** @type {any} */ ({})) {
  const final=[...events].reverse().find(e=>e.kind==='result')||{};
  const failure=[...events].reverse().find(e=>e.kind==='error'||e.delta?.kind==='error');
  return {...final,error:final.error||failure?.error||failure?.delta?.error||(final.state==='COMPLETED'?null:raw.exception_info?.exception_message)||null,
    toolCalls:events.flatMap(e=>e.delta?.kind==='tool_result'?e.delta.toolCalls||[]:[])};
}
function executionStatus(final, raw=/** @type {any} */ ({})) {
  if(String(final.error||'').includes('EVAL_TOKEN_BUDGET'))return 'BUDGET_EXHAUSTED';
  if(!final.state&&raw.exception_info?.exception_type==='AgentTimeoutError')return 'BUDGET_EXHAUSTED';
  return protocol.classifyExecution(final);
}
function availability(final) {
  if(String(final.error||'').includes('EVAL_TOKEN_BUDGET'))return 'budget-not-funded';
  return !final.iterations&&final.error?'no-completed-model-response':'model-response-recorded';
}
module.exports={nativeResult,executionStatus,availability};
