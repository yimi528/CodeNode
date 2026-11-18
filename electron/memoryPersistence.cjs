'use strict';

async function persistCandidates(candidates, options = {}) {
  const registry = options.registry || null;
  const context = options.context || null;
  const signal = options.signal || null;
  const results = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (signal && signal.aborted) break;
    if (!candidate || !['project', 'user'].includes(candidate.scope)) {
      results.push({ key: candidate && candidate.key || '', status: 'ambiguous' });
      continue;
    }
    // 工具面收敛后，写入记忆的入口是族工具 `memory`（action=save）；旧名 remember 仍是别名。
    // 这里按**族名**判可见性（别名不在 schema 里，isExposed 查不到）。
    if (!registry || !context || !registry.contains('memory') || !registry.isExposed('memory')) {
      results.push({ key: candidate.key, status: 'unavailable' });
      continue;
    }
    try {
      const saved = await registry.execute('memory', {
        action: 'save',
        content: candidate.content || candidate.key + ' = ' + candidate.value,
        key: candidate.key, memoryKind: candidate.kind, value: candidate.value, scope: candidate.scope,
      }, context);
      results.push({ key: candidate.key, status: saved && saved.ok ? 'saved' : 'not_saved' });
    } catch {
      results.push({ key: candidate.key, status: 'not_saved' });
    }
  }
  return results;
}

module.exports = { persistCandidates };
