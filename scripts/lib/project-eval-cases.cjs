'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function readCases(file){
 const absolute=path.resolve(file),raw=fs.readFileSync(absolute,'utf8'),input=JSON.parse(raw);
 if(input.version!==1||!Array.isArray(input.tasks)||!input.tasks.length)throw Error('项目评测需要 version=1 和非空 tasks');
 const ids=new Set();
 const tasks=input.tasks.map(task=>{
  if(!/^[a-z0-9][a-z0-9-]{2,80}$/.test(task.id)||ids.has(task.id))throw Error('项目评测任务编号无效或重复');ids.add(task.id);
  if(!task.repository||typeof task.repository.path!=='string'||!task.repository.path.trim()||!/^[a-f0-9]{40,64}$/.test(task.repository.commit||''))throw Error('项目评测必须固定本地仓库路径与完整提交号');
  if(task.repository.snapshot&&!['tree','history'].includes(task.repository.snapshot))throw Error('项目快照必须为 tree 或 history');
  if(!task.prompt||!Array.isArray(task.checks)||!task.checks.some(check=>check.type==='verify-shell'))throw Error('真实项目任务必须包含独立 verify-shell 验收');
  if(!Array.isArray(task.allowTools)||!task.budget?.timeoutMs)throw Error('项目任务缺少工具范围或时间预算');
  return {...task,evaluation:task.evaluation||{track:'workflow',family:'repository-workflow',split:'development',objective:task.prompt,limitations:'旧版项目工作流任务，未完成编码能力校准',review:'unreviewed'},required:true,realModel:true,category:'repository-workflow',repository:{...task.repository,path:path.resolve(path.dirname(absolute),task.repository.path)}};
 });
 return {tasks,datasetVersion:'project-eval-'+crypto.createHash('sha256').update(raw).digest('hex').slice(0,16)};
}
module.exports={readCases};
