import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useUiStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { placeCanvasNode, placeWorkflowNode } from '../lib/nodePlacement';
import { NodeIcon } from '../nodes/NodeIcon';

const actionGroups = [
  { title: '执行步骤', actions: [
    { type: 'task', label: '新建任务', description: '写下这一步要完成的事' },
    { type: 'tool', label: '调用工具', description: '指定要运行的命令或工具' },
    { type: 'stage', label: '交给子代理', description: '让另一个 AI 负责其中一步' },
  ] },
  { title: '提供资料', actions: [
    { type: 'file', label: '引用项目文件', description: '连到需要读取这个文件的任务' },
    { type: 'image', label: '添加图片', description: '放入可预览的截图或参考图' },
    { type: 'object', label: '记录对象', description: '记录数据、配置或实体的名称' },
  ] },
  { title: '流程边界', actions: [
    { type: 'start', label: '入口', description: '连到流程的第一步' },
    { type: 'end', label: '出口', description: '接在流程的最后一步后面' },
  ] },
  { title: '组织与绘图', actions: [
    { type: 'scope', label: '创建分组', description: '把相关步骤放到一个分组里' },
    { type: 'vector', label: '画草图', description: '绘制流程图或标注想法' },
  ] },
] as const;
type AddType = typeof actionGroups[number]['actions'][number]['type'];

export default function AddMenu() {
  const vectorEnabled = useUiStore(s => s.preferences.vectorEditorEnabled);
  const canGroup = useGraphStore(s => s.selectedIds.length >= 2 && s.nodes.filter(n => n.selected && n.type !== 'scope').length >= 2);
  const menu = useUiStore(s => s.addMenu);
  const close = useUiStore(s => s.closeAddMenu);
  const { screenToFlowPosition, getViewport, setViewport } = useReactFlow();
  const menuRef = useRef<HTMLDivElement>(null);

  const closeAndRestoreFocus = useCallback(() => {
    if (useUiStore.getState().addMenu?.anchor === 'above') {
      document.querySelector<HTMLButtonElement>('.canvas-add-trigger')?.focus({ preventScroll: true });
    }
    close();
  }, [close]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const reposition = () => {
      const trigger = menu.anchor === 'above' ? document.querySelector('.canvas-add-trigger')?.getBoundingClientRect() : undefined;
      if (trigger && !trigger.width) { close(); return; }
      const x = trigger ? trigger.left + trigger.width / 2 - element.offsetWidth / 2 : menu.x;
      const y = trigger ? trigger.top - 8 : menu.y;
      element.style.maxHeight = trigger ? Math.max(0, y - 8) + 'px' : 'calc(100vh - 16px)';
      const top = trigger ? y - element.offsetHeight : Math.min(y, window.innerHeight - element.offsetHeight - 8);
      element.style.left = Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8)) + 'px';
      element.style.top = Math.max(8, top) + 'px';
    };
    reposition();
    if (menu.anchor === 'above') element.querySelector('button')?.focus({ preventScroll: true });
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [menu, close, canGroup, vectorEnabled]);

  const isOpen = Boolean(menu);
  useEffect(() => {
    if (!isOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') closeAndRestoreFocus();
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Element && !event.target.closest('#canvas-add-menu, .canvas-add-trigger')) close();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen, close, closeAndRestoreFocus]);

  if (!menu) return null;

  const handlePick = (type: AddType) => {
    const api = { screenToFlowPosition, getViewport, setViewport };
    if (type === 'vector') {
      placeCanvasNode(api);
    } else if (type === 'scope' && canGroup) {
      useGraphStore.getState().createScopeFromSelection();
    } else {
      placeWorkflowNode(api, type, menu.anchor === 'above' ? undefined : { x: menu.x, y: menu.y });
    }
    closeAndRestoreFocus();
  };

  return (
    <div className="add-menu" id="canvas-add-menu" ref={menuRef} role="group" aria-label="添加节点">
      <div className="add-menu-columns">
        {actionGroups.map((group, index) => (
          <section className="add-menu-group" key={group.title} aria-labelledby={`add-menu-group-${index}`}>
            <h2 className="add-menu-group-title" id={`add-menu-group-${index}`}>{group.title}</h2>
            <div className="add-menu-group-actions">
              {group.actions.map(({ type, label, description }) => {
                if (type === 'vector' && !vectorEnabled) return null;
                const groupSelection = type === 'scope' && canGroup;
                return (
                  <button type="button" key={type} data-node-type={type} className="add-menu-item" onClick={() => handlePick(type)}>
                    <NodeIcon type={type} />
                    <span className="add-menu-copy">
                      <span className="add-menu-label">{groupSelection ? '将所选节点编组' : label}</span>
                      <span className="add-menu-sub">{groupSelection ? '一起移动、折叠这些节点' : description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="add-menu-tip">Esc 关闭 · {menu.anchor === 'above' ? '在画布中心添加' : '在光标位置添加'}</div>
    </div>
  );
}
