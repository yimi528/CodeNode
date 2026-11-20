import { useEffect, useState, type ReactNode } from 'react';
import { buildTree, useProjectStore, type FileNode } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { projectNameOf, readRecentProjects, recentPathKey } from '../lib/recentProjects';
import { EditorPanel } from './WorkbenchDock';
import ProjectPanel, { ProjectFileTree } from './side/ProjectPanel';
import PreviewPanel, { FilePreview, type PreviewFile } from './side/PreviewPanel';

function WorkspaceFiles({ root, workspaceLabel }: { root: string; workspaceLabel: ReactNode }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [refresh, setRefresh] = useState(0);
  const selectedPath = useUiStore(s => s.filePreviewLocation?.root === root ? s.filePreviewLocation.relPath : null);
  const selectPath = (relPath: string) => useUiStore.setState({ filePreviewLocation: { root, relPath } });
  const [selected, setSelected] = useState<PreviewFile | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTree([]);
    setError(null);
    void (async () => {
      try {
        const result = await window.codenode?.listProject(root);
        if (!result?.ok || !result.files) throw Error(result?.error || '无法读取工作区');
        if (active) setTree(buildTree(result.files));
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [root, refresh]);

  useEffect(() => {
    setSelected(null);
    setPreviewError('');
    if (!selectedPath) return;
    if (/\.cnode$/i.test(selectedPath)) {
      setSelected({ relPath: selectedPath, content: '', truncated: false });
      setPreviewLoading(false);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    void (async () => {
      try {
        const result = await window.codenode?.readProjectFile(root, selectedPath, { preview: true });
        if (!result?.ok || !result.preview) throw Error(result?.error || '文件读取失败');
        const preview = result.preview;
        if (active) setSelected({
          relPath: selectedPath,
          content: preview.kind === 'text' ? preview.content : '',
          truncated: preview.kind === 'text' && preview.truncated,
          mtimeMs: result.mtimeMs,
          bytes: result.bytes,
          encoding: preview.kind === 'text' ? preview.encoding : undefined,
          media: preview.kind === 'text' ? undefined : preview,
        });
      } catch (cause) {
        if (active) setPreviewError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setPreviewLoading(false);
      }
    })();
    return () => { active = false; };
  }, [root, selectedPath, refresh]);

  return <>
    <div className="files-explorer">
      <header><strong>文件</strong></header>
      <ProjectFileTree
        root={root} tree={tree} loading={loading} error={error}
        selectedPath={selectedPath} fileFilter={filter} setFileFilter={setFilter} onOpen={selectPath}
        workspaceLabel={workspaceLabel}
        actions={<button onClick={() => setRefresh(value => value + 1)} title="刷新文件树" disabled={loading}>刷新</button>}
      />
    </div>
    <div className="files-document">
      {previewError || previewLoading ? <div className="pm-preview-empty" role={previewError ? 'alert' : 'status'}>
        {previewError || '正在读取文件…'}
      </div> : <FilePreview key={refresh} root={root} selected={selected} embedded />}
    </div>
  </>;
}

function WorkspaceEditor() {
  const selected = useProjectStore(state => state.selected);
  const editable = selected && !selected.relPath.toLowerCase().endsWith('.cnode');
  return <>
    <div className="files-explorer"><header><strong>文件</strong></header><ProjectPanel embedded onOpen={() => {}} /></div>
    <div className="files-document">{editable ? <EditorPanel /> : <PreviewPanel embedded onBack={() => {}} />}</div>
  </>;
}

export default function FileWorkspace({ editing }: { editing: boolean }) {
  const projectRoot = useProjectStore(state => state.root) || '';
  const browseRoot = useUiStore(s => s.filePreviewLocation?.root || null);
  const setBrowseRoot = (root: string | null) => useUiStore.setState({ filePreviewLocation: root ? { root, relPath: null } : null });
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState('');
  const choices = new Map<string, string>();
  for (const root of [browseRoot, ...readRecentProjects().map(project => project.root)]) {
    if (root && recentPathKey(root) !== recentPathKey(projectRoot)) choices.set(recentPathKey(root), root);
  }
  const chooseDirectory = async () => {
    setChoosing(true);
    setChooseError('');
    try {
      if (!window.codenode) throw Error('需要 Electron 环境');
      const result = await window.codenode.chooseProject();
      if (result.ok && result.root) setBrowseRoot(recentPathKey(result.root) === recentPathKey(projectRoot) ? null : result.root);
    } catch (cause) {
      setChooseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  };
  const root = browseRoot || projectRoot;
  const workspaceNames = Array.from(choices.values(), projectNameOf);
  const selectedWorkspace = recentPathKey(browseRoot || '');
  return <section className="files-workspace" aria-label={editing ? '项目文件编辑' : '项目文件'}><div className="files-layout">
    {editing ? <WorkspaceEditor /> : <WorkspaceFiles root={root} key={root} workspaceLabel={
      <div className="files-workspace-picker">
        <select aria-label="选择工作区" value={choices.has(selectedWorkspace) ? selectedWorkspace : ''} onChange={event => {
          setChooseError('');
          setBrowseRoot(choices.get(event.target.value) || null);
        }}>
          <option value="" title={projectRoot}>当前工作区 · {projectNameOf(projectRoot)}</option>
          {Array.from(choices, ([key, folder]) => {
            const name = projectNameOf(folder);
            const duplicate = workspaceNames.indexOf(name) !== workspaceNames.lastIndexOf(name) || name === projectNameOf(projectRoot);
            return <option key={key} value={key} title={folder}>{duplicate ? folder : name}</option>;
          })}
        </select>
        <button type="button" onClick={() => void chooseDirectory()} disabled={choosing}>选择目录…</button>
        {chooseError && <small role="alert">{chooseError}</small>}
      </div>
    } />}
  </div></section>;
}
