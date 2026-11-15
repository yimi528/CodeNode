'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {hash,writeNew,readJson}=require('./eval-protocol.cjs');

function reviewPack(tasks, directory) {
  if(fs.existsSync(directory))throw Error('复核包目录已存在');
  fs.mkdirSync(directory,{recursive:true});
  const reviewerDir=path.join(directory,'reviewer');fs.mkdirSync(reviewerDir);
  const packId=require('node:crypto').randomUUID();
  const rows=[];
  for(const task of tasks) {
    const blinded=task.reference&&task.behaviorCases?.length?[{label:'initial',files:task.fixture},
      {label:'reference',files:{...task.fixture,...task.reference}},
      ...(task.calibration||[]).map(c=>({label:c.id,files:{...task.fixture,...task.reference,...c.files}}))]:[];
    for(let i=blinded.length-1;i>0;i--){const j=require('node:crypto').randomInt(i+1);[blinded[i],blinded[j]]=[blinded[j],blinded[i]];}
    const taskHash=hash(task);
    const candidates=blinded.map((item,index)=>({candidateId:hash(taskHash+index).slice(0,16),files:item.files}));
    const answerKey=blinded.map((item,index)=>({candidateId:candidates[index].candidateId,source:item.label,expected:item.label==='initial'?false:item.label==='reference'?true:task.calibration.find(c=>c.id===item.label).expected==='pass'}));
    writeNew(path.join(reviewerDir,task.id+'.json'),{taskId:task.id,taskHash,prompt:task.prompt,objective:task.evaluation.objective,candidates});
    rows.push({taskId:task.id,taskHash,answerKey});
  }
  writeNew(path.join(directory,'controller-key.json'),{private:true,packId,rows});
  writeNew(path.join(reviewerDir,'review-template.json'),{schemaVersion:1,packId,reviewer:'',kind:'human-independent',independentFromAuthor:false,
    tasks:rows.map(r=>({taskId:r.taskId,taskHash:r.taskHash,verdict:'pending',notes:'',candidateLabels:[]}))});
  return {tasks:rows.length,template:path.join(reviewerDir,'review-template.json')};
}
function validateReview(tasks, file) {
  if(!file||!fs.existsSync(file))return {pass:false,reason:'缺少独立人工复核',reviewed:0};
  const review=readJson(file);
  if(review.schemaVersion!==1||review.kind!=='human-independent'||review.independentFromAuthor!==true||typeof review.reviewer!=='string'||!review.reviewer.trim())return {pass:false,reason:'复核者、类型或独立性声明不完整',reviewed:0};
  const keyFile=path.resolve(path.dirname(file),'../controller-key.json');
  if(!fs.existsSync(keyFile))return {pass:false,reason:'缺少复核包控制端索引',reviewed:0};
  const key=readJson(keyFile);if(key.packId!==review.packId)return {pass:false,reason:'复核包身份不匹配',reviewed:0};
  let reviewed=0;
  for(const task of tasks) {
    const row=review.tasks?.find(r=>r.taskId===task.id);
    if(!row||row.taskHash!==hash(task)||row.verdict!=='approved'||!row.notes?.trim()||!Array.isArray(row.candidateLabels))return {pass:false,reason:'任务未批准、契约漂移或缺少候选盲判：'+task.id,reviewed};
    const expected=key.rows.find(r=>r.taskId===task.id);
    if(!expected||expected.taskHash!==row.taskHash||row.candidateLabels.length!==expected.answerKey.length||new Set(row.candidateLabels.map(c=>c.candidateId)).size!==expected.answerKey.length||expected.answerKey.some(c=>row.candidateLabels.find(l=>l.candidateId===c.candidateId)?.pass!==c.expected))return {pass:false,reason:'候选盲判不完整或与契约存在争议：'+task.id,reviewed};
    reviewed++;
  }
  return {pass:true,reviewer:review.reviewer,reviewed,evidenceHash:hash(fs.readFileSync(file))};
}
module.exports={reviewPack,validateReview};
