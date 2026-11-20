import GoalOverview from './components/GoalOverview';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { themeTokens } from './lib/theme';
import { useReactFlow } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import { useProjectAutoSave } from './lib/useProjectAutoSave';
import ActivityBar from './components/ActivityBar';
import PluginWorkspace from './components/PluginWorkspace';
import TaskWorkspace from './components/TaskWorkspace';
import Canvas from './components/Canvas';
import StartupSplash from './components/StartupSplash';
import welcomeLogo from '../assets/branding/welcome-logo.png';
import SidePanel from './components/side/SidePanel';
import './components/side/nodeInspectorDock.css';
import ProjectNavigation from './components/ProjectNavigation';
import ConversationPanel from './components/ConversationPanel';
import FileWorkspace from './components/FileWorkspace';
import AddMenu from './components/AddMenu';
import StatusBar from './components/StatusBar';
import { useGraphStore } from './store/graphStore';
import { useUiStore } from './store/uiStore';
import { useSessionStore } from './store/sessionStore';
import { useProjectStore } from './store/projectStore';
import { newProject, openProject, openProjectFile, saveProject, restoreLastWorkspace } from './lib/projectActions';
import { useWorkspaceHistory } from './lib/workspaceHistory';
import { installToolListener } from './lib/toolUi';
import ToolDialog from './components/ToolDialog';
import ModelManager from './components/ModelManager';
import WorkbenchDock from './components/WorkbenchDock';
import GlobalSettings from './components/GlobalSettings';
import GoalAutoAdvanceManager from './components/GoalAutoAdvanceManager';
import { getActiveVectorNode } from './vector/vectorStore';
import type { Graph } from './types';

function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 焦点在画布节点（矢量画布）内部时，工作台快捷键让位给节点自身。 */
function isVectorNodeFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el?.closest?.('.vs-scope'));
}

/** 是否正在进行真正的“文字编辑”，此时 Delete/Backspace 应留给控件。
 *
 *  只按“焦点是不是 input/textarea”判断会误伤：点选节点时焦点常常落在节点内的
 *  非文本控件上（如画布节点的模式按钮 .wf-vector-mode、面板里的 range/checkbox），
 *  用户并没有在编辑文字，Delete 应该删除节点而不是被吞掉。
 *  因此这里做白名单：只认真正的文本录入控件（textarea / 文本类 input / contentEditable）。 */
const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'email', 'password', 'tel', 'number'];

function isTextEditingNow(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.includes(type);
  }
  return el.isContentEditable === true;
}

