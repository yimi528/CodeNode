#!/usr/bin/env node
'use strict';
const dataset = require('./agent-eval-tasks.cjs');
const { runQualityChecks } = require('../lib/eval-quality.cjs');

try {
  const result = runQualityChecks(dataset.tasks);
  for (const issue of result.validation.issues) console.error(`${issue.taskId} ${issue.field}: ${issue.message}`);
  for (const task of result.tasks) {
    console.log(`${task.id}: ${task.pass ? 'PASS' : 'FAIL'} [${task.track}] ${task.calibrationStatus}, review=${task.review}`);
    for (const check of task.checks.filter(c => !c.pass)) console.error(`  ${check.id}: expected=${check.expected}, actual=${check.actual}; ${check.detail}`);
  }
  console.log(`TASK QUALITY: ${result.pass ? 'PASS' : 'FAIL'} | ${result.tasks.length} tasks | 自动检查不替代独立人工复核`);
  process.exitCode = result.pass ? 0 : 1;
} catch (error) { console.error(error.message || error); process.exitCode = 1; }
