'use strict';
const { createHash } = require('node:crypto');
const { captureInputs } = require('./codeVerification.cjs');
const PREFIX = '【系统提示】无进展检测：';
const WAIT_TOOLS = new Set(['ask_user', 'delegate_task', 'delegate_tasks', 'cancel_subagent_task', 'ui_control']);
const ACTIVE = new Set(['running', 'pending', 'queued', 'waiting', 'working', 'in_progress', 'cancelling']);
const digest = value => createHash('sha256').update(value).digest('hex');

/** @param {{root?: string|null, limits?: any, canonicalArgs: Function, emitTrace: Function, onDelta?: Function, signal?: AbortSignal, snapshot?: Function}} options */
function createGuard({ root, limits = {}, canonicalArgs, emitTrace, onDelta, signal, snapshot = captureInputs }) {
  let cursor = 0, stalled = 0, warnings = 0, epoch = null, workspace = null;
  const seen = new Map(), paths = new Set(), versions = new Map();
  const threshold = Math.max(2, Math.min(20, Math.floor(Number(limits.noProgressRounds) || 3)));
  const neutralize = messages => {
    const message = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(PREFIX));
    if (message) message.content = PREFIX + '检测计数已重置，请根据最新证据继续推进任务。';
  };
  const reset = messages => { stalled = 0; seen.clear(); workspace = null; neutralize(messages); };
  return {
    update(messages, records, currentEpoch) {
      if (limits.noProgressDetection !== true || signal?.aborted) return;
      if (epoch !== currentEpoch) { reset(messages); epoch = currentEpoch; }
      const round = records.slice(cursor); cursor = records.length;
      if (!round.length) return; // Final prose and provider retries are not tool rounds.
      if (round.some(r => WAIT_TOOLS.has(r.name) || ACTIVE.has(r.data?.status) || ACTIVE.has(r.data?.task?.status))) {
        reset(messages);
        emitTrace({ kind: 'no_progress_observation', reason: 'waiting-or-interaction', stalledRounds: 0 });
        return;
      }
      let versionChanged = false;
      for (const record of round) {
        if (record.data?.path && paths.size < 128) paths.add(String(record.data.path));
        const version = record.data?.sourceSha256 || record.data?.sha256;
        if (record.ok !== false && record.data?.path && version) {
          const file = String(record.data.path);
          if (versions.get(file) !== version) versionChanged = true;
          versions.delete(file); versions.set(file, version);
          if (versions.size > 128) versions.delete(versions.keys().next().value);
        }
      }
      if (versionChanged) reset(messages);
      // A shell can change code even when stdout/exit code stay identical. Reuse the bounded
      // verification snapshot; incomplete snapshots suppress warnings instead of guessing.
      if (round.some(r => r.name === 'execute_shell' || r.name === 'poll_job')) {
        let current;
        try { current = root ? snapshot(root, [...paths]) : null; } catch { current = null; }
        if (!current?.complete) {
          reset(messages);
          emitTrace({ kind: 'no_progress_observation', reason: 'workspace-version-unknown', stalledRounds: 0 });
          return;
        }
        if (workspace !== current.fingerprint) { reset(messages); workspace = current.fingerprint; }
      }
      const signatures = round.map(record => {
        const data = record.data || {};
        return digest(JSON.stringify({ tool: record.name, args: canonicalArgs(record.args), ok: record.ok,
          error: record.failure?.code || data.code, exitCode: data.exitCode, status: data.status,
          source: data.sourceSha256 || data.sha256, result: digest(String(data.output ?? record.result ?? '')) }));
      });
      const repeated = signatures.every(key => seen.has(key));
      for (const key of signatures) {
        seen.delete(key); seen.set(key, true);
        if (seen.size > 128) seen.delete(seen.keys().next().value);
      }
      if (repeated) stalled++; else { stalled = 0; neutralize(messages); }
      emitTrace({ kind: 'no_progress_observation', reason: repeated ? 'repeated-action-and-result' : 'new-evidence', stalledRounds: stalled });
      if (!repeated || stalled < threshold || stalled % threshold !== 0 || warnings >= 2) return;
      warnings++;
      const text = PREFIX + '连续 ' + stalled + ' 个工具轮次重复既有参数和结果，尚未观察到新证据；这不是任务失败判定。' +
        '下一步先说明哪些已有证据支持当前假设，再选择一种不同策略：缩小复现、检查调用链、验证另一假设或调整针对性测试。' +
        '避免原样重复同一无效操作；代码已改变后的复测、确有必要的等待仍可继续。';
      const previous = messages.findIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(PREFIX));
      if (previous >= 0) messages[previous] = { role: 'user', content: text };
      else messages.push({ role: 'user', content: text });
      const event = { kind: 'no_progress_detected', stalledRounds: stalled, threshold, warning: warnings,
        tools: [...new Set(round.map(r => String(r.name).slice(0, 80)))], action: 'strategy-hint' };
      emitTrace(event); onDelta?.(event);
    },
  };
}

module.exports = { createGuard, PREFIX };
