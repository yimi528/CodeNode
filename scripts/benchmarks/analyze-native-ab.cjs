'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function readArm(entry) {
  if (!entry.result_path) return null;
  const file = path.join(path.dirname(entry.result_path), 'agent', 'codenode.jsonl');
  const raw = fs.existsSync(entry.result_path) ? JSON.parse(fs.readFileSync(entry.result_path, 'utf8')) : {};
  const events = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const final = events.filter(e => e.kind === 'result').at(-1), deltas = events.filter(e => e.kind === 'event').map(e => e.delta || {});
  return { resultPath: entry.result_path, originalReward: entry.original_reward, gradingStatus: entry.grading_status, finished: !!(raw.finished_at || entry.finished_at),
    agentStarted: !!final || !!raw.agent_execution?.started_at,
    state: final?.state || null, iterations: final?.iterations ?? null,
    mainUsageTokens: final?.usage?.total_tokens ?? null, ledgerTokens: final?.cost?.totalTokens ?? null, ledgerContainsEstimates: final?.cost?.estimated ?? null,
    requestTimeout: deltas.some(e => e.kind === 'error' && /超过.*总时长上限|timed? ?out/i.test(String(e.error || ''))),
    stopReason: deltas.filter(e => e.kind === 'limit_reached').at(-1)?.stopReason || null,
    compactions: deltas.filter(e => e.kind === 'compacted' && e.ok).length,
    noProgressHints: deltas.filter(e => e.kind === 'no_progress_detected').length };
}
function analyze(directory) {
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
  const cases = [];
  for (const row of result.cases) {
    const arms = {};
    for (const [arm, entry] of Object.entries(row.arms)) {
      const value = readArm(entry); if (value) arms[arm] = value;
    }
    cases.push({ task: row.task, arms });
  }
  const setupFile = path.join(directory, 'setup-recovery', 'results.json');
  let setupRecoveredSlots = 0;
  if (fs.existsSync(setupFile)) {
    const recovered = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
    for (const item of recovered.items) {
      if (!item.result_path) continue;
      const row = cases.find(c => c.task === item.task), previous = row?.arms[item.arm];
      if (!row || previous?.agentStarted || previous?.originalReward != null || sha(item.original_result) !== item.original_result_sha256) throw new Error('Invalid preparation-only recovery evidence');
      const original = JSON.parse(fs.readFileSync(item.original_result, 'utf8'));
      if (original.agent_execution?.started_at) throw new Error('An executed agent cannot be replaced');
      const replacement = readArm(item);
      if (replacement) { row.arms[item.arm] = { ...replacement, preparationFailure: previous, setupRecovery: item.result_path }; if (replacement.agentStarted) setupRecoveredSlots++; }
    }
  }
  const gradingDir = path.join(directory, 'grading-recovery');
  if (fs.existsSync(gradingDir)) for (const name of fs.readdirSync(gradingDir)) {
    const file = path.join(gradingDir, name, 'recovery.json'); if (!fs.existsSync(file)) continue;
    const recovered = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (recovered.model_requests !== 0 || sha(recovered.checkpoint) !== recovered.checkpoint_sha256) throw new Error('Invalid verifier-only recovery evidence');
    const originalPath = path.join(path.dirname(path.dirname(recovered.checkpoint)), 'result.json');
    const arm = cases.flatMap(c => Object.values(c.arms)).find(a => path.resolve(a.resultPath) === path.resolve(originalPath));
    if (!arm || arm.gradingStatus !== 'startup_failed') throw new Error('Recovery does not correspond to a recorded grading startup failure');
    const checkpoint = JSON.parse(fs.readFileSync(recovered.checkpoint, 'utf8'));
    if (checkpoint.task_sha256 !== recovered.task_sha256 || checkpoint.solved_image !== recovered.image) throw new Error('Recovery source identity mismatch');
    arm.recoveredReward = recovered.reward; arm.gradingRecovery = file;
  }
  const summary = {};
  for (const arm of ['baseline', 'improved']) {
    const values = cases.map(c => c.arms[arm]).filter(Boolean);
    summary[arm] = { planned: plan.cases.length, finished: values.filter(v => v.finished && v.agentStarted).length,
      resolved: values.filter(v => v.originalReward === 1).length,
      resolvedWithGradingRecovery: values.filter(v => (v.recoveredReward ?? v.originalReward) === 1).length,
      gradingStartupFailed: values.filter(v => v.gradingStatus === 'startup_failed').length,
      tokenStops: values.filter(v => v.stopReason === 'token_limit').length,
      requestTimeouts: values.filter(v => v.requestTimeout).length,
      mainUsageTokens: values.reduce((sum, v) => sum + (v.mainUsageTokens || 0), 0),
      ledgerTokensIncludingEstimates: values.reduce((sum, v) => sum + (v.ledgerTokens || 0), 0),
      compactions: values.reduce((sum, v) => sum + v.compactions, 0) };
  }
  const paired = { baselineOnly: 0, improvedOnly: 0, ties: 0, pending: 0 };
  const pairedWithGradingRecovery = { baselineOnly: 0, improvedOnly: 0, ties: 0, pending: 0 };
  for (const row of cases) {
    const a = row.arms.baseline, b = row.arms.improved;
    if (!a?.finished || !b?.finished || !a.agentStarted || !b.agentStarted || a.originalReward == null || b.originalReward == null) paired.pending++;
    else if (a.originalReward > b.originalReward) paired.baselineOnly++;
    else if (b.originalReward > a.originalReward) paired.improvedOnly++;
    else paired.ties++;
    const x = a?.recoveredReward ?? a?.originalReward, y = b?.recoveredReward ?? b?.originalReward;
    if (!a?.finished || !b?.finished || x == null || y == null) pairedWithGradingRecovery.pending++;
    else if (x > y) pairedWithGradingRecovery.baselineOnly++;
    else if (y > x) pairedWithGradingRecovery.improvedOnly++;
    else pairedWithGradingRecovery.ties++;
  }
  const data = { complete: !!result.complete && paired.pending === 0, runtimeSourceSha256: plan.manifest.source_sha256, summary, paired, pairedWithGradingRecovery, cases, setupRecoveredSlots,
    rawEnvironmentSummary: result.summary || null,
    limits: plan.limits, method: 'fixed known tasks, one attempt per arm; joint feature effect, not individual attribution',
    billing: 'Main usage excludes helper-model calls; ledger includes conservative estimates. Neither is a provider invoice.' };
  fs.writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(data, null, 2) + '\n');
  const lines = ['# 原生改进 A/B 分析', '', '状态：' + (data.complete ? '本批首次尝试均已结束。' : '本批尚未结束，以下仅为中间结果。'), '',
    '| 组别 | 已结束 | 首次求解原始评分通过 | 仅恢复评分后通过 | Token 停止 | 请求超时 | 成功主请求 usage Token | 含估算的账本 Token | 压缩次数 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [arm, s] of Object.entries(summary)) lines.push(`| ${arm} | ${s.finished}/${s.planned} | ${s.resolved}/${s.planned} | ${s.resolvedWithGradingRecovery}/${s.planned} | ${s.tokenStops} | ${s.requestTimeouts} | ${s.mainUsageTokens} | ${s.ledgerTokensIncludingEstimates} | ${s.compactions} |`);
  lines.push('', '配对结果：' + JSON.stringify(paired) + '。', '',
    '仅恢复评分后的配对：' + JSON.stringify(pairedWithGradingRecovery) + '。',
    '固定已见题目、单次模型尝试，仅作诊断回归；不代表完整榜单或新题泛化能力。超时保留在原始分数中，不能自动归因为能力差距。',
    '准备阶段 DNS 失败且没有 Agent 执行或模型日志的槽位，使用已验证的同版本离线 Node 归档补齐首次模型尝试；已补齐 ' + setupRecoveredSlots + ' 个。原始环境失败仍单独保留，已执行的 Agent 不重跑。',
    '“仅恢复评分”单列保持原解题代码／镜像／测试不变且不调用模型的评分恢复，不覆盖原始成绩。配对计数仍使用首次评分原值。',
    '主请求 usage 不含辅助模型调用；账本可能含失败／未知 usage 的保守估算。实际金额以供应商账单为准。',
    '本批冻结来源：`' + data.runtimeSourceSha256 + '`；本批启动后的检查点边界修复、schema 精简及默认开关收敛经过离线回归，不混入本批冻结运行时。',
    '推广决定：整组改进未证明稳定完成率收益，保持实验开关、暂不默认推广；缓存失效和恢复正确性的修复保留。该结论不等于各单项功能均无效。',
    '', '[固定计划](plan.json) · [逐题原始结果](results.json) · [详细分析](analysis.json)', '');
  fs.writeFileSync(path.join(directory, 'analysis.md'), lines.join('\n'));
  return data;
}
if (require.main === module) { const result = analyze(path.resolve(process.argv[2])); console.log(JSON.stringify({ complete: result.complete, summary: result.summary, paired: result.paired })); }
module.exports = { analyze };
