import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Tip = { heading: string; body: string; x: number; y: number; above: boolean; width: number };

export default function CanvasTooltip({ canvas }: { canvas: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const host = canvas.current;
    if (!host) return;
    let timer: number | undefined;
    let anchor: HTMLElement | null = null;
    const find = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[data-tip-heading]') : null;
    const close = () => {
      window.clearTimeout(timer);
      anchor = null;
      setTip(null);
    };
    const show = (event: Event) => {
      const button = find(event.target);
      if (!button || button === anchor) return;
      close();
      anchor = button;
      timer = window.setTimeout(() => {
        const bounds = button.getBoundingClientRect();
        const body = button.getAttribute('aria-description');
        if (!bounds.width || !body) return;
        const width = Math.min(240, window.innerWidth - 16);
        const above = bounds.bottom > window.innerHeight / 2;
        setTip({ heading: button.dataset.tipHeading || '', body, width, above,
          x: Math.max(8, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - 8)),
          y: above ? bounds.top - 8 : bounds.bottom + 8 });
      }, event.type === 'focusin' ? 0 : 300);
    };
    const leave = (event: PointerEvent | FocusEvent) => {
      if (anchor && find(event.relatedTarget) !== anchor) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    host.addEventListener('pointerover', show, true);
    host.addEventListener('pointerout', leave, true);
    host.addEventListener('focusin', show);
    host.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.clearTimeout(timer);
      host.removeEventListener('pointerover', show, true);
      host.removeEventListener('pointerout', leave, true);
      host.removeEventListener('focusin', show);
      host.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [canvas]);

  return tip && createPortal(<div role="tooltip" className="canvas-tool-tip" style={{
    left: tip.x, top: tip.y, width: tip.width, transform: tip.above ? 'translateY(-100%)' : undefined,
  }}><strong>{tip.heading}</strong><div>{tip.body}</div></div>, canvas.current?.closest('.app') ?? document.body);
}
