import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import backendConfig from '../../../config/agent.backends.json';
import { useBackendSwitchStore } from '../../store/backendSwitchStore';
import { useProjectStore } from '../../store/projectStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { AgentBackendSettings } from '../../types';

import { CanvasIcon } from '../CanvasIcons';

const ModelManager = lazy(() => import('../ModelManager'));

export default function ModelConnectionControl({ label, backend, busy, children }: {
  label: string;
  backend: AgentBackendSettings['backend'];
  busy: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useProjectStore(s => s.root);
  const projectFile = useProjectStore(s => s.projectFile);
  const conversationId = useSessionStore(s => s.memoryConversationId);
  const sessionId = useSessionStore(s => s.activeId);
  const managerOpen = useUiStore(s => s.modelManagerOpen);
  useEffect(() => { if (managerOpen) setHost(null); }, [managerOpen]);
  const close = () => { setHost(null); trigger.current?.focus(); };
  const useApiConnection = async () => {
    const api = window.codenode;
    if (!api || busy || useBackendSwitchStore.getState().switching) throw new Error('请在任务结束后切换模型连接');
    useBackendSwitchStore.setState({ switching: true });
    try {
      const config = await api.agentConfig(root, sessionId, conversationId);
      const current = useProjectStore.getState();
      if (current.root !== root || current.projectFile !== projectFile || useSessionStore.getState().memoryConversationId !== conversationId) {
        throw new Error('对话已切换，请在当前对话中选择连接');
      }
      const profile = config.backend?.profiles?.builtin || backendConfig.defaults as AgentBackendSettings;
      const result = await api.backendSave(root, root ? 'project' : 'machine', profile, root ? { conversationId } : undefined);
      if (!result.ok) throw new Error(result.error || '切换 Agent 失败');
      window.dispatchEvent(new Event('codenode-backend-settings'));
      useUiStore.getState().setToast('已切换到 CodeNode，下一条消息将使用所选 API 模型');
      close();
    } finally {
      useBackendSwitchStore.setState({ switching: false });
    }
  };

  return <div className="composer-model-control">
    <button ref={trigger} type="button" className="model-connection-trigger" aria-label="配置模型连接"
      aria-haspopup="dialog" aria-expanded={!!host} disabled={busy} title={`配置模型连接 · ${label}`}
      onClick={event => {
        if (host) host.querySelector<HTMLButtonElement>('.composer-model-box .mm-close')?.click();
        else setHost(event.currentTarget.closest<HTMLElement>('.composer-dock'));
      }}>
      <CanvasIcon name="box" />
    </button>
    {host && createPortal(<Suspense fallback={null}><ModelManager inline={{
      picker: children, close, trigger: trigger.current,
      backendName: backend === 'builtin' ? undefined : backendConfig.labels[backend],
      useApiConnection: backend === 'builtin' ? undefined : useApiConnection,
    }} /></Suspense>, host)}
  </div>;
}
