import type { ButtonHTMLAttributes } from 'react';

const paths = {
  undo: 'M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10h-2',
  redo: 'm15 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10h2',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 6 6 6-6 6',
  refresh: 'M20 8a8 8 0 1 0 .6 7M20 3v5h-5',
  target: 'M20 11a8.5 8.5 0 1 1-7-7.9M15.7 13a4 4 0 1 1-4.8-5M12 12l7.5-7.5M17 7V4l2.5-2L20 4l2 .5L20 7Z',
  fit: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  minimap: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15',
  links: 'm10 13 4-4m-5 7-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m0 8a3.5 3.5 0 0 0 5 0l5-5a3.5 3.5 0 0 0-5-5l-2 2',
  snap: 'M4 13V5h6v8a2 2 0 0 0 4 0V5h6v8a8 8 0 0 1-16 0zm0-4h6m4 0h6',
  save: 'M5 3h12l4 4v14H3V5a2 2 0 0 1 2-2zm2 0v6h10V3M7 21v-7h10v7',
  properties: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  delete: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  workflow: 'M8 4l12 8-12 8z',
  layout: 'M3 8h5v8H3zm7 0h4v8h-4zm6 0h5v8h-5z',
  arrange: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  flow: 'M3 12h4l3-7 4 14 3-7h4',
  terminal: 'M3 5h18v14H3zM6 9l3 3-3 3m6 0h5',
  checkpoints: 'M3 11a9 9 0 1 1 2 7m-2-2v-5h5m4-4v5l3 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  select: 'm4 3 16 7-7 3-3 7z',
  hand: 'M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-3-4a1.7 1.7 0 0 1 2.5-2z',
  box: 'm12 2.5 8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3zM3.5 7.3 12 12l8.5-4.7M12 12v9.5m-4.2-17 8.4 4.8',
  folder: 'M3 18V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2M3 18l3-7h16l-3 8H5a2 2 0 0 1-2-1z',
  microphone: 'M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zm-3 5v1a6 6 0 0 0 12 0v-1m-6 7v4',
  send: 'M12 19V5m-6 6 6-6 6 6',
  shield: 'M12 3 4.5 6v5c0 4 3 7.5 7.5 10 4.5-2.5 7.5-6 7.5-10V6zm-3 9 2 2 4-4',
  vector: 'M12 3v18M3 12h18M6 6l12 12M18 6 6 18',
  keyboard: 'M3 6h18v12H3zM6 10h.01m4 0h.01m4 0h.01m4 0h.01M7 14h10',
};

export type CanvasIconName = keyof typeof paths;

export function CanvasIcon({ name }: { name: CanvasIconName }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}

export function CanvasIconButton({ icon, label, title = label, description, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: CanvasIconName;
  label: string;
  description?: string;
}) {
  return <button {...props} type="button" className={`canvas-icon-button ${props.className ?? ''}`} aria-label={label} title={description ? undefined : title}
    data-tip-heading={description ? title : undefined} aria-description={description}>
    <CanvasIcon name={icon} />
  </button>;
}
