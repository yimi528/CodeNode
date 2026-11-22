import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { useCheckpointStore, type Checkpoint } from '../store/checkpointStore';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { loadRecentProjects, rememberRecentProject, sameRecentProject } from './recentProjects';
import { readWorkspaceLocation } from './workspaceHistory';
import type { Graph, SessionCanvas, SessionDoc, SessionMsg } from '../types';

const LAST_ROOT_KEY = 'codenode.lastProjectRoot';
const LAST_FILE_KEY = 'codenode.lastProjectFile';

interface SessionPayload {
  messages?: SessionMsg[];
  memoryConversationId?: string;
  archived?: boolean;
  id?: string;
  label?: string;
  prompt?: string;
  status?: string;
  createdAt?: number;
  nodeCount?: number;
  summary?: string;
  root?: { nodes?: unknown[]; edges?: unknown[] };
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

function nameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function buildPayload() {
  const ss = useSessionStore.getState();
  const active = ss.current();
  const liveGraph=useGraphStore.getState().getDocument();
  const sessions = ss.order
    .map((id) => ss.sessions[id])
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      label: s.label,
      prompt: s.prompt,
      status: s.status,
      createdAt: s.createdAt,
      nodeCount: s.id===ss.activeId?liveGraph.nodes.length:s.nodeCount,
      archived: !!s.archived,
      messages: s.id===ss.activeId?ss.messages:s.messages,
      memoryConversationId: s.memoryConversationId,
      summary: s.summary || '',
      root: s.id===ss.activeId?liveGraph:s.doc.root,
    }));
  return {
    graph: active ? liveGraph : { nodes: [], edges: [] },
    canvases: {
      sessions,
      messages: ss.messages,
      memoryConversationId: ss.memoryConversationId,
      memoryTaskEpoch: ss.memoryTaskEpoch,
    },
    workspace: { viewport: useUiStore.getState().viewport },
    manifest: useProjectStore.getState().doc,
    checkpoints: useCheckpointStore.getState().items,
  };
}

async function fetchSoul(root: string | null): Promise<{ raw: string; greeting: string }> {
  try {
    const api = window.codenode;
    if (!api) return { raw: '', greeting: '' };
    const cfg = await api.agentConfig(root);
    const raw = cfg?.soul?.raw || '';
    const greeting = cfg?.soul?.greeting || '';
    return { raw, greeting };
  } catch {
    return { raw: '', greeting: '' };
  }
}

function applyLoaded(
  _root: string,
  data?: {
    graph?: { nodes?: unknown[]; edges?: unknown[] };
    canvases?: {
      sessions?: unknown[];
      messages?: unknown[];
      memoryConversationId?: string;
      memoryTaskEpoch?: number;
    };
    workspace?: { viewport?: { x: number; y: number; zoom: number } };
    manifest?: { documentId?: string; createdAt?: string; name?: string };
    checkpoints?: unknown[];
  },
  sessionId?: string,
): void {
  useProjectStore.getState().setDoc(data?.manifest || {});
  useCheckpointStore.getState().setProjectRoot(_root, (data?.checkpoints || []) as Checkpoint[]);
  if (data?.workspace?.viewport) {
    useUiStore.getState().setPendingViewport(data.workspace.viewport);
  }

  const sessData = data?.canvases?.sessions as SessionPayload[] | undefined;
  const messages = data?.canvases?.messages as SessionMsg[] | undefined;
  const memoryConversationId = data?.canvases?.memoryConversationId ||
    (data?.manifest?.documentId ? 'memory-' + data.manifest.documentId : undefined);
  const memoryTaskEpoch = data?.canvases?.memoryTaskEpoch;
  const ss = useSessionStore.getState();

  if (sessData && sessData.length) {
    const list: SessionCanvas[] = sessData.map((sd) => ({
      id: sd.id || 'canvas-' + Math.random().toString(36).slice(2, 8),
      label: sd.label || '画布',
      prompt: sd.prompt || '',
      status: sd.status === 'active' || sd.status === 'completed' ? (sd.status as 'active' | 'completed') : 'active',
      createdAt: sd.createdAt || Date.now(),
      nodeCount: sd.nodeCount || 0,
      archived: !!sd.archived,
      messages: sd.messages,
      memoryConversationId: sd.memoryConversationId,
      summary: sd.summary || '',
      doc: {
        root: { nodes: (sd.root?.nodes as never[]) || [], edges: (sd.root?.edges as never[]) || [] } as Graph,
      } as SessionDoc,
    }));
    const selected = sessionId ? list.find(session => session.id === sessionId) : undefined;
    ss.restoreSessions(list, selected ? [] : messages || [], sessionId, selected?.memoryConversationId || memoryConversationId, memoryTaskEpoch);
  } else {
    // 旧版单画布：把加载到的图作为首个会话（忽略其中的组节点与组图）
    const doc: SessionDoc = {
      root: {
        nodes: ((data?.graph?.nodes as never[]) || []).filter((n) => {
          const t = (n as { type?: string } | null)?.type;
          return t !== 'group' && t !== 'group-input' && t !== 'group-output';
        }) as never[],
        edges: ((data?.graph?.edges as never[]) || []) as never[],
      },
    };
    useSessionStore.setState({ sessions: {}, order: [], activeId: null, streaming: false, progress: null });
    void fetchSoul(_root).then(({ raw, greeting }) => {
      const ss2 = useSessionStore.getState();
      if (ss2.order.length) return;
      ss2.restoreSessions(
        [
          {
            id: 'canvas-' + Math.random().toString(36).slice(2, 8),
            label: '画布1',
            prompt: raw,
            status: 'completed',
            createdAt: Date.now(),
            nodeCount: doc.root.nodes.length,
            doc,
          } as SessionCanvas,
        ],
        greeting ? [{ role: 'assistant', content: greeting, status: 'done' } as SessionMsg] : [],
        undefined,
        memoryConversationId,
        memoryTaskEpoch
      );
    });
  }
}

