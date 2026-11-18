/**
 * project_info —— **已并入 `project_overview`（kind=info）**，见 docs/tool-consolidation.zh-CN.md L2。
 *
 * 本模块只保留执行体，供 projectOverviewTool 的族分发复用；不再注册独立工具。
 * 旧名由 toolkit.registerLegacyAliases 登记成别名。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const fsRunner = require('../fsRunner.cjs');
const { isCancelled } = require('./shared.cjs');

/**
 * 执行体（族分发调用）；参数与合并前的 project_info 一致。
 * @param {any} context
 * @param {any} args
 */
async function execute(context, args) {
  const rawPath = String((args && args.path) || '').trim();
  const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在: ' + root);
  context.audit('project_overview info root=' + root);
  // P7 收口：识别工程信息要**扫全项目**（每个源文件读一遍算行数），与 scan_project 属同一类重活 ——
  // 放进 worker 才不会冻住 Electron 主进程，取消也才真的生效。降级时下面 audit 留痕。
  const outcome = await fsRunner.runFsTask(
    'detectProjectInfo',
    { root, shouldStop: () => isCancelled(context) },
    { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
  );
  if (outcome.cancelled || outcome.timedOut) {
    return AgentToolResult.failure('CANCELLED', '项目识别已取消（用户停止），结果不完整。', { cancelled: true, root });
  }
  if (outcome.mode === 'sync-fallback') {
    context.audit('project_overview info worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
  }
  const info = outcome.result;
  const lines = [
    '构建系统: ' + info.buildSystem,
    '模块/源目录: ' + (info.modules.length ? info.modules.join(', ') : '无'),
    '入口候选: ' + (info.mainCandidates.length ? info.mainCandidates.join(', ') : '无'),
    '文件总数: ' + info.fileCount,
  ];
  return AgentToolResult.ok(lines.join('  |  '), { ...info, root, workerMode: outcome.mode });
}

module.exports = { execute };
