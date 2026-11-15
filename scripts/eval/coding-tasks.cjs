'use strict';

const math = `'use strict';
function add(a, b) { return a - b; }
function mul(a, b) { return a * b; }
module.exports = { add, mul };
`;
const publicTest = `'use strict';
const assert = require('node:assert/strict');
const { add, mul } = require('../src/math.cjs');
assert.equal(add(2, 3), 5);
assert.equal(mul(4, 5), 20);
console.log('PUBLIC TESTS PASS');
`;
const behaviorCases = [[2,3],[-7,2],[0,0],[1.5,2.25],[100,-9],[-3,-4]].flatMap(([a,b], i) => [
  { id: 'add-' + i, module: 'src/math.cjs', export: 'add', args: [a,b], expected: a+b },
  { id: 'mul-' + i, module: 'src/math.cjs', export: 'mul', args: [a,b], expected: a*b },
]);
const crossCases = [
  { id: 'total-quantities', module: 'src/cart.cjs', export: 'total', args: [[{price:2,quantity:3},{price:1.5,quantity:2}]], expected: 9 },
  { id: 'total-empty', module: 'src/cart.cjs', export: 'total', args: [[]], expected: 0 },
  { id: 'total-zero', module: 'src/cart.cjs', export: 'total', args: [[{price:10,quantity:0}]], expected: 0 },
  { id: 'format-empty', module: 'src/format.cjs', export: 'formatTotal', args: [[]], expected: '0.00' },
  { id: 'format-quantity', module: 'src/format.cjs', export: 'formatTotal', args: [[{price:2.5,quantity:3}]], expected: '7.50' },
  { id: 'format-multiple', module: 'src/format.cjs', export: 'formatTotal', args: [[{price:1.25,quantity:2},{price:0.5,quantity:1}]], expected: '3.00' },
];
const referenceMath = math.replace('return a - b;', 'return a + b;');
const equivalentMath = "const plus = require('./plus.cjs');\nexports.add = plus; exports.mul = (x,y) => x*y;\n";
const calibration = [
  { id: 'equivalent-helper', expected: 'pass', files: { 'src/math.cjs': equivalentMath, 'src/plus.cjs': 'module.exports = (x,y) => x+y;\n' } },
  { id: 'hardcoded-public', expected: 'fail', files: { 'src/math.cjs': 'exports.add = () => 5; exports.mul = (a,b) => a*b;\n' } },
  { id: 'mul-regression', expected: 'fail', files: { 'src/math.cjs': 'exports.add = (a,b) => a+b; exports.mul = () => 20;\n' } },
  { id: 'forged-success', expected: 'fail', files: { 'src/math.cjs': "console.log('CODING ACCEPTANCE PASS'); process.exit(0);\n" } },
  { id: 'tampered-tests', expected: 'fail', files: { 'test/public.cjs': "console.log('PUBLIC TESTS PASS');\n" } },
];
const editMath = { tool: 'edit_file', args: { path: 'src/math.cjs', oldText: 'return a - b;', newText: 'return a + b;' } };
const runTests = { tool: 'execute_shell', args: { command: 'node test/public.cjs', timeoutSeconds: 30 } };
const base = {
  category: 'coding', required: true, realModel: true,
  allowTools: ['read_file', 'edit_file', 'write_file', 'execute_shell', 'search_files', 'list_directory', 'find_files'],
  budget: { maxSteps: 16, timeoutMs: 120000, maxToolCalls: 24 },
  modelBudget: { maxSteps: 24, timeoutMs: 180000, maxToolCalls: 36 },
  fixture: { 'src/math.cjs': math, 'test/public.cjs': publicTest },
  behaviorCases,
  reference: { 'src/math.cjs': referenceMath },
  calibration,
  evaluation: {
    track: 'coding', family: 'math-cart', split: 'development',
    objective: '从计算错误定位并修复代码，保持公开接口兼容',
    limitations: '同源微型项目；不覆盖大型仓库理解，也不是保留集泛化证据',
    review: 'unreviewed',
  },
  checks: [{ type: 'coding-behavior' }],
  // 过程指标失败不会影响能力通过率。
  observations: [{ type: 'tool-success-output', tool: 'execute_shell', text: 'PUBLIC TESTS PASS' }],
  notes: '离线只验证参考轨迹与评分器接线；真实模型通过才提供该配置下的编码能力证据。',
};
module.exports = [
  {
    ...base, id: 'coding-known-location', title: '编码：已知位置的加法修复',
    prompt: 'src/math.cjs 的 add(2,3) 返回 -1，应返回 5。修复加法，保持 mul 行为与导出接口兼容。可运行 node test/public.cjs 验证。不要修改测试。',
    script: [{ tool: 'read_file', args: { path: 'src/math.cjs' } }, editMath, runTests, { content: '已修复并验证。' }],
  },
  {
    ...base, id: 'coding-error-localization', title: '编码：从失败测试定位加法根因',
    prompt: '用户报告计算结果不对，运行 node test/public.cjs 得到 AssertionError: -1 !== 5。请定位根因并修复，保持已有 API 兼容，不要修改测试。',
    script: [runTests, { tool: 'read_file', args: { path: 'test/public.cjs' } }, { tool: 'read_file', args: { path: 'src/math.cjs' } }, editMath, runTests, { content: '已定位并修复。' }],
  },
  {
    ...base, id: 'coding-cross-file', title: '编码：购物车总价与格式接口跨文件实现',
    prompt: '修复购物车总价，并新增 formatTotal(items) 导出：累加每项 price * quantity 后返回两位小数字符串。空购物车返回 "0.00"，quantity=0 不计价。保留 total、add、mul 的现有导出及数字返回类型。输入为有限非负 price 和非负整数 quantity；无需新增输入校验。可运行 node test/public.cjs。不要修改测试。',
    fixture: {
      ...base.fixture,
      'src/cart.cjs': "const { add } = require('./math.cjs');\nfunction total(items) { return items.reduce((sum, item) => add(sum, item.price), 0); }\nmodule.exports = { total };\n",
      'src/format.cjs': "module.exports = {};\n",
      'test/public.cjs': publicTest.replace("console.log('PUBLIC TESTS PASS');\n", '') + "const { total } = require('../src/cart.cjs');\nassert.equal(total([{price:2,quantity:3}]), 6);\nconst { formatTotal } = require('../src/format.cjs');\nassert.equal(formatTotal([]), '0.00');\nconsole.log('PUBLIC TESTS PASS');\n",
    },
    behaviorCases: [...behaviorCases, ...crossCases],
    reference: {
      'src/math.cjs': referenceMath,
      'src/cart.cjs': "const { add, mul } = require('./math.cjs');\nexports.total = items => items.reduce((s,r) => add(s,mul(r.price,r.quantity)),0);\n",
      'src/format.cjs': "const { total } = require('./cart.cjs');\nexports.formatTotal = items => total(items).toFixed(2);\n",
    },
    calibration: [...calibration,
      { id: 'zero-quantity', expected: 'fail', files: { 'src/cart.cjs': 'exports.total = rows => rows.reduce((s,r) => s+r.price*(r.quantity || 1),0);\n' } },
      { id: 'empty-only', expected: 'fail', files: { 'src/format.cjs': "exports.formatTotal = () => '0.00';\n" } },
    ],
    script: [
      { tool: 'read_file', args: { path: 'src/math.cjs' } },
      { tool: 'read_file', args: { path: 'src/cart.cjs' } },
      { tool: 'read_file', args: { path: 'src/format.cjs' } }, editMath,
      { tool: 'edit_file', args: { path: 'src/cart.cjs', oldText: 'add(sum, item.price)', newText: 'add(sum, item.price * item.quantity)' } },
      { tool: 'edit_file', args: { path: 'src/format.cjs', oldText: 'module.exports = {};', newText: "const { total } = require('./cart.cjs');\nfunction formatTotal(items) { return total(items).toFixed(2); }\nmodule.exports = { formatTotal };" } },
      runTests, { content: '已完成总价和格式接口并验证。' },
    ],
  },
];
