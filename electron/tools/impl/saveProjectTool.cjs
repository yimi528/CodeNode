/**
 * save_project —— **已并入 `workbench_edit`（kind=save_project）**，见 docs/tool-consolidation.zh-CN.md L1。
 *
 * 本模块只保留执行体，供 workbenchEditTool 的族分发复用；不再注册独立工具。
 * 旧名 `save_project` 由 toolkit.registerLegacyAliases 登记成别名，模型历史上调过的旧名照旧可用
 * （执行时翻译成 workbench_edit + kind=save_project，安全语义由 byKind 承接：
 * requiredCapability=project.save、requiresConfirmation=WRITE —— 与合并前逐字一致）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

/** 保存当前工程；返回 AgentToolResult */
async function execute(context) {
  const filePath = await context.saveProject();
  if (!filePath) {
    // 保存失败（路径越界 / 上下文只读 / 未接线）必须报错：谎报「已保存到磁盘」会让模型
    // 依据不存在的落盘结果继续推进（判据必须落在真实终态上）
    const reason = typeof context.saveError === 'function' ? context.saveError() : null;
    return AgentToolResult.error(
      '保存工程失败：' + (reason || '未写入任何文件（项目未打开、上下文只读或保存被拒绝）'),
      { filePath: '' }
    );
  }
  return AgentToolResult.ok('已保存当前工程到 ' + filePath, { filePath });
}

module.exports = { execute };
