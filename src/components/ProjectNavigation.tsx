import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { newProject, openProject, openProjectFile, openRecentProject, saveProject } from '../lib/projectActions';
import { readRecentProjects, projectNameOf, forgetRecentProject, recentPathKey, sameRecentProject, type RecentProject } from '../lib/recentProjects';
import { conversationTitle, firstTitleMessage } from '../lib/conversationTitle';
import type { SessionMsg } from '../types';

type ProjectEntry = Pick<RecentProject, 'root' | 'file' | 'name'>;
type SessionEntry = { id: string; label?: string; messages?: SessionMsg[]; archived?: boolean };

function ProjectSessions({ target, liveSessions, activeId, busy, onSelect, onArchive, onOpenProject }: {
  target: string;
  liveSessions: SessionEntry[] | null;
  activeId?: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
  onOpenProject?: () => void;
}) {
  const current = liveSessions !== null;
  const [saved, setSaved] = useState<SessionEntry[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (current) return;
    let alive = true;
    setSaved(null);
    const api = window.codenode;
    if (!api) { setSaved([]); return; }
    void api.loadProject(target).then(result => {
      const sessions = result.data?.canvases?.sessions as SessionEntry[] | undefined;
      if (alive) setSaved(result.ok && Array.isArray(sessions)
        ? sessions.filter(session => typeof session?.id === 'string' && !session.archived)
          .map(({ id, label, messages }) => ({ id, label: conversationTitle(label, firstTitleMessage(messages)) }))
        : []);
    }).catch(() => { if (alive) setSaved([]); });
    return () => { alive = false; };
  }, [target, current]);

  const entries = (liveSessions ?? saved)?.filter(session => typeof session?.id === 'string' && !session.archived);
  const latest = entries?.slice(-4).reverse();
  const active = entries?.find(session => session.id === activeId);
  if (latest && active && !latest.includes(active)) latest.push(active);
  const visible = showAll ? entries?.slice().reverse() : latest;
  return <div className="project-nav-sessions">
    {!entries?.length && <div className="project-nav-empty">
      <span>{entries ? '暂无已保存的对话' : '正在读取对话…'}</span>
      {entries && onOpenProject && <button type="button" className="project-nav-open" disabled={busy} onClick={onOpenProject}>打开工程</button>}
    </div>}
    {visible?.map(session => {
      const label = session.label || '未命名对话';
      return <div key={session.id} className="project-session-row">
        <button className={session.id === activeId ? 'active' : ''} disabled={busy} aria-current={session.id === activeId ? 'page' : undefined} onClick={() => onSelect(session.id)} title={label}>{label}</button>
        {onArchive && <button className="session-archive" aria-label={`归档 ${session.label || label}`} title="归档聊天" disabled={busy} onClick={() => onArchive(session.id)}>▣</button>}
      </div>;
    })}
    {entries && latest && entries.length > latest.length && <button
      type="button"
      className="project-nav-more"
      aria-expanded={showAll}
      onClick={() => setShowAll(value => !value)}
    >{showAll ? '收起对话' : '展开更多对话'}</button>}
  </div>;
}

function showConversation() {
  const ui = useUiStore.getState();
  ui.updatePreferences({ workbenchView: 'conversation' });
  ui.setSideTab('conversation');
  useUiStore.setState({ conversationOpen: true, conversationAutoHidden: false, ...(window.innerWidth <= 600 ? { navigationOpen: false } : {}) });
}

function startCanvas() {
  useSessionStore.getState().newConversation();
  useUiStore.getState().showCanvas();
  if (window.innerWidth <= 600) useUiStore.setState({ navigationOpen: false });
  void saveProject();
}

