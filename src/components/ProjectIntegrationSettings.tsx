import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useTrellisStore } from '../store/trellisStore';
import { useUiStore } from '../store/uiStore';
import TrellisCliSettings from './TrellisCliSettings';
import TrellisConnectPanel from './TrellisConnectPanel';

export default function ProjectIntegrationSettings() {
  const root = useProjectStore(s => s.root);
  return root && <ProjectIntegrations key={root} root={root} />;
}

function ProjectIntegrations({ root }: { root: string }) {
  const [connectionPanel, setConnectionPanel] = useState<'idle' | 'open' | 'closed'>('idle');
  const [configuringCli, setConfiguringCli] = useState(false);
  const project = useTrellisStore(s => s.root === root ? s.project : null);
  const error = useTrellisStore(s => s.root === root && !s.project ? s.error : '');
  const loading = useTrellisStore(s => s.root !== root || s.loading);
  const refresh = useTrellisStore(s => s.refresh);
  const available = Boolean(window.codenode?.trellisProject);
  const connected = project?.detected === true;
  const connecting = connectionPanel === 'open';
  const checkProject = () => void refresh(root, useSessionStore.getState().memoryConversationId);

  useEffect(() => {
    if (available && useTrellisStore.getState().root === root && !useTrellisStore.getState().loading) {
      void refresh(root, useSessionStore.getState().memoryConversationId);
    }
  }, [available, refresh, root]);

  return <div className="project-integration-settings">
    <header className="project-settings-heading">
      <p>{root.split(/[/\\]/).filter(Boolean).pop() || root}</p>
    </header>
    <h3>工具集成</h3>
    <div className="project-integration-row">
      <div>
        <strong>Trellis</strong>
        <p>{connected ? '当前项目已接入 Trellis。' : '使用 Trellis 管理项目任务和开发规范。'}</p>
      </div>
      {connected ? (
        <button onClick={() => useUiStore.getState().setAppPage('tasks')}>查看任务</button>
      ) : project ? (
        <button aria-expanded={connecting} onClick={() => setConnectionPanel(connecting ? 'closed' : 'open')}>{connecting ? '收起接入设置' : '接入 Trellis'}</button>
      ) : error ? (
        <button onClick={checkProject} disabled={loading}>重新检测</button>
      ) : (
        <span role="status">{available ? '正在检测…' : '需要桌面应用'}</span>
      )}
    </div>
    {error && <p role="alert" className="settings-scope">{error}</p>}
    {connected && <button className="project-cli-toggle" aria-expanded={configuringCli} onClick={() => setConfiguringCli(value => !value)}>配置本机 Trellis</button>}
    <div hidden={!connected && !connecting}>
      {project?.detected === false && connectionPanel !== 'idle' && <TrellisConnectPanel root={root} onConfigure={() => setConfiguringCli(value => !value)} configuring={configuringCli} />}
      {configuringCli && <TrellisCliSettings />}
    </div>
  </div>;
}