export async function newProject(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  useProjectStore.setState({ error: null });
  let res;
  try {
    res = await api.createProject();
  } catch (e) {
    const message = '新建工程失败：' + String(e);
    useProjectStore.setState({ error: message });
    useUiStore.getState().setToast(message);
    return;
  }
  if (!res.ok || !res.filePath) {
    if (res.error) {
      const message = '新建工程失败：' + res.error;
      useProjectStore.setState({ error: message });
      useUiStore.getState().setToast(message);
    }
    return;
  }
  const root = res.root || dirOf(res.filePath);
  localStorage.setItem(LAST_ROOT_KEY, root);
  localStorage.setItem(LAST_FILE_KEY, res.filePath);
  rememberRecentProject({ root, file: res.filePath });
  await useProjectStore.getState().loadRoot(root);
  useCheckpointStore.getState().setProjectRoot(root, []);
  useProjectStore.getState().setProjectFile(res.filePath);
  useProjectStore.getState().setDoc({});
  useGraphStore.getState().clear();
  const { raw, greeting } = await fetchSoul(root);
  useSessionStore.getState().initProject(greeting || raw, raw);
  useUiStore.getState().showCanvas();
  useUiStore.getState().setToast('已新建项目：' + nameOf(res.filePath));
}

export async function openProject(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const res = await api.chooseProject();
  if (!res.ok || !res.root) return;
  localStorage.setItem(LAST_ROOT_KEY, res.root);
  localStorage.removeItem(LAST_FILE_KEY);
  await useProjectStore.getState().loadRoot(res.root);
  useCheckpointStore.getState().setProjectRoot(res.root);
  const lr = await api.loadProject(res.root);
  if (lr.ok && lr.data && lr.filePath) {
    localStorage.setItem(LAST_FILE_KEY, lr.filePath);
    rememberRecentProject({ root: res.root, file: lr.filePath });
    useProjectStore.getState().setProjectFile(lr.filePath);
    applyLoaded(res.root, lr.data);
    const warn = lr.data.warnings?.length ? '（' + lr.data.warnings.join('；') + '）' : '';
    useUiStore.getState().setToast('已打开项目：' + nameOf(lr.filePath) + warn);
  } else {
    rememberRecentProject({ root: res.root });
    useGraphStore.getState().clear();
    const { raw, greeting } = await fetchSoul(res.root);
    useSessionStore.getState().initProject(greeting || raw, raw);
    useUiStore.getState().setToast('已打开项目目录（无 .cnode 工程文件）：' + res.root);
  }
  useUiStore.getState().showCanvas();
}

