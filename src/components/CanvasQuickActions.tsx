import { useUiStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { CanvasIconButton } from './CanvasIcons';

export default function CanvasQuickActions({ hand, setHand }: { hand: boolean; setHand: (active: boolean) => void }) {
  const showShortcuts = useUiStore(s => s.preferences.showShortcuts);
  const addMenuOpen = useUiStore(s => Boolean(s.addMenu));

  return <div className="canvas-quick-actions" role="group" aria-label="画布快捷操作">
    <CanvasIconButton icon="plus" description="打开节点菜单，选择要添加的节点类型。" label="添加节点" className="canvas-add-trigger" aria-expanded={addMenuOpen}
      aria-controls={addMenuOpen ? 'canvas-add-menu' : undefined} title={showShortcuts ? '添加节点 · Shift + A' : '添加节点'}
      onClick={event => {
        const ui = useUiStore.getState();
        if (!useProjectStore.getState().root) {
          ui.setToast('请先打开或新建项目');
          return;
        }
        if (ui.addMenu) {
          ui.closeAddMenu();
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        ui.openAddMenu(bounds.left + bounds.width / 2, bounds.top, 'above');
      }} />
    <CanvasIconButton icon="select" description="用鼠标选中和移动节点。" label="选择工具" aria-pressed={!hand} onClick={() => setHand(false)} />
    <CanvasIconButton icon="hand" description="切换手形工具，拖动平移整张画布。" label="拖动画布" title={showShortcuts ? '拖动画布 · 按住空格临时拖动' : '拖动画布'}
      aria-pressed={hand} onClick={() => setHand(!hand)} />
  </div>;
}
