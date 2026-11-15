'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dataset = require('../eval/agent-eval-tasks.cjs');
const { validateTasks, runQualityChecks, assessmentFor, summarizeAssessments } = require('../lib/eval-quality.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const coding = dataset.tasks.find(t => t.id === 'coding-known-location');

assert.equal(validateTasks(dataset.tasks).pass, true);
assert.equal(validateTasks([]).pass, false);
assert.equal(validateTasks([null]).pass, false);
for (const mutate of [
  task => { delete task.evaluation; },
  task => { task.id = 123; },
  task => { task.evaluation.track = 'magic'; },
  task => { task.evaluation.limitations = ''; },
  task => { task.evaluation.review = 'independent-reviewed'; },
  task => { task.fixture['../escaped.cjs'] = 'bad'; },
  task => { task.reference['../escaped.cjs'] = 'bad'; },
  task => { task.behaviorCases[0].module = '../escaped.cjs'; },
  task => { task.behaviorCases[0].expected = null; },
  task => { task.checks = []; },
  task => { task.checks = {}; },
  task => { task.checks = [null]; },
  task => { task.behaviorCases = [null]; },
  task => { task.calibration = [null]; },
  task => { task.fixture['bad\0file'] = 'bad'; },
  task => { task.calibration = []; },
  task => { task.calibration = {}; },
  task => { task.budget.timeoutMs = 0; },
]) {
  const task = copy(coding); mutate(task);
  assert.equal(validateTasks([task]).pass, false, JSON.stringify(task));
}
assert.equal(validateTasks([coding, coding]).pass, false);
assert.equal(validateTasks([coding], new Set(['not-a-grader'])).pass, false);
const quality = runQualityChecks(dataset.tasks);
assert.equal(quality.pass, true, JSON.stringify(quality));
assert.equal(quality.tasks.filter(t => t.calibrationStatus === 'automated-pass').length, dataset.tasks.filter(t => t.evaluation.track === 'coding').length);
assert.ok(quality.tasks.every(t => t.review === 'unreviewed'), '不能将自动校准冒充独立人工审查');
assert.equal(quality.tasks.find(t => t.id === 'long-context-compression').track, 'mechanism');
const wrongReference = copy(coding); wrongReference.reference = { ...wrongReference.fixture };
const rejected = runQualityChecks([wrongReference]);
assert.equal(rejected.pass, false);
assert.equal(rejected.tasks[0].checks.find(c => c.id === 'reference').actual, 'fail');
const alreadyFixed = copy(coding); Object.assign(alreadyFixed.fixture, alreadyFixed.reference);
assert.equal(runQualityChecks([alreadyFixed]).tasks[0].checks.find(c => c.id === 'initial').pass, false);
const brokenEquivalent = copy(coding);
brokenEquivalent.calibration[0].files = { 'src/math.cjs': 'exports.add=()=>0; exports.mul=()=>0;' };
assert.equal(runQualityChecks([brokenEquivalent]).pass, false);


const offline = assessmentFor(coding, 'offline', 'pass');
assert.equal(offline.evidence, 'scripted-regression');
assert.equal(assessmentFor(coding, 'model', 'pass').evidence, 'model-coding-outcome');
assert.equal(assessmentFor(coding, 'model', 'skipped').evidence, 'not-executed');
const mechanism = dataset.tasks.find(t => t.id === 'long-context-compression');
assert.equal(assessmentFor(mechanism, 'model', 'pass').evidence, 'model-contract-outcome');
const groups = summarizeAssessments([
  { status: 'pass', assessment: offline },
  { status: 'fail', assessment: assessmentFor(coding, 'model', 'fail') },
  { status: 'skipped', assessment: assessmentFor(coding, 'model', 'skipped') },
]);
assert.equal(groups.length, 3);
assert.equal(groups.find(g => g.evidence === 'model-coding-outcome').passed, 0);
assert.equal(groups.find(g => g.evidence === 'not-executed').skipped, 1);

// 真实 runner 的 model 模式：坏参考修复在 API 调用和 Agent 工具执行前被拦截。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-quality-integration-'));
try {
  const marker = path.join(temp, 'model-called');
  const runner = require.resolve('../eval/agent-eval.cjs');
  const code = `
    const fs = require('node:fs');
    global.fetch = async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw Error('unexpected model call'); };
    const data = require(${JSON.stringify(require.resolve('../eval/agent-eval-tasks.cjs'))});
    const task = data.tasks.find(t => t.id === 'coding-known-location');
    task.reference = { ...task.fixture };
    process.argv = [process.execPath, ${JSON.stringify(runner)}, '--mode=model', '--require-model', '--task=coding-known-location', ${JSON.stringify('--report-dir=' + temp)}];
    require(${JSON.stringify(runner)});
  `;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CODENODE_EVAL_API_KEY: 'synthetic-quality-test', CODENODE_EVAL_BASE_URL: 'http://127.0.0.1:9' } });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.equal(fs.existsSync(marker), false, '质量检查失败不能调用真实模型');
  const report = JSON.parse(fs.readFileSync(path.join(temp, fs.readdirSync(temp).find(f => f.endsWith('.json'))), 'utf8'));
  assert.equal(report.taskQuality.pass, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.tasks[0].status, 'skipped');
  assert.equal(report.tasks[0].assessment.evidence, 'not-executed');
  assert.equal(report.tasks[0].workspace, undefined);
  assert.ok(report.harness.selfChecks.some(c => !c.pass));
  assert.match(child.stderr, /任务质量检查失败/);

  // 旧版外部项目任务使用保守的 workflow 分类；用独立本地仓库避免宿主 partial clone 影响。
  const repo = path.join(temp, 'repository');
  fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'electron'));
  fs.writeFileSync(path.join(repo, 'config/goal.task-priorities.json'), '{"default":"normal"}');
  fs.writeFileSync(path.join(repo, 'electron/goalTaskPriority.cjs'), "exports.normalize = () => require('../config/goal.task-priorities.json').default;\n");
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', 'commit', '--quiet', '-m', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/project-eval.example.json'), 'utf8'));
  cases.tasks[0].repository = { path: repo, commit };
  const casesFile = path.join(temp, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  const reports = path.join(temp, 'repository-reports');
  const project = spawnSync(process.execPath, [runner, '--cases=' + casesFile, '--report-dir=' + reports], { encoding: 'utf8', timeout: 30000 });
  assert.equal(project.status, 0, project.stdout + project.stderr);
  const projectReport = JSON.parse(fs.readFileSync(path.join(reports, fs.readdirSync(reports).find(f => f.endsWith('.json'))), 'utf8'));
  assert.equal(projectReport.tasks[0].assessment.track, 'workflow');
  assert.equal(projectReport.tasks[0].assessment.evidence, 'scripted-regression');
  assert.equal(projectReport.tasks[0].assessment.review, 'unreviewed');

} finally { fs.rmSync(temp, { recursive: true, force: true }); }

console.log(`EVAL QUALITY: PASS (${quality.tasks.length} task contracts, ${quality.tasks.reduce((n,t) => n+t.checks.length,0)} calibration candidates, model-call guard)`);
