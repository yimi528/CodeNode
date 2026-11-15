'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const agent=require('../../electron/agent.cjs');
const sandbox=require('../../electron/sandbox.cjs');
const toolkit=require('../../electron/tools/toolkit.cjs');
const {AgentToolContext}=require('../../electron/tools/context.cjs');
const {installScriptedModel}=require('../lib/scripted-model.cjs');

async function exercise(model) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-reasoning-history-'));
  fs.writeFileSync(path.join(root,'fixture.txt'),'fixture');
  const policy=sandbox.resolvePolicy({mode:'off'},{projectRoot:root,userDataDir:root});
  sandbox.setDefaultPolicy(policy);
  const controller=new AbortController();
  const context=new AgentToolContext({projectRoot:root,confirm:async()=>true,sandbox:policy,signal:controller.signal});
  const registry=toolkit.buildDefaultRegistryWithConfig({projectRoot:root,ragEnabled:false,toolsAllowed:['read_file']});
  const stub=installScriptedModel([
    {reasoning:'synthetic-tool-reasoning',toolCalls:[{name:'read_file',args:{path:'fixture.txt'}}]},
    {reasoning:'synthetic-continuation-reasoning',content:'partial',finishReason:'length'},
    {content:'done'},
  ],{loopLast:false});
  try {
    const result=await agent.runAgentChat({cfg:{apiBase:'http://scripted.local/v1',apiKey:'',model,protocol:'openai',maxTokens:1024,
      limits:{maxTotalTokens:1000000,maxConcurrentRuns:1},reliability:{maxAttempts:1,retryBaseMs:1,retryMaxMs:2},compression:{enabled:false},rag:{enabled:false},tools:{}},
      messages:[{role:'system',content:'Test fixture'},{role:'user',content:'Read fixture and finish'}],tools:{registry,context},signal:controller.signal,timeoutMs:10000});
    assert.equal(result.state,'COMPLETED');
    return stub.seen.filter(r=>r.kind==='main');
  } finally {stub.restore();fs.rmSync(root,{recursive:true,force:true});}
}
async function main(){
  const deepseek=await exercise('deepseek-flash');
  assert.equal(deepseek.length,3);
  const tool=deepseek[1].messages.find(m=>m.role==='assistant'&&m.tool_calls?.length);
  assert.equal(tool.reasoning_content,'synthetic-tool-reasoning','DeepSeek requires complete reasoning history after tool calls');
  const continuation=deepseek[2].messages.find(m=>m.role==='assistant'&&m.content==='partial');
  assert.equal(continuation.reasoning_content,'synthetic-continuation-reasoning','non-tool continuation also preserves provider reasoning');
  const generic=await exercise('scripted-model');
  assert.ok(generic.every(r=>r.messages.every(m=>!Object.hasOwn(m,'reasoning_content'))),'provider-specific history must not change other OpenAI-compatible wire formats');
  console.log('DEEPSEEK REASONING: PASS (real tool loop and continuation preserve reasoning; other providers unchanged; zero external calls)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
