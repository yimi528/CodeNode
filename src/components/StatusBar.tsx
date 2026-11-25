import { useStore } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';

function CanvasStatus() {
  const nodeCount=useGraphStore(s=>s.nodes.length);
  const edgeCount=useGraphStore(s=>s.edges.length);
  const selectedCount=useGraphStore(s=>s.selectedIds.length);
  const zoomPercent = useStore(s => Math.round(s.transform[2] * 100));
  return <><span>节点 {nodeCount}</span><span>连线 {edgeCount}</span>{selectedCount > 0 && <span>选中 {selectedCount}</span>}<span>缩放 {zoomPercent}%</span></>;
}

export default function StatusBar({ showCanvasStatus = true }: { showCanvasStatus?: boolean }) {
  const toast = useUiStore(s => s.toast);
  return <footer className="status-bar">
    {showCanvasStatus && <CanvasStatus />}
    <span className="status-toast" role="status" aria-live="polite" aria-atomic="true">{toast || ''}</span>
  </footer>;
}
