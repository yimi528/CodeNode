'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { gradeCoding } = require('./coding-grader.cjs');

const TRACKS = ['mechanism', 'coding', 'workflow', 'reliability'];
const TRACK_LABELS = { mechanism: '机制契约', coding: '编码行为', workflow: '产品流程契约', reliability: '可靠性场景', unclassified: '未分类历史结果' };

function safeRelative(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\0') && !file.includes('\\') &&
    !path.posix.isAbsolute(file) && !/^[a-z]:/i.test(file) &&
    file.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
}

function validateTasks(tasks, checkTypes) {
  const issues = [], ids = new Set();
  const issue = (taskId, field, message) => issues.push({ taskId, field, message });
  if (!Array.isArray(tasks) || !tasks.length) return { pass: false, issues: [{ taskId: '', field: 'tasks', message: '任务集不能为空' }] };
  for (const task of tasks) {
    const id = task?.id || '(missing-id)';
    if (!task || typeof task !== 'object') { issue(id, 'task', '任务必须是对象'); continue; }
    const checks = Array.isArray(task.checks) ? task.checks : [];
    const observations = Array.isArray(task.observations) ? task.observations : [];
    if (task.observations != null && !Array.isArray(task.observations)) issue(id, 'observations', '过程观测必须是数组');
    const behaviors = Array.isArray(task.behaviorCases) ? task.behaviorCases : [];
    const calibrations = Array.isArray(task.calibration) ? task.calibration : [];
    if (typeof task.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id) || ids.has(id)) issue(id, 'id', '任务编号无效或重复');
    ids.add(id);
    for (const key of ['title', 'prompt']) if (typeof task?.[key] !== 'string' || !task[key].trim()) issue(id, key, '必须有非空文本');
    if (typeof task?.realModel !== 'boolean') issue(id, 'realModel', '必须明确真实模型适用性');
    if (task?.realModel === false && (typeof task.modelSkipReason !== 'string' || !task.modelSkipReason.trim())) issue(id, 'modelSkipReason', '脚本专用任务必须解释跳过原因');
    const ev = task?.evaluation;
    if (!TRACKS.includes(ev?.track)) issue(id, 'evaluation.track', '必须明确机制、编码、流程或可靠性轨道');
    for (const key of ['family', 'objective', 'limitations']) if (typeof ev?.[key] !== 'string' || !ev[key].trim()) issue(id, 'evaluation.' + key, '必须声明任务家族、测量目标及边界');
    if (!['development', 'holdout'].includes(ev?.split)) issue(id, 'evaluation.split', '必须声明开发集或保留集');
    if (!['unreviewed', 'independent-reviewed'].includes(ev?.review)) issue(id, 'evaluation.review', '必须明确人工复核状态');
    if (ev?.review === 'independent-reviewed' && (typeof ev.reviewEvidence !== 'string' || !ev.reviewEvidence.trim())) issue(id, 'evaluation.reviewEvidence', '独立复核必须关联证据');
    if (!Array.isArray(task?.allowTools) || !task.allowTools.length || new Set(task.allowTools).size !== task.allowTools.length || task.allowTools.some(tool => typeof tool !== 'string' || !tool)) issue(id, 'allowTools', '必须有非空且不重复的工具清单');
    for (const [label, budget] of [['budget', task?.budget], ['modelBudget', task?.modelBudget]]) {
      if (label === 'modelBudget' && budget == null) continue;
      if (!Number.isFinite(budget?.timeoutMs) || budget.timeoutMs <= 0) issue(id, label, '必须有正数 timeoutMs');
    }
    if (!Array.isArray(task?.checks) || !task.checks.length) issue(id, 'checks', '必须有真实验收条件');
    for (const check of [...checks, ...observations]) {
      if (typeof check?.type !== 'string' || (checkTypes && !checkTypes.has(check.type))) issue(id, 'checks', '未知检查类型：' + check?.type);
    }
    for (const file of Object.keys(task?.fixture || {})) if (!safeRelative(file)) issue(id, 'fixture', '夹具路径越界：' + file);
    if (ev?.track !== 'coding') continue;
    if (!checks.some(c => c?.type === 'coding-behavior')) issue(id, 'checks', '当前 coding 轨道要求评测端行为验收');
    if (!Array.isArray(task.behaviorCases) || !task.behaviorCases.length) issue(id, 'behaviorCases', '必须声明行为输入与期望值');
    const caseIds = new Set();
    for (const test of behaviors) {
      if (!test || typeof test !== 'object') { issue(id, 'behaviorCases', '行为用例必须是对象'); continue; }
      if (!test.id || caseIds.has(test.id)) issue(id, 'behaviorCases', '行为用例编号必须非空且唯一');
      caseIds.add(test.id);
      if (!safeRelative(test.module) || !/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.cjs$/.test(test.module) ||
          !/^[a-zA-Z_$][\w$]*$/.test(test.export) || !Array.isArray(test.args) ||
          !Object.hasOwn(test, 'expected') ||
          !['string', 'number', 'boolean'].includes(typeof test.expected) ||
          (typeof test.expected === 'number' && !Number.isFinite(test.expected))) issue(id, 'behaviorCases', '当前行为协议要求 src 下的 CJS 函数、参数数组和有限标量期望值');
    }
    if (!task.reference || !Object.keys(task.reference).length) issue(id, 'reference', '必须提供参考修复');
    if (!Array.isArray(task.calibration) || !calibrations.some(c => c?.expected === 'pass') || !calibrations.some(c => c?.expected === 'fail')) issue(id, 'calibration', '必须有等价正确实现和错误补丁');
    const calibrationIds = new Set(['initial', 'reference']);
    for (const candidate of calibrations) {
      if (!candidate || typeof candidate !== 'object') { issue(id, 'calibration', '校准候选必须是对象'); continue; }
      if (!candidate.id || calibrationIds.has(candidate.id)) issue(id, 'calibration', '校准编号必须唯一且不能使用保留名');
      calibrationIds.add(candidate.id);
      if (!['pass', 'fail'].includes(candidate.expected) || !candidate.files || !Object.keys(candidate.files).length) issue(id, 'calibration', '必须声明候选文件与预期判定');
    }
    for (const files of [task.reference, ...calibrations.map(c => c?.files)]) {
      for (const [file, text] of Object.entries(files || {})) if (!safeRelative(file) || typeof text !== 'string') issue(id, 'calibration', '候选路径或文本无效：' + file);
    }
  }
  return { pass: issues.length === 0, issues };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function calibrateTask(task) {
  const candidates = [{ id: 'initial', expected: 'fail', files: {}, initial: true },
    { id: 'reference', expected: 'pass', files: task.reference }, ...task.calibration];
  return candidates.map(candidate => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-task-quality-'));
    try {
      const files = { ...task.fixture, ...(candidate.initial ? {} : task.reference), ...candidate.files };
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      const result = gradeCoding(root, task);
      return { id: candidate.id, expected: candidate.expected, actual: result.pass ? 'pass' : 'fail',
        pass: result.pass === (candidate.expected === 'pass'), detail: result.detail };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

/** @param {any[]} tasks @param {{ checkTypes?: Set<string>, checkerSource?: string }} options */
function runQualityChecks(tasks, options = {}) {
  const validation = validateTasks(tasks, options.checkTypes);
  const graderHash = crypto.createHash('sha256');
  for (const name of ['coding-grader.cjs', 'coding-candidate.cjs']) graderHash.update(fs.readFileSync(path.join(__dirname, name)));
  const report = { schemaVersion: 1, pass: validation.pass, validation,
    checkerHash: options.checkerSource ? crypto.createHash('sha256').update(options.checkerSource).digest('hex') : null,
    grader: { id: 'coding-parent-comparison', version: 2, sha256: graderHash.digest('hex') },
    contractHash: crypto.createHash('sha256').update(JSON.stringify(canonical(tasks))).digest('hex'), tasks: [] };
  if (!validation.pass) return report;
  for (const task of tasks) {
    const checks = task.evaluation.track === 'coding' ? calibrateTask(task) : [];
    const pass = checks.every(check => check.pass);
    report.tasks.push({ id: task.id, track: task.evaluation.track, review: task.evaluation.review,
      calibrationStatus: checks.length ? (pass ? 'automated-pass' : 'automated-fail') : 'not-applicable', pass, checks });
    if (!pass) report.pass = false;
  }
  return report;
}

function assessmentFor(task, mode, status) {
  const track = task.evaluation?.track || 'unclassified';
  return { ...task.evaluation, track,
    evidence: status === 'skipped' ? 'not-executed' : mode === 'offline' ? 'scripted-regression' : track === 'coding' ? 'model-coding-outcome' : 'model-contract-outcome' };
}

function summarizeAssessments(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const { track = 'unclassified', evidence = 'unclassified' } = task.assessment || {};
    const key = track + '/' + evidence;
    if (!groups.has(key)) groups.set(key, { track, evidence, total: 0, passed: 0, failed: 0, skipped: 0 });
    const group = groups.get(key);
    group.total++;
    if (['pass', 'fail', 'skipped'].includes(task.status)) group[{ pass: 'passed', fail: 'failed', skipped: 'skipped' }[task.status]]++;
  }
  return [...groups.values()];
}

module.exports = { TRACKS, TRACK_LABELS, validateTasks, runQualityChecks, assessmentFor, summarizeAssessments };
