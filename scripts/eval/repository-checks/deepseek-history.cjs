'use strict';
module.exports=async root=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
 const agent=require(path.join(root,'electron/agent.cjs')),sandbox=require(path.join(root,'electron/sandbox.cjs'));
 const toolkit=require(path.join(root,'electron/tools/toolkit.cjs'));
 const {AgentToolContext}=require(path.join(root,'electron/tools/context.cjs'));
 const {installScriptedModel}=require(path.join(root,'scripts/lib/scripted-model.cjs'));
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'history-contract-'));fs.writeFileSync(path.join(workspace,'fixture.txt'),'fixture');
 try{
  const policy=sandbox.resolvePolicy({mode:'off'},{projectRoot:workspace,userDataDir:workspace});sandbox.setDefaultPolicy(policy);
  const context=new AgentToolContext({projectRoot:workspace,confirm:async()=>true,sandbox:policy,signal:new AbortController().signal});
  const registry=toolkit.buildDefaultRegistryWithConfig({projectRoot:workspace,ragEnabled:false,toolsAllowed:['read_file']});
  const stub=installScriptedModel([{reasoning:'tool-history',toolCalls:[{name:'read_file',args:{path:'fixture.txt'}}]},
   {reasoning:'continuation-history',content:'partial',finishReason:'length'},{content:'done'}],{loopLast:false});
  try{
   const result=await agent.runAgentChat({cfg:{apiBase:'http://scripted.invalid/v1',apiKey:'',model:'deepseek-flash',protocol:'openai',maxTokens:1024,
    limits:{maxTotalTokens:100000,maxConcurrentRuns:1},reliability:{maxAttempts:1},compression:{enabled:false},rag:{enabled:false},tools:{}},
    tools:{registry,context},messages:[{role:'user',content:'Read fixture and finish'}],timeoutMs:5000});
   assert.equal(result.state,'COMPLETED','DEEPSEEK_HISTORY: complete tool loop');
   const seen=stub.seen.filter(r=>r.kind==='main');
   assert.equal(seen[1].messages.find(m=>m.tool_calls?.length)?.reasoning_content,'tool-history','DEEPSEEK_HISTORY: preserve tool reasoning');
   assert.equal(seen[2].messages.find(m=>m.role==='assistant'&&m.content==='partial')?.reasoning_content,'continuation-history','DEEPSEEK_HISTORY: preserve continuation reasoning');
  }finally{stub.restore();}
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
 return {checks:3};
};
