import { MiniMap, useReactFlow, useStore, type Node as FlowNode } from '@xyflow/react';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { workflowReadiness } from '../lib/workflowRunState';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { shortcutLabel } from '../lib/tutorialContent';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { CanvasIcon, CanvasIconButton, type CanvasIconName } from './CanvasIcons';

type MenuAction = {
  id: CanvasIconName; label: string; description: string; group: string;
  shortcut?: string; disabled?: boolean; pressed?: boolean;
};
const groups = ['布局', '显示与对齐'];
const mac = /Mac/i.test(navigator.platform);
function minimapNodeColor(node: FlowNode) {
  return node.selected ? 'var(--glass-accent)' : 'var(--glass-muted)';
}

type ViewControls = {
  minimap: boolean;
  links: boolean;
  snap: boolean;
  hasPlanNodes: boolean;
  toggleMinimap: () => void;
  toggleLinks: () => void;
  toggleSnap: () => void;
};

export default function CanvasActions({ minimap, links, snap, hasPlanNodes, toggleMinimap, toggleLinks, toggleSnap }: ViewControls) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const canUndo = useGraphStore(s => s.past.length > 0);
  const canRedo = useGraphStore(s => s.future.length > 0);
  const nodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const workflow = useMemo(() => workflowReadiness(nodes, edges), [nodes, edges]);
  const preferences = useUiStore(s => s.preferences);
  const zoomPercent = useStore(s => Math.round(s.transform[2] * 100));
  const atMinZoom = useStore(s => s.transform[2] <= s.minZoom);
  const atMaxZoom = useStore(s => s.transform[2] >= s.maxZoom);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const menu = menuRef.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    }
    function onEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
      if (event.key !== 'Escape' || !menu?.open) return;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  const handlers: Partial<Record<CanvasIconName, () => void>> = {
    links: toggleLinks,
    snap: toggleSnap,
    minimap: toggleMinimap,
    undo: () => useGraphStore.getState().undo(),
    redo: () => useGraphStore.getState().redo(),
    arrange: () => {
      useGraphStore.getState().arrangeNodes();
      useUiStore.getState().setToast('已自动整理：按依赖分层、分支并列');
    },
    fit: () => void fitView({ padding: 0.2 }),
  };
  const arrange = CANVAS_ACTIONS.find(action => action.id === 'arrange');
  const fit = CANVAS_ACTIONS.find(action => action.id === 'fit');
  const showNodeActions = nodes.length > 0 || !preferences.hideDisabledActions;
  const canFit = nodes.length > 0 || hasPlanNodes;
  const menuActions: MenuAction[] = [
    ...(arrange && showNodeActions && preferences.visibleActions.includes('arrange') ? [{
      ...arrange, id: 'arrange' as const, shortcut: arrange.shortcut?.replace('Ctrl', 'Mod'),
      disabled: !nodes.length, description: arrange.description + (nodes.length ? '' : ' 请先添加节点。'),
    }] : []),
    { id: 'links', group: '显示与对齐', label: '显示连线', pressed: links, description: '显示或隐藏节点之间的连线，连接关系会保留。' },
    { id: 'snap', group: '显示与对齐', label: '吸附网格', pressed: snap, description: '拖动节点时自动对齐网格。' },
    { id: 'minimap', group: '显示与对齐', label: '小地图', pressed: minimap, description: '查看画布缩略图，快速平移或缩放。' },
  ];

  function hint(action: { id: string; label: string; shortcut?: string }) {
    const keys = action.shortcut && preferences.showShortcuts ? shortcutLabel(action.shortcut, mac) : '';
    return [action.label, keys]
      .filter(Boolean).join(' · ');
  }

  return (
    <div className="canvas-actions" aria-label="画布工具栏">
      <div className="canvas-view-strip" role="group" aria-label="画布视图">
        {workflow.ready && preferences.visibleActions.includes('workflow') &&
          <button type="button" className="canvas-run-trigger" data-action="workflow" aria-label="运行工作流" data-tip-heading="运行工作流"
            aria-description="先查看执行范围，再选择开始执行。" onClick={() => useUiStore.getState().openDock('runs')}>
            <CanvasIcon name="workflow" />运行…
          </button>}
        <div className="canvas-history-controls">
          <CanvasIconButton icon="undo" description={canUndo ? '撤回上一次画布编辑。' : '暂无可撤销的画布编辑。'} label="撤销" title={hint({ id: 'undo', label: '撤销', shortcut: 'Mod + Z' })} disabled={!canUndo} onClick={handlers.undo} />
          <CanvasIconButton icon="redo" description={canRedo ? '重新应用刚撤销的画布编辑。' : '先撤销一次画布编辑，才能重做。'} label="重做" title={hint({ id: 'redo', label: '重做', shortcut: mac ? 'Mod + Shift + Z' : 'Mod + Y' })} disabled={!canRedo} onClick={handlers.redo} />
        </div>
        <div className="canvas-zoom-controls">
          <CanvasIconButton icon="minus" description={atMinZoom ? '已达到最小缩放倍率。' : '缩小视图，看到更大范围的画布。'} label="缩小画布" disabled={atMinZoom} onClick={() => void zoomOut()} />
          <span aria-label="画布缩放倍率">{zoomPercent}%</span>
          <CanvasIconButton icon="plus" description={atMaxZoom ? '已达到最大缩放倍率。' : '放大视图，查看节点细节。'} label="放大画布" disabled={atMaxZoom} onClick={() => void zoomIn()} />
        </div>
        {fit && (canFit || !preferences.hideDisabledActions) && preferences.visibleActions.includes('fit') && <CanvasIconButton icon="fit" label="适应画布" title={hint(fit)} description={fit.description} data-action="fit" disabled={!canFit} onClick={handlers.fit} />}
        <details className="toolbar-dropdown canvas-command-menu" ref={menuRef}>
          <summary className="canvas-icon-button" aria-label="画布选项" data-tip-heading="画布选项" aria-description="整理节点布局，调整连线、吸附和小地图。"><CanvasIcon name="properties" /><span>画布选项</span></summary>
          <div className="toolbar-menu" style={{
            '--canvas-menu-width': preferences.menuWidth + 'px',
            '--canvas-menu-row-height': preferences.menuRowHeight + 'px',
          } as CSSProperties} onClick={event => {
            const button = (event.target as Element).closest('button');
            const menu = menuRef.current;
            if (!menu || !button || button.disabled) return;
            menu.open = false;
            menu.querySelector('summary')?.focus();
          }}>
            {groups.map(group => {
              const members = menuActions.filter(action => action.group === group);
              if (!members.length) return null;
              return <div className="toolbar-menu-section" role="group" aria-label={group} key={group}>
                {preferences.showGroupLabels && <div className="toolbar-menu-label">{group}</div>}
                {members.map(action => <button key={action.id} type="button" data-action={action.id} disabled={action.disabled} aria-label={action.label} aria-pressed={action.pressed}
                  data-tip-heading={hint(action)} aria-description={action.description} onClick={handlers[action.id]}>
                  <CanvasIcon name={action.id} /><span>{action.label}</span>
                  {action.pressed && <b aria-hidden="true">✓</b>}
                  {preferences.showShortcuts && action.shortcut && <kbd>{shortcutLabel(action.shortcut, mac)}</kbd>}
                </button>)}
              </div>;
            })}
          </div>
        </details>
      </div>
      {minimap && <MiniMap className="canvas-minimap" position="top-right" ariaLabel="画布小地图"
        nodeColor={minimapNodeColor} pannable zoomable />}
    </div>
  );
}
