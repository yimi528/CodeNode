#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TRACK_LABELS } = require('../lib/eval-quality.cjs');
const ROOT = path.resolve(__dirname, '../..');

// Without-replacement estimators. Do not substitute (c/n)^k for measured pass^k.
function allSuccess(n, c, k) {
  if (c < k) return 0;
  let value = 1;
  for (let i = 0; i < k; i++) value *= (c - i) / (n - i);
  return value;
}

function metrics(n, c) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(c) || c < 0 || c > n) throw Error('无效试验计数');
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return { k, passAtK: 1 - allSuccess(n, n - c, k), passPowerK: allSuccess(n, c, k) };
  });
}

function aggregate(reports) {
  if (!reports.length) throw Error('缺少报告');
  const first = reports[0];
  const ids = first.tasks.map(t => t.id).sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw Error('任务为空或重复');
  for (const report of reports) {
    for (const key of ['datasetVersion', 'mode', 'model']) {
      if (report[key] !== first[key]) throw Error('试验配置发生变化：' + key);
    }
    if (report.taskQuality?.contractHash !== first.taskQuality?.contractHash || report.taskQuality?.grader?.sha256 !== first.taskQuality?.grader?.sha256 || report.taskQuality?.checkerHash !== first.taskQuality?.checkerHash) throw Error('试验任务或评分器契约发生变化');
    if (report.git.codeFingerprint !== first.git.codeFingerprint) throw Error('试验之间源码发生变化');
    if (JSON.stringify(report.tasks.map(t => t.id).sort()) !== JSON.stringify(ids)) throw Error('试验任务集合不同');
    if (JSON.stringify(report.tasks.map(t => [t.id, t.assessment?.track, t.assessment?.family, t.assessment?.split]).sort()) !== JSON.stringify(first.tasks.map(t => [t.id, t.assessment?.track, t.assessment?.family, t.assessment?.split]).sort())) throw Error('试验任务证据分类发生变化');
  }
  const tasks = ids.map(id => {
    const trials = reports.map(r => r.tasks.find(t => t.id === id));
    const n = trials.filter(t => ['pass', 'fail'].includes(t.status)).length;
    const c = trials.filter(t => t.status === 'pass').length;
    return {
      id, category: trials[0].category, assessment: trials[0].assessment || { track: 'unclassified', evidence: 'unclassified' }, required: trials[0].required !== false,
      attempted: n, passed: c, skipped: trials.filter(t => t.status === 'skipped').length,
      // Skipped trials are unavailable evidence, never a success or a zero-valued score.
      metrics: n === reports.length ? metrics(n, c) : null,
      checkPassRate: trials.map(t => t.checks?.length ? t.checks.filter(c => c.pass).length / t.checks.length : null),
      durationMs: trials.map(t => t.durationMs),
      failures: trials.flatMap((t, i) => t.status === 'pass' ? [] : [{ trial: i + 1, status: t.status, reason: t.reason, failed: t.failed }]),
    };
  });
  const complete = tasks.filter(t => t.metrics);
  const means = Array.from({ length: reports.length }, (_, i) => ({
    k: i + 1, eligibleTasks: complete.length,
    passAtK: complete.length ? complete.reduce((sum, t) => sum + t.metrics[i].passAtK, 0) / complete.length : null,
    passPowerK: complete.length ? complete.reduce((sum, t) => sum + t.metrics[i].passPowerK, 0) / complete.length : null,
  }));
  const groupKeys = [...new Set(tasks.map(t => t.assessment.track + '/' + t.assessment.evidence))];
  const assessmentGroups = groupKeys.map(key => {
    const members = tasks.filter(t => t.assessment.track + '/' + t.assessment.evidence === key);
    const eligible = members.filter(t => t.metrics);
    return { track: members[0].assessment.track, evidence: members[0].assessment.evidence,
      totalTasks: members.length, eligibleTasks: eligible.length,
      means: Array.from({ length: reports.length }, (_, i) => ({ k: i + 1,
        passAtK: eligible.length ? eligible.reduce((sum, t) => sum + t.metrics[i].passAtK, 0) / eligible.length : null,
        passPowerK: eligible.length ? eligible.reduce((sum, t) => sum + t.metrics[i].passPowerK, 0) / eligible.length : null })) };
  });
  return { tasks, means, assessmentGroups, passed: reports.every(r => r.exitCode === 0 && r.harness?.selfChecks?.length && r.harness.selfChecks.every(c => c.pass)) && tasks.filter(t => t.required).every(t => t.passed === reports.length) };
}

