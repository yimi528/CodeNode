import { useStore } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';

export default function StatusBar({ showCanvasStatus = true }: { showCanvasStatus?: boolean }) {
  const nodeCount=useGraphStore(s=>s.nodes.length);
  const edgeCount=useGraphStore(s=>s.edges.length);
  const selectedCount=useGraphStore(s=>s.selectedIds.length);
  const toast=useUiStore(s=>s.toast);
  const zoomPercent = useStore(s => Math.round(s.transform[2] * 100));
  return <footer className="status-bar">
    {showCanvasStatus && <><span>节点 {nodeCount}</span><span>连线 {edgeCount}</span><span>选中 {selectedCount}</span><span>缩放 {zoomPercent}%</span></>}
    <span className="status-toast" role="status" aria-live="polite" aria-atomic="true">{toast || ''}</span>
  </footer>;
}
