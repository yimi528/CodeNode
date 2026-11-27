import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import type { SessionCanvas } from '../types';
import { useUiStore } from '../store/uiStore';
import { CanvasIcon } from './CanvasIcons';
import { newProject, openProject, openProjectFile, openRecentProject, saveProject } from '../lib/projectActions';
import { readRecentProjects, projectNameOf, forgetRecentProject, recentPathKey, sameRecentProject, type RecentProject } from '../lib/recentProjects';

type ProjectEntry = Pick<RecentProject, 'root' | 'file' | 'name'>;
type SessionEntry = Pick<SessionCanvas, 'id' | 'label' | 'prompt' | 'archived'>;

function ProjectSessions({ target, liveSessions, activeId, busy, onSelect, onArchive }: {
  target: string;
  liveSessions: SessionEntry[] | null;
  activeId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => void;
}) {
  const current = liveSessions !== null;
  const [saved, setSaved] = useState<SessionEntry[] | null>(null);
  useEffect(() => {
    if (current) return;
    let active = true;
    setSaved(null);
    const api = window.codenode;
    if (!api) { setSaved([]); return; }
    void api.loadProject(target).then(result => {
      const sessions = result.data?.canvases?.sessions as SessionEntry[] | undefined;
      if (active) setSaved(result.ok && Array.isArray(sessions) ? sessions : []);
    }).catch(() => { if (active) setSaved([]); });
    return () => { active = false; };
  }, [target, current]);

  const entries = (liveSessions ?? saved)?.filter(session => typeof session?.id === 'string' && !session.archived);
  return <div className="project-nav-sessions">
    {!entries?.length && <div className="project-nav-empty">{entries ? '暂无已保存的对话' : '正在读取对话…'}</div>}
    {entries?.map(session => {
      const label = session.prompt && !session.prompt.startsWith('#') ? session.prompt : session.label || '未命名对话';
      return <div key={session.id} className="project-session-row">
        <button className={session.id === activeId ? 'active' : ''} disabled={busy} aria-current={session.id === activeId ? 'page' : undefined} onClick={() => onSelect(session.id)} title={label}>{label}</button>
        {onArchive && <button className="session-archive" aria-label={`归档 ${session.label || label}`} title="归档聊天" disabled={busy} onClick={() => onArchive(session.id)}>▣</button>}
      </div>;
    })}
  </div>;
}

