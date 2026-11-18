'use strict';
const path = require('node:path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { changedFilesFromToolCalls } = require('./tools/fileChanges.cjs');
const PREFIX = '【系统提示】任务工作状态：\n';
const clip = (value, n = 600) => String(value || '').slice(0, n);
/** @param {{enabled: boolean, root?: string|null, runId?: string, messages: any[], records: any[], plan?: any, verification?: any, emitTrace?: Function}} options */
function update({ enabled, root, runId, messages, records, plan, verification, emitTrace }) {
  if (!enabled) return null;
  const previous = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(PREFIX));
  let historical = null;
  try { historical = previous ? JSON.parse(previous.content.slice(PREFIX.length).split('\n工作规则：')[0]) : null; } catch {}
  const users = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('【系统提示】') && !m.content.startsWith('<compaction>'));
  const current = (plan?.items || []).find(i => i.status === 'in_progress') || (plan?.items || []).find(i => i.status === 'pending');
  const notes = messages.filter(m => m.role === 'assistant' && m.tool_calls?.length && m.content).slice(-1);
  const checks = records.filter(r => r.name === 'execute_shell' || r.name === 'poll_job').slice(-4).map(r => ({ callId: r.callId,
    command: clip(r.data?.command), exitCode: r.data?.exitCode ?? null, status: r.data?.status || (r.ok ? 'returned' : 'failed'),
    output: clip(r.data?.output ?? r.result), historical: false }));
  const state = { version: 1, truncated: false, goal: clip(users[0]?.content || historical?.goal, 2000), latestDirection: clip(users.at(-1)?.content, 1000),
    relevantFiles: [...new Set(records.map(r => r.data?.path).filter(Boolean))].slice(-20),
    hypothesis: { text: clip(current?.hypothesis || notes[0]?.content || historical?.hypothesis?.text), status: 'unverified-model-statement' },
    changes: changedFilesFromToolCalls(records),
    checks: checks.length ? checks : (Array.isArray(historical?.checks) ? historical.checks : []).slice(-4).map(c => ({ command: clip(c?.command), output: clip(c?.output), exitCode: c?.exitCode ?? null, historical: true })),
    verification: verification ? { status: verification.status, verified: verification.verified === true } : { status: 'not_provided', verified: false },
    nextStep: clip(current?.step || '构造或更新最小复现，执行针对性验证，再按具体反例调整修改。'),
    evidence: records.slice(-8).map(r => ({ callId: r.callId, tool: r.name, ok: r.ok, sourceSha256: r.data?.sourceSha256 || r.data?.sha256 || null })) };
  if (!records.length && historical) {
    state.relevantFiles = (Array.isArray(historical.relevantFiles) ? historical.relevantFiles : []).slice(-20).map(p => clip(p, 300));
    state.changes = (Array.isArray(historical.changes) ? historical.changes : []).slice(-20).map(p => clip(p, 300));
  }
  // runCheckpoint caps individual messages at 6000 characters. Keep this JSON valid below it.
  if (JSON.stringify(state).length > 5000) {
    state.goal = clip(state.goal, 1000); state.latestDirection = clip(state.latestDirection, 600);
    state.hypothesis.text = clip(state.hypothesis.text, 300);
    state.relevantFiles = state.relevantFiles.slice(-5).map(p => clip(p, 160));
    state.changes = state.changes.slice(-5).map(p => clip(p, 160));
    state.checks = state.checks.slice(-1).map(c => ({ command: clip(c.command, 200), output: clip(c.output, 200), exitCode: c.exitCode, historical: c.historical }));
    state.evidence = state.evidence.slice(-3).map(e => ({ callId: clip(e.callId, 64), tool: clip(e.tool, 64), ok: e.ok, sourceSha256: clip(e.sourceSha256, 80) }));
    state.truncated = true;
    while (JSON.stringify(state).length > 5000 && state.relevantFiles.length) state.relevantFiles.shift();
    while (JSON.stringify(state).length > 5000 && state.changes.length) state.changes.shift();
  }
  const content = PREFIX + JSON.stringify(state) + '\n工作规则：先定位入口→最小复现或可执行验收点→小范围修改→针对性测试→必要回归。假设尚未核实；命令返回和历史检查不等于当前版本已通过，精确需求与原始证据优先。';
  if (previous) previous.content = content; else messages.push({ role: 'user', content });
  if (root && runId) {
    try {
      const safe = String(runId).replace(/[^A-Za-z0-9._-]/g, '_');
      const target = require('./tools/impl/shared.cjs').resolveInRoot(root, '.codenode/runs/' + safe + '.working-state.json');
      if (!target) throw new Error('Working-state path escapes project');
      atomicWriteFile(target, JSON.stringify(state, null, 2));
    } catch { emitTrace?.({ kind: 'working_state_persistence_failed' }); }
  }
  emitTrace?.({ kind: 'working_state_updated', evidence: state.evidence.length, checks: state.checks.length, verification: state.verification.status });
  return state;
}
module.exports = { update, PREFIX };
