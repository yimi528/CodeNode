#!/usr/bin/env node
/**
 * tool-consolidation-measure.cjs —— 工具面收敛后的**存量盘点 + 不变量守卫**。
 *
 * 背景：本仓库按 docs/tool-consolidation.zh-CN.md 做过一次工具面收敛（32 → 20 内置 +
 * 8 个子代理 → 3 个族）。收敛当时用这份脚本**测量**「合并前后」的数字；现在它改成
 * **回归守卫**：把「当前工具面长什么样」和「合并带来的约束」钉成可执行判据，
 * 防止后续新增工具时悄悄破坏它们。
 *
 * 它检查四件事：
 *   A. 存量：默认 / 联网 / 全开三种装配下的工具数与 schema token（数字只允许按注释里的理由变化）；
 *   B. 任务面：core+code / canvas / research / symbols / orchestration 的暴露面与成本；
 *   C. 族工具契约：每个族都能按 kind 解出安全语义，**未登记的 kind 必须 fail-closed**；
 *   D. 旧名别名：每个被合并的名字都还在别名表里，且别名不占 schema。
 *
 * 用法：node scripts/tools/tool-consolidation-measure.cjs [--json]
 * 退出码：0 = 全部判据通过；1 = 有判据不满足（打印差异）。
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

const toolkit = require(path.join(ROOT, 'electron/tools/toolkit.cjs'));
const agent = require(path.join(ROOT, 'electron/agent.cjs'));
const compaction = require(path.join(ROOT, 'electron/compaction.cjs'));
const profiles = require(path.join(ROOT, 'electron/tools/profiles.cjs'));
const descriptorLib = require(path.join(ROOT, 'electron/tools/descriptor.cjs'));
const { SubagentManager } = require(path.join(ROOT, 'electron/subagents.cjs'));

/** 真实装配：注册表 +（可选）子代理族。 */
function buildRegistry(opts = {}) {
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: null,
    ragEnabled: true,
    webSearchEnabled: opts.web === true,
    difyEnabled: opts.web === true,
  });
  if (opts.subagents === true) {
    new SubagentManager({ leases: null, agent, toolkit, cfg: {}, registry, runId: 'inventory', onDelta: () => {} })
      .register(registry);
  }
  return registry;
}

const tokensOf = (registry) => compaction.estimateTokens([], registry.toOpenAiTools());
const namesOf = (registry) => registry.listTools().map((spec) => spec.name);

/** 收敛后的期望：三档装配的工具数（改动它们必须同时改注释与 docs/tool-consolidation.zh-CN.md） */
const EXPECTED_TOOL_COUNTS = Object.freeze({
  builtin: 20,      // 默认装配（rag 开 / 联网关 / 无子代理）
  full: 23,         // + 3 个子代理族（delegate / subagent_read / subagent_control）
});

/** 每个族：判别字段 + 允许的 kind + 缺省 kind（不传判别字段时生效） */
const FAMILY_EXPECTATIONS = Object.freeze({
  get_workbench_model: { field: 'view', kinds: ['full', 'counts', 'view_all', 'focus', 'zoom', 'pan', 'resize', 'toggle_panel'], defaultKind: 'full' },
  workbench_edit: { field: 'kind', kinds: ['bulk_create_nodes', 'bulk_create_files', 'bulk_create_assets', 'bulk_delete_nodes', 'save_project', 'write_analysis'], defaultKind: null },
  list_files: { field: 'kind', kinds: ['glob', 'dir'], defaultKind: 'dir' },
  symbol_nav: { field: 'kind', kinds: ['definition', 'references', 'callers', 'callees'], defaultKind: 'definition' },
  project_overview: { field: 'kind', kinds: ['info', 'structure', 'review'], defaultKind: 'info' },
  memory: { field: 'action', kinds: ['save', 'search'], defaultKind: 'search' },
  web: { field: 'kind', kinds: ['fetch', 'search', 'dify'], defaultKind: 'fetch' },
  delegate: { field: 'kind', kinds: ['single', 'batch'], defaultKind: null },
  subagent_read: { field: 'kind', kinds: ['get', 'inspect_retry', 'merge'], defaultKind: null },
  subagent_control: { field: 'kind', kinds: ['cancel', 'retry', 'review'], defaultKind: null },
});

