import { useRef } from 'react';

const MIN_WIDTH = 240;

export default function GoalPanelResize({ width, max, label, onResize }: {
  width: number;
  max: number;
  label: string;
  onResize: (width: number) => void;
}) {
  const gesture = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const min = Math.min(MIN_WIDTH, max);
  const current = Math.min(max, width);
  const resize = (value: number) => onResize(Math.max(min, Math.min(max, Math.round(value))));

  return <div
    className="overview-goal-resize"
    role="separator"
    tabIndex={0}
    aria-label={`调整 ${label} 宽度`}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={current}
    title="拖动调整面板宽度"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointerId: event.pointerId, x: event.clientX, width: current };
    }}
    onPointerMove={event => {
      const previous = gesture.current;
      if (previous?.pointerId === event.pointerId) resize(previous.width + event.clientX - previous.x);
    }}
    onLostPointerCapture={() => { gesture.current = null; }}
    onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resize(current + (event.key === 'ArrowRight' ? 16 : -16));
    }}
  />;
}
