import { useState, type ReactNode } from 'react';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';

export default function GoalDraftPanel({ root, initialObjective, onCreated, onCancel, resizeHandle }: {
  root: string | null;
  initialObjective: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
  resizeHandle: ReactNode;
}) {
  const [title, setTitle] = useState(initialObjective.slice(0, 300));
  const [objective, setObjective] = useState(initialObjective);
  const [criteria, setCriteria] = useState('');
  const [scope, setScope] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    if (busy || !root || !window.codenode || !title.trim() || !criteria.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.codenode.goalCreate(root, {
        title: title.trim(),
        objective: objective.trim() || title.trim(),
        scope, exclusions,
        criteria: criteria.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        maxTokens: maxTokens ? Number(maxTokens) : undefined,
        maxCostUsd: maxCost ? Number(maxCost) : undefined,
      });
      if (!result.ok || !result.value?.id) throw Error(result.error || '无法创建目标');
      await useGoalControlStore.getState().refresh(root);
      if (useProjectStore.getState().root === root) onCreated(result.value.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="overview-goal-editor overview-create-panel" aria-label={title.trim() || '新建目标'} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
  }}>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <header>
        <input className="overview-goal-name" aria-label="Goal 标题" value={title} placeholder="新建目标" maxLength={300} autoFocus onChange={event => setTitle(event.target.value)} />
        <button type="button" aria-label="关闭目标编辑" disabled={busy} onClick={onCancel}>取消</button>
      </header>
      <div className="overview-editor-scroll goal-control-body goal-create-form">
        <label>希望完成什么<textarea aria-label="Goal 目标" value={objective} onChange={event => setObjective(event.target.value)} placeholder="说明希望得到的结果" rows={3} /></label>
        <label>怎样算完成<textarea aria-label="验收条件" value={criteria} onChange={event => setCriteria(event.target.value)} placeholder="每行一条完成标准" rows={3} /></label>
        <details className="goal-create-advanced">
          <summary>范围与预算（可选）</summary>
          <textarea aria-label="Goal 范围" value={scope} onChange={event => setScope(event.target.value)} placeholder="包含的范围" rows={2} />
          <textarea aria-label="Goal 排除项" value={exclusions} onChange={event => setExclusions(event.target.value)} placeholder="不包含的内容" rows={2} />
          <input aria-label="Goal Token 预算" type="number" min="1" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} placeholder="Token 上限（可选）" />
          <input aria-label="Goal 费用预算 USD" type="number" min="0" step="any" value={maxCost} onChange={event => setMaxCost(event.target.value)} placeholder="费用上限 USD（可选）" />
        </details>
        {error && <p role="alert">{error}</p>}
        <button className="goal-create-submit" type="submit" disabled={busy || !title.trim() || !criteria.trim()}>{busy ? '创建中…' : '创建目标'}</button>
      </div>
    </form>
    {resizeHandle}
  </section>;
}
