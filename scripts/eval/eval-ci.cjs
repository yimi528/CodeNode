#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const protocol=require('../lib/eval-protocol.cjs');
const budget=require('../lib/eval-ci-budget.cjs');
const ROOT=path.resolve(__dirname,'../..');

function verifySource(run, source, head, repository) {
  if(run.repository?.full_name!==repository || !['workflow_dispatch','schedule'].includes(run.event) ||
      run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==head||
      !['.github/workflows/agent-evaluation-live.yml','.github/workflows/agent-evaluation.yml'].includes(run.path)) throw Error('Untrusted, incomplete or stale capability evidence run');
  if(source.repository!==repository||source.sourceCommit!==head||String(source.runId)!==String(run.id)||source.purpose!=='confirmation') throw Error('Capability source identity mismatch');
}
function decision(directory, reviewFile) {
  const {gate,readPlan}=require('./eval-system.cjs');
  const plan=path.join(directory,'confirmation/plan.json');
  if(!fs.existsSync(plan))throw Error('Missing confirmation plan');
  const source=protocol.readJson(path.join(directory,'ci-source.json'));
  if(readPlan(plan).runtime.sourceCommit!==source.sourceCommit)throw Error('Frozen runtime differs from evidence source commit');
  return gate(plan,reviewFile);
}
function main(argv) {
  const command=argv[0];
  const directory=path.resolve(process.env.CODENODE_EVAL_CI_DIRECTORY||path.join(ROOT,'out/evals/live'));
  const policy=require('../../config/eval-budget-policy.json');
  if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==policy.repository)throw Error('Unexpected budget repository');
  if(command==='acquire') {
    if(!process.env.GITHUB_RUN_ID||!process.env.GITHUB_RUN_ATTEMPT)throw Error('Missing CI run identity');
    const result=budget.acquire(directory,policy,budget.storeFor(policy),process.env.GITHUB_RUN_ID+'/'+process.env.GITHUB_RUN_ATTEMPT);
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'runnable='+result.runnable+'\n');
    return result;
  }
  if(command==='persist')return budget.persist(directory,policy,budget.storeFor(policy));
  if(command==='prepare') {
    const {prepare}=require('./eval-system.cjs');
    const purpose=process.env.CODENODE_EVAL_PURPOSE||'diagnostic';
    if(!['confirmation','diagnostic'].includes(purpose))throw Error('Unknown evaluation purpose');
    const created=prepare({output:path.join(directory,purpose),subset:purpose==='confirmation'?'holdout':'coding',
      ...(purpose==='diagnostic'?{subset:undefined,tasks:'coding-timeout-default',arms:'single'}:{}),
      trials:purpose==='confirmation'?'2':'1',mode:'model',kind:purpose==='confirmation'?'confirmation':'pilot',
      isolation:'harbor',profile:'native-product','budget-ledger':path.join(directory,'token-ledger.json')});
    protocol.atomicJson(path.join(directory,'ci-source.json'),{schemaVersion:1,repository:policy.repository,purpose,
      runId:process.env.GITHUB_RUN_ID,sourceCommit:process.env.GITHUB_SHA,preparedAt:new Date().toISOString()});
    if(purpose==='confirmation') {
      const {reviewPack}=require('../lib/eval-reviews.cjs');
      reviewPack(require('./eval-system.cjs').readPlan(created.plan).taskSpecs,path.join(directory,'review-pack'));
    }
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'plan='+created.plan+'\n');
    return created;
  }
  if(command==='decision')return decision(directory,process.env.CODENODE_EVAL_REVIEW_FILE);
  if(command==='fetch') {
    const runId=process.env.CODENODE_EVAL_EVIDENCE_RUN;
    if(!/^\d+$/.test(runId||''))throw Error('A capability evidence run ID is required');
    const run=budget.github(['api',`repos/${policy.repository}/actions/runs/${runId}`]);
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
    if(run.head_sha!==head||run.repository?.full_name!==policy.repository||run.status!=='completed'||run.conclusion!=='success'||!['workflow_dispatch','schedule'].includes(run.event))throw Error('Evidence run is not a completed trusted run for this release commit');
    if(fs.existsSync(directory))throw Error('Evidence destination already exists');
    execFileSync('gh',['run','download',runId,'--repo',policy.repository,'--name','agent-evaluation-live-evidence','--dir',directory],{stdio:'inherit'});
    verifySource(run,protocol.readJson(path.join(directory,'ci-source.json')),head,policy.repository);
    const review=process.env.CODENODE_EVAL_INDEPENDENT_REVIEW;
    const reviewFile=path.join(directory,'review-pack/reviewer/completed-review.json');
    if(review)protocol.atomicJson(reviewFile,JSON.parse(review));
    const value=decision(directory,review?reviewFile:undefined);
    if(!value.pass)process.exitCode=1;
    return value;
  }
  throw Error('Commands: acquire, prepare, persist, decision, fetch');
}
if(require.main===module)Promise.resolve().then(()=>main(process.argv.slice(2))).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main,verifySource,decision};
