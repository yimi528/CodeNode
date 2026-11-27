'use strict';
module.exports=async root=>{
 const path=require('node:path'),assert=require('node:assert/strict');
 const {compareTasks}=require(path.join(root,'scripts/lib/eval-statistics.cjs'));
 const partial=compareTasks([{taskId:'a',family:'a',baseline:[0,0],improved:[1,1]},
  {taskId:'b',family:'b',baseline:[0,1],improved:[1,1]}],{samples:100});
 assert.notEqual(partial.decision,'improvement-supported','PARTIAL_BOUNDARY: eight observations must not have false precision');
 assert.ok(!partial.interval||partial.interval[0]<=0,'PARTIAL_BOUNDARY: boundary uncertainty includes zero');
 const large=compareTasks([{taskId:'a',family:'a',baseline:Array(1000).fill(0),improved:Array(1000).fill(1)},
  {taskId:'b',family:'b',baseline:Array(1000).fill(0),improved:Array(1000).fill(1)}],{samples:100});
 assert.equal(large.decision,'improvement-supported','PARTIAL_BOUNDARY: do not solve the problem by always rejecting gains');
 assert.equal(compareTasks([{taskId:'x',family:'x',baseline:[1],improved:[1]}]).decision,'insufficient-evidence','PARTIAL_BOUNDARY: insufficient coverage remains explicit');
 return {checks:4};
};
