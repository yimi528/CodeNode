import { nodePresentation } from './presentation';

export function NodeIcon({ type }: { type?: string }) {
  const { path, color } = nodePresentation(type);
  return <svg className="node-kind-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"
    fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
}
