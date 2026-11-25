import { useEffect, useRef, useState } from 'react';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { CanvasIcon } from './CanvasIcons';
import GoalControlPanel from './side/GoalControlPanel';
import { goalAttention } from '../lib/goalAttention';
const stateName:Record<string,string>={active:'进行中',completed:'已完成',paused:'已暂停',stopped:'已停止',archived:'已归档'};
export default function GoalOverview(){
 const root=useProjectStore(s=>s.root),{goals,selectedGoalId,select,refresh,error,pendingDraft,clearDraft}=useGoalControlStore();
 const [editor,setEditor]=useState(false),[creating,setCreating]=useState(false);
 const [autoPlanGoalId,setAutoPlanGoalId]=useState<string|null>(null);
 const editorRef=useRef<HTMLElement>(null),returnFocus=useRef<HTMLElement|null>(null);
 const detail=goals.find(g=>g.id===selectedGoalId);
 const visible=goals.filter(g=>g.status!=='archived');
 const attention=goalAttention(goals);
 const openEditor=(goalId:string|null,taskId:string|null=null)=>{returnFocus.current=document.activeElement as HTMLElement;setCreating(!goalId);if(goalId)select(goalId,taskId);setEditor(true);};
 const close=()=>{setEditor(false);setAutoPlanGoalId(null);clearDraft();returnFocus.current?.focus();};
 useEffect(()=>{setEditor(false);setCreating(false);},[root]);
 useEffect(()=>{if(pendingDraft!==null&&root)openEditor(null);},[pendingDraft,root]);
 useEffect(()=>{
  if(!editor)return;
  editorRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭目标编辑"]')?.focus();
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Tab'){const controls=Array.from(editorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,summary')||[]).filter(n=>n.getClientRects().length);const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}if(e.key==='Escape'&&!document.querySelector('.tool-dialog,.global-settings,.mm-dialog')){e.preventDefault();setEditor(false);returnFocus.current?.focus();}};
  document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
 },[editor]);
 return <section className="goal-overview" aria-label="目标总览">
  <header className="overview-project-header">
   <h1>项目目标</h1>
   <div>
    <button className="overview-refresh" aria-label="刷新目标总览" title="刷新目标" onClick={() => void refresh(root)}><CanvasIcon name="refresh" /></button>
    <button className="overview-create" onClick={() => openEditor(null)}><CanvasIcon name="plus" />新建目标</button>
   </div>
  </header>
  {attention.length > 0 && <section className="overview-attention">
   <h2>需要你处理 <span>{attention.length}</span></h2>
   <div className="overview-attention-list">
    {attention.slice(0, 6).map(item => <button key={item.key} data-owner={item.owner} data-action={item.action} data-priority={item.priority}
      aria-label={`需要你处理：${item.label} · ${item.text} · ${item.goal.title}`} onClick={() => openEditor(item.goalId, item.taskId)}>
     <i className="overview-attention-dot" aria-hidden="true" />
     <span className="overview-row-copy"><strong>{item.text}</strong><small>{item.goal.title} · {item.label}</small></span>
     <CanvasIcon name="chevron" />
    </button>)}
   </div>
   {attention.length > 6 && <div className="overview-attention-overflow">
    <button type="button" data-action="open-full-attention" data-owner="user" data-goal-id={attention[6].goalId} data-goal-title={attention[6].goal.title}
      aria-label={`在目标编辑器查看剩余 ${attention.length - 6} 项待办`} onClick={() => openEditor(attention[6].goalId, attention[6].taskId)}>查看剩余 {attention.length - 6} 项</button>
   </div>}
  </section>}
  {visible.length === 0 ? <div className="overview-empty"><CanvasIcon name="target" /><p>还没有目标</p></div> :
   <section className="overview-goals">
    <h2>全部目标</h2>
    <div className="overview-goal-list" aria-label="项目目标列表">{visible.map(goal => {
     const total = goal.tasks.length;
     const done = goal.tasks.filter(task => task.status === 'completed').length;
     const status = goal.status === 'completed' && goal.complete === false ? '需重新核验' : stateName[goal.status] || goal.status;
     return <button key={goal.id} data-goal-id={goal.id} onClick={() => openEditor(goal.id)}>
      <span className="overview-row-copy">
       <strong>{goal.title}</strong>
       {goal.objective.trim() !== goal.title.trim() && <small>{goal.objective}</small>}
      </span>
      <span className="overview-row-progress">
       <span className="overview-progress-track" aria-hidden="true"><i style={{ width: total ? `${done / total * 100}%` : 0 }} /></span>
       <span aria-label={`${done} / ${total} 项任务`}>{done}/{total}</span>
      </span>
      <span className="overview-row-status">{status}</span>
     </button>;
    })}</div>
   </section>}
  {error&&<p role="status">{error}</p>}
  <div className="overview-editor-mask" hidden={!editor} onPointerDown={e=>{if(e.target===e.currentTarget)close();}}><section ref={editorRef} className={`overview-goal-editor${creating?'':' with-goal-graph'}`} role="dialog" aria-modal="true" aria-label={creating?'新建目标':'目标详情'}>
   <header><div><h2>{creating?'新建目标':detail?.title||'目标详情'}</h2><span>{creating?'先写清目标与完成标准':'任务、决定与验收'}</span></div><button aria-label="关闭目标编辑" onClick={close}>×</button></header>
   <div className="overview-editor-scroll"><GoalControlPanel key={root||'no-project'} creating={creating} autoPlanGoalId={autoPlanGoalId} onAutoPlanConsumed={()=>setAutoPlanGoalId(null)} onCreated={goalId=>{if(pendingDraft!==null)setAutoPlanGoalId(goalId);clearDraft();setCreating(false);setEditor(true);}}/></div>
  </section></div>
 </section>;
}
export function WorkbenchViewSwitcher(){
 const workbenchView = useUiStore(s => s.preferences.workbenchView);
 const editing = useUiStore(s => s.sideTab === 'project');
 const replay = useUiStore(s => s.stageReplayOpen) && !editing;
 const selectView = (view: 'overview' | 'conversation') => {
   const ui = useUiStore.getState();
   if (editing) ui.setSideTab('agent');
   ui.closeStageReplay();
   ui.updatePreferences({ workbenchView: view });
 };
 return <nav className="workbench-view-switch" aria-label="工作台视图">
   <button type="button" aria-current={!editing && !replay && workbenchView === 'overview' ? 'page' : undefined} aria-label="切换到总览" onClick={() => selectView('overview')}>总览</button>
   <button type="button" aria-current={!editing && !replay && workbenchView === 'conversation' ? 'page' : undefined} aria-label="切换到画布" onClick={() => selectView('conversation')}>画布</button>
   <button type="button" aria-current={replay ? 'page' : undefined} onClick={() => useUiStore.getState().openStageReplay()}>3D 回放</button>
 </nav>;
}
