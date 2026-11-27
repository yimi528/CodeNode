import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import welcomeLogo from '../assets/branding/welcome-logo.png';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { useGraphStore } from './store/graphStore';
import { useSessionStore } from './store/sessionStore';
import { useChatStore } from './store/chatStore';
import { useUiStore } from './store/uiStore';
import { useProjectStore } from './store/projectStore';
import { useReplayStore } from './store/replayStore';
import '@xyflow/react/dist/style.css';
import './design-system.css';
import './styles.css';
import './trellis.css';
import './workflow-canvas.css';

const w = window as unknown as {
  __codenodeStore?: typeof useGraphStore;
  __codenodeSession?: typeof useSessionStore;
  __codenodeChat?: typeof useChatStore;
  __codenodeUi?: typeof useUiStore;
  __codenodeProject?: typeof useProjectStore;
  __codenodeReplay?: typeof useReplayStore;
};
w.__codenodeStore = useGraphStore;
w.__codenodeSession = useSessionStore;
w.__codenodeChat = useChatStore;
w.__codenodeUi = useUiStore;
w.__codenodeProject = useProjectStore;
w.__codenodeReplay = useReplayStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="window-titlebar" aria-hidden="true">
      <div className="window-titlebar-brand">
        <img src={welcomeLogo} alt="" />
        <span>CodeNode</span>
      </div>
    </div>
    <ErrorBoundary>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
