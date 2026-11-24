import backendConfig from '../../config/agent.backends.json';
import type { AgentBackendSettings } from '../types';

export function agentLabel(backend: AgentBackendSettings['backend']) {
  return backendConfig.labels[backend].replace(' ACP', '').replace(' Agent', '');
}
