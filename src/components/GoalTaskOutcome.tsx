import { useState } from 'react';
import type { GoalItem } from '../store/goalControlStore';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useChatStore } from '../store/chatStore';
import { useUiStore } from '../store/uiStore';
import { useReplayStore } from '../store/replayStore';
import { useSending } from '../lib/useSending';
import DeliveryCard from './side/DeliveryCard';
import { useSessionStore } from '../store/sessionStore';
import { goalTaskPresentation } from '../lib/goalTaskPresentation';

export default function GoalTaskOutcome({ goal, task, root, locked }: { goal: GoalItem; task: GoalItem['tasks'][number]; root: string; locked: boolean }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [answer, setAnswer] = useState('');
  const sending = useSending();
  const messages = useSessionStore(s => s.messages);
  const sessions = useSessionStore(s => s.sessions);
  const delivery = task.lastRun?.runId && (messages.find(msg => msg.run?.id === task.lastRun?.runId) || Object.values(sessions).flatMap(session => session.messages || []).find(msg => msg.run?.id === task.lastRun?.runId));
  const view = goalTaskPresentation(goal, task);
  const refresh = useGoalControlStore(s => s.refresh);
  const select = useGoalControlStore(s => s.select);
  const disabled = busy || locked || sending;
  const manage = () => {
    const detail = document.querySelector('.goal-task-detail');
    detail?.querySelectorAll('details').forEach(item => { item.open = true; });
    detail?.scrollIntoView({ block: 'start' });
  };
  const execute = async () => {
    if (disabled || useProjectStore.getState().root !== root) return;
    setBusy(true); setNotice('');
    try {
      const result = await window.codenode!.goalCanRun(root, goal.id, task.id);
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) throw Error(result.error || '无法检查运行资格');
      if (result.value?.decision !== 'run' || result.value?.task?.id !== task.id) { setNotice(result.value?.reason || '当前阶段不能运行，请处理阻塞或重新排队'); return; }
      await useChatStore.getState().send(`执行当前阶段：${task.title}\n${task.objective}\n请按阶段验收条件完成工作，报告实际产物、验证结果和遗留事项。`, { projectRoot: root, goalId: goal.id, taskId: task.id });
      await refresh(root);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const requeue = async () => {
    if (disabled || task.executionStatus === 'unknown') return;
    setBusy(true); setNotice('');
    try {
      const result = await window.codenode!.goalTaskUpdate(root, goal.id, task.id, { status: 'todo', expectedRevision: useGoalControlStore.getState().revision });
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) throw Error(result.error || '重新排队失败');
      await refresh(root); setNotice('已重新排队；点击“执行当前阶段”会重新检查依赖、决定和预算。');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const resolve = async (id: string) => {
    if (disabled || !answer.trim()) return;
    setBusy(true); setNotice('');
    try {
      const result = await window.codenode!.goalDecisionResolve(root, id, answer.trim());
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) throw Error(result.error || '决定保存失败');
      setAnswer(''); await refresh(root); setNotice('决定已保存，可重新检查运行资格。');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="goal-graph-outcome" aria-label="本阶段执行说明">
    <strong>阶段交付与下一步 · {task.title}</strong>
    <small>负责人：{task.owner || 'main'} · {view.evidenceLabel}</small>
    {view.reason && <p role="status">{view.reason}</p>}
    <div className="goal-outcome-actions">
      <button type="button" disabled={disabled || goal.status !== 'active' || task.executionStatus === 'unknown' || ['in_progress','cancelled'].includes(task.status)} onClick={() => void execute()}>执行当前阶段</button>
      {['completed','failed','blocked','cancelled'].includes(task.status) && <button type="button" disabled={disabled || goal.status !== 'active' || task.executionStatus === 'unknown'} onClick={() => void requeue()}>重新排队此阶段</button>}
      <button type="button" onClick={manage}>处理阻塞与独立验收</button>
      {task.lastRun && <button type="button" onClick={() => { useReplayStore.getState().setRunId(task.lastRun.runId); useUiStore.getState().openDock('runs'); }}>查看阶段运行记录</button>}
    </div>
    {task.lastRun ? <><small>Run {task.lastRun.runId} · {task.lastRun.status} · {new Date(task.lastRun.finishedAt).toLocaleString()}</small><pre>{task.lastRun.summary || '没有文字总结，请查看运行记录。'}</pre></> : <p>尚未执行。执行后将显示产物总结与验收记录。</p>}
    {delivery && <DeliveryCard key={`${root}:${task.lastRun?.runId}`} message={delivery} isLatest={false} />}
    {view.upstream.length > 0 && <div className="goal-outcome-upstream"><strong>上游交付</strong>{view.upstream.map(item => <div key={item.id}><button type="button" onClick={() => select(goal.id, item.id)}>{item.title} · {item.status === 'completed' ? '已完成' : '未完成'}</button><p>{item.lastRun?.summary || '尚无交付总结'}</p></div>)}</div>}
    {view.decisions.map(item => <form key={item.id} onSubmit={event => { event.preventDefault(); void resolve(item.id); }}><label>{item.question}<small>{(item.options || []).join(' / ')}</small><input aria-label={`阶段决定 ${item.question}`} value={answer} onChange={event => setAnswer(event.target.value)} disabled={disabled}/></label><button type="submit" disabled={disabled || !answer.trim()}>保存阶段决定</button></form>)}
    {view.evidence.map(item => <details key={item.id}><summary>验收：{item.check} · {item.status === 'passed' && item.freshness?.valid ? '当前有效' : item.freshness?.reason || item.status}</summary><pre>{item.result || '未记录输出'}</pre>{item.command && <code>{item.command}</code>}</details>)}
    {goal.status !== 'active' && <p>目标已暂停、停止或完成；恢复目标后才能重新执行阶段。</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
