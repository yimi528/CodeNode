'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {instrumentFetch}=require('./eval-transport.cjs');

function scriptedFetch(task) {
  let index=0;
  return async (_url,init)=>{
    const body=JSON.parse(init.body);
    if(!body.stream)return new Response(JSON.stringify({choices:[{message:{content:'脚本摘要'}}],usage:{total_tokens:120}}),{headers:{'content-type':'application/json'}});
    const step=task.script[index++];
    if(!step)throw Error('离线 Harbor 模型脚本耗尽');
    const calls=step.tools|| (step.tool?[{name:step.tool,args:step.args}]:[]);
    const delta=calls.length?{tool_calls:calls.map((c,i)=>({index:i,id:'script-'+index+'-'+i,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{content:step.content||''};
    const packets=[{choices:[{index:0,delta}]},{choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}]},
      {choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}];
    return new Response(packets.map(p=>'data: '+JSON.stringify(p)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
}
async function startBroker(writer,options) {
  const token=options.token||'proxy-'+crypto.randomUUID();
  const transport=instrumentFetch(options.mockTask?scriptedFetch(options.mockTask):global.fetch,writer,
    {apiBase:options.apiBase,ledger:options.mockTask?null:options.ledger});
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
    try {
      let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>2*1024*1024)throw Error('请求过大');}
      const body=JSON.parse(text);
      if(body.model!==options.model)throw Error('模型标识超出实验计划');
      const response=await transport(options.apiBase.replace(/\/+$/,'')+'/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(options.apiKey||'offline')},body:JSON.stringify(body)});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});
      if(response.body)for await(const chunk of response.body)res.write(Buffer.from(chunk));
      res.end();
    } catch(error){if(!res.headersSent)res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:String(error.message).replaceAll(options.apiKey||'NO-KEY','[REDACTED]')}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',()=>resolve(undefined));});
  const address=server.address();if(!address||typeof address==='string')throw Error('Broker 未获得 TCP 端口');
  return {token,port:address.port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve(undefined));})};
}
module.exports={startBroker,scriptedFetch};
