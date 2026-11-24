import { useEffect, useMemo, useState } from 'react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { isWorkflowStage, workflowGraph, workflowSignature } from '../lib/workflowRunState';
import type { StageRecord } from '../lib/stageScene';
import StageScene from './side/StageScene';

const emptyTimeline: StageRecord[] = [];

export default function StageReplayWorkspace({ root, workflowId, active }: {
  root: string | null; workflowId: string; active: boolean;
}) {
  const nodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const canvasSelection = useGraphStore(s => s.selectedId);
  const target = useUiStore(s => s.stageReplayTarget);
  const openStageReplay = useUiStore(s => s.openStageReplay);
  const graph = useMemo(() => workflowGraph(nodes, edges), [nodes, edges]);
  const signature = useMemo(() => workflowSignature(graph), [graph]);
  const stageNodes = useMemo(() => nodes.filter(node => isWorkflowStage(node.type)), [nodes]);
  const statuses = JSON.stringify(stageNodes.map(node => node.data.status));
  const [history, setHistory] = useState<{ signature: string; timeline?: StageRecord[]; order?: string[]; unavailable?: boolean } | null>(null);

  useEffect(() => {
    if (!active || !root || !stageNodes.length || !window.codenode?.workflowState) return;
    let current = true;
    void window.codenode.workflowState(root, workflowId, { action: 'read', graph, inspectTimeline: true }).then(result => {
      if (!current) return;
      setHistory(result.ok && result.state
        ? { signature, timeline: result.stageTimeline, order: result.state.order }
        : { signature, unavailable: true });
    }).catch(() => {
      if (current) setHistory({ signature, unavailable: true });
    });
    return () => { current = false; };
  }, [active, root, workflowId, signature, statuses, stageNodes.length]);

  if (!root || !stageNodes.length) {
    return <p className="workspace-stage-empty">{root ? '在画布上添加阶段节点后，可在这里查看回放。' : '打开一个项目后，可在这里查看阶段回放。'}</p>;
  }

  const scope = JSON.stringify([root, workflowId]);
  const record = history?.signature === signature ? history : null;
  const timeline = record?.timeline ?? emptyTimeline;
  const byId = new Map(stageNodes.map(node => [node.id, node]));
  const order = new Set([...timeline.map(item => item.nodeId), ...(record?.order ?? []), ...byId.keys()]);
  const stages = [...order].flatMap(id => {
    const node = byId.get(id);
    return node ? [{ id, title: String(node.data.label || id) }] : [];
  });
  const requested = target?.scope === scope ? target.nodeId : canvasSelection;
  const latest = timeline[timeline.length - 1];
  const selected = (requested && byId.get(requested)) || (latest && byId.get(latest.nodeId)) || stageNodes[0];
  const evidence = timeline.find(item => item.nodeId === selected.id)?.evidence ?? null;
  const labels = new Map(nodes.map(node => [node.id, String(node.data.label || node.id)]));
  const upstream = evidence ? [...new Set(evidence.upstream)].map(id => labels.get(id) ?? id) : [];
  const status = selected.data.status === 'running' ? 'running'
    : record?.unavailable ? 'unavailable'
    : record || !window.codenode?.workflowState ? 'ready' : 'loading';

  return <StageScene open={active} stages={stages} selectedId={selected.id}
    timeline={timeline} evidence={evidence} upstream={upstream}
    onSelect={nodeId => openStageReplay({ scope, nodeId })} status={status} />;
}