/** 被合并的旧名 → 现在应该落到哪个族（别名必须还在） */
const LEGACY_ALIAS_EXPECTATIONS = Object.freeze({
  bulk_edit: 'workbench_edit',
  write_analysis_md: 'workbench_edit',
  save_project: 'workbench_edit',
  query_scalars: 'retrieve_context',
  ui_control: 'get_workbench_model',
  find_definition: 'symbol_nav',
  find_references: 'symbol_nav',
  get_callers: 'symbol_nav',
  get_callees: 'symbol_nav',
  find_files: 'list_files',
  list_directory: 'list_files',
  project_info: 'project_overview',
  analyze_project: 'project_overview',
  code_review: 'project_overview',
  remember: 'memory',
  recall: 'memory',
  fetch_url: 'web',
  web_search: 'web',
  dify_call: 'web',
  delegate_task: 'delegate',
  delegate_tasks: 'delegate',
  get_subagent_task: 'subagent_read',
  inspect_subagent_retry: 'subagent_read',
  merge_subagent_results: 'subagent_read',
  cancel_subagent_task: 'subagent_control',
  retry_subagent_task: 'subagent_control',
  review_subagent_result: 'subagent_control',
});

const failures = [];
function check(label, condition, detail) {
  if (condition) return true;
  failures.push(label + (detail ? ' :: ' + detail : ''));
  return false;
}

function inventory() {
  const report = { assemblies: {}, faces: {}, families: {}, aliases: {} };

  // ---------------- A. 存量 ----------------
  const defaultRegistry = buildRegistry();
  const webRegistry = buildRegistry({ web: true });
  const fullRegistry = buildRegistry({ web: true, subagents: true });
  for (const [label, registry] of [['default', defaultRegistry], ['web', webRegistry], ['full', fullRegistry]]) {
    report.assemblies[label] = { tools: namesOf(registry).length, schemaTokens: tokensOf(registry), names: namesOf(registry) };
  }

  check('A1 默认装配是 ' + EXPECTED_TOOL_COUNTS.builtin + ' 个工具', report.assemblies.default.tools === EXPECTED_TOOL_COUNTS.builtin,
    '实际 ' + report.assemblies.default.tools + '：' + report.assemblies.default.names.join(','));
  check('A2 全开装配是 ' + EXPECTED_TOOL_COUNTS.full + ' 个工具（+3 个子代理族）', report.assemblies.full.tools === EXPECTED_TOOL_COUNTS.full,
    '实际 ' + report.assemblies.full.tools);
  check('A3 联网开关不再改变工具数（web 是族，fetch 常驻）', report.assemblies.default.tools === report.assemblies.web.tools,
    'default=' + report.assemblies.default.tools + ' web=' + report.assemblies.web.tools);

  // ---------------- B. 任务面 ----------------
  const FACE_PROFILES = [
    ['core', ['core']],
    ['core+code', ['core', 'code']],
    ['core+code+canvas', ['core', 'code', 'canvas']],
    ['core+code+research', ['core', 'code', 'research']],
    ['core+code+symbols', ['core', 'code', 'symbols']],
    ['core+code+orchestration', ['core', 'code', 'orchestration']],
  ];
  for (const [label, profileNames] of FACE_PROFILES) {
    const exposed = profiles.namesForProfiles(profileNames, namesOf(fullRegistry));
    report.faces[label] = {
      tools: exposed.length,
      schemaTokens: compaction.estimateTokens([], fullRegistry.toOpenAiTools(exposed)),
    };
  }
  check('B1 每个任务面都非空且都小于全量', Object.values(report.faces).every((face) => face.tools > 0 && face.tools < EXPECTED_TOOL_COUNTS.full));

  // ---------------- C. 族工具契约 ----------------
  for (const [name, expected] of Object.entries(FAMILY_EXPECTATIONS)) {
    const descriptor = fullRegistry.descriptorOf(name);
    if (!check('C1 族工具已注册：' + name, !!descriptor)) continue;
    const byKind = descriptor.byKind || {};
    const kindsOk = expected.kinds.every((kind) => !!byKind[kind]);
    check('C2 ' + name + ' 声明了全部 kind（' + expected.kinds.join('/') + '）', kindsOk, '实际 ' + Object.keys(byKind).join(','));
    check('C3 ' + name + ' 的判别字段是 ' + expected.field, descriptor.kindField === expected.field, String(descriptor.kindField));
    check('C4 ' + name + ' 的缺省 kind 与执行体一致', (descriptor.defaultKind || null) === expected.defaultKind,
      'descriptor=' + String(descriptor.defaultKind) + ' 期待=' + String(expected.defaultKind));

    // 每个 kind 都要能解出语义，并且「未登记的 kind」必须 fail-closed（可写 + 要审批）
    for (const kind of expected.kinds) {
      const effective = descriptorLib.effectiveDescriptor(descriptor, { [expected.field]: kind });
      check('C5 ' + name + '(' + kind + ') 解出了已登记契约', effective.kindRegistered === true, JSON.stringify({ kind: effective.kind }));
    }
    const unknown = descriptorLib.effectiveDescriptor(descriptor, { [expected.field]: '__not_a_kind__' });
    check('C6 ' + name + ' 的未知 kind fail-closed（不可只读、要审批）',
      unknown.kindRegistered === false && unknown.readOnly === false && !!unknown.requiresConfirmation,
      JSON.stringify({ readOnly: unknown.readOnly, confirm: unknown.requiresConfirmation }));

    report.families[name] = {
      field: descriptor.kindField,
      defaultKind: descriptor.defaultKind || null,
      kinds: Object.keys(byKind),
      readOnlyKinds: expected.kinds.filter((kind) => descriptorLib.effectiveDescriptor(descriptor, { [expected.field]: kind }).readOnly === true),
    };
  }

  // ---------------- D. 旧名别名 ----------------
  const aliasMap = new Map(fullRegistry.listAliases().map((alias) => [alias.name, alias]));
  const schemaNames = new Set(namesOf(fullRegistry));
  report.aliases = Object.fromEntries([...aliasMap.entries()].map(([name, alias]) => [name, alias.family]));
  for (const [legacy, family] of Object.entries(LEGACY_ALIAS_EXPECTATIONS)) {
    const alias = aliasMap.get(legacy);
    check('D1 旧名仍是别名：' + legacy + ' → ' + family, !!alias && alias.family === family, alias ? alias.family : '(缺失)');
    check('D2 旧名不占 schema：' + legacy, !schemaNames.has(legacy));
  }
  check('D3 别名表里没有重复指向同一个未注册族', [...aliasMap.values()].every((alias) => schemaNames.has(alias.family)),
    [...aliasMap.entries()].filter(([, alias]) => !schemaNames.has(alias.family)).map(([name]) => name).join(','));

  return report;
}

