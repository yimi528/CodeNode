'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ts = require('@typescript/typescript6');
function load(file, dependencies = {}) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; } });
  return mod.exports;
}
const { goalTaskPresentation } = load('src/lib/goalTaskPresentation.ts');
const upstream = {id:'a',title:'定位',status:'todo'}, task={id:'b',dependsOn:['a'],status:'todo'};
const goal={tasks:[upstream,task],decisions:[],evidence:[]};
assert.match(goalTaskPresentation(goal,task).reason,/等待上游：定位/);
upstream.status='completed';upstream.lastRun={summary:'找到入口'};
assert.equal(goalTaskPresentation(goal,task).reason,'');
goal.decisions=[{id:'global',status:'open',taskIds:[]},{id:'local',status:'open',taskIds:['b']},{id:'other',status:'open',taskIds:['a']}];
assert.equal(goalTaskPresentation(goal,task).decisions.length,2);
task.executionStatus='unknown';assert.match(goalTaskPresentation(goal,task).reason,/需先复核/);
goal.evidence=[{taskId:'b',status:'passed',freshness:{valid:true}},{taskId:'b',status:'passed',freshness:{valid:false}},{taskId:'b',status:'failed',freshness:{valid:true}},{taskId:'a',status:'passed',freshness:{valid:true}}];
assert.equal(goalTaskPresentation(goal,task).evidenceLabel,'1/3 项有效验收');
const files=load('src/lib/fileChanges.ts');
const {deliverySummary}=load('src/lib/runPresentation.ts',{'./fileChanges':files});
const message={content:'阶段结果',tools:[],backendChanges:{files:[{path:'src/a.ts'}]},codeVerification:{status:'passed',verified:true,checks:[{status:'passed'}]}};
assert.equal(deliverySummary(message).files.length,1);
assert.equal(deliverySummary(message).verified,true);
message.run={state:'CANCELLED'};assert.equal(deliverySummary(message).incomplete,true);
message.run.rolledBackAt=123;assert.equal(deliverySummary(message).verified,false);assert.match(deliverySummary(message).checks,/原校验不再代表当前代码/);
console.log('TASK DELIVERY: PASS (dependency/decision/unknown gates, current evidence, external files, partial outcomes, rollback invalidation)');
