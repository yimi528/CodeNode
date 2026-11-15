'use strict';

// 候选代码只在子进程加载。父进程持有期望值和最终判分权。
// fd 3 与 stdout 分开，避免候选打印成功标记冒充验收通过。
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const encode = JSON.stringify;
const write = fs.writeSync.bind(fs);
const outcomes = [];
for (const test of input) {
  try {
    const implementation = require(path.resolve(test.module));
    if (typeof implementation[test.export] !== 'function') throw Error('缺少函数导出：' + test.export);
    const value = implementation[test.export](...test.args);
    outcomes.push({ ok: true, value });
  } catch (error) {
    outcomes.push({ ok: false, error: String(error.message || error).slice(0, 1000) });
  }
}
const encoded = encode({ version: 1, outcomes });
if (process.env.CODENODE_CANDIDATE_RESULT) fs.writeFileSync(process.env.CODENODE_CANDIDATE_RESULT, encoded);
else write(3, encoded);
