import { WorkbenchViewSwitcher } from './GoalOverview';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { saveProject } from '../lib/projectActions';
import { CanvasIconButton } from './CanvasIcons';

export default function Toolbar() {
  const projectRoot = useProjectStore(s => s.root);
  const conversationOpen=useUiStore(s=>s.conversationOpen);
  const toggleConversation=useUiStore(s=>s.toggleConversation);
  const saveState=useProjectSaveStore();
  const autoSave=useUiStore(s=>s.preferences.autoSaveEnabled);
  const replay = useUiStore(s => s.stageReplayOpen && s.sideTab !== 'project');
  const saveInHeader = useUiStore(s =>
    s.sideTab === 'project' || s.stageReplayOpen || s.preferences.workbenchView === 'overview');

  return (
    <header className="toolbar">
      <span className="toolbar-project-name" title={projectRoot ?? undefined}>{projectRoot?.split(/[\\/]/).filter(Boolean).pop() || '工作台'}</span>
      {projectRoot && <>
      <span className={'toolbar-save-state state-'+saveState.status} role="status" title={saveState.error || (autoSave?'项目自动保存已开启；Ctrl+S 可手动保存':'自动保存已关闭；Ctrl+S 可手动保存')}>{saveState.status==='saving'?'保存中…':saveState.status==='error'?'保存失败':saveState.status==='dirty'?'未保存':saveState.status==='idle'?'未保存项目':'已保存'}</span>

      {saveInHeader && <CanvasIconButton icon="save" label="保存项目" onClick={() => void saveProject()} />}

      <WorkbenchViewSwitcher/>
      {!replay && <div className="toolbar-group toolbar-spacer">
        <button className="conversation-toggle" title={conversationOpen?'隐藏对话栏':'显示对话栏'} aria-label={conversationOpen?'隐藏对话栏':'显示对话栏'} aria-expanded={conversationOpen} aria-controls="conversation-panel" onClick={toggleConversation}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>
        </button>
      </div>}
      </>}
    </header>
  );
}
