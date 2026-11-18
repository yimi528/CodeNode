'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {apply,TOOLS}=require('../../electron/benchmarkProfile.cjs');
assert.throws(()=>apply({},{}),/evaluator-owned container/);
assert.throws(()=>apply({},{CODENODE_BENCHMARK_CONTAINER:'1'}),/explicit CODENODE_API_KEY/);
const cfg=apply({tools:{toolsDeny:['write_file']},sandbox:{mode:'strict'},webSearch:{enabled:true}},{CODENODE_BENCHMARK_CONTAINER:'1',CODENODE_API_KEY:'fixture-key'});
assert.deepEqual(cfg.tools.toolsAllowed,TOOLS);assert.equal(cfg.soulEvolution,false);assert.equal(cfg.externalVerification,true);assert.equal(cfg.webSearch.enabled,false);assert.equal(cfg.modelRouting.enabled,false);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-benchmark-guard-'));
try{
/** @type {NodeJS.ProcessEnv} */
const env={...process.env,CODENODE_API_KEY:'fixture-key'};delete env.CODENODE_BENCHMARK_CONTAINER;
const result=spawnSync(process.execPath,['bin/codenode-agent.cjs','--benchmark','--project',root,'--prompt','do not execute'],{encoding:'utf8',env});assert.equal(result.status,2);assert.match(result.stderr,/evaluator-owned container/);assert.equal(fs.existsSync(path.join(root,'.codenode')),false);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('BENCHMARK PROFILE: PASS (explicit container and credentials, controlled tools/config, no personal context and host guard)');
