import { useEffect, useRef, useState } from 'react';
import { useGoalControlStore, type GoalItem } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import GoalControlPanel from './side/GoalControlPanel';
import GoalDraftPanel from './GoalDraftPanel';
import GoalPanelResize from './GoalPanelResize';
import { goalAttention } from '../lib/goalAttention';
import './goalOverview.css';

const stateName: Record<string, string> = { active:'进行中', completed:'已完成', paused:'已暂停', stopped:'已停止', archived:'已归档' };
const DRAFT_WIDTH = 418;
const CARD_WIDTH = 260;
type GoalDraft = { id: string; objective: string; autoPlan: boolean };

function GoalNameForm({ goal, root }: { goal: GoalItem; root: string | null }) {
  const [name, setName] = useState(goal.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const change = name.trim();
  const canSave = !!root && !!change && change !== goal.title && !saving;
  return <>
    <form className="overview-goal-name-form" onSubmit={async event => {
      event.preventDefault();
      if (!canSave || !window.codenode) return;
      setSaving(true);
      setError('');
      try {
        const result = await window.codenode.goalUpdate(root, goal.id, { title: change });
        if (!result.ok) throw Error(result.error || '无法保存名称');
        await useGoalControlStore.getState().refresh(root);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally { setSaving(false); }
    }}>
      <input className="overview-goal-name" aria-label="目标名称编辑" maxLength={300} value={name} onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={!canSave}>保存名称</button>
    </form>
    {error && <span role="alert">{error}</span>}
  </>;
}

export default function GoalOverview() {
  const root = useProjectStore(s => s.root);
  const { goals, selectedGoalId, select, refresh, error, pendingDraft, clearDraft } = useGoalControlStore();
  const [drafts, setDrafts] = useState<GoalDraft[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [availableWidth, setAvailableWidth] = useState(940);
  const [editor, setEditor] = useState(false);
  const [autoPlanGoalId, setAutoPlanGoalId] = useState<string | null>(null);
  const nextDraft = useRef(0);
  const board = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const detail = goals.find(goal => goal.id === selectedGoalId);
  const visible = goals.filter(goal => goal.status !== 'archived');
  const attention = goalAttention(goals);

  useEffect(() => {
    const area = board.current;
    if (!area) return;
    const measure = () => { if (area.clientWidth > 0) setAvailableWidth(area.clientWidth); };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setDrafts([]);
    setWidths({});
    setEditor(false);
    setAutoPlanGoalId(null);
  }, [root]);

  useEffect(() => {
    if (!root || pendingDraft === null || useGoalControlStore.getState().pendingDraft !== pendingDraft) return;
    const draft = { id: 'draft-' + ++nextDraft.current, objective: pendingDraft, autoPlan: true };
    clearDraft();
    setDrafts(current => [...current, draft]);
  }, [pendingDraft, root, clearDraft]);

  useEffect(() => {
    if (editor) editorRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭目标编辑"]')?.focus();
  }, [editor, selectedGoalId]);

  const addDraft = () => {
    const draft = { id: 'draft-' + ++nextDraft.current, objective: '', autoPlan: false };
    setDrafts(current => [...current, draft]);
  };
  const openEditor = (goalId: string, taskId: string | null = null) => {
    returnFocus.current = document.activeElement as HTMLElement;
    select(goalId, taskId);
    setEditor(true);
  };
  const close = () => {
    setEditor(false);
    setAutoPlanGoalId(null);
    const trigger = returnFocus.current;
    if (trigger?.isConnected) trigger.focus();
    else addButton.current?.focus();
  };
  const removeDraft = (id: string, goalId?: string) => {
    setDrafts(current => current.filter(draft => draft.id !== id));
    setWidths(current => {
      if (!current[id]) return current;
      const next = { ...current };
      if (goalId) next[goalId] = next[id];
      delete next[id];
      return next;
    });
  };
  const handle = (id: string, width: number, label: string) => <GoalPanelResize
    width={width} max={availableWidth} label={label}
    onResize={value => setWidths(current => ({ ...current, [id]: value }))}
  />;

  return <section className="goal-overview" aria-label="目标总览">
    <header className="overview-project-header">
      <span>{root?.split(/[\\/]/).pop() || '当前项目'}</span>
      <div>
        <button className="overview-refresh" aria-label="刷新目标总览" title="刷新目标" onClick={() => void refresh(root)}>↻</button>
        <button className="overview-create" disabled={!root} onClick={addDraft}>＋ 新建目标</button>
      </div>
    </header>
    <div className="overview-brief"><div className="overview-brief-icon" aria-hidden="true">✦</div><div><span>项目简报</span><h1>{attention.length?'有一些事项需要你处理':visible.length?'继续推进你的目标':'从一个目标开始'}</h1><p>{attention.length?`${attention.length} 项待处理事项，先核对预算、处理决定或运行复核，再跟进阻塞与等待。`:visible.length?`${visible.filter(g=>g.status==='active').length} 个目标正在进行，任务与验收进度都在这里。`:'描述你想完成的事，CodeNode 会帮你管理任务和验收。'}</p></div></div>
    {!!attention.length&&<section className="overview-attention"><h2>需要你处理 <span>{attention.length}</span></h2>{attention.slice(0,6).map(item=><button key={item.key} data-owner={item.owner} data-action={item.action} data-priority={item.priority} aria-label={`需要你处理：${item.label} · ${item.text} · ${item.goal.title}`} onClick={()=>openEditor(item.goalId,item.taskId)}><span className="overview-attention-label">{item.label}</span><span><strong>{item.text}</strong><small>{item.goal.title}</small></span><span aria-hidden="true">›</span></button>)}{attention.length>6&&<div className="overview-attention-overflow"><button type="button" data-action="open-full-attention" data-owner="user" data-goal-id={attention[6].goalId} data-goal-title={attention[6].goal.title} aria-label={`在目标编辑器查看剩余 ${attention.length-6} 项待办`} onClick={()=>openEditor(attention[6].goalId,attention[6].taskId)}>查看剩余 {attention.length-6} 项</button></div>}</section>}
    <section className="overview-goals">
      <div className="overview-list-heading"><h2>全部目标{visible.length > 0 && <span>{visible.length}</span>}</h2></div>
      <div ref={board} className="overview-goal-list" aria-label="项目目标列表">
        {visible.map(goal => {
          const width = widths[goal.id] || CARD_WIDTH;
          const done = goal.tasks.filter(task => task.status === 'completed').length;
          const status = goal.status === 'completed' && goal.complete === false ? '需重新核验' : stateName[goal.status] || goal.status;
          return <div className="overview-goal-item" key={goal.id} style={{ flexBasis: width }}>
            <button className="overview-goal-card" data-goal-id={goal.id} aria-expanded={editor && selectedGoalId === goal.id} onClick={() => openEditor(goal.id)}>
              <span className="overview-card-meta">
                <span className={'overview-state-dot status-' + goal.status} /><span>{status}</span>
                <span className="overview-row-progress">{done}/{goal.tasks.length} 任务</span>
              </span>
              <strong>{goal.title}</strong>
              <span className="overview-card-objective">{goal.objective}</span>
            </button>
            {handle(goal.id, width, goal.title)}
          </div>;
        })}
        {drafts.map(draft => {
          const width = widths[draft.id] || DRAFT_WIDTH;
          return <div className="overview-goal-item" key={draft.id} style={{ flexBasis: width }}>
            <GoalDraftPanel
              root={root} initialObjective={draft.objective}
              onCreated={goalId => {
                removeDraft(draft.id, goalId);
                if (draft.autoPlan) { select(goalId); setAutoPlanGoalId(goalId); setEditor(true); }
                else addButton.current?.focus({ preventScroll: true });
              }}
              onCancel={() => { removeDraft(draft.id); addButton.current?.focus({ preventScroll: true }); }}
              resizeHandle={handle(draft.id, width, '目标草稿')}
            />
          </div>;
        })}
        <button ref={addButton} type="button" className="overview-add-draft" disabled={!root} onClick={addDraft}>＋ 新建目标</button>
      </div>
      <section ref={editorRef} className="overview-goal-editor with-goal-graph" hidden={!editor} aria-label="目标详情" onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.tool-dialog,.global-settings,.mm-dialog')) {
          event.preventDefault();
          close();
        }
      }}>
        <header>
          {detail ? <GoalNameForm key={detail.id} goal={detail} root={root} /> : <h2>目标详情</h2>}
          <button type="button" aria-label="关闭目标编辑" onClick={close}>×</button>
        </header>
        <div className="overview-editor-scroll">
          <GoalControlPanel key={root || 'no-project'} autoPlanGoalId={autoPlanGoalId} onAutoPlanConsumed={() => setAutoPlanGoalId(null)} />
        </div>
      </section>
    </section>
    {error && <p role="status">{error}</p>}
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