export async function openProjectFile(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  useProjectStore.setState({ error: null });
  let res;
  try {
    res = await api.openGraph();
  } catch (e) {
    const message = '打开工程文件失败：' + String(e);
    useProjectStore.setState({ error: message });
    useUiStore.getState().setToast(message);
    return;
  }
  if (res.error) {
    const message = '打开工程文件失败：' + res.error;
    useProjectStore.setState({ error: message });
    useUiStore.getState().setToast(message);
    return;
  }
  if (!res.ok || !res.filePath) return;
  const root = dirOf(res.filePath);
  localStorage.setItem(LAST_ROOT_KEY, root);
  localStorage.setItem(LAST_FILE_KEY, res.filePath);
  rememberRecentProject({ root, file: res.filePath });
  await useProjectStore.getState().loadRoot(root);
  useCheckpointStore.getState().setProjectRoot(root);
  useProjectStore.getState().setProjectFile(res.filePath);
  if (res.data) applyLoaded(root, res.data);
  useUiStore.getState().showCanvas();
  const warn = res.data?.warnings?.length ? '（' + res.data.warnings.join('；') + '）' : '';
  useUiStore.getState().setToast('已打开工程文件：' + res.filePath + warn);
}

export function captureProjectSnapshot() {
  const project=useProjectStore.getState();
  const fingerprint=JSON.stringify(buildPayload());
  const payload=JSON.parse(fingerprint) as ReturnType<typeof buildPayload>;
  return {root:project.root,file:project.projectFile,target:project.projectFile||project.root,key:project.root+'|'+project.projectFile,activeId:useSessionStore.getState().activeId,payload,fingerprint};
}
export type ProjectSnapshot=ReturnType<typeof captureProjectSnapshot>;

export function updateSnapshotSession(snapshot: ProjectSnapshot, session: SessionCanvas, messages: SessionMsg[]): ProjectSnapshot {
  const active = snapshot.activeId === session.id;
  const payload = {
    ...snapshot.payload,
    graph: active ? session.doc.root : snapshot.payload.graph,
    canvases: {
      ...snapshot.payload.canvases,
      messages: active ? messages : snapshot.payload.canvases.messages,
      sessions: snapshot.payload.canvases.sessions.map(saved => saved.id === session.id ? {
        ...saved, messages, summary: session.summary || '', root: session.doc.root, nodeCount: session.nodeCount, status: session.status,
      } : saved),
    },
  };
  return { ...snapshot, payload, fingerprint: JSON.stringify(payload) };
}
const saveQueues=new Map<string,Promise<boolean>>();
export function persistProjectSnapshot(snapshot:ProjectSnapshot,automatic=false):Promise<boolean> {
  const previous=saveQueues.get(snapshot.key)||Promise.resolve(true);
  const run=previous.catch(()=>false).then(async()=>{
    const store=useProjectSaveStore;
    const current=()=>snapshot.key===useProjectStore.getState().root+'|'+useProjectStore.getState().projectFile;
    if(automatic&&current()&&captureProjectSnapshot().fingerprint!==snapshot.fingerprint)return false;
    if(current()) store.setState({key:snapshot.key,status:'saving',error:''});
    try {
      const api=window.codenode;if(!api)throw Error('需要 Electron 环境');
      if(automatic&&!snapshot.file) return false;
      const result=snapshot.target?await api.saveProject(snapshot.target,snapshot.payload):await api.saveGraph(snapshot.payload);
      if(!result.ok||!result.filePath)throw Error(result.error||'已取消保存');
      if(current()) {
        if(snapshot.file!==result.filePath)useProjectStore.getState().setProjectFile(result.filePath);
        try {localStorage.setItem(LAST_FILE_KEY,result.filePath);localStorage.setItem(LAST_ROOT_KEY,dirOf(result.filePath));rememberRecentProject({root:dirOf(result.filePath),file:result.filePath});}catch{}
        if(!snapshot.target) await useProjectStore.getState().loadRoot(dirOf(result.filePath));
        const latest=captureProjectSnapshot();
        store.setState({key:latest.key,savedFingerprint:snapshot.fingerprint,status:latest.fingerprint===snapshot.fingerprint?'saved':'dirty',error:''});
        if(!automatic)useUiStore.getState().setToast('项目已保存');
      }
      return true;
    }catch(error) {
      if(current()) {
        const message=error instanceof Error?error.message:String(error);
        store.setState({key:snapshot.key,status:'error',error:message});
        if(!automatic)useUiStore.getState().setToast('保存失败：'+message);
      }
      return false;
    }
  });
  saveQueues.set(snapshot.key,run);
  void run.finally(()=>{if(saveQueues.get(snapshot.key)===run)saveQueues.delete(snapshot.key)});
  return run;
}
export async function saveProject():Promise<boolean> {
  try{return await persistProjectSnapshot(captureProjectSnapshot());}
  catch(error){useProjectSaveStore.setState({status:'error',error:String(error)});useUiStore.getState().setToast('保存失败：'+String(error));return false;}
}

