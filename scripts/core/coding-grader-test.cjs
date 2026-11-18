'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../eval/coding-tasks.cjs');
const { gradeCoding } = require('../lib/coding-grader.cjs');
let cases = 0;
function scenario(task, mutate, expected, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-grader-test-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const fix = () => {
    // 与参考轨迹不同的等价实现，并使用新增辅助文件。
    write('src/plus.cjs', 'module.exports = (x,y) => x + y;');
    write('src/math.cjs', "const plus = require('./plus.cjs');\nmodule.exports = {add: plus, mul: (x,y) => x*y};");
    if (task.id === 'coding-cross-file') {
      write('src/cart.cjs', 'exports.total = rows => rows.map(r => r.price*r.quantity).reduce((x,y) => x+y,0);');
      write('src/format.cjs', "exports.formatTotal = rows => require('./cart.cjs').total(rows).toFixed(2);");
    }
  };
  try {
    for (const [file, text] of Object.entries(task.fixture)) write(file, text);
    mutate({ root, write, fix });
    const result = gradeCoding(root, task);
    assert.equal(result.pass, expected, label + ': ' + result.detail);
    cases++;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
for (const task of tasks) {
  scenario(task, () => {}, false, '未修复必须失败');
  scenario(task, ({fix}) => fix(), true, '接受等价实现与辅助文件');
  scenario(task, ({fix,write}) => {fix();write('test/public.cjs', "console.log('PUBLIC TESTS PASS');");}, false, '测试被改写不能通过');
  scenario(task, ({fix,write}) => {fix();write('src/math.cjs', 'exports.add = () => 5; exports.mul = (a,b) => a*b;');}, false, '只匹配公开样例不能通过');
  scenario(task, ({fix,write}) => {fix();write('src/math.cjs', 'exports.add = (a,b) => a+b; exports.mul = () => 20;');}, false, '破坏既有行为不能通过');
  scenario(task, ({fix,write}) => {fix();write('src/math.cjs', 'process.exit(0);');}, false, '提前退出不能通过');
  scenario(task, ({fix,write}) => {fix();write('src/math.cjs', "console.log('CODING ACCEPTANCE PASS'); process.exit(0);");}, false, '伪造成功标记后退出不能通过');
  scenario(task, ({fix,write}) => {fix();write('src/math.cjs', "require('node:assert/strict').equal=()=>{}; exports.add=()=>0; exports.mul=()=>0;");}, false, '篡改子进程断言不能影响父进程判分');
  scenario(task, ({root,fix}) => {fix();fs.unlinkSync(path.join(root,'src/math.cjs'));fs.symlinkSync('plus.cjs',path.join(root,'src/math.cjs'));}, false, '拒绝候选符号链接');
  scenario(task, ({root,fix}) => {fix();fs.unlinkSync(path.join(root,'test/public.cjs'));}, false, '删除公开测试不能通过');
}
const cross = tasks[2];
scenario(cross, ({fix,write}) => {fix();write('src/cart.cjs', 'exports.total = rows => rows.reduce((s,r) => s+r.price*(r.quantity || 1),0);');}, false, 'quantity=0 回归必须被捕获');
scenario(cross, ({fix,write}) => {fix();write('src/format.cjs', "exports.formatTotal = () => '0.00';");}, false, '只实现空购物车不能通过');
// 走真实 runner：等价 write_file 修复且不跑公开测试仍能通过；篡改测试必须失败。
const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-grader-integration-'));
try {
  const datasetPath = require.resolve('../eval/agent-eval-tasks.cjs');
  const runnerPath = require.resolve('../eval/agent-eval.cjs');
  const program = `
    const dataset = require(${JSON.stringify(datasetPath)});
    const base = dataset.tasks.find(t => t.id === 'coding-known-location');
    const good = { ...base, id: 'coding-equivalent-no-test', script: [
      { tool: 'write_file', args: { path: 'src/math.cjs', content: 'exports.add=(x,y)=>x+y; exports.mul=(x,y)=>x*y;' } },
      { content: '已修复，未运行公开测试。' }
    ] };
    const bad = { ...base, id: 'coding-tampered-test', script: [
      ...good.script.slice(0,1),
      { tool: 'write_file', args: { path: 'test/public.cjs', content: 'process.exit(0);' } },
      { content: '完成。' }
    ] };
    dataset.tasks.push(good, bad);
    dataset.modelSubsets.calibration = [good.id, bad.id];
    process.argv = [process.execPath, ${JSON.stringify(runnerPath)}, '--subset=calibration', ${JSON.stringify('--report-dir=' + reports)}];
    require(${JSON.stringify(runnerPath)});
  `;
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', program], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  const file = fs.readdirSync(reports).find(name => name.endsWith('.json'));
  assert.ok(file, 'runner must produce a report');
  const report = JSON.parse(fs.readFileSync(path.join(reports, file), 'utf8'));
  assert.ok(report.harness.selfChecks.every(check => check.pass));
  const good = report.tasks.find(task => task.id === 'coding-equivalent-no-test');
  const bad = report.tasks.find(task => task.id === 'coding-tampered-test');
  assert.equal(good.status, 'pass');
  assert.equal(good.observations[0].pass, false, '未主动测试只作观测');
  assert.equal(bad.status, 'fail');
  assert.match(bad.checks[0].detail, /受保护文件被修改/);
  cases += 2;
} finally { fs.rmSync(reports, { recursive: true, force: true }); }
console.log(`CODING GRADER: PASS (${cases} positive/negative scenarios, including runner integration)`);