function render(report) {
  const pct = v => v == null ? '不可用' : (100 * v).toFixed(1) + '%';
  return [
    '# CodeNode 重复试验评测', '',
    `- 参考：[Anthropic 教程](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)`,
    `- 模式：${report.mode}；每题 ${report.trials} 次；必需任务门禁：${report.passed ? 'PASS' : 'FAIL'}`,
    `- 数据集：${report.datasetVersion}；源码指纹：${report.codeFingerprint}`,
    '- 离线模式只证明脚本化输入下的框架回归；重复运行不能证明模型的随机可靠性。',
    '- 每轮新进程、每题独立工作区。下表按任务等权；跳过的任务不参与均值，覆盖数另列。',
    '- pass@k = 1 − C(n−c,k)/C(n,k)；pass^k = C(c,k)/C(n,k)。k≤n；小样本不支持高置信度泛化。',
    '- 断言通过比例仅用于定位部分完成，所有必需断言仍须通过。', '',
    '## 全部任务的契约诊断汇总', '',
    '下表混合不同轨道，仅保留为兼容诊断统计，不能解释为综合模型能力分。', '',
    '| k | 有效任务数 | pass@k | pass^k |', '| --- | --- | --- | --- |',
    ...report.means.map(m => `| ${m.k} | ${m.eligibleTasks} | ${pct(m.passAtK)} | ${pct(m.passPowerK)} |`), '',
    '## 按轨道解释证据', '',
    '| 轨道 | 证据 | 完整覆盖任务/计划任务 | k | pass@k | pass^k |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.assessmentGroups.flatMap(g => g.means.map(m => `| ${TRACK_LABELS[g.track] || g.track} | ${g.evidence} | ${g.eligibleTasks}/${g.totalTasks} | ${m.k} | ${pct(m.passAtK)} | ${pct(m.passPowerK)} |`)), '',
    '| 任务 | 必需 | 成功/尝试 | 跳过 | 各轮断言通过比例 |', '| --- | --- | --- | --- | --- |',
    ...report.tasks.map(t => `| ${t.id} | ${t.required ? '是' : '否'} | ${t.passed}/${t.attempted} | ${t.skipped} | ${t.checkPassRate.map(pct).join(' / ')} |`), '',
    '## 失败与轨迹复核', '',
    ...report.tasks.filter(t => t.failures.length).map(t => `- ${t.id}: ${JSON.stringify(t.failures)}`),
    ...report.runs.map(r => `- [第 ${r.trial} 轮原始报告](${r.report})；退出码 ${r.exitCode}；轨迹与终态：trial-${r.trial}/artifacts/*/eval-transcript.json。`), '',
    '- 人工需复核失败题及抽样成功题，确认题面、断言和终态一致；本报告不自动声称已完成专家校准。', '',
  ].join('\n');
}

function main(argv) {
  let trials = 3;
  let output;
  const forwarded = [];
  for (const arg of argv) {
    if (arg.startsWith('--trials=')) trials = Number(arg.slice(9));
    else if (arg.startsWith('--report-dir=')) output = path.resolve(arg.slice(13));
    else if (/^--(?:mode=|task=|subset=|cases=)/.test(arg) || arg === '--require-model') forwarded.push(arg);
    else throw Error('未知参数：' + arg);
  }
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw Error('--trials 必须为 1 到 20');
  if (!output) {
    const parent = path.join(ROOT, 'docs/eval-reports');
    fs.mkdirSync(parent, { recursive: true });
    output = fs.mkdtempSync(path.join(parent, 'agent-repeat-'));
  } else fs.mkdirSync(output, { recursive: true });
  const reports = [], runs = [];
  for (let i = 1; i <= trials; i++) {
    const dir = path.join(output, `trial-${i}`);
    fs.mkdirSync(dir); // Never overwrite previous evidence.
    const log = fs.openSync(path.join(dir, 'runner.log'), 'w');
    let child;
    try {
      child = spawnSync(process.execPath, [path.join(__dirname, 'agent-eval.cjs'), ...forwarded, '--keep', '--report-dir=' + dir], { cwd: ROOT, stdio: ['ignore', log, log] });
    } finally { fs.closeSync(log); }
    const files = fs.readdirSync(dir).filter(f => /^agent-eval-.*\.json$/.test(f));
    if (files.length !== 1) throw Error(`第 ${i} 轮缺少唯一报告，请查看 ${dir}/runner.log`);
    const file = path.join(dir, files[0]);
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Move retained fixtures/logs into the evidence directory before cleaning temp files.
    if (report.workRoot) {
      const original = path.resolve(report.workRoot);
      if (path.dirname(original) !== fs.realpathSync(os.tmpdir()) && path.dirname(original) !== path.resolve(os.tmpdir())) throw Error('异常临时工作区');
      if (!path.basename(original).startsWith('codenode-eval-')) throw Error('异常临时工作区前缀');
      const saved = path.join(dir, 'artifacts');
      fs.cpSync(original, saved, { recursive: true });
      for (const task of report.tasks) if (task.workspace) task.workspace = path.join(saved, path.relative(original, task.workspace));
      report.workRoot = saved;
      fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
      fs.rmSync(original, { recursive: true, force: true });
    }
    // A child crash or harness error must never disappear behind passing task records.
    report.exitCode = child.status === 0 ? report.exitCode : (child.status || 1);
    reports.push(report);
    runs.push({ trial: i, exitCode: report.exitCode, report: path.relative(output, file) });
    console.log(`trial ${i}/${trials}: ${report.totals.passed}/${report.totals.run}, exit=${report.exitCode}`);
  }
  const summary = {
    schemaVersion: 2, startedAt: reports[0].startedAt, finishedAt: new Date().toISOString(),
    trials, mode: reports[0].mode, datasetVersion: reports[0].datasetVersion,
    codeFingerprint: reports[0].git.codeFingerprint, runs, ...aggregate(reports),
  };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'summary.md'), render(summary));
  console.log(path.join(output, 'summary.md'));
  return summary.passed ? 0 : 1;
}

module.exports = { metrics, aggregate };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