/** Project/session navigation is independent of the conversation/inspector. */
export default function ProjectNavigation() {
  const appPage = useUiStore(s => s.appPage);
  const root = useProjectStore(s => s.root);
  const booted = useUiStore(s => s.booted);
  const projectError = useProjectStore(s => s.error);
  const file = useProjectStore(s => s.projectFile);
  const sessions = useSessionStore(s => s.sessions);
  const streaming = useSessionStore(s => s.streaming);
  const order = useSessionStore(s => s.order);
  const activeId = useSessionStore(s => s.activeId);
  const open = useUiStore(s => s.navigationOpen);
  const width = useUiStore(s => s.navigationWidth);
  const setWidth = useUiStore(s => s.setNavigationWidth);
  const visibleActions = useUiStore(s => s.preferences.visibleActions);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const act = async (operation: () => Promise<boolean>) => {
    if (busy || useSessionStore.getState().streaming) return;
    setBusy(true);
    setError('');
    try {
      if (await operation()) {
        const state = useProjectStore.getState();
        changeMeta(state.projectFile || state.root || '', { hidden: false });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开项目失败');
    } finally {
      setBusy(false);
    }
  };
  const isCurrent = (project: ProjectEntry) => sameRecentProject(project, { root: root || '', file: file || undefined });
  const recent = booted ? readRecentProjects() : [];
  const projects = [
    ...(root ? [{ root, file: file || undefined, name: projectNameOf(file || root) }] : []),
    ...recent.filter(project => !isCurrent(project)),
  ].filter(project => !meta[project.file || project.root]?.hidden);
  const candidateKeys = projects.map(project => recentPathKey(project.file || project.root));
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
    const legacyIndex = projectOrder.indexOf(recentPathKey(project.root).toLowerCase());
    return Math.min(index >= 0 ? index : projectOrder.length + candidateKeys.indexOf(key), legacyIndex >= 0 ? legacyIndex : Infinity);
  };
  projects.sort((a, b) =>
    Number(!!meta[b.file || b.root]?.pinned) - Number(!!meta[a.file || a.root]?.pinned) ||
    rank(a) - rank(b) ||
    projectOrder.indexOf(recentPathKey(a.file || a.root)) - projectOrder.indexOf(recentPathKey(b.file || b.root))
  );
  const showConversation = () => {
    const ui = useUiStore.getState();
    ui.setSideTab('agent');
    ui.updatePreferences({ workbenchView: 'conversation' });
    useUiStore.setState({conversationOpen:true,conversationAutoHidden:false,...(window.innerWidth<=600?{navigationOpen:false}:{})});
  };
  void revision;
  if (!open || appPage !== 'workbench') return null;
  return <aside ref={panel} className="project-navigation" aria-label="项目与会话" style={{'--navigation-width':width+'px'} as CSSProperties}>
    <div className="navigation-resize" role="separator" aria-label="调整项目栏宽度" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={width} tabIndex={0} onPointerDown={startResize} onDoubleClick={()=>setWidth(216)} onKeyDown={event => { if(event.key==='ArrowLeft'||event.key==='ArrowRight') { event.preventDefault(); setWidth(width+(event.key==='ArrowRight'?16:-16)); } }} />
    <div className="project-nav-head"><strong>CodeNode</strong></div>
    <button className="project-nav-new" disabled={busy || streaming} onClick={() => { useSessionStore.getState().newConversation(); showConversation(); if (root) void saveProject(); }}>＋ 新对话</button>
    <div className="project-nav-title"><span>项目</span><details className="project-actions"><summary aria-label="项目操作">＋</summary><div><button disabled={streaming || busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(newProject); }}>新建项目</button><button disabled={streaming || busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProject); }}>打开项目</button><button disabled={streaming || busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProjectFile); }}>打开工程文件</button></div></details></div>
    <div className="project-nav-scroll">
      {projects.map(project => {
        const key = project.file || project.root, current = isCurrent(project);
        const name = meta[key]?.name || project.name.replace(/\.cnode$/i, '');
        const folded = collapsed[key] ?? !current;
        return <section className="project-group" key={key} data-project-path={key}>
          <div className="project-group-row">
            <button className="project-group-name" aria-expanded={root ? !folded : undefined}
              title={project.root} disabled={!root && busy} onClick={() => {
                if (!root) void act(() => openRecentProject(project));
                else setCollapsed(state => ({ ...state, [key]: !folded }));
              }}>{root && <span aria-hidden="true">{folded ? '›' : '⌄'}</span>}<CanvasIcon name="folder" /><span>{name}</span>{meta[key]?.pinned && <small>置顶</small>}</button>
            <button className="project-new-chat" aria-label={`在 ${name} 新建聊天`} disabled={streaming || busy} onClick={() => void act(async () => {
              if (!current && !await openRecentProject(project)) return false;
              setCollapsed(state => ({ ...state, [key]: false }));
              useSessionStore.getState().newConversation();
              showConversation();
              if (useProjectStore.getState().root) void saveProject();
              return true;
            })}>＋</button>
            <details className="project-row-menu"><summary aria-label={`${name} 项目菜单`}>⋯</summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute('open')}>
              {current && <>
                <button data-action="save" onClick={() => void saveProject()}>保存项目</button>
                <button onClick={() => useUiStore.getState().setSideTab('project')}>打开项目文件</button>
                {visibleActions.includes('terminal') && <button onClick={() => useUiStore.getState().openDock('terminal')}>项目终端</button>}
                {visibleActions.includes('checkpoints') && <button onClick={() => useUiStore.getState().openDock('checkpoints')}>检查点与恢复</button>}
              </>}
              {!current && <button disabled={streaming || busy} onClick={() => void act(async () => {
                if (!await openRecentProject(project)) return false;
                setCollapsed(state => ({ ...state, [key]: false }));
                showConversation();
                return true;
              })}>打开项目</button>}
              <button onClick={() => changeMeta(key, { pinned: !meta[key]?.pinned })}>{meta[key]?.pinned ? '取消置顶' : '置顶'}</button>
              <button onClick={() => setRenaming(key)}>编辑名称</button>
              {current && <button disabled={streaming || busy} onClick={() => { order.filter(id => !sessions[id]?.archived).forEach(id => useSessionStore.getState().setArchived(id, true)); if (useProjectStore.getState().root) void saveProject(); }}>归档聊天</button>}
              <button onClick={() => { changeMeta(key, { hidden: true }); forgetRecentProject(project); refresh(value => value+1); }}>从侧栏移除</button>
            </div></details>
          </div>
          {renaming === key && <input className="project-rename" aria-label="项目显示名称" autoFocus defaultValue={name} onKeyDown={event => { if(event.key === 'Enter') { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); } if(event.key === 'Escape') setRenaming(null); }} onBlur={event => { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); }} />}
          {root && !folded && <ProjectSessions
            target={key}
            liveSessions={current ? order.map(id => sessions[id]).filter(Boolean) : null}
            activeId={current ? activeId : null}
            busy={streaming || busy}
            onSelect={id => {
              if (current) {
                useSessionStore.getState().switchSession(id);
                showConversation();
              } else void act(async () => {
                if (!await openRecentProject(project, id)) return false;
                showConversation();
                return true;
              });
            }}
            onArchive={current ? id => {
              useSessionStore.getState().setArchived(id, true);
              if (root) void saveProject();
            } : undefined}
          />}

        </section>;
      })}
      {booted && !projects.length && <p className="project-nav-empty">还没有项目</p>}
      {!root && !!order.length && <section className="project-group"><div className="project-nav-title">未分组</div><div className="project-nav-sessions">{order.map(id => sessions[id]).filter(session => session && !session.archived).map(session => <div className="project-session-row" key={session.id}><button className={session.id === activeId ? 'active' : ''} disabled={streaming || busy} onClick={() => { useSessionStore.getState().switchSession(session.id); showConversation(); }}>{session.prompt || session.label}</button></div>)}</div></section>}
    </div>
    <button className="project-nav-archive" onClick={() => useUiStore.getState().openSettings('archived')}><CanvasIcon name="checkpoints" />已归档聊天</button>
{(error || projectError) && <div className="project-nav-error" role="alert">{error || projectError}</div>}
  </aside>;
}
