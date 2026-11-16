'use strict';

function rng(seed = 1) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
function mean(values) { return values.length ? values.reduce((n,v) => n+v,0)/values.length : null; }
function weighted(rows,values) { const total=rows.reduce((n,r)=>n+(r.weight??1),0); return total ? rows.reduce((n,r,i)=>n+(r.weight??1)*values[i],0)/total : null; }
function percentile(values, p) { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*p)))]; }
function wilson(success, n, z = 1.959963984540054) {
  if (!Number.isInteger(n) || !Number.isInteger(success) || n<0 || success<0 || success>n) throw Error('无效二项计数');
  if (!n) return null;
  const p=success/n, denominator=1+z*z/n, center=(p+z*z/(2*n))/denominator;
  const radius=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/denominator;
  return [Math.max(0,center-radius),Math.min(1,center+radius)];
}

// Trials are resampled within task and arm. Family resampling is used only for an explicitly declared task population.
function compareTasks(rows, options = /** @type {any} */ ({})) {
  const trials=options.samples || 2000, random=rng(options.seed || 1);
  if (!Number.isInteger(trials) || trials < 100 || trials > 100000) throw Error('bootstrap 次数必须为 100 至 100000');
  const complete=rows.filter(r=>r.baseline?.length && r.improved?.length && [...r.baseline,...r.improved].every(x=>x===0||x===1));
  const families=[...new Set(complete.map(r=>r.family))];
  const differences=complete.map(r=>({taskId:r.taskId,family:r.family,delta:mean(r.improved)-mean(r.baseline)}));
  const estimate=weighted(complete,differences.map(d=>d.delta));
  const sufficient=complete.length>=2 && complete.every(r=>r.baseline.length>=2 && r.improved.length>=2) &&
    (options.scope !== 'population' || families.length>=5);
  if (!sufficient) return {estimate,interval:null,decision:'insufficient-evidence',completeTasks:complete.length,plannedTasks:rows.length,differences,scope:options.scope || 'fixed-suite'};
  const draw=values=>values[Math.floor(random()*values.length)];
  const deltas=[];
  for(let i=0;i<trials;i++) {
    let sampled=complete;
    if(options.scope==='population') sampled=Array.from({length:families.length},()=>draw(families)).flatMap(f=>complete.filter(r=>r.family===f));
    const values=sampled.map(r=>mean(Array.from({length:r.improved.length},()=>draw(r.improved)))-mean(Array.from({length:r.baseline.length},()=>draw(r.baseline))));
    deltas.push(weighted(sampled,values));
  }
  let interval=[percentile(deltas,0.025),percentile(deltas,0.975)];
  const minimum=options.minimumEffect ?? 0.05, regression=options.maxRegression ?? 0.05;
  // Any constant task/arm group can make a tiny-sample plug-in bootstrap falsely
  // precise, even when other groups vary. Protect partial as well as full boundaries.
  const saturated=complete.every(r=>new Set(r.baseline).size===1 && new Set(r.improved).size===1);
  const hasBoundaryGroup=complete.some(r=>new Set(r.baseline).size===1 || new Set(r.improved).size===1);
  let intervalMethod='task-stratified-bootstrap';
  let boundaryInsufficient=false;
  if(hasBoundaryGroup) {
    if(options.scope==='population'){interval=null;boundaryInsufficient=true;intervalMethod='unavailable-for-boundary-population';}
    else {
      const alpha=0.05,totalWeight=complete.reduce((n,r)=>n+(r.weight??1),0);
      const radius=complete.reduce((n,r)=>n+(r.weight??1)/totalWeight*(Math.sqrt(Math.log(4*complete.length/alpha)/(2*r.baseline.length))+Math.sqrt(Math.log(4*complete.length/alpha)/(2*r.improved.length))),0);
      interval=[Math.max(-1,estimate-radius),Math.min(1,estimate+radius)];
      boundaryInsufficient=radius>=1;intervalMethod='hoeffding-union-bound-fixed-suite';
    }
  }
  const covered=complete.length===rows.length;
  const decision=!covered||boundaryInsufficient ? 'insufficient-evidence' : interval[0]>minimum ? 'improvement-supported' : interval[1]<-regression ? 'regression-supported' : 'inconclusive';
  return {estimate,interval,decision,scope:options.scope || 'fixed-suite',completeTasks:complete.length,plannedTasks:rows.length,
    families:families.length,intervalMethod,assumptions:'Independent bounded trial outcomes within each task and arm; task-population claims require family sampling.',bootstrapSamples:trials,seed:options.seed||1,saturated,hasBoundaryGroup,differences};
}
function coverage(records, planned) {
  const complete=records.filter(r=>r.protocol?.gradingStatus==='PASS'||r.protocol?.gradingStatus==='FAIL');
  return {planned,started:records.filter(r=>r.protocol&&r.protocol.executionStatus!=='NOT_STARTED').length,scored:complete.length,
    delivered:records.filter(r=>r.protocol?.delivered===true).length,
    conservativeDelivery:planned?records.filter(r=>r.protocol?.delivered===true).length/planned:null,
    artifactPassRate:complete.length?complete.filter(r=>r.protocol.gradingStatus==='PASS').length/complete.length:null,
    unknown:records.filter(r=>!r.protocol||['UNKNOWN','INFRA_ERROR'].includes(r.protocol.executionStatus)||['ERROR','NOT_RUN'].includes(r.protocol.gradingStatus)).length};
}
module.exports={rng,mean,wilson,compareTasks,coverage};
