'use strict';
const { freezeContract } = require('./taskAcceptance.cjs');
const { resolveToolPath, sensitiveFile } = require('./tools/paths.cjs');
const runStore = require('./runStore.cjs');
const fs = require('node:fs');

function configure(cfg, root, value, resumeRunId) {
  const requested = freezeContract(value);
  let frozen = requested;
  if (resumeRunId) {
    const records = runStore.readRun(root, runStore.normalizeRunId(resumeRunId));
    const original = records.find(item => item.type === 'task_acceptance_contract');
    frozen = freezeContract(original?.contract);
    if (requested && requested.contractHash !== frozen?.contractHash) throw Error('续跑必须沿用原运行的任务验收规则；新规则请用于新任务');
    cfg.acceptanceResume = true;
    cfg.acceptanceResumeRunId = resumeRunId;
    cfg.acceptanceBaselines = records.filter(item => item.type === 'task_acceptance_check' && item.evidence?.phase === 'before').map(item => item.evidence);
  }
  if (frozen) {
    if (!root) throw Error('任务验收需要先选择项目');
    const context = { projectRoot: () => root };
    for (const name of [...frozen.contract.artifacts.map(r => r.path), ...frozen.contract.checks.flatMap(r => [...r.inputs, r.execution.cwd || '.'])]) {
      const file = resolveToolPath(context, name);
      if (!file || fs.existsSync(file) && sensitiveFile(context, file)) throw Error('任务验收路径越界或受保护：' + name);
    }
    for (const rule of frozen.contract.checks) if (rule.execution.mode !== 'argv') throw Error('桌面验收仅支持程序与参数；请将复杂命令放入项目测试脚本');
  }
  cfg.acceptance = frozen?.contract || null;
  return cfg;
}
module.exports = { configure };