function main() {
  const report = inventory();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('== A. 装配存量（真实 registry，token 口径与请求体一致） ==');
    for (const [label, entry] of Object.entries(report.assemblies)) {
      console.log('   ' + label.padEnd(8) + String(entry.tools).padStart(3) + ' 个工具 / ' +
        String(entry.schemaTokens).padStart(5) + ' tokens');
    }
    console.log('\n== B. 任务面 ==');
    for (const [label, entry] of Object.entries(report.faces)) {
      console.log('   ' + label.padEnd(24) + String(entry.tools).padStart(2) + ' 个工具 / ' +
        String(entry.schemaTokens).padStart(5) + ' tokens');
    }
    console.log('\n== C. 族工具（kind 级安全门） ==');
    for (const [name, entry] of Object.entries(report.families)) {
      console.log('   ' + name.padEnd(20) + 'field=' + entry.field.padEnd(7) +
        ' default=' + String(entry.defaultKind).padEnd(12) + ' kinds=' + entry.kinds.join('/') +
        (entry.readOnlyKinds.length ? '  [只读: ' + entry.readOnlyKinds.join('/') + ']' : ''));
    }
    console.log('\n== D. 旧名别名（不占 schema） ==');
    const byFamily = {};
    for (const [legacy, family] of Object.entries(report.aliases)) (byFamily[family] || (byFamily[family] = [])).push(legacy);
    for (const [family, names] of Object.entries(byFamily)) console.log('   ' + family.padEnd(20) + names.join(', '));
  }

  if (failures.length) {
    console.error('\nTOOL CONSOLIDATION INVENTORY: FAIL —— ' + failures.length + ' 项');
    for (const failure of failures) console.error('  ✗ ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('\nTOOL CONSOLIDATION INVENTORY: PASS（存量 + 任务面 + kind 级安全门 + 旧名别名，全部有判据）');
}

if (require.main === module) main();
module.exports = { inventory, buildRegistry, EXPECTED_TOOL_COUNTS, FAMILY_EXPECTATIONS, LEGACY_ALIAS_EXPECTATIONS };