export default function App() {
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const layoutNodes = useGraphStore((s) => s.layoutNodes);
  const arrangeNodes = useGraphStore((s) => s.arrangeNodes);
  const createScopeFromSelection = useGraphStore((s) => s.createScopeFromSelection);
  useProjectAutoSave();
  const projectRoot = useProjectStore(s => s.root);
  const selectedPage = useUiStore(s => s.appPage);
  const appPage = !projectRoot && selectedPage === 'tasks' ? 'workbench' : selectedPage;
  const sideOpen = useUiStore((s) => s.sideOpen);
  const sideTab = useUiStore(s => s.sideTab);
  const conversationMain = sideTab === 'conversation';
  const filePreview = !!projectRoot && sideTab === 'preview';
  const workbenchView=useUiStore(s=>s.preferences.workbenchView);
  const overview=workbenchView==='overview'&&!['project','preview'].includes(sideTab);
  const theme = useUiStore((s) => s.theme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    for (const [name,value] of Object.entries(themeTokens(theme))) root.style.setProperty(name,value);
  }, [theme]);
  const dockOpen = useUiStore((s) => s.dockOpen);
  const [starting, setStarting] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [projectActionError, setProjectActionError] = useState('');
  const restoring = useRef(false);
  const projectActionPending = useRef(false);
  useWorkspaceHistory(switchingProject, projectActionPending);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const nodeClipboard = useRef<Graph | null>(null);

  const runProjectAction = useCallback(async (action: () => Promise<void>) => {
    if (projectActionPending.current || useSessionStore.getState().streaming) return false;
    if (!window.codenode) {
      setProjectActionError('请在 CodeNode 桌面应用中打开工程。');
      return false;
    }
    projectActionPending.current = true;
    setSwitchingProject(true);
    setProjectActionError('');
    useProjectStore.setState({ error: null });
    try {
      await action();
      const error = useProjectStore.getState().error;
      if (error) setProjectActionError(error);
      return !error;
    } catch (cause) {
      setProjectActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      projectActionPending.current = false;
      setSwitchingProject(false);
    }
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => useUiStore.getState().setLastMouse(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  useEffect(() => {
    if (!restoring.current) {
      restoring.current = true;
      if (window.codenode) void runProjectAction(restoreLastWorkspace);
      else void restoreLastWorkspace();
    }
    const uninstall = installToolListener();
    return uninstall;
  }, [runProjectAction]);

  // 窄窗口优先保留画布与 Prompt：侧栏改为浮层，过窄时默认收起。
  useEffect(() => {
    let wasNarrow = window.innerWidth <= 860;
    let navigationCompact = window.innerWidth <= 600;
    if (navigationCompact && useUiStore.getState().preferences.autoCollapseSidebars) useUiStore.setState({ navigationOpen: false, navigationAutoHidden: true });
    if (wasNarrow && useUiStore.getState().preferences.autoCollapseSidebars && useUiStore.getState().sideOpen) useUiStore.getState().setSideOpen(false);
    const onResize = () => {
      const isNarrow = window.innerWidth <= 860;
      const nextNavigationCompact = window.innerWidth <= 600;
      if (useUiStore.getState().preferences.autoCollapseSidebars && nextNavigationCompact && !navigationCompact && useUiStore.getState().navigationOpen) useUiStore.setState({ navigationOpen: false, navigationAutoHidden: true });
      if (!nextNavigationCompact && navigationCompact && useUiStore.getState().navigationAutoHidden) useUiStore.setState({ navigationOpen: true, navigationAutoHidden: false });
      navigationCompact = nextNavigationCompact;
      if (useUiStore.getState().preferences.autoCollapseSidebars && isNarrow && !wasNarrow && useUiStore.getState().sideOpen) {
        useUiStore.getState().setSideOpen(false);
      }
      wasNarrow = isNarrow;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!projectRoot) return;
    const workspace = document.querySelector('.workspace-main');
    if (!workspace) return;
    let wasCompact: boolean | null = null;
    const adapt = () => {
      const ui = useUiStore.getState();
      if (ui.sideTab === 'preview') return;
      if (ui.sideTab === 'conversation') return;
      const compact = workspace.getBoundingClientRect().width <= 660;
      if (compact === wasCompact) return;
      wasCompact = compact;
      if (compact && ui.conversationOpen && !useSessionStore.getState().streaming && !ui.modelManagerOpen && !document.activeElement?.closest('.conversation-right, .hermes-picker-layer')) {
        useUiStore.setState({ conversationOpen: false, conversationAutoHidden: true });
      } else if (!compact && ui.conversationAutoHidden) {
        useUiStore.setState({ conversationOpen: true, conversationAutoHidden: false });
      }
    };
    const observer = new ResizeObserver(adapt); observer.observe(workspace); adapt();
    return () => observer.disconnect();
  }, [projectRoot, sideTab, appPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (starting) return;
      if (useUiStore.getState().settingsOpen || useUiStore.getState().modelManagerOpen) return;
      const mod = e.ctrlKey || e.metaKey;

      // 主工作区在无工程时仍可使用项目操作和导航快捷键。
      if (!useProjectStore.getState().root) {
        if (mod && e.key.toLowerCase() === 'n') {
          e.preventDefault();
          void runProjectAction(newProject);
        } else if (mod && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          void runProjectAction(openProject);
        } else if (mod && e.key.toLowerCase() === 'b' && !isTypingTarget()) {
          e.preventDefault();
          useUiStore.getState().toggleNavigation();
        }
        return;
      }
      const tab = useUiStore.getState().sideTab;
      if (tab === 'preview') return;
      if (useUiStore.getState().preferences.workbenchView === 'overview') return;

      // 删除选中节点。
      // 与画布节点的分工：焦点落在画布节点内部（.vs-scope）时让位——由画布节点自己的快捷键删图形，
      // 而不是把整个画布节点删掉；焦点不在里面（例如点的是节点标题栏）才删节点本身。
      // 这条规则的两端分别是「选中画布节点后删不掉」和「在画布节点里按 Delete 把节点整个删了」。
      // 画布节点会在指针按下时把焦点收回 .vs-scope（VectorNode.tsx 的 focusBodyOnPointerDown），
      // 所以这里判断焦点归属是可靠的。
      if (tab !== 'conversation' && !mod && (e.key === 'Delete' || e.key === 'Backspace' || e.key.toLowerCase() === 'x')) {
        const focused=document.activeElement as HTMLElement|null;
        if(focused&&focused!==document.body&&!focused.closest('.canvas-wrap'))return;
        if (!isTextEditingNow() && !isVectorNodeFocus()) {
          const st = useGraphStore.getState();
          const ids = st.selectedIds.length ? st.selectedIds : st.selectedId ? [st.selectedId] : [];
          const edgeIds=st.edges.filter(edge=>edge.selected).map(edge=>edge.id);
          if (ids.length||edgeIds.length) {
            e.preventDefault();
            if(ids.length)deleteNodes(ids);
            const remaining=new Set(useGraphStore.getState().edges.map(edge=>edge.id));
            if(edgeIds.some(id=>remaining.has(id)))st.onEdgesChange(edgeIds.filter(id=>remaining.has(id)).map(id=>({id,type:'remove'})));
            return;
          }
        }
      }

      // 选中的是画布节点 / 焦点在矢量画布内时，快捷键交给画布节点处理
      const activeVector = getActiveVectorNode();
      if (activeVector && activeVector === selectedId) return;
      if (isVectorNodeFocus()) return;

      // 全局保存/打开/新建：即使在输入框中也生效
      if (mod && e.key.toLowerCase() === 's') {
        if (document.activeElement?.closest('.dock-code-editor')) return;
        e.preventDefault();
        const state = useProjectStore.getState();
        if (useUiStore.getState().sideTab === 'project' && state.selected && !/\.cnode$/i.test(state.selected.relPath)) { if (state.dirty) void state.saveSelected(); }
        else void saveProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void runProjectAction(newProject);
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void runProjectAction(openProject);
        return;
      }

      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault(); useUiStore.getState().setAppPage('workbench'); useUiStore.getState().setSideTab('project');
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.files-workspace .pm-search input')?.focus(),0);
        return;
      }

      if (isTypingTarget()) return;

      // Ctrl+B：开合右侧侧栏（对齐 VS Code 的习惯）
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        useUiStore.getState().toggleNavigation();
        return;
      }

      if (tab === 'conversation') return;

      const key = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && (key === 'c' || key === 'v')) {
        const canvas = document.querySelector<HTMLElement>('.canvas-wrap');
        const focused = document.activeElement;
        if (!canvas || (focused !== document.body && !canvas.contains(focused)) || window.getSelection()?.isCollapsed === false) return;
        const graph = useGraphStore.getState();
        if (key === 'c') {
          if (!graph.selectedIds.length) return;
          nodeClipboard.current = graph.copyNodes(graph.selectedIds);
        } else {
          const copied = nodeClipboard.current;
          if (!copied?.nodes.length) return;
          const rect = canvas.getBoundingClientRect();
          const mouse = useUiStore.getState().lastMouse;
          const inside = mouse.x >= rect.left && mouse.x < rect.right && mouse.y >= rect.top && mouse.y < rect.bottom;
          const point = screenToFlowPosition(inside ? mouse : {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
          graph.pasteNodes(copied, {
            x: point.x - Math.min(...copied.nodes.map((node) => node.position.x)),
            y: point.y - Math.min(...copied.nodes.map((node) => node.position.y)),
          });
        }
        e.preventDefault();
        return;
      }

      if (e.code === 'KeyA' && e.shiftKey && !mod) {
        e.preventDefault();
        const m = useUiStore.getState().lastMouse;
        useUiStore.getState().openAddMenu(m.x, m.y);
        return;
      }

      if (e.key === 'Home' || (!mod && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        fitView({ padding: 0.2 });
        return;
      }

      // 删除选中节点已在上方（矢量画布让位之前）统一处理

      if (mod && e.key.toLowerCase() === 'j') {
        // Blender 风格：Ctrl+J 把选中的节点“加入”为一个新的范围节点
        e.preventDefault();
        createScopeFromSelection();
      } else if (mod && e.key.toLowerCase() === 'l') {
        // 自动排版属于画布操作，不入撤销历史（撤销只记录节点操作）
        e.preventDefault();
        layoutNodes();
      } else if (mod && e.key.toLowerCase() === 'a' && e.shiftKey) {
        e.preventDefault();
        arrangeNodes();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedId) duplicateNode(selectedId);
      }
    };
    // 用捕获阶段监听：节点内部（如矢量画布面板的按钮 / 输入控件）会在冒泡阶段
    // stopPropagation，一旦焦点落在这些元素上，冒泡阶段的工作台快捷键（含删除）
    // 就会被吞掉 —— 表现就是「选中画布节点后 Delete 没反应」。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [starting, runProjectAction, undo, redo, duplicateNode, selectedId, deleteNodes, fitView, screenToFlowPosition, layoutNodes, arrangeNodes, createScopeFromSelection]);

  const workbenchActive = appPage === 'workbench';
  const hideWorkbenchOverlays = !workbenchActive || filePreview || conversationMain;

  return (
    <>
      {starting && <StartupSplash onFinish={() => setStarting(false)} />}
      <div className={`app ui-clean glass-theme theme-${theme}`} inert={starting}>
        <div className="app-shell">
          <ActivityBar />
          <div className="app-shell-main">
            {projectRoot && <div className="app-workbench-toolbar" hidden={!workbenchActive}><Toolbar /></div>}
            <div className={`app-body side-left${projectRoot && dockOpen && !hideWorkbenchOverlays ? ' has-dock' : ''}`}>
              {appPage === 'plugins' && <PluginWorkspace />}
              {projectRoot && <TaskWorkspace hidden={appPage !== 'tasks'} />}
              <div className="app-workbench-layer" data-inactive={!workbenchActive} aria-hidden={!workbenchActive} inert={!workbenchActive}>
                <div className="app-project-navigation" hidden={filePreview} inert={filePreview}>
                  <ProjectNavigation switching={switchingProject} runProjectAction={runProjectAction} />
                </div>
                <main className={`workspace-main workspace-${sideTab}`} aria-label="工作区">
                  {projectRoot ? (
                    <>
                      <div className="workspace-overview-layer" hidden={!overview}><GoalOverview /></div>
                      <div className="workspace-content" hidden={overview} inert={overview}>
                        {(sideTab === 'project' || filePreview) && <FileWorkspace editing={sideTab === 'project'} />}
                        {sideTab === 'node' && sideOpen && <div className="node-inspector-dock"><SidePanel /></div>}
                        <div className="workspace-canvas" aria-hidden={conversationMain || sideTab === 'project' || filePreview} inert={conversationMain}>
                          <Canvas />
                        </div>
                        <ConversationPanel suspended={filePreview} centered={conversationMain} />
                      </div>
                    </>
                  ) : (
                    <section className="workspace-home" aria-labelledby="workspace-home-title">
                      <div className="workspace-home-content">
                        <img src={welcomeLogo} alt="" width="48" height="48" />
                        <h1 id="workspace-home-title">CodeNode</h1>
                        <p>打开最近的对话，或从一个工程开始。</p>
                        <div className="workspace-home-actions" role="group" aria-label="工程操作">
                          <button type="button" data-project-action="open" disabled={switchingProject} onClick={() => void runProjectAction(openProject)}>打开工程</button>
                          <button type="button" data-project-action="new" disabled={switchingProject} onClick={() => void runProjectAction(newProject)}>新建工程</button>
                          <button type="button" data-project-action="file" disabled={switchingProject} onClick={() => void runProjectAction(openProjectFile)}>打开工程文件</button>
                        </div>
                        <div className="workspace-home-feedback" role="status">{switchingProject ? '正在打开工程…' : ''}</div>
                      </div>
                    </section>
                  )}
                </main>
                {projectRoot && <div className="app-workbench-overlays" hidden={hideWorkbenchOverlays}>
                  <AddMenu />
                  <WorkbenchDock />
                </div>}
              </div>
            </div>
            {projectRoot && <div className="app-workbench-status" hidden={!workbenchActive}><StatusBar /></div>}
          </div>
        </div>
        {projectActionError && <div className="workspace-project-error" role="alert">
          <span>{projectActionError}</span>
          <button type="button" aria-label="关闭工程提示" onClick={() => setProjectActionError('')}>×</button>
        </div>}
        <ToolDialog />
        <GoalAutoAdvanceManager />
        <GlobalSettings />
        <ModelManager />
      </div>
    </>
  );
}
