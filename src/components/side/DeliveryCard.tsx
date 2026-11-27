import { useState } from 'react';
import type { SessionMsg } from '../../types';
import { deliverySummary } from '../../lib/runPresentation';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { useSending } from '../../lib/useSending';
import FileChangesCard from './FileChangesCard';
import CodeVerificationCard from './CodeVerificationCard';
import TaskAcceptanceCard from './TaskAcceptanceCard';
import './DeliveryCard.css';
import { useReplayStore } from '../../store/replayStore';

type RollbackPlan = Awaited<ReturnType<NonNullable<Window['codenode']>['rollbackPlan']>>;
export default function DeliveryCard({ message, isLatest }: { message: SessionMsg; isLatest: boolean }) {
  const root = useProjectStore(s => s.root);
  const sending = useSending();
  const [plan, setPlan] = useState<RollbackPlan | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false), [instruction, setInstruction] = useState('');
  if (message.status === 'running' || (!message.run && !message.tools?.length && !message.codeVerification && !message.taskAcceptance && !message.backendChanges)) return null;
  const summary = deliverySummary(message);
  const runId = message.run?.id;
  const preview = async () => {
    if (!root || !runId || busy || sending) return;
    setBusy(true); setNotice(''); setPlan(null);
    try {
      const result = await window.codenode!.rollbackPlan(root, runId);
      if (useProjectStore.getState().root !== root) return;
      if (!result.ok) throw Error(result.error || '无法读取回滚计划');
      setPlan(result);
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  };
  const rollback = async () => {
    if (!root || !runId || !plan || busy || sending) return;
    setBusy(true); setNotice('');
    try {
      const result = await window.codenode!.rollbackApply(root, runId, { force: false });
      if (useProjectStore.getState().root !== root) return;
      if (result.applied?.length) {
        const invalidate = (msg: SessionMsg): SessionMsg => msg.run?.id === runId ? { ...msg, run: { ...msg.run, rolledBackAt: Date.now() }, taskAcceptance: msg.taskAcceptance ? { ...msg.taskAcceptance, status: 'stale', verified: false } : undefined, codeVerification: msg.codeVerification ? { ...msg.codeVerification, status: 'stale', verified: false } : undefined } : msg;
        useSessionStore.setState(state => ({ messages: state.messages.map(invalidate), sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, { ...session, messages: (session.messages || []).map(invalidate) }])) }));
      }
      setPlan(null);
      setNotice(`已回滚 ${result.applied?.length || 0} 个文件；拒绝 ${result.refused?.length || 0} 项；跳过 ${result.skipped?.length || 0} 项。${result.error || ''}${result.refused?.map(item => `${item.path}：${item.reason}`).join('；') || ''}`);
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  };
  return <section className="delivery-card" aria-label="本轮交付">
    <header><strong>{summary.title}</strong><span>{summary.files.length ? `${summary.files.length} 个变更文件` : '未记录文件变更'}</span></header>
    <p>{summary.checks}</p>
    <FileChangesCard message={message} showVerification={false} />
    {message.codeVerification && <CodeVerificationCard report={message.codeVerification} />}
    {message.taskAcceptance && <TaskAcceptanceCard report={message.taskAcceptance} rolledBack={!!message.run?.rolledBackAt} />}
    <div className="delivery-actions">
      <button type="button" onClick={() => { if (runId) useReplayStore.getState().setRunId(runId); useUiStore.getState().openDock('runs'); }}>查看运行与恢复</button>
      {isLatest && <button type="button" disabled={sending || busy} onClick={() => setEditing(value => !value)}>继续修改</button>}
      {runId && summary.files.length > 0 && <button type="button" disabled={sending || busy || !!message.run?.rolledBackAt} onClick={() => void preview()}>预览文件回滚</button>}
    </div>
    {editing && isLatest && <form onSubmit={event => { event.preventDefault(); if (!instruction.trim() || sending || busy) return; void useChatStore.getState().send(instruction.trim(), { projectRoot: root || undefined }); setEditing(false); setInstruction(''); }}>
      <label>下一步修改要求<textarea value={instruction} onChange={event => setInstruction(event.target.value)} disabled={sending || busy} rows={3} required /></label>
      <button type="submit" disabled={!instruction.trim() || sending || busy}>发送修改要求</button>
    </form>}
    {plan && <section className="delivery-rollback" aria-label="文件回滚预览">
      <strong>还原 {plan.summary.restore} 项 · 删除 {plan.summary.delete} 项 · 冲突 {plan.summary.conflict} 项 · 跳过 {plan.summary.skip} 项</strong>
      <p>仅回滚可恢复的文件；后续修改发生冲突时会拒绝覆盖。命令和外部操作不会撤销。</p>
      <ul>{plan.items.map(item => <li key={item.path}>{item.path} · {item.action === 'restore' ? '还原' : item.action === 'delete' ? '删除' : '跳过'}{item.conflict ? ' · 有后续修改' : ''}{item.reason ? ` · ${item.reason}` : ''}</li>)}</ul>
      <button type="button" disabled={sending || busy || !plan.items.some(item => item.restorable && !item.conflict && item.action !== 'skip')} onClick={() => void rollback()}>确认回滚可恢复文件</button>
      <button type="button" disabled={busy} onClick={() => setPlan(null)}>取消</button>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
