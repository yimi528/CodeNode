import { useEffect, useState } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';

/** 文件编辑器中的工程摘要与空状态。 */
export default function PreviewPanel() {
  const selected = useProjectStore(s => s.selected);
  const root = useProjectStore(s => s.root);
  const isProject = !!selected?.relPath.toLowerCase().endsWith('.cnode');
  const [summary, setSummary] = useState<{nodes:number;edges:number;canvases:number;error?:string}|null>(null);
  useEffect(() => {
    let alive = true; setSummary(null);
    if (isProject && root && selected) {
      void window.codenode?.loadProject(root.replace(/[\\/]+$/,'')+'/'+selected.relPath).then(result => {
        if (alive) setSummary({nodes:result.data?.graph?.nodes?.length || 0,edges:result.data?.graph?.edges?.length || 0,canvases:result.data?.canvases?.sessions?.length || 0,...(!result.ok?{error:result.error || '无法读取工程'}:{})});
      }).catch(() => { if (alive) setSummary({nodes:0,edges:0,canvases:0,error:'无法读取工程'}); });
    }
    return () => { alive = false; };
  }, [root,selected?.relPath,selected?.mtimeMs,isProject]);

  if (!selected) {
    return (
      <div className="sp-pane">
        <div className="pm-preview-empty">
          尚未选择文件
          <div className="sp-empty-hint">在左侧选择文件即可查看内容。</div>
        </div>
      </div>
    );
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(selected.relPath);
      useUiStore.getState().setToast('已复制相对路径');
    } catch {
      useUiStore.getState().setToast('复制失败（剪贴板不可用）');
    }
  };
  return (
    <div className="sp-pane sp-pane-preview">
      <div className="sp-subhead sp-subhead-col">
        <div className="sp-path-name" title={selected.relPath}>{selected.relPath}</div>
        <div className="fp-actions"><button onClick={() => void copyPath()} title="复制相对路径">复制路径</button></div>
      </div>
      {isProject && <div className="project-document-summary"><strong>CodeNode 工程文件</strong>{!summary ? <p>读取中…</p> : summary.error ? <p role="alert">{summary.error}</p> : <p>{summary.nodes} 节点 · {summary.edges} 连线 · {summary.canvases} 画布</p>}<button onClick={() => useUiStore.getState().setSideTab('agent')}>返回工作台</button></div>}
    </div>
  );
}