/** 恢复上次离开时的工程、会话和工作区。 */
export async function restoreLastWorkspace(): Promise<void> {
  try {
    if (!window.codenode) return;
    const location = readWorkspaceLocation();
    const recent = await loadRecentProjects();
    const entry = location ? location.project : recent[0];
    if (entry) {
      await openRecentProject(entry, location?.sessionId, true);
      const project = useProjectStore.getState();
      if (!sameRecentProject({ root: project.root || '', file: project.projectFile || undefined }, entry)) {
        useUiStore.getState().showCanvas();
        return;
      }
      if (location?.newCanvas) useSessionStore.getState().newConversation();
    }
    if (location) {
      const ui = useUiStore.getState();
      ui.updatePreferences({ workbenchView: location.overview ? 'overview' : 'conversation' });
      useUiStore.setState({
        appPage: !entry && location.page === 'tasks' ? 'workbench' : location.page,
        pluginView: location.pluginView,
        sideTab: entry ? location.tab : 'agent',
        sideOpen: !!entry && location.tab === 'node',
        filePreviewLocation: entry ? location.preview || null : null,
      });
      if (entry && location.tab === 'project' && location.editorFile) {
        try { await useProjectStore.getState().openFile(location.editorFile); }
        catch { ui.setToast('上次编辑的文件已无法打开'); }
      }
    } else if (entry) {
      useUiStore.getState().showCanvas();
    }
  } catch (error) {
    useProjectStore.setState({ root: null, projectFile: null, tree: [], error: null });
    useSessionStore.getState().reset();
    useGraphStore.getState().clear();
    useUiStore.getState().showCanvas();
    throw error;
  } finally {
    useUiStore.getState().setBooted(true);
  }
}

/**
 * 打开一条「最近打开」记录：优先加载 .cnode 文件，只有目录时按目录打开。
 */
export async function openRecentProject(entry: { root: string; file?: string; name?: string }, sessionId?: string, restoring = false, parked?: () => ProjectSnapshot | undefined): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const target = entry.file || entry.root;
  if (!target) return;

  const inMemory = parked?.();
  const requested = sessionId && !inMemory ? await api.loadProject(target) : undefined;
  const savedSessions = (inMemory?.payload.canvases.sessions || requested?.data?.canvases?.sessions) as SessionPayload[] | undefined;
  if (sessionId && ((!inMemory && !requested?.ok) || !Array.isArray(savedSessions) ||
    !savedSessions.some(session => session?.id === sessionId && !session.archived))) {
    if (!restoring) throw Error('找不到这条对话，请重新展开项目。');
    sessionId = undefined;
  }

  const root = entry.file ? dirOf(entry.file) : entry.root;
  await useProjectStore.getState().loadRoot(root);
  const st = useProjectStore.getState();
  if (restoring && st.error) throw Error('无法恢复上次打开的工程：' + st.error);
  if (!st.root) {
    useUiStore.getState().setToast('打开失败：' + (st.error || '目录不可用'));
    return;
  }

  const latest = parked?.();
  if (latest) {
    useProjectStore.getState().setProjectFile(latest.file);
    applyLoaded(root, latest.payload, sessionId);
    return;
  }

  if (entry.file || requested) {
    const lr = requested || await api.loadProject(target);
    if (lr.ok && lr.data) {
      const loadedFile = lr.filePath || target;
      useProjectStore.getState().setProjectFile(loadedFile);
      useCheckpointStore.getState().setProjectRoot(root);
      applyLoaded(root, lr.data, sessionId);
      rememberRecentProject({ root, file: loadedFile, name: entry.name });
      useUiStore.getState().setToast('已打开最近工程：' + nameOf(loadedFile));
      return;
    }
    useUiStore.getState().setToast('该工程文件已不可用，已按目录打开：' + (lr.error || ''));
  }

  const lr2 = await api.loadProject(root);
  if (lr2.ok && lr2.data && lr2.filePath) {
    useProjectStore.getState().setProjectFile(lr2.filePath);
    useCheckpointStore.getState().setProjectRoot(root);
    applyLoaded(root, lr2.data);
    rememberRecentProject({ root, file: lr2.filePath });
    useUiStore.getState().setToast('已打开最近工程：' + nameOf(lr2.filePath));
    return;
  }
  useGraphStore.getState().clear();
  const { raw, greeting } = await fetchSoul(root);
  useSessionStore.getState().initProject(greeting || raw, raw);
  useCheckpointStore.getState().setProjectRoot(root, []);
  rememberRecentProject({ root });
  useUiStore.getState().setToast('已打开最近工程目录（无 .cnode 工程文件）：' + root);
}
