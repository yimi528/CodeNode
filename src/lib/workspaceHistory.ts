import { useEffect, type RefObject } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore, type SideTab } from '../store/uiStore';

export const LAST_WORKSPACE_KEY = 'codenode.lastWorkspace';

type WorkspaceLocation = {
  project: { root: string; file?: string } | null;
  sessionId?: string;
  newCanvas?: boolean;
  page: 'workbench' | 'plugins' | 'tasks';
  pluginView: 'plugins' | 'skills';
  tab: SideTab;
  overview: boolean;
  preview?: { root: string; relPath: string | null };
  editorFile?: string;
};

export function readWorkspaceLocation(): WorkspaceLocation | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_WORKSPACE_KEY) || 'null');
    if (!value || typeof value !== 'object') return null;
    const { project, preview } = value;
    return {
      project: typeof project?.root === 'string' && project.root
        ? { root: project.root, file: typeof project.file === 'string' ? project.file : undefined }
        : null,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      newCanvas: value.newCanvas === true,
      page: value.page === 'plugins' || value.page === 'tasks' ? value.page : 'workbench',
      pluginView: value.pluginView === 'skills' ? 'skills' : 'plugins',
      tab: ['agent', 'conversation', 'node', 'project', 'preview'].includes(value.tab) ? value.tab : 'agent',
      overview: value.overview === true,
      preview: typeof preview?.root === 'string' && preview.root
        ? { root: preview.root, relPath: typeof preview.relPath === 'string' ? preview.relPath : null }
        : undefined,
      editorFile: typeof value.editorFile === 'string' ? value.editorFile : undefined,
    };
  } catch { return null; }
}

export function useWorkspaceHistory(switching: boolean, pending: RefObject<boolean>) {
  useEffect(() => {
    if (switching) return;
    let previous = '';
    const record = () => {
      const project = useProjectStore.getState();
      const session = useSessionStore.getState();
      const ui = useUiStore.getState();
      if (pending.current || !ui.booted || project.loading) return;
      const location: WorkspaceLocation = {
        project: project.root ? { root: project.root, file: project.projectFile || undefined } : null,
        sessionId: project.root ? session.activeId || undefined : undefined,
        newCanvas: !!project.root && session.newConversationPending,
        page: ui.appPage,
        pluginView: ui.pluginView,
        tab: ui.sideTab,
        overview: ui.preferences.workbenchView === 'overview',
        preview: project.root ? ui.filePreviewLocation || undefined : undefined,
        editorFile: project.selected?.relPath,
      };
      const serialized = JSON.stringify(location);
      if (serialized === previous) return;
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, serialized);
        previous = serialized;
      } catch {}
    };
    const subscriptions = [
      useProjectStore.subscribe(record),
      useUiStore.subscribe(record),
      useSessionStore.subscribe((next, old) => {
        if (next.activeId !== old.activeId || next.newConversationPending !== old.newConversationPending) record();
      }),
    ];
    record();
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [switching, pending]);
}
