import { useState, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useTrellisStore } from '../store/trellisStore';
import TrellisWritePanel from './TrellisWritePanel';
import { useUiStore } from '../store/uiStore';

const labels: Record<string, string> = {
  planning: '待规划',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
};

export default function TaskWorkspace({ hidden }: { hidden: boolean }) {
  const root = useProjectStore(s => s.root);
  return root && <ProjectTasks key={root} root={root} hidden={hidden} />;
}

function ProjectTasks({ root, hidden }: { root: string; hidden: boolean }) {
  const conversation = useSessionStore(s => s.memoryConversationId);
  const streaming = useSessionStore(s => s.streaming);
  const { root: storeRoot, project: rawProject, context: rawContext, viewed, loading, busy, error, refresh, view, bind } = useTrellisStore();
  const project = storeRoot === root ? rawProject : null;
  const context = storeRoot === root ? rawContext : null;
  const navigationOpen = useUiStore(s => s.navigationOpen);
  const navigationWidth = useUiStore(s => s.navigationWidth);
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('materials');
  const [document, setDocument] = useState('');
  const task = project?.tasks.find(item => item.taskPath === viewed);
  const docs = context?.documents || [];
  const selected = docs.find(doc => doc.source === document) || docs.find(doc => doc.source.endsWith('/prd.md')) || docs[0];
  const bound = project?.selectedTask === viewed;
  const reload = () => void refresh(root, conversation);
  const query = search.trim().toLowerCase();

  return <section className="task-workspace" aria-label="任务工作区" hidden={hidden} inert={hidden} style={{ '--task-nav-width': navigationWidth + 'px' } as CSSProperties}>
    <aside hidden={!navigationOpen} className="task-navigation" aria-label="任务列表">
      <div className="task-nav-heading"><h2>任务</h2><span>{project?.tasks.length || 0}</span></div>
      <p className="task-project-name">{root.split(/[/\\]/).filter(Boolean).pop() || root}</p>
      <input aria-label="搜索任务" placeholder="搜索任务" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="task-list">
        {project?.tasks.filter(item => (item.title + ' ' + item.id).toLowerCase().includes(query)).map(item =>
          <button key={item.taskPath} className="task-list-item" aria-label={'查看任务 ' + item.title} aria-current={viewed === item.taskPath ? 'true' : undefined} onClick={() => void view(item.taskPath)}>
            <strong>{item.title}</strong>
            {project.selectedTask === item.taskPath && <span>当前对话</span>}
          </button>
        )}
      </div>
      <button className="task-refresh" disabled={loading || busy} onClick={reload}>刷新任务</button>
    </aside>
    <main className="task-detail">
      <header className="task-page-heading">
        <div><h1>{task?.title || '任务'}</h1>{task && <p>{labels[task.status] || task.status}</p>}</div>
        {(task || project?.selectedTask) && <button className="task-bind" disabled={busy || loading || streaming} onClick={() => void bind(!task || bound ? null : task.taskPath)}>
          {!task ? '解除失效绑定' : bound ? '解除对话绑定' : '绑定到当前对话'}
        </button>}
      </header>
      {error && storeRoot === root && <p role="alert" className="task-diagnostic">{error}</p>}
      {project?.detected && !project.tasks.length && <div className="task-empty"><h2>还没有可读取的任务</h2><p>请在 Trellis 中创建任务，或检查结构诊断后刷新。</p></div>}
      {loading && !context && <p role="status">正在读取任务资料…</p>}
      {project?.diagnostics.map((item, index) => <p className="task-diagnostic" role="alert" key={index}>{item.source}：{item.error}</p>)}
      {context && task && <>
        <nav className="task-sections" aria-label="任务内容">
          <button aria-pressed={section === 'materials'} onClick={() => setSection('materials')}>需求与规范</button>
          <button aria-pressed={section === 'runs'} onClick={() => setSection('runs')}>运行与证据{context.runs.length > 0 && <span> {context.runs.length}</span>}</button>
          <button aria-pressed={section === 'actions'} onClick={() => setSection('actions')}>工作日志</button>
        </nav>
        {!context.ready && <div className="task-diagnostic" role="alert"><strong>任务资料需要修复</strong>{context.diagnostics.map((item, index) => <p key={index}>{item.source}：{item.error}</p>)}</div>}
        <div className="task-materials" hidden={section !== 'materials'}>
          {selected && <article className="task-document">
            <TaskDocumentContent content={selected.content} />
            <details>
              <summary>任务资料与版本</summary>
              <label className="task-document-picker">资料<select value={selected.source} onChange={event => setDocument(event.target.value)}>
                {docs.map(doc => <option key={doc.source} value={doc.source}>{doc.source.endsWith('/prd.md') ? '需求说明 · PRD' : doc.source}</option>)}
              </select></label>
              <p>{selected.source}</p>
              <p>SHA-256：{selected.fingerprint}</p>
              <p>适用阶段：{selected.stages.join('、')}</p>
              <details><summary>查看原文</summary><pre>{selected.content}</pre></details>
            </details>
          </article>}
        </div>
        <section className="task-runs" hidden={section !== 'runs'} aria-label="运行与证据">
          <h2>关联运行</h2>
          <p>阶段结束不自动完成任务；局部检查不代表全部需求验收通过。</p>
          {!context.runs.length && <div className="task-empty"><h3>尚未执行</h3><p>绑定当前对话后可发送任务，或生成画布流程。</p></div>}
          {context.runs.map(run => <article key={run.runId}>
            <h3>{run.runId}</h3>
            <p>{run.status} · 检查：{run.verification?.status || '未执行'} · {run.evidenceFresh ? '证据版本一致' : '尚无有效版本证据'}</p>
            {!!run.sourcesChanged.length && <p role="alert">任务资料已变化：{run.sourcesChanged.join('、')}</p>}
            {run.verification && <pre>{JSON.stringify(run.verification, null, 2)}</pre>}
          </article>)}
        </section>
        <div hidden={section !== 'actions'}><TrellisWritePanel key={task.taskPath} root={root} context={context} disabled={busy || loading || streaming} reload={reload} /></div>
      </>}
    </main>
  </section>;
}

function TaskDocumentContent({ content }: { content: string }) {
  let fence = '';
  return <div className="task-document-content">{content.split(/\r?\n/).map((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) {
      fence = marker[1];
      return <div className="task-document-line" key={index}>{line}</div>;
    }
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      return <div className="task-document-line" key={index}>{line || ' '}</div>;
    }
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/);
    if (heading) {
      const Heading = heading[1].length < 3 ? 'h2' : 'h3';
      return <Heading key={index}>{heading[2]}</Heading>;
    }
    const checkbox = line.match(/^\s*[-*+] \[([ xX])\][ \t]+(.+)$/);
    if (checkbox) {
      return <div className="task-document-check" key={index}><input type="checkbox" checked={!checkbox[1].includes(' ')} disabled aria-label={checkbox[2]} />{checkbox[2]}</div>;
    }
    return <div className="task-document-line" key={index}>{line || ' '}</div>;
  })}</div>;
}