/** Project/session navigation is independent of the conversation/inspector. */
export default function ProjectNavigation({ switching, runProjectAction }: {
  switching: boolean;
  runProjectAction: (action: () => Promise<void>) => Promise<boolean>;
}) {
  const root = useProjectStore(s => s.root);
  const file = useProjectStore(s => s.projectFile);
  const sessions = useSessionStore(s => s.sessions);
  const streaming = useSessionStore(s => s.streaming);
  const order = useSessionStore(s => s.order);
  const activeId = useSessionStore(s => s.activeId);
  const open = useUiStore(s => s.navigationOpen);
  const recentReady = useUiStore(s => s.booted);
  const width = useUiStore(s => s.navigationWidth);
  const setWidth = useUiStore(s => s.setNavigationWidth);
  const panel = useRef<HTMLElement>(null);
  const resizeCleanup = useRef<() => void>(() => {});
  useEffect(() => () => resizeCleanup.current(), []);
  const startResize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); resizeCleanup.current();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try { if (pointerId) handle.setPointerCapture(pointerId); } catch {}
    const left = panel.current?.getBoundingClientRect().left || 0;
    const move = (pointer: PointerEvent) => setWidth(pointer.clientX - left);
    const finish = () => { document.body.classList.remove('is-resizing-side'); try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch {} window.removeEventListener('blur',finish); window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',finish); window.removeEventListener('pointercancel',finish); };
    resizeCleanup.current = finish; document.body.classList.add('is-resizing-side');
    window.addEventListener('blur',finish); window.addEventListener('pointermove',move); window.addEventListener('pointerup',finish); window.addEventListener('pointercancel',finish);
  };
  const [revision, refresh] = useState(0);
  const [projectOrder, setProjectOrder] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem('codenode.projectOrder') || '[]'); return Array.isArray(value) ? value.filter(key => typeof key === 'string') : []; } catch { return []; } });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, { name?: string; pinned?: boolean; hidden?: boolean }>>(() => { try { return JSON.parse(localStorage.getItem('codenode.projectNavigation') || '{}'); } catch { return {}; } });
  const changeMeta = (key: string, patch: { name?: string; pinned?: boolean; hidden?: boolean }) => setMeta(current => { const next = { ...current, [key]: { ...current[key], ...patch } }; localStorage.setItem('codenode.projectNavigation', JSON.stringify(next)); return next; });
  useEffect(() => {
    const dismiss = (event: Event) => document.querySelectorAll<HTMLDetailsElement>('.project-actions[open], .project-row-menu[open]').forEach(menu => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) menu.open = false; });
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, []);
  const act = async (operation: () => Promise<void>) => {
    if (!await runProjectAction(operation)) return;
    const state = useProjectStore.getState();
    const key = state.projectFile || state.root;
    if (key) changeMeta(key, { hidden: false });
  };
  const openOtherProject = async (project: ProjectEntry, sessionId?: string) => {
    const projectState = useProjectStore.getState();
    if (projectState.dirty && !window.confirm('当前文件有未保存修改，是否放弃修改并切换项目？')) return false;
    const saveState = useProjectSaveStore.getState();
    if (projectState.projectFile && ['dirty', 'saving', 'error'].includes(saveState.status) && !await saveProject()) {
      throw Error('当前项目未能保存，无法切换项目。');
    }
    if (useSessionStore.getState().streaming) return false;
    await openRecentProject(project, sessionId);
    const opened = useProjectStore.getState();
    if (!project.file) return recentPathKey(opened.root || '') === recentPathKey(project.root);
    return sameRecentProject({ root: opened.root || '', file: opened.projectFile || undefined }, project);
  };

  const currentProject = { root: root || '', file: file || undefined };
  const isCurrent = (project: ProjectEntry) => !!root && sameRecentProject(project, currentProject);
  const recent = readRecentProjects();
  const projects = [
    ...(root ? [{ ...currentProject, name: projectNameOf(file || root) }] : []),
    ...recent.filter(item => !isCurrent(item)),
  ].filter(item => !meta[item.file || item.root]?.hidden);
  const candidateKeys = projects.map(item => recentPathKey(item.file || item.root));
  const candidateSignature = JSON.stringify(candidateKeys);
  useEffect(() => {
    const candidates: string[] = JSON.parse(candidateSignature);
    setProjectOrder(previous => {
      const next = [...previous, ...candidates.filter(key => !previous.includes(key))];
      localStorage.setItem('codenode.projectOrder', JSON.stringify(next));
      return next.length === previous.length ? previous : next;
    });
  }, [candidateSignature]);
  const rank = (project: ProjectEntry) => {
    const key = recentPathKey(project.file || project.root);
    const index = projectOrder.indexOf(key);
    const legacy = projectOrder.indexOf(recentPathKey(project.root));
    return Math.min(index >= 0 ? index : projectOrder.length + candidateKeys.indexOf(key), legacy >= 0 ? legacy : Infinity);
  };
  projects.sort((a,b) => Number(!!meta[b.file || b.root]?.pinned)-Number(!!meta[a.file || a.root]?.pinned) || rank(a)-rank(b));
  const busy = streaming || switching;
  void revision;
  if (!open) return null;
  return <aside ref={panel} className="project-navigation" aria-label="项目与会话" style={{'--navigation-width':width+'px'} as CSSProperties}>
    <div className="navigation-resize" role="separator" aria-label="调整项目栏宽度" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={width} tabIndex={0} onPointerDown={startResize} onDoubleClick={()=>setWidth(216)} onKeyDown={event => { if(event.key==='ArrowLeft'||event.key==='ArrowRight') { event.preventDefault(); setWidth(width+(event.key==='ArrowRight'?16:-16)); } }} />
    <div className="project-nav-head"><strong>工程与对话</strong></div>
    <button className="project-nav-new" disabled={busy || !root} title={!root ? '打开工程后即可新建对话' : undefined} onClick={startCanvas}>＋ 新对话</button>
    <div className="project-nav-title"><span>最近项目</span><details className="project-actions"><summary aria-label="项目操作">＋</summary><div><button disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(newProject); }}>新建项目</button><button disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProject); }}>打开项目</button><button disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProjectFile); }}>打开工程文件</button></div></details></div>
    <div className="project-nav-scroll">
      {projects.length === 0 && <div className="project-nav-placeholder">
        {recentReady ? '还没有最近工程' : '正在读取最近工程…'}
      </div>}
      {projects.map((project, index) => {
        const key = project.file || project.root, current = isCurrent(project);
        const name = meta[key]?.name || (/^workflow\.cnode$/i.test(project.name)
          ? projectNameOf(project.root)
          : project.name.replace(/\.cnode$/i, ''));
        const folded = collapsed[key] ?? (!current && index >= 3);
        const openProjectEntry = () => void act(async () => {
          if (await openOtherProject(project)) {
            setCollapsed(state => ({ ...state, [key]: false }));
            useUiStore.getState().showCanvas();
          }
        });
        return <section className="project-group" data-project-path={key} key={key}>
          <div className="project-group-row">
            <button className="project-group-name" aria-expanded={!folded} title={project.root} onClick={() => setCollapsed(state => ({ ...state, [key]: !folded }))}>
              <span className="project-group-chevron" aria-hidden="true">{folded ? '›' : '⌄'}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /></svg>
              <span className="project-group-label" title={name}>{name}</span>{meta[key]?.pinned && <small>置顶</small>}
            </button>
            <button className="project-new-chat" aria-label={`在 ${name} 新建聊天`} disabled={busy} onClick={() => void act(async () => {
              if (!current && !await openOtherProject(project)) return;
              setCollapsed(state => ({ ...state, [key]: false }));
              startCanvas();
            })}>＋</button>
            <details className="project-row-menu"><summary aria-label={`${name} 项目菜单`}>⋯</summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute('open')}>
              {!current && <button className="project-open" disabled={busy} onClick={openProjectEntry}>打开项目</button>}
              <button onClick={() => changeMeta(key, { pinned: !meta[key]?.pinned })}>{meta[key]?.pinned ? '取消置顶' : '置顶'}</button>
              <button onClick={() => setRenaming(key)}>编辑名称</button>
              {current && <button disabled={busy} onClick={() => { order.filter(id => !sessions[id]?.archived).forEach(id => useSessionStore.getState().setArchived(id, true)); void saveProject(); }}>归档聊天</button>}
              <button onClick={() => { changeMeta(key, { hidden: true }); forgetRecentProject(project); refresh(value => value+1); }}>从侧栏移除</button>
            </div></details>
          </div>
          {renaming === key && <input className="project-rename" aria-label="项目显示名称" autoFocus defaultValue={name} onKeyDown={event => { if(event.key === 'Enter') { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); } if(event.key === 'Escape') setRenaming(null); }} onBlur={event => { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); }} />}
          {!folded && <ProjectSessions
            target={key}
            liveSessions={current ? order.map(id => sessions[id]).filter(Boolean) : null}
            activeId={current ? activeId : null}
            busy={busy}
            onSelect={id => {
              if (current) {
                useSessionStore.getState().switchSession(id);
                showConversation();
              } else void act(async () => {
                if (await openOtherProject(project, id)) showConversation();
              });
            }}
            onArchive={current ? id => { useSessionStore.getState().setArchived(id, true); void saveProject(); } : undefined}
            onOpenProject={!current ? openProjectEntry : undefined}
          />}
        </section>;
      })}
    </div>
  </aside>;
}
