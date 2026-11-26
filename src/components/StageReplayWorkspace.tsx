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
  const [history, setHistory] = useState<{ signature: string; timeline?: StageRecord[]; order?: string[] } | null>(null);

  useEffect(() => {
    if (!active || !root || !stageNodes.length || !window.codenode?.workflowState) return;
    let current = true;
    void window.codenode.workflowState(root, workflowId, { action: 'read', graph, inspectTimeline: true }).then(result => {
      if (!current) return;
      setHistory(result.ok && result.state
        ? { signature, timeline: result.stageTimeline, order: result.state.order }
        : { signature });
    }).catch(() => {
      if (current) setHistory({ signature });
    });
    return () => { current = false; };
  }, [active, root, workflowId, signature, statuses, stageNodes.length]);

  const scope = JSON.stringify([root, workflowId]);
  const record = history?.signature === signature ? history : null;
  const timeline = record?.timeline ?? emptyTimeline;
  const byId = new Map(stageNodes.map(node => [node.id, node]));
  const order = new Set([...timeline.map(item => item.nodeId), ...(record?.order ?? []), ...byId.keys()]);
  const stageIds = [...order].filter(id => byId.has(id));
  const requested = target?.scope === scope ? target.nodeId : canvasSelection;
  const latest = timeline[timeline.length - 1];
  const selected = (requested && byId.get(requested)) || (latest && byId.get(latest.nodeId)) || stageNodes[0];
  const selectedId = selected?.id ?? '';
  const step = (direction: number) => {
    const next = stageIds[stageIds.indexOf(selectedId) + direction];
    if (next) openStageReplay({ scope, nodeId: next });
  };
  return <StageScene open={active} selectedId={selectedId} timeline={timeline} onStep={step} />;
}
