'use strict';
module.exports=async root=>{
 const path=require('node:path'),assert=require('node:assert/strict');
 const agent=require(path.join(root,'electron/agent.cjs'));
 const {installScriptedModel}=require(path.join(root,'scripts/lib/scripted-model.cjs'));
 for(const tools of [null,undefined]){
  const stub=installScriptedModel([{content:'done'}],{loopLast:false});
  try{
   const result=await agent.runAgentChat({cfg:{apiBase:'http://scripted.invalid/v1',apiKey:'',model:'scripted-model',maxTokens:512,
    limits:{maxTotalTokens:100000,maxConcurrentRuns:1},reliability:{maxAttempts:1},compression:{enabled:false},rag:{enabled:false},tools:{}},
    tools,messages:[{role:'user',content:'Hello'}],timeoutMs:3000});
   assert.equal(result.state,'COMPLETED','NULL_TOOL_CONTEXT: pure chat must complete');
   assert.ok(stub.calls>0,'NULL_TOOL_CONTEXT: mocked model must execute');
  }catch(error){
   if(error instanceof TypeError&&/Cannot read properties of (null|undefined).*context/.test(error.message))throw Error('NULL_TOOL_CONTEXT: '+error.message);
   throw error;
  }finally{stub.restore();}
 }
 return {checks:4};
};
