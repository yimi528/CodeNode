import { useUiStore } from '../store/uiStore';
import { TutorialBookIcon } from './TutorialArtwork';
import './CanvasTutorialHint.css';

export default function CanvasTutorialHint() {
  const dismissed = useUiStore(s => s.tutorialHintDismissed);
  const openTutorial = useUiStore(s => s.openTutorial);
  const setDismissed = useUiStore(s => s.setTutorialHintDismissed);
  if (dismissed) return null;
  return <div className="canvas-tutorial-position"><section className="canvas-tutorial-hint" aria-label="画布入门引导" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button className="tutorial-hint-close" aria-label="关闭入门引导" onClick={() => setDismissed(true)}>×</button>
    <h2><TutorialBookIcon />第一次使用 CodeNode？</h2>
    <p>直接在对话中提出任务。需要手动编排时，开启工具栏的高级模式。</p>
    <button className="tutorial-hint-open" onClick={() => openTutorial('create')}>查看教程 <span aria-hidden="true">→</span></button>
  </section></div>;
}
