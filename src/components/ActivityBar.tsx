import type { CSSProperties, ReactNode } from 'react';
import { useUiStore } from '../store/uiStore';

const railIcons = {
  workbench: <>
    <path d="m3 8.3 8.2-4.6a1.6 1.6 0 0 1 1.6 0L21 8.3l-9 5.1Z" fill="currentColor" fillOpacity=".2" />
    <path d="m3 12.4 9 5 9-5m-18 4.2 9 5 9-5" />
  </>,
  plugins: <>
    <rect x="3" y="4" width="7" height="7" rx="1.7" />
    <rect x="3" y="14" width="7" height="7" rx="1.7" />
    <rect x="13" y="14" width="7" height="7" rx="1.7" />
    <path d="m16.8 2.3 4.7 4.7-4.7 4.7L12.1 7Z" fill="currentColor" strokeWidth="1" />
  </>,
  tasks: <>
    <path d="m3.5 7 2 2 3.2-4M12 7h8.5m-17 9 2 2 3.2-4M12 16h8.5" />
  </>,
  sidebar: <>
    <rect x="2.5" y="4" width="19" height="16" rx="3" />
    <path d="M8.8 4v16" />
    <path className="rail-panel-arrow" d="m13 9 3 3-3 3" />
  </>,
  settings: <>
    <path d="M3 6h4m5 0h9M3 12h11m5 0h2M3 18h3m5 0h10" />
    <circle cx="9.5" cy="6" r="2.3" /><circle cx="16.5" cy="12" r="2.3" /><circle cx="8.5" cy="18" r="2.3" />
  </>,
} satisfies Record<string, ReactNode>;

function RailIcon({ kind }: { kind: keyof typeof railIcons }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{railIcons[kind]}</svg>;
}

export default function ActivityBar({ showTasks }: { showTasks: boolean }) {
  const { appPage, setAppPage, setPluginView, navigationOpen, toggleNavigation, preferences, setSideTab, openSettings } = useUiStore();
  const sidebarLabel = navigationOpen ? '隐藏侧边栏' : '显示侧边栏';
  return <nav className="activity-bar" aria-label="主导航" style={{ '--activity-bar-width': preferences.activityBarWidth + 'px' } as CSSProperties}>
    <button className="toolbar-navigation-toggle" title={sidebarLabel + ' (Ctrl+B)'} aria-label={sidebarLabel}
      aria-expanded={navigationOpen} onClick={toggleNavigation}><RailIcon kind="sidebar" /></button>
    <div className="activity-bar-links">
      <button title="工作台" aria-label="工作台" aria-current={appPage === 'workbench' ? 'page' : undefined}
        onClick={() => { setAppPage('workbench'); setSideTab('agent'); }}><RailIcon kind="workbench" /></button>
      <button title="插件" aria-label="插件" aria-current={appPage === 'plugins' ? 'page' : undefined}
        onClick={() => setPluginView('plugins')}><RailIcon kind="plugins" /></button>
      {showTasks && <button title="任务" aria-label="任务" aria-current={appPage === 'tasks' ? 'page' : undefined}
        onClick={() => setAppPage('tasks')}><RailIcon kind="tasks" /></button>}
    </div>
    <div className="activity-bar-footer"><button className="global-settings-trigger" title="设置" aria-label="全局设置"
      onClick={() => openSettings()}><RailIcon kind="settings" /></button></div>
  </nav>;
}
