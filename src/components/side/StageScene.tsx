import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react';
import { sceneAtStage, type StageRecord } from '../../lib/stageScene';
import { drawStageScene, initialStageView } from '../../lib/stageSceneRenderer';
import './StageScene.css';

export default function StageScene({ open, selectedId, timeline, onStep }: {
  open: boolean;
  selectedId: string;
  timeline: StageRecord[];
  onStep: (direction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef({ ...initialStageView });
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const animationId = useRef<string | undefined>(undefined);
  const components = useMemo(() => open ? sceneAtStage(timeline, selectedId) : [], [open, timeline, selectedId]);
  const attemptId = timeline.find(stage => stage.nodeId === selectedId)?.evidence.attemptId;

  const setZoom = useCallback((value: number) => {
    viewRef.current.zoom = Math.max(.4, Math.min(3, value));
    renderRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
      // Chromium sends trackpad pinch as a Ctrl-modified wheel event.
      const rate = event.ctrlKey ? .01 : .002;
      setZoom(viewRef.current.zoom * Math.exp(-event.deltaY * unit * rate));
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [open, setZoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
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
      drawStageScene(ctx, width, height, viewRef.current, components, 1 - (1 - progress) ** 3);
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
    };
  }, [components, attemptId, open]);

  const turn = (horizontal: number, vertical = 0) => {
    viewRef.current.azimuth = (viewRef.current.azimuth + horizontal) % (2 * Math.PI);
    viewRef.current.elevation = Math.max(-.85, Math.min(1.42, viewRef.current.elevation + vertical));
    renderRef.current();
  };
  const drag = (event: PointerEvent<HTMLCanvasElement>) => {
    const previous = pointer.current;
    if (previous?.id !== event.pointerId) return;
    turn((event.clientX - previous.x) * .012, (event.clientY - previous.y) * .009);
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  if (!open) return null;
  return <canvas ref={canvasRef} className="stage-scene-canvas" role="img" tabIndex={0}
    aria-label={components.map(item => item.label).join('、') || '暂无已记录的组件'}
    aria-description="拖动或使用方向键旋转。滚轮、触控板捏合或加减键缩放，0 恢复原始大小。Page Up 和 Page Down 切换阶段，按 Escape 或双击返回。"
    onKeyDown={event => {
      const step = Math.PI / 18;
      switch (event.key) {
        case 'ArrowLeft': turn(-step); break;
        case 'ArrowRight': turn(step); break;
        case 'ArrowUp': turn(0, step); break;
        case 'ArrowDown': turn(0, -step); break;
        case '+':
        case '=': setZoom(viewRef.current.zoom * 1.2); break;
        case '-': setZoom(viewRef.current.zoom / 1.2); break;
        case '0': setZoom(initialStageView.zoom); break;
        case 'PageUp': onStep(-1); break;
        case 'PageDown': onStep(1); break;
        default: return;
      }
      event.preventDefault();
    }}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.currentTarget.focus({ preventScroll: true });
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={drag}
    onLostPointerCapture={event => {
      if (pointer.current?.id === event.pointerId) pointer.current = null;
    }} />;
}
