import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { sceneAtStage, stageComponents, stageOutcomePreview, type SceneStage, type StageEvidence, type StageRecord } from '../../lib/stageScene';
import { drawStageScene, initialStageView, type StageSceneTarget } from '../../lib/stageSceneRenderer';
import { useReplayStore } from '../../store/replayStore';
import { useUiStore } from '../../store/uiStore';
import StageFileList from './StageFileList';
import './StageScene.css';

const stateLabels = { added: '新增文件', affected: '受影响', historical: '历史 · 已回滚' };

export default function StageScene({ open, stages, selectedId, timeline, evidence, upstream, status, onSelect }: {
  open: boolean;
  stages: SceneStage[];
  selectedId: string;
  timeline: StageRecord[];
  evidence: StageEvidence | null;
  upstream: string[];
  status: 'loading' | 'running' | 'unavailable' | 'ready';
  onSelect: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stagebarRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ ...initialStageView });
  const pointer = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const hitTest = useRef<(x: number, y: number) => StageSceneTarget | null>(() => null);
  const [picked, setPicked] = useState<{ stageId: string; target: StageSceneTarget } | null>(null);
  const files = evidence?.files;
  const changes = useMemo(() => stageComponents(files ?? []), [files]);
  const components = useMemo(() => open ? sceneAtStage(timeline, selectedId) : [], [open, timeline, selectedId]);
  const animationId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const bar = stagebarRef.current;
    const current = bar?.querySelector('[aria-current="step"]');
    if (!bar || !current) return;
    const item = current.getBoundingClientRect();
    const container = bar.getBoundingClientRect();
    if (item.left < container.left) bar.scrollLeft += item.left - container.left;
    else if (item.right > container.right) bar.scrollLeft += item.right - container.right;
  }, [selectedId, open, stages.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const attemptId = evidence?.attemptId;
    const animate = attemptId && animationId.current !== attemptId && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    animationId.current = attemptId;
    const start = performance.now();
    let frame = 0;
    let width = 0, height = 0;
    function schedule() {
      if (!frame) frame = requestAnimationFrame(draw);
    }
    function draw(now: number) {
      frame = 0;
      if (width < 1 || height < 1 || !ctx) return;
      const progress = animate ? Math.max(0, Math.min(1, (now - start) / 390)) : 1;
      hitTest.current = drawStageScene(ctx, width, height, viewRef.current, components, 1 - (1 - progress) ** 3);
      if (progress < 1) schedule();
    }
    const resize = () => {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = nextWidth;
      height = nextHeight;
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    renderRef.current = schedule;
    resize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      renderRef.current = () => {};
      hitTest.current = () => null;
    };
  }, [components, evidence?.attemptId, open]);

  const turn = (horizontal: number, vertical = 0) => {
    viewRef.current.azimuth = (viewRef.current.azimuth + horizontal) % (2 * Math.PI);
    viewRef.current.elevation = Math.max(.32, Math.min(1.3, viewRef.current.elevation + vertical));
    renderRef.current();
  };
  const targetAt = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return hitTest.current(event.clientX - bounds.left, event.clientY - bounds.top);
  };
  const startPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
    event.currentTarget.style.cursor = '';
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const drag = (event: PointerEvent<HTMLCanvasElement>) => {
    const previous = pointer.current;
    if (previous?.id !== event.pointerId) {
      event.currentTarget.style.cursor = targetAt(event) ? 'pointer' : '';
      return;
    }
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    if (!previous.dragging && Math.hypot(dx, dy) < 4) return;
    turn(dx * .012, dy * .009);
    pointer.current = { id: previous.id, x: event.clientX, y: event.clientY, dragging: true };
  };
  const endPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const previous = pointer.current;
    if (previous?.id !== event.pointerId) return;
    pointer.current = null;
    if (previous.dragging || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) >= 4) return;
    const target = targetAt(event);
    setPicked(target ? { stageId: selectedId, target } : null);
    event.currentTarget.style.cursor = target ? 'pointer' : '';
  };

  if (!open) return null;
  const selection = picked?.stageId === selectedId ? picked.target : null;
  const selectedComponent = components.find(component => component.kind === selection?.kind);
  const selectedFiles = changes.find(component => component.kind === selection?.kind)?.files;
  let note = timeline.length ? '这一阶段尚无运行记录。场景显示最近一次已记录的状态。' : '阶段执行后会显示运行记录里的文件变化。';
  if (status === 'loading') note = '正在读取阶段记录…';
  else if (status === 'running') note = '阶段正在运行，结算后显示本次变化。';
  else if (status === 'unavailable') note = '暂时无法读取阶段记录。';
  else if (evidence) {
    if (!evidence.fileCount) note = evidence.changesComplete ? '本次运行未记录文件变化。' : '暂无可归属到本阶段的文件变更证据。';
    else note = `本阶段记录 ${evidence.fileCount} 个文件变更`;
    if (evidence.phase === 'failed') note = `执行未完成 · ${note}`;
  }

  const verification = evidence?.verification;
  const runId = evidence?.runId;
  const summary = evidence?.output.trim() || '';
  const preview = stageOutcomePreview(summary);
  return (
    <section className="stage-scene" aria-label="阶段 3D 回放">
      <div ref={stagebarRef} className="stage-scene-stagebar" role="group" aria-label="切换阶段">
        {stages.map(stage => (
          <button key={stage.id} type="button" title={stage.title} aria-current={stage.id === selectedId ? 'step' : undefined}
            onClick={() => onSelect(stage.id)}>{stage.title}</button>
        ))}
      </div>
      <div className="stage-scene-layout">
        <div className="stage-scene-view">
          <canvas ref={canvasRef} className="stage-scene-canvas" role="img"
            aria-label={components.length ? components.map(item => item.label + (item.change === 'added' ? '新增' : item.change ? '有改动' : '保留')).join('、') : '暂无已记录的组件'}
            onPointerDown={startPointer} onPointerMove={drag} onPointerUp={endPointer} onLostPointerCapture={event => {
              if (pointer.current?.id === event.pointerId) pointer.current = null;
            }} />
          <div className="stage-scene-view-footer">
            <span className="stage-scene-key"><i />本阶段变更</span>
            <div className="stage-scene-orbit" role="group" aria-label="调整视角">
              <span>点选看变更 · 拖动旋转</span>
              <button type="button" aria-label="向左旋转 3D 场景" onClick={() => turn(-Math.PI / 7)}>↶</button>
              <button type="button" aria-label="向右旋转 3D 场景" onClick={() => turn(Math.PI / 7)}>↷</button>
            </div>
          </div>
        </div>
        <div className="stage-scene-record">
          {selectedComponent && <section className="stage-scene-selection" aria-label="选中的架构证据">
            <div>
              <strong>{selectedComponent.label}{selection?.type === 'connection' ? '关联连线' : ''}</strong>
              <button type="button" aria-label="清除证据选中" onClick={() => setPicked(null)}>×</button>
            </div>
            {selection?.type === 'connection' && <p className="stage-scene-note">连线表示项目与此组件的文件变更关联。</p>}
            {selectedFiles?.length ? <StageFileList files={selectedFiles} /> : <p className="stage-scene-note">本阶段暂无此组件的变更记录。</p>}
          </section>}
          {preview && <p className="stage-scene-result">{preview}</p>}
          <p className="stage-scene-note" role="status">{note}</p>
          {upstream.length > 0 && <p className="stage-scene-note">上游交付 {upstream.join('、')}</p>}
          {verification && <p className="stage-scene-note">
            {verification.historical ? '回滚前的局部校验' : '运行时局部校验'} · 通过 {verification.passed} / {verification.total}
            {verification.failed > 0 ? ` · 失败 ${verification.failed}` : ''}
          </p>}
          {changes.map(component => (
            <details className="stage-scene-evidence" key={component.kind} data-change={component.state}>
              <summary><span>{component.label}</span><small>{stateLabels[component.state]} · {component.files.length}</small></summary>
              <StageFileList files={component.files} />
            </details>
          ))}
          {evidence && evidence.fileCount > evidence.files.length && <p className="stage-scene-note">显示前 {evidence.files.length} 个文件。</p>}
          {summary && summary.replace(/^Agent[：:]\s*/, '') !== preview && <details className="stage-scene-evidence">
            <summary>阶段总结</summary><pre className="stage-execution-output">{summary}</pre>
          </details>}
          {runId && <button type="button" className="stage-scene-run-link" onClick={() => {
            useReplayStore.getState().setRunId(runId);
            useUiStore.getState().openDock('runs');
          }}>查看本次运行</button>}
        </div>
      </div>
    </section>
  );
}
