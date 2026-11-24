import { useStore } from '@xyflow/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { shallow } from 'zustand/shallow';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { CanvasIcon, type CanvasIconName } from './CanvasIcons';

const commands = CANVAS_ACTIONS.filter(action => ['properties', 'duplicate', 'delete'].includes(action.id));

export default function NodeActions({ canvas }: { canvas: RefObject<HTMLDivElement | null> }) {
  const id = useGraphStore(s => s.selectedId);
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
    return { left: Math.max(4, Math.min(right - 28, s.width - 32)),
      top: Math.max(4, Math.min(top - 30, s.height - 32)), height: s.height };
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
  if (!id || !position || !actions.length) return null;
  return <div className="node-actions" ref={anchor} style={{ left: position.left, top: position.top }}>
    <button ref={trigger} type="button" aria-label="节点操作" aria-expanded={open} data-tip-heading="节点操作"
      aria-description="查看属性、复制或删除当前节点。" onClick={() => setOpenId(open ? null : id)}><CanvasIcon name="more" /></button>
    {open && <div className="node-action-list" role="group" aria-label="选中节点的操作" style={{
      left: Math.max(-position.left + 4, -112), ...(position.top > position.height / 2 ? {bottom: '100%'} : {top: '100%'}),
    }}>
      {actions.map(action => <button type="button" key={action.id} data-action={action.id}
        data-tip-heading={action.label} aria-description={action.description} onClick={() => {
          setOpenId(null);
          if (action.id === 'properties') useUiStore.getState().setSideTab('node');
          if (action.id === 'duplicate') useGraphStore.getState().duplicateNode(id);
          if (action.id === 'delete') useGraphStore.getState().deleteNodes([id]);
        }}><CanvasIcon name={action.id as CanvasIconName} />{action.label}</button>)}
    </div>}
  </div>;
}
