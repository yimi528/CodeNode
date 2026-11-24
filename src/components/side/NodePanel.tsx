import { useEffect, useMemo, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { FileData, ImageData, ScopeData } from '../../types';
import { flattenFilePaths } from '../../lib/flow';
import { isWorkflowStage, workflowGraph, workflowSignature } from '../../lib/workflowRunState';
import { stageOutcomePreview, type StageEvidence } from '../../lib/stageScene';
import { readMaterial } from '../../lib/materialFile';
import { ALLOWED_IMAGE_MIME, TEXT_FILE_ACCEPT } from '../../lib/imageAttach';
import { NodeIcon } from '../../nodes/NodeIcon';
import { nodeModes, nodePresentation } from '../../nodes/presentation';
import FlowList from './FlowList';
import StageFileList from './StageFileList';

type StageExecution = { key: string; phase: 'ready' | 'unavailable'; error?: string; evidence?: StageEvidence | null };

/** 标签页 1：选中节点的属性检查器（原独立「检查器」浮层的全部内容） */
export default function NodePanel() {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const flow = useGraphStore((s) => (s.selectedId ? s.flow[s.selectedId] : undefined));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const runFlow = useGraphStore((s) => s.runFlow);
  const setToast = useUiStore((s) => s.setToast);
  const projectRoot = useProjectStore((s) => s.root);
  const tree = useProjectStore((s) => s.tree);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const workflowId = useSessionStore((s) => s.activeId) || 'canvas';
  const graph = useMemo(() => workflowGraph(nodes, edges), [nodes, edges]);
  const executionSignature = useMemo(() => workflowSignature(graph), [graph]);
  const isStage = isWorkflowStage(node?.type);
  const running = node?.data.status === 'running';
  const sceneKey = JSON.stringify([projectRoot, workflowId]);
  const requestKey = JSON.stringify([sceneKey, executionSignature, node?.id, node?.data.status]);
  const [execution, setStageExecution] = useState<StageExecution | null>(null);
  const stageExecution = execution?.key === requestKey ? execution : null;

  useEffect(() => {
    let alive = true;
    if (!isStage || !node || !projectRoot || !window.codenode?.workflowState) return;
    void window.codenode.workflowState(projectRoot, workflowId, {
      action: 'read', graph, inspectNodeId: node.id,
    }).then((result) => {
      if (!alive) return;
      if (!result.ok || !result.state) {
        setStageExecution({ key: requestKey, phase: 'unavailable', error: result.error || '暂时无法读取本阶段记录' });
        return;
      }
      setStageExecution({ key: requestKey, phase: 'ready', evidence: result.stageEvidence });
    }).catch((error) => {
      if (alive) setStageExecution({ key: requestKey, phase: 'unavailable', error: String(error?.message || error) });
    });
    return () => { alive = false; };
  }, [requestKey, isStage]);

  // 进入编辑前记录一次快照，使“编辑节点”成为一次可撤销的节点操作
  const beginEdit = () => useGraphStore.getState().commit();

  if (!node) {
    return (
      <div className="sp-pane">
        <div className="inspector-empty">
          未选中节点
          <div className="sp-empty-hint">在画布上点选一个节点，这里会显示它的可编辑属性。</div>
        </div>
      </div>
    );
  }

  const d = node.data as Record<string, unknown> & FileData & ScopeData & ImageData;
  const status = String(d.status || 'pending');
  const modes = nodeModes(node.type || 'task');
  const isFile = node.type === 'file';
  const isImage = node.type === 'image';
  const isScope = node.type === 'scope';
  const stageEvidence = stageExecution?.evidence;
  const outcome = stageEvidence?.output.trim() || '';
  const preview = stageOutcomePreview(outcome);

  const handleReadFile = async () => {
    const root = projectRoot;
    if (!root || !d.filePath) {
      setToast('请先选择项目与文件');
      return;
    }
    if (!window.codenode) return;
    const res = await window.codenode.readProjectFile(root, d.filePath);
    if (res.ok) {
      updateNodeData(node.id, { content: res.content || '' });
      runFlow();
      setToast(`已读取 ${d.filePath}（${(res.content || '').length} 字符）`);
    } else {
      setToast('读取失败：' + (res.error || ''));
    }
  };

  const handleReadImage = async () => {
    const root = projectRoot;
    if (!root || !d.imagePath) {
      setToast('请先选择项目与图片路径');
      return;
    }
    if (!window.codenode) return;
    const res = await window.codenode.readProjectFile(root, d.imagePath, { binary: true });
    if (res.ok && res.dataUrl) {
      updateNodeData(node.id, { dataUrl: res.dataUrl });
      setToast(`已读取图片 ${d.imagePath}（${Math.round((res.bytes || 0) / 1024)}KB）`);
    } else {
      setToast('读取图片失败：' + (res.error || ''));
    }
  };

  return (
    <div className="sp-pane">
      <div className="sp-kv">
        <span>ID</span>
        <code title={node.id}>{node.id}</code>
      </div>
      <div className="sp-kv">
        <span>类型</span>
        <span><NodeIcon type={node.type} /> {nodePresentation(node.type).label}</span>
      </div>
      {modes && <div className="inspector-field"><label>
        {isStage ? '执行方式' : '资料格式'}
        <select value={node.type} disabled={running} onChange={event => useGraphStore.getState().changeNodeMode(node.id, event.target.value)}>
          {Object.entries(modes).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
      </label></div>}
      {modes && !isStage && <div className="inspector-field"><label>导入文件或图片
        <input type="file" accept={[...ALLOWED_IMAGE_MIME, TEXT_FILE_ACCEPT].join(',')} onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          try {
            const item = await readMaterial(file);
            if ((useSessionStore.getState().activeId || 'canvas') === workflowId)
              useGraphStore.getState().changeNodeMode(node.id, item.type, item.data);
          } catch (error) { setToast(String(error)); }
        }} /></label></div>}
      {isStage && <div className="inspector-field"><label>任务指令
        <textarea value={String(d.prompt || '')} rows={3} onFocus={beginEdit}
          onChange={event => updateNodeData(node.id, { prompt: event.target.value })} />
      </label></div>}
      {isStage && <div className="inspector-field"><label>流程标记
        <select value={String(d.boundary || '')} onFocus={beginEdit} onChange={event => updateNodeData(node.id, { boundary: event.target.value })}>
          <option value="">无</option><option value="start">起点</option><option value="end">输出</option><option value="both">起点和输出</option>
        </select></label></div>}
      {d.trellis && <div className="sp-kv"><span>Trellis 执行动作</span><code>{String((d.trellis as {phase: string; role: string}).phase)} · {String((d.trellis as {phase: string; role: string}).role)}</code></div>}

      <div className="inspector-field">
        <label>名称</label>
        <input value={String(d.label || '')} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { label: e.target.value })} />
      </div>
      <div className="inspector-field">
        <label>状态</label>
        <select value={status} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { status: e.target.value })}>
          {['pending', 'running', 'done', 'failed', 'blocked'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {isStage && (
        <section className="stage-execution-card" aria-label="本阶段 Agent 执行情况">
          {stageEvidence && (
            <>
              {preview && <p>{preview}</p>}
              {stageEvidence.files.length > 0 && <details>
                <summary>文件变更 {stageEvidence.fileCount}</summary>
                <StageFileList files={stageEvidence.files} />
                {stageEvidence.fileCount > stageEvidence.files.length && <p>显示前 {stageEvidence.files.length} 个文件。</p>}
              </details>}
              {outcome && outcome.replace(/^Agent[：:]\s*/, '') !== preview && <details>
                <summary>阶段总结</summary><pre className="stage-execution-output">{outcome}</pre>
              </details>}
            </>
          )}
          <button type="button" className="stage-scene-trigger"
            onClick={() => useUiStore.getState().openStageReplay({ scope: sceneKey, nodeId: node.id })}>查看 3D 回放</button>
          {status === 'running' ? (
            <p>Agent 正在处理这个阶段。任务要求：{String(d.prompt || d.goal || '尚未填写任务说明')}</p>
          ) : stageExecution?.phase === 'unavailable' ? (
            <p>{stageExecution.error}</p>
          ) : null}
        </section>
      )}

      {isStage && (
        <>
        <div className="inspector-field"><label><input type="checkbox" checked={Boolean(d.requiresInput)} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { requiresInput: e.target.checked })} /> 需要上游输出</label><div className="sp-empty-hint">当前连线输入：{flow?.input?.length ? flow.input.map((item) => item.label).join('、') : '无'}</div>{d.requiresInput && !flow?.input?.length ? <div className="task-trace-warning">缺少输入连线，运行时会阻塞</div> : null}</div>
        <div className="inspector-field"><label>输出名称</label><input value={String(d.outputName || '')} placeholder="例如：测试结果" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { outputName: e.target.value })} /></div>
        <div className="inspector-field"><label>完成条件（支持 contains:文本 / equals:文本；自然语言需人工核对）</label><textarea value={String(d.completionCondition || '')} rows={2} placeholder="例如：contains:verified，或命令退出码为 0" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { completionCondition: e.target.value })} /></div>
        <div className="inspector-field"><label>可能写入的范围</label><input value={String(d.writeScope || '')} placeholder="项目文件路径或画布节点；留空表示未声明" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { writeScope: e.target.value })} /></div>
        <div className="inspector-field"><label><input type="checkbox" checked={Boolean(d.confirmWrite)} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { confirmWrite: e.target.checked })} /> 执行前确认写入范围</label></div>
        <div className="inspector-field"><label>模板依赖工具（逗号分隔）</label><input value={String(d.requiredTools || '')} placeholder="例如 retrieve_context,execute_shell" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { requiredTools: e.target.value })} /></div>
        <div className="inspector-field"><label>模板依赖模型</label><input value={String(d.requiredModel || '')} placeholder="模型 ID 或名称" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { requiredModel: e.target.value })} /></div>
        <div className="inspector-field"><label>模板依赖路径（逗号分隔）</label><input value={String(d.requiredPaths || '')} placeholder="项目内相对路径" onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { requiredPaths: e.target.value })} /></div></>
      )}

      {node.type === 'object' && (
        <div className="inspector-field">
          <label>对象名称</label>
          <input
            value={String(d.objectName || '')}
            placeholder="对象名称（数据对象/配置对象/实体名）"
            onFocus={beginEdit}
            onChange={(e) => updateNodeData(node.id, { objectName: e.target.value })}
          />
        </div>
      )}

      {isScope && (
        <>
          <div className="inspector-field">
            <label>宽 / 高</label>
            <div className="inspector-row">
              <input
                type="number"
                value={d.width || 320}
                min={160}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { width: Number(e.target.value) })}
              />
              <input
                type="number"
                value={d.height || 220}
                min={120}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { height: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="inspector-field">
            <label>填充颜色（hex）</label>
            <input value={d.fill || '#3b2f6b'} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { fill: e.target.value })} />
          </div>
          <div className="inspector-field">
            <label>不透明度（0–1）</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={d.opacity ?? 0.16}
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { opacity: Number(e.target.value) })}
            />
          </div>
          <div className="inspector-field">
            <label>
              <input
                type="checkbox"
                checked={Boolean(d.shrink)}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { shrink: e.target.checked })}
              />{' '}
              Shrink / 自动收缩
            </label>
          </div>
          <div className="inspector-field">
            <label>说明</label>
            <textarea value={String(d.goal || '')} rows={3} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { goal: e.target.value })} />
          </div>
        </>
      )}

      {isImage && (
        <>
          <div className="inspector-field">
            <label>项目内图片路径（相对路径）</label>
            <input
              value={String(d.imagePath || '')}
              placeholder="例如 assets/logo.png"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { imagePath: e.target.value, dataUrl: undefined })}
            />
          </div>
          {tree.length > 0 && (
            <div className="inspector-field">
              <label>从项目选择图片</label>
              <select
                value={String(d.imagePath || '')}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { imagePath: e.target.value, dataUrl: undefined })}
              >
                <option value="">— 选择 —</option>
                {flattenFilePaths(tree)
                  .filter((p) => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(p))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div className="inspector-field">
            <button className="inspector-btn" onClick={() => void handleReadImage()}>
              读取图片
            </button>
          </div>
          <div className="inspector-field">
            <label>宽 / 高（px）</label>
            <div className="inspector-row">
              <input
                type="number"
                min={120}
                value={d.width || 320}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { width: Number(e.target.value) })}
              />
              <input
                type="number"
                min={100}
                value={d.height || 224}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { height: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="inspector-field">
            <label>说明</label>
            <textarea
              rows={2}
              value={String(d.note || '')}
              placeholder="这张图的用途 / 给 Agent 的提示…"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { note: e.target.value })}
            />
          </div>
          {d.dataUrl ? (
            <div className="inspector-field">
              <label>当前图片（{Math.round(String(d.dataUrl).length / 1024)}KB base64）</label>
              <img className="inspector-image" src={String(d.dataUrl)} alt="节点图片" />
              <button className="inspector-btn" onClick={() => updateNodeData(node.id, { dataUrl: undefined })}>
                清除图片数据
              </button>
            </div>
          ) : (
            <div className="inspector-hint">还没有图片数据：可在画布上直接把图拖进节点，或按 Ctrl+V 粘贴，或填上面的路径后点「读取图片」。</div>
          )}
        </>
      )}

      {isFile && (
        <>
          <div className="inspector-field">
            <label>项目文件（相对路径）</label>
            <input
              value={String(d.filePath || '')}
              placeholder="选择下方文件或手动输入"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { filePath: e.target.value })}
            />
          </div>
          {tree.length > 0 && (
            <div className="inspector-field">
              <label>从项目选择文件</label>
              <select
                value={String(d.filePath || '')}
                onFocus={beginEdit}
                onChange={(e) => {
                  const path = e.target.value;
                  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) {
                    useGraphStore.getState().changeNodeMode(node.id, 'image', { imagePath: path, dataUrl: '', label: path.split('/').pop() });
                  } else updateNodeData(node.id, { filePath: path, content: '' });
                }}
              >
                <option value="">— 选择 —</option>
                {flattenFilePaths(tree).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="inspector-field">
            <button className="inspector-btn" onClick={() => void handleReadFile()}>
              读取文件内容
            </button>
          </div>
          {d.content && (
            <div className="inspector-field">
              <label>内容预览（{d.content.length} 字符）</label>
              <pre className="inspector-pre">
                {d.content.slice(0, 600)}
                {d.content.length > 600 ? '…' : ''}
              </pre>
            </div>
          )}
        </>
      )}

      <FlowList title="数据流 · 输入" items={flow?.input || []} />
      <FlowList title="数据流 · 输出" items={flow?.output || []} />
    </div>
  );
}
