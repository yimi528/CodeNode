import { buildTree, useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { useCheckpointStore, type Checkpoint } from '../store/checkpointStore';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { loadRecentProjects, recentPathKey, rememberRecentProject, sameRecentProject } from './recentProjects';
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
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (separator < 0) return '';
  if (separator === 0 || /^[a-z]:$/i.test(filePath.slice(0, separator))) return filePath.slice(0, separator + 1);
  return filePath.slice(0, separator);
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
    const projectFile = useProjectStore.getState().projectFile;
    void fetchSoul(_root).then(({ raw, greeting }) => {
      const current = useProjectStore.getState();
      if (current.root !== _root || current.projectFile !== projectFile) return;
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

let switchingProject = false;

function isSessionRunning(): boolean {
  if (!useSessionStore.getState().streaming) return false;
  useUiStore.getState().setToast('Agent 正在运行，请先停止或等待完成后切换项目');
  return true;
}

async function runProjectSwitch(action: () => Promise<boolean>): Promise<boolean> {
  if (switchingProject || isSessionRunning()) return false;
  switchingProject = true;
  try {
    return await action();
  } catch (error) {
    useUiStore.getState().setToast(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    switchingProject = false;
  }
}

type ConfirmedDraft = Pick<ReturnType<typeof useProjectStore.getState>, 'selected' | 'draft'>;

async function canLeaveProject(confirmedDraft?: ConfirmedDraft): Promise<boolean> {
  if (isSessionRunning()) return false;
  const project = useProjectStore.getState();
  const alreadyConfirmed = confirmedDraft?.selected === project.selected && confirmedDraft?.draft === project.draft;
  if (project.dirty && !alreadyConfirmed && !window.confirm('当前文件有未保存修改，是否放弃修改并切换项目？')) return false;
  if (!project.root) return true;
  const snapshot = captureProjectSnapshot();
  const saved = useProjectSaveStore.getState();
  if (!project.projectFile || saved.key !== snapshot.key || saved.savedFingerprint !== snapshot.fingerprint || saved.status === 'saving' || saved.status === 'error') {
    if (!await saveProject()) throw Error('当前项目未能保存，无法切换项目。');
  }
  const latest = useProjectStore.getState();
  if (latest.dirty && (latest.selected !== project.selected || latest.draft !== project.draft)) {
    throw Error('切换期间文件又有修改，请重新确认后再切换。');
  }
  const latestSnapshot = captureProjectSnapshot();
  if (useProjectSaveStore.getState().savedFingerprint !== latestSnapshot.fingerprint) {
    throw Error('切换期间项目又有修改，请重新切换。');
  }
  return !isSessionRunning();
}

type LoadedProject = Parameters<typeof applyLoaded>[1];

async function enterProject(root: string, file: string | null, data?: LoadedProject, sessionId?: string, confirmedDraft?: ConfirmedDraft): Promise<boolean> {
  const api = window.codenode;
  if (!api) return false;

  const current = useProjectStore.getState();
  if (sameRecentProject({ root, file: file || undefined }, { root: current.root || '', file: current.projectFile || undefined })) {
    if (sessionId) useSessionStore.getState().switchSession(sessionId);
    return true;
  }

  const [listing, soul] = await Promise.all([api.listProject(root), data ? null : fetchSoul(root)]);
  if (!listing.ok || !listing.files) throw Error('无法打开项目目录：' + (listing.error || root));
  if (!await canLeaveProject(confirmedDraft)) return false;

  void useProjectStore.getState().loadRoot(root, file, buildTree(listing.files));
  if (data) {
    applyLoaded(root, data, sessionId);
  } else {
    useProjectStore.getState().setDoc({});
    useCheckpointStore.getState().setProjectRoot(root, []);
    useGraphStore.getState().clear();
    useSessionStore.getState().initProject(soul?.greeting || soul?.raw || '', soul?.raw || '');
  }

  localStorage.setItem(LAST_ROOT_KEY, root);
  if (file) localStorage.setItem(LAST_FILE_KEY, file);
  else localStorage.removeItem(LAST_FILE_KEY);
  rememberRecentProject({ root, file });
  return true;
}

export function newProject(): Promise<boolean> {
  return runProjectSwitch(async () => {
    const api = window.codenode;
    const draft = useProjectStore.getState();
    if (!api || !await canLeaveProject()) return false;
    const result = await api.createProject(useProjectStore.getState().projectFile || undefined);
    if (!result.ok || !result.filePath) {
      if (result.error) throw Error('新建工程失败：' + result.error);
      return false;
    }
    if (!await enterProject(result.root || dirOf(result.filePath), result.filePath, undefined, undefined, draft.dirty ? draft : undefined)) return false;
    useUiStore.getState().setToast('已新建项目：' + nameOf(result.filePath));
    return true;
  });
}

export function openProject(): Promise<boolean> {
  return runProjectSwitch(async () => {
    const api = window.codenode;
    if (!api) return false;
    const selected = await api.chooseProject();
    if (!selected.ok || !selected.root) return false;
    const root = selected.root;
    const loaded = await api.loadProject(root);
    if (!await enterProject(root, loaded.filePath || null, loaded.data)) return false;
    const warn = loaded.data?.warnings?.length ? '（' + loaded.data.warnings.join('；') + '）' : '';
    useUiStore.getState().setToast(loaded.filePath ? '已打开项目：' + nameOf(loaded.filePath) + warn : '已打开项目目录：' + root);
    return true;
  });
}

export function openProjectFile(): Promise<boolean> {
  return runProjectSwitch(async () => {
    const api = window.codenode;
    if (!api) return false;
    const result = await api.openGraph();
    if (result.error) {
      const message = '打开工程文件失败：' + result.error;
      useProjectStore.setState({ error: message });
      throw Error(message);
    }
    if (!result.ok || !result.filePath) return false;
    if (!await enterProject(dirOf(result.filePath), result.filePath, result.data)) return false;
    const warn = result.data?.warnings?.length ? '（' + result.data.warnings.join('；') + '）' : '';
    useUiStore.getState().setToast('已打开工程文件：' + result.filePath + warn);
    return true;
  });
}

export function captureProjectSnapshot() {
  const project=useProjectStore.getState();
  const fingerprint=JSON.stringify(buildPayload());
  const payload=JSON.parse(fingerprint) as ReturnType<typeof buildPayload>;
  return {root:project.root,file:project.projectFile,target:project.projectFile||project.root,key:project.root+'|'+project.projectFile,payload,fingerprint};
}
export type ProjectSnapshot=ReturnType<typeof captureProjectSnapshot>;
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

/**
 * 启动时恢复上次打开的工程。
 *
 * 需求变更：不再自动进入最近打开的工程，而是停在门禁页，
 * 由用户在「最近打开」列表里自己选择（见 ProjectGate）。
 * 这里只负责结束启动引导（置 booted），让门禁页接管。
 */
export async function restoreLastProject(): Promise<void> {
  try {
    if (!window.codenode) return;
    // 兼容旧版本：把单条"上次打开"迁移进最近列表（只做迁移，不自动打开）
    await loadRecentProjects();
  } catch (e) {
    console.error('[CodeNode] 读取最近工程失败:', e);
  } finally {
    useUiStore.getState().setBooted(true);
  }
}

/**
 * 打开一条「最近打开」记录：优先加载 .cnode 文件，只有目录时按目录打开。
 */
export function openRecentProject(entry: { root: string; file?: string; name?: string }, sessionId?: string): Promise<boolean> {
  return runProjectSwitch(async () => {
    const api = window.codenode;
    const target = entry.file || entry.root;
    if (!api || !target) return false;
    const loaded = await api.loadProject(target);
    if (entry.file && (!loaded.ok || !loaded.data || recentPathKey(loaded.filePath) !== recentPathKey(entry.file))) {
      throw Error('无法打开工程：' + (loaded.error || entry.file));
    }
    const sessions = loaded.data?.canvases?.sessions as SessionPayload[] | undefined;
    if (sessionId && (!Array.isArray(sessions) || !sessions.some(session => session?.id === sessionId && !session.archived))) {
      throw Error('找不到这条对话，请重新展开项目。');
    }
    const file = loaded.filePath || null;
    if (!await enterProject(entry.file ? dirOf(entry.file) : entry.root, file, loaded.data, sessionId)) return false;
    useUiStore.getState().setToast(file ? '已打开最近工程：' + nameOf(file) : '已打开最近工程目录：' + entry.root);
    return true;
  });
}
