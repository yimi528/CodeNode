const TYPE_ACCENT: Record<string, string> = {
  start: '#22c55e',
  end: '#ef4444',
  task: '#3b82f6',
  stage: '#8b5cf6',
  tool: '#f59e0b',
  file: '#f97316',
  scope: '#8b5cf6',
  object: '#06b6d4',
  vector: '#21aba3',
};

const TYPE_MARK: Record<string, string> = {
  start: '▶', end: '■', task: '◆', stage: '▦', tool: '⚙',
  file: 'F', image: '▣', scope: '▣', object: '◇', vector: '▧',
};

export function workflowNodeAccent(type: string | undefined, accent?: unknown): string {
  return (typeof accent === 'string' && accent) || TYPE_ACCENT[type || ''] || '#3b82f6';
}

export function workflowNodeMark(type?: string): string {
  return TYPE_MARK[type || ''] || '◇';
}
