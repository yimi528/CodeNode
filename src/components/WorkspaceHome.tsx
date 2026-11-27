import { useState } from 'react';
import { newProject, openProject, openProjectFile } from '../lib/projectActions';
import { CanvasIcon } from './CanvasIcons';

export default function WorkspaceHome({ ready }: { ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const open = async (action: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !ready || !window.codenode;

  return <section className="workspace-home" aria-label="工作台首页">
    <CanvasIcon name="folder" />
    <h1>打开或新建项目</h1>
    <div className="workspace-home-actions">
      <button type="button" disabled={disabled} onClick={() => void open(openProject)}>打开项目</button>
      <button type="button" disabled={disabled} onClick={() => void open(newProject)}>新建项目</button>
      <button type="button" disabled={disabled} onClick={() => void open(openProjectFile)}>打开工程文件</button>
    </div>
  </section>;
}
