/**
 * analyze_project —— **已并入 `project_overview`（kind=structure）**，见 docs/tool-consolidation.zh-CN.md L2。
 *
 * 本模块只保留执行体，供 projectOverviewTool 的族分发复用；不再注册独立工具。
 * 旧名由 toolkit.registerLegacyAliases 登记成别名。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
// 遍历 / 摘要逻辑都在 fsCore（worker 里跑同一份实现）；这里只需要 runner 与取消检查。
const fsRunner = require('../fsRunner.cjs');
const { isCancelled } = require('./shared.cjs');

/**
 * 执行体（族分发调用）；参数与合并前的 analyze_project 一致。
 * @param {any} context
 * @param {any} args
 */
async function execute(context, args) {
  const a = args || {};
  const rawPath = String(a.path || '').trim();
  const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在: ' + root);
  const analyzeFiles = a.analyzeFiles !== false;
  const limit = typeof a.limitFiles === 'number' && Number.isFinite(a.limitFiles) ? Math.max(1, Math.min(1000, Math.floor(a.limitFiles))) : 1000;
  context.audit('project_overview structure root=' + root);
  try {
    // P7 收口：扫描 + 逐文件读取 + 结构摘要**整体**放进 worker 线程 ——
    //   ① 一次扫描搞定（旧实现 detectProjectInfo 与 scan 各扫一遍，等于把全项目读两轮）；
    //   ② 主线程不再被「读全项目算行数 + 逐文件摘要」冻住，取消也能真的 terminate。
    const outcome = await fsRunner.runFsTask(
      'analyzeProject',
      { root, analyzeFiles, limit, shouldStop: () => isCancelled(context) },
      { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
    );
    if (outcome.cancelled || outcome.timedOut) {
      return AgentToolResult.failure('CANCELLED', '项目分析已取消（用户停止），结果不完整。', { cancelled: true, root });
    }
    if (outcome.mode === 'sync-fallback') {
      context.audit('project_overview structure worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
    }
    const r = outcome.result;
    /** @type {Record<string, any>} */
    const data = {
      root,
      workerMode: outcome.mode,
      buildSystem: r.buildSystem,
      mainCandidates: r.mainCandidates,
      modules: r.modules,
      jdks: r.jdks,
      sourceFileCount: r.sourceFileCount,
      assetFileCount: r.assetFileCount,
      languageSummary: r.languageSummary,
      files: r.files,
      analyzedFileCount: r.fileAnalysis.length,
    };
    if (r.fileAnalysis.length) data.fileAnalysis = r.fileAnalysis;
    const text =
      '工程识别：' + r.buildSystem +
      '  |  入口候选: ' + (r.mainCandidates.length ? r.mainCandidates.join(', ') : '无') +
      '  |  源文件: ' + r.sourceFileCount +
      (analyzeFiles ? '  |  已分析: ' + r.fileAnalysis.length + ' 个文件' : '');
    return AgentToolResult.ok(text, data);
  } catch (e) {
    return AgentToolResult.error('工程分析失败：' + ((e && e.message) || e));
  }
}

module.exports = { execute };
