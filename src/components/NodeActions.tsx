import { useStore } from '@xyflow/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { shallow } from 'zustand/shallow';
import { NodeIcon } from '../nodes/NodeIcon';
import { nodePresentation } from '../nodes/presentation';
import { isWorkflowStage } from '../lib/workflowRunState';
import { saveProject } from '../lib/projectActions';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { CanvasIcon, type CanvasIconName } from './CanvasIcons';

const commands = CANVAS_ACTIONS.filter(action => ['properties', 'duplicate', 'delete'].includes(action.id));

function editorField(type?: string) {
  if (isWorkflowStage(type)) return { key: 'prompt', label: '任务指令' };
  switch (type) {
    case 'file': return { key: 'content', label: '文件内容' };
    case 'image': return { key: 'imagePath', label: '图片路径' };
    case 'object': return { key: 'objectName', label: '对象名称' };
    case 'scope': return { key: 'goal', label: '分组说明' };
    default: return { key: 'label', label: '节点名称' };
  }
}

export default function NodeActions({ canvas }: { canvas: RefObject<HTMLDivElement | null> }) {
  const id = useGraphStore(s => s.selectedId);
  const node = useGraphStore(s => s.nodes.find(item => item.id === id));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const saveStatus = useProjectSaveStore(s => s.status);
  const autoSave = useUiStore(s => s.preferences.autoSaveEnabled);
  const visible = useUiStore(s => s.preferences.visibleActions);
  const actions = commands.filter(action => visible.includes(action.id));
  const position = useStore(s => {
    const n = id ? s.nodeLookup.get(id) : undefined;
    if (!n || n.hidden || n.dragging) return null;
    const [dx, dy, zoom] = s.transform;
    const left = n.internals.positionAbsolute.x * zoom + dx;
    const top = n.internals.positionAbsolute.y * zoom + dy;
    const right = left + (n.measured.width ?? 0) * zoom;
    if (right < 0 || left > s.width || top > s.height || top + (n.measured.height ?? 0) * zoom < 0) return null;
    return { center: (left + right) / 2, top, bottom: top + (n.measured.height ?? 0) * zoom,
      height: s.height, width: s.width, nodeWidth: right - left };

  }, shallow);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = !!id && openId === id;
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const host = canvas.current;
    if (!host) return;
    const context = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      const el = e.target instanceof Element ? e.target : null;
      const nodeId = el?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      if (!nodeId || e.ctrlKey || el?.closest('.vs-scope,input,textarea,[contenteditable="true"]')) return;
      e.preventDefault();
      useGraphStore.getState().setSelectedIds([nodeId]);
      setOpenId(nodeId);
    };
    host.addEventListener('contextmenu', context);
    host.addEventListener('keydown', context);
    return () => { host.removeEventListener('contextmenu', context); host.removeEventListener('keydown', context); };
  }, [canvas]);
  useEffect(() => {
    if (openId && (!position || id !== openId)) setOpenId(null);
  }, [openId, id, position]);
  useEffect(() => {
    if (!open) return;
    anchor.current?.querySelector<HTMLButtonElement>('.node-action-list button')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent | FocusEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpenId(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpenId(null);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, id]);
  if (!id || !node || !position) return null;
  const hasInlineEditor = isWorkflowStage(node.type);
  const field = editorField(node.type);
  const value = String(node.data[field.key] ?? '');
  const expanded = expandedId === id;
  const width = Math.max(0, Math.min(position.width - 12, expanded ? 520 : Math.max(272, Math.min(360, position.nodeWidth + 40))));
  const height = Math.min(expanded ? 222 : 120, position.height * 0.45);
  const center = Math.max(width / 2 + 6, Math.min(position.center, position.width - width / 2 - 6));
  const editorTop = Math.max(4, Math.min(position.bottom + 10, position.height - height - 6));
  const invoke = (action: string) => {
    setOpenId(null);
    if (action === 'properties') useUiStore.getState().setSideTab('node');
    if (action === 'duplicate') useGraphStore.getState().duplicateNode(id);
    if (action === 'delete') useGraphStore.getState().deleteNodes([id]);
  };
  const reference = () => {
    useUiStore.getState().updatePreferences({ conversationOpen: true });
    const title = String(node.data.label || nodePresentation(node.type).label);
    const detail = [node.data.filePath, field.key === 'label' ? '' : value].filter(Boolean).join('\n');
    const text = '@' + title + ' (' + id + ')' + (detail ? '\n' + detail : '');
    window.dispatchEvent(new CustomEvent('codenode-reference-node', { detail: text }));
  };
  return <>
    <div className={`node-actions${hasInlineEditor ? ' node-actions-compact' : ''}`} role="group" aria-label="节点操作栏" ref={anchor}
      style={{ left: center, top: Math.max(4, position.top - 44), maxWidth: width }}>
      <button type="button" onClick={reference} aria-label="引用到对话" title="引用到对话"><span aria-hidden="true">@</span>{!hasInlineEditor && <span>引用到对话</span>}</button>
      {visible.includes('properties') && <button type="button" onClick={() => invoke('properties')} aria-label="编辑节点" title="编辑节点"><CanvasIcon name="properties" />{!hasInlineEditor && <span>编辑节点</span>}</button>}
      {visible.includes('delete') && <button type="button" onClick={() => invoke('delete')} aria-label="移出画布" title="移出画布"><CanvasIcon name="delete" />{!hasInlineEditor && <span>移出画布</span>}</button>}
      {hasInlineEditor && !expanded && <button type="button" aria-label="展开输入框" title="展开输入框"
        onClick={() => setExpandedId(id)}><CanvasIcon name="fit" /></button>}
      {!!actions.length && <button ref={trigger} type="button" aria-label="节点操作" aria-expanded={open}
        onClick={() => setOpenId(open ? null : id)}><CanvasIcon name="more" /></button>}
      {open && <div className="node-action-list" role="group" aria-label="更多节点操作">
        {actions.map(action => <button type="button" key={action.id} data-action={action.id}
          onClick={() => invoke(action.id)}><CanvasIcon name={action.id as CanvasIconName} />{action.label}</button>)}
      </div>}
    </div>
    {(!hasInlineEditor || expanded) && <section key={id} className="node-editor" aria-label="节点输入框" style={{ left: center, top: editorTop, width, height }}>
      <textarea aria-label={field.label} value={value} onFocus={() => useGraphStore.getState().commit()}
        onChange={event => useGraphStore.getState().updateNodeData(id, { [field.key]: event.target.value,
          ...(field.key === 'imagePath' ? { dataUrl: undefined } : {}) })} />
      <button className="node-editor-expand" type="button" aria-label={expanded ? '收起输入框' : '展开输入框'}
        aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : id)}><CanvasIcon name="fit" /></button>
      <footer><span><NodeIcon type={node.type} />{field.label}</span>
        <small>{saveStatus === 'saving' ? '保存中' : saveStatus === 'error' ? '保存失败' : autoSave ? '自动保存' : ''}</small>
        <button type="button" aria-label="保存节点" title="保存节点" onClick={() => void saveProject()}><CanvasIcon name="send" /></button>
      </footer>
    </section>}
  </>;
}
