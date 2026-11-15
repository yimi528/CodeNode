'use strict';
const originals = require('./coding-tasks.cjs');

function task(id, family, prompt, initial, reference, cases, split = 'development') {
  const fixture = { 'src/main.cjs': initial, 'test/public.cjs': `const assert=require('node:assert/strict');const {solve}=require('../src/main.cjs');assert.deepEqual(solve(...${JSON.stringify(cases[0].args)}),${JSON.stringify(cases[0].expected)});console.log('PUBLIC TESTS PASS');\n` };
  return { id, title: prompt.split('。')[0], category: 'coding', required: true, realModel: true, fixture,
    prompt: prompt + '。入口为 src/main.cjs 的 solve，保持该导出；可运行 node test/public.cjs，不要修改测试。',
    evaluation: { track: 'coding', family, split, objective: prompt, limitations: '受控小项目，有限输入契约；不代表真实大型仓库能力', review: 'unreviewed' },
    allowTools: ['read_file','edit_file','write_file','execute_shell','search_files','list_directory','find_files'],
    budget: { maxSteps: 16, timeoutMs: 120000, maxToolCalls: 24 }, modelBudget: { maxSteps: 24, timeoutMs: 180000, maxToolCalls: 36 },
    behaviorCases: cases.map((c,i) => ({ id: id+'-'+i, module:'src/main.cjs', export:'solve', ...c })),
    reference: { 'src/main.cjs': reference },
    calibration: [
      { id:'equivalent-helper',expected:'pass',files:{'src/main.cjs':"exports.solve=require('./helper.cjs').solve;\n",'src/helper.cjs':reference} },
      { id:'wrong-constant',expected:'fail',files:{'src/main.cjs':'exports.solve=()=>987654321;\n'} },
      { id:'forged-marker',expected:'fail',files:{'src/main.cjs':"console.log('CODING ACCEPTANCE PASS');process.exit(0);\n"} },
    ],
    checks: [{type:'coding-behavior'}], observations:[{type:'tool-success-output',tool:'execute_shell',text:'PUBLIC TESTS PASS'}],
    script:[{tool:'read_file',args:{path:'src/main.cjs'}},{tool:'write_file',args:{path:'src/main.cjs',content:reference}},
      {tool:'execute_shell',args:{command:'node test/public.cjs'}},{content:'已修复并验证。'}],
  };
}
/** @type {any[]} */
const tasks = [
  task('coding-timeout-default','config-default','修复超时配置：输入对象的 timeout 为非负整数时原样返回，包括 0；未提供时返回 1000',
    'exports.solve = options => options.timeout || 1000;\n','exports.solve = options => options.timeout === undefined ? 1000 : options.timeout;\n',
    [{args:[{timeout:0}],expected:0},{args:[{}],expected:1000},{args:[{timeout:20}],expected:20}]),
  task('coding-text-normalization','text-normalization','修复短名格式化：输入仅含英文字母和空白，去除首尾空白，转小写，内部连续空白变为一个连字符；全空白返回空字符串',
    'exports.solve = text => text.trim();\n',"exports.solve = text => text.trim().toLowerCase().replace(/\\s+/g,'-');\n",
    [{args:[' A  B '],expected:'a-b'},{args:['  '],expected:''},{args:['Hello\tWORLD'],expected:'hello-world'},{args:['X'],expected:'x'}]),
  task('coding-user-search','user-search','修复用户搜索计数：输入用户数组和搜索词，忽略姓名和搜索词的大小写，统计姓名包含搜索词的用户数；空数组返回 0，空词匹配全部',
    'exports.solve = (users,term) => users.filter(u=>u.name.includes(term)).length;\n',
    'exports.solve = (users,term) => users.filter(u=>u.name.toLowerCase().includes(term.toLowerCase())).length;\n',
    [{args:[[{name:'ALICE'},{name:'Bob'}],'ali'],expected:1},{args:[[],'x'],expected:0},{args:[[{name:'A'},{name:'a'}],''],expected:2},{args:[[{name:'BOB'}],'bo'],expected:1}]),
  task('coding-port-parser','port-parser','修复端口解析：输入字符串只有十进制数字且值在 1 至 65535 时返回数字，否则返回 -1；不接受空白、小数、符号或尾随字符',
    'exports.solve = text => parseInt(text,10);\n',
    "exports.solve = text => /^\\d+$/.test(text) && Number(text)>=1 && Number(text)<=65535 ? Number(text) : -1;\n",
    [{args:['12x'],expected:-1},{args:['8080'],expected:8080},{args:['0'],expected:-1},{args:['65536'],expected:-1},{args:[' 2'],expected:-1},{args:['001'],expected:1}]),
  task('coding-inventory-total','inventory','修复库存总数：输入商品数组，每项含整数 stock 和布尔 enabled，只累计 enabled 为 true 的 stock；空数组返回 0',
    'exports.solve = rows => rows.reduce((s,r)=>s+r.stock,0);\n',
    'exports.solve = rows => rows.filter(r=>r.enabled===true).reduce((s,r)=>s+r.stock,0);\n',
    [{args:[[{stock:5,enabled:false},{stock:2,enabled:true}]],expected:2},{args:[[]],expected:0},{args:[[{stock:0,enabled:true},{stock:3,enabled:true}]],expected:3}], 'holdout'),
  task('coding-http-success','http-status','修复 HTTP 成功判断：输入整数状态码，仅 200 至 299 返回 true，其他值返回 false',
    'exports.solve = status => status === 200;\n', 'exports.solve = status => status >= 200 && status < 300;\n',
    [{args:[201],expected:true},{args:[199],expected:false},{args:[299],expected:true},{args:[300],expected:false},{args:[404],expected:false}], 'holdout'),
];

const base = originals.find(t => t.id === 'coding-error-localization');
const renamed = JSON.parse(JSON.stringify(base).replaceAll('math.cjs','arithmetic.cjs'));
renamed.id='coding-localization-renamed';renamed.title='报错定位的文件改名变体';
renamed.evaluation={...renamed.evaluation,parentTaskId:base.id,variant:'rename',objective:'文件改名后的同一行为修复'};
const paraphrase=structuredClone(base);paraphrase.id='coding-localization-paraphrase';paraphrase.title='报错定位的需求改写变体';
paraphrase.prompt='计算模块的公开检查 node test/public.cjs 未通过：实际 -1、期望 5。请查明原因并修正实现，保留其他接口行为，不可改测试。';
paraphrase.evaluation={...paraphrase.evaluation,parentTaskId:base.id,variant:'paraphrase'};
const fault=/** @type {any} */ (structuredClone(base));fault.id='coding-localization-transient-read';fault.title='首次读取故障后的定位恢复';
fault.injectFailure={tool:'read_file',count:1};
fault.evaluation={...fault.evaluation,parentTaskId:base.id,variant:'transient-read',objective:'相同任务首次读取发生临时故障后的恢复'};
fault.script=[{tool:'read_file',args:{path:'test/public.cjs'}},...fault.script];
tasks.push(renamed,paraphrase,fault);
module.exports=tasks;
