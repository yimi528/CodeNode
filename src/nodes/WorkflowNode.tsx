import { boundaryLabel } from './presentation';
import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useSessionStore, type PlanItem } from '../store/sessionStore';
import type { WorkflowNodeData } from '../types';
import { workflowNodeAccent, workflowNodeMark } from '../lib/workflowNodeAppearance';

const STATUS_COLOR: Record<string, string> = {
  pending: '#64748b',
  running: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  blocked: '#8b5cf6',
};

const STATUS_TEXT: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  blocked: '阻塞',
};

const PLAN_STATUS_TEXT: Record<PlanItem['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
};

function WorkflowNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as WorkflowNodeData & { objectName?: string; planPreview?: PlanItem; planPreviewOnly?: boolean };
  const plan = d.planPreview;
  const working = useSessionStore((s) => !!plan && plan.status === 'in_progress' && s.streaming);
  const status = d.status || 'pending';
  const nodeType = useGraphStore((s) => s.nodes.find((n) => n.id === id)?.type) || (d.planPreviewOnly ? 'task' : undefined);
  const accent = workflowNodeAccent(nodeType, d.accent);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const flowOut = useGraphStore((s) => s.flow[id]?.output.length ?? 0);
  const flowIn = useGraphStore((s) => s.flow[id]?.input.length ?? 0);
  const promptable = nodeType === 'task' || nodeType === 'stage' || nodeType === 'tool';
  const isStart = nodeType === 'start';
  const isEnd = nodeType === 'end';
  const isObject = nodeType === 'object';
  const nodeStyle = { '--wf-accent': accent } as CSSProperties;

  return (
    <div className={`wf-node wf-workflow-card wf-node-${nodeType || 'default'} wf-status-${status}${selected ? ' is-selected' : ''}${isObject ? ' wf-object-node' : ''}${plan ? ' wf-agent-plan' : ''}${working ? ' is-working' : ''}`} style={nodeStyle}>
      {!isStart && <Handle type="target" position={Position.Left} className="wf-handle" isConnectable={!d.planPreviewOnly} />}
      <div className="wf-node-title">
        <span className="wf-node-kind" aria-hidden="true">{workflowNodeMark(nodeType)}</span>
        <span className="wf-node-label" title={plan ? d.label : undefined}>{d.label}</span>
        {d.memberBadge ? <span className="wf-member-badge" title="所属范围">{d.memberBadge}</span> : null}
      </div>
      {(d.goal || d.subtitle) && <div className="wf-node-sub">{d.goal || d.subtitle}</div>}
      {d.trellis && <div className="wf-node-sub" title={d.trellis.taskPath}>Trellis · {d.trellis.role} · 快照 {d.trellis.snapshotId.slice(0, 8)}</div>}
      {d.planPreviewOnly ? (
        <div className="wf-node-body wf-plan-summary">
          {plan?.acceptanceCriteria || plan?.reason}
        </div>
      ) : isObject ? (
        <input
          className="wf-object-name nodrag"
          value={d.objectName || ''}
          placeholder="对象名称…"
          onChange={(e) => updateNodeData(id, { objectName: e.target.value })}
        />
      ) : promptable ? (
        <textarea
          className="wf-node-body wf-node-prompt nodrag nopan nowheel"
          aria-label={`任务指令 · ${d.label}`}
          value={d.prompt || ''}
          placeholder="任务指令"
          rows={1}
          wrap="soft"
          readOnly={status === 'running'}
          tabIndex={status === 'running' ? -1 : undefined}
          onFocus={event => {
            const graph = useGraphStore.getState();
            if (!event.currentTarget.readOnly) graph.commit();
            if (!graph.selectedIds.includes(id)) graph.setSelectedIds([id]);
          }}
          onChange={event => updateNodeData(id, { prompt: event.currentTarget.value })}
        />
      ) : null}
      <div className="wf-node-footer">
        {plan && <span className="wf-plan-status" data-status={plan.status} title={[
          plan.reason,
          plan.ownerTaskId && `子代理 ${plan.ownerTaskId}`,
          plan.evidenceCallIds?.length && `证据调用 ${plan.evidenceCallIds.join('、')}`,
        ].filter(Boolean).join('\n') || undefined}>
          <span className="wf-plan-light" aria-hidden="true" />
          <span>{plan.status === 'in_progress' && !working ? '已暂停' : PLAN_STATUS_TEXT[plan.status]}
            {plan.reason && ` · ${plan.reason}`}
          </span>
        </span>}
        {(!plan || status !== 'pending' || d.boundary) && <span className="wf-status-text" style={{ color: status === 'pending' ? accent : STATUS_COLOR[status] }}>
          <span className="wf-status-dot" aria-hidden="true" />
          {[STATUS_TEXT[status] || status, boundaryLabel(d.boundary)].filter(Boolean).join(' · ')}
        </span>}
        {flowOut > 0 && <span className="wf-flow-badge" title={`输入 ${flowIn} 项 · 输出 ${flowOut} 项`}>↦{flowOut}</span>}
      </div>
      {!isEnd && <Handle type="source" position={Position.Right} className="wf-handle" isConnectable={!d.planPreviewOnly} />}
    </div>
  );
}

export default memo(WorkflowNode);
