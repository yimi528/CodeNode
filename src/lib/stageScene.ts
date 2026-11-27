export type StageFile = { path: string; kind: 'added' | 'modified' | 'deleted'; reverted: boolean };

export type StageEvidence = {
  attemptId: string;
  runId: string | null;
  phase: 'done' | 'failed';
  output: string;
  upstream: string[];
  files: StageFile[];
  fileCount: number;
  changesComplete: boolean;
  verification: { passed: number; failed: number; total: number; historical: boolean } | null;
};
export type StageRecord = { nodeId: string; evidence: StageEvidence };
export type SceneStage = { id: string; title: string };

const components = {
  frontend: '界面',
  api: '服务 / API',
  database: '数据库',
  cache: '缓存',
  config: '配置',
  tests: '测试',
  files: '项目文件',
};

export type ComponentKind = keyof typeof components;
export type StageComponent = { kind: ComponentKind; label: string; files: StageFile[]; state: 'added' | 'affected' | 'historical' };
export type SceneComponent = { kind: ComponentKind; label: string; change: 'added' | 'affected' | null };

function componentKind(file: string): ComponentKind {
  const name = file.toLowerCase();
  if (/(^|\/)(tests?|__tests__|specs?|e2e)(\/|$)|\.(test|spec)\.[^.]+$/.test(name)) return 'tests';
  if (/(^|\/)(db|database|migrations|prisma|schema)(\/|$)|\.(sql|prisma)$/.test(name)) return 'database';
  if (/(^|\/)(cache|caching|redis)(\/|$)|(^|\/)redis\.[^/]+$/.test(name)) return 'cache';
  if (/(^|\/)(api|routes|server|services|controllers|backend)(\/|$)/.test(name)) return 'api';
  if (/(^|\/)(components|ui|frontend|views|pages|styles)(\/|$)|\.(tsx|jsx|css|html|vue|svelte|scss)$/.test(name)) return 'frontend';
  if (/(^|\/)(config|\.github|\.env[^/]*)(\/|$)|\.(ya?ml|toml|ini)$|(^|\/)(package\.json|[^/]+\.config\.[^.]+)$/.test(name)) return 'config';
  return 'files';
}

export function stageComponents(files: StageFile[]): StageComponent[] {
  const groups = new Map<ComponentKind, StageFile[]>();
  for (const file of files) {
    const kind = componentKind(file.path);
    const group = groups.get(kind);
    if (group) group.push(file);
    else groups.set(kind, [file]);
  }
  return (Object.keys(components) as ComponentKind[]).flatMap(kind => {
    const items = groups.get(kind);
    if (!items) return [];
    const active = items.filter(file => !file.reverted);
    return [{
      kind,
      label: components[kind],
      files: items,
      state: !active.length ? 'historical' : active.every(file => file.kind === 'added') ? 'added' : 'affected',
    }];
  });
}

export function sceneAtStage(timeline: StageRecord[], nodeId: string): SceneComponent[] {
  const current = timeline.findIndex(record => record.nodeId === nodeId);
  const live = new Map<string, ComponentKind>();
  for (let index = 0; index < (current < 0 ? timeline.length : current); index++) {
    for (const file of timeline[index].evidence.files) {
      if (file.reverted) continue;
      if (file.kind === 'deleted') live.delete(file.path);
      else live.set(file.path, componentKind(file.path));
    }
  }
  const existing = new Set(live.values());
  const changes = current < 0 ? [] : stageComponents(timeline[current].evidence.files);
  return (Object.keys(components) as ComponentKind[]).flatMap<SceneComponent>(kind => {
    const change = changes.find(item => item.kind === kind)?.state;
    if (change === 'added' || change === 'affected') {
      return [{ kind, label: components[kind], change: change === 'added' && !existing.has(kind) ? 'added' : 'affected' }];
    }
    return existing.has(kind) ? [{ kind, label: components[kind], change: null }] : [];
  });
}

export function stageOutcomePreview(output: string): string {
  const lines = output.replace(/^Agent[：:]\s*/, '').split('\n').map(line => line.trim()).filter(Boolean);
  const index = lines.findIndex(line => /^(?:#+\s*)?(?:\*\*)?做了什么/.test(line));
  const action = index < 0 ? lines[0] : lines[index].replace(/^.*?做了什么\**[：:]?\**\s*/, '') || lines[index + 1];
  const text = action?.replace(/^(?:[-*]|\d+[.)])\s+/, '').replace(/\*\*/g, '') || '';
  return text.length > 110 ? text.slice(0, 109) + '…' : text;
}
