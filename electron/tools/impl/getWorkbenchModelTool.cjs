/**
 * get_workbench_model —— 读画布 + 视口动作（工具面收敛 L1）。
 *
 * 原来有两个工具：`get_workbench_model`（读画布）与 `ui_control`（7 个界面动作）。
 * 后者 6/7 的 action 是「把视图定位到某处」（view_all/focus/zoom/pan/resize/toggle_panel），
 * 本质是**读**；剩下 1 个（new_content）与 `workbench_edit` 的 create 重复。
 * 于是合并成一个：`view` 决定读什么，`view=focus/zoom/pan/view_all/resize/toggle_panel` 走界面动作。
 *
 * 安全语义：读与视口动作都**不改文档**。`ui_control` 原有的 `ui.interact` 审批在这里由
 * `byKind` 承接（视口 kind 保留 WRITE 级确认，读 kind 免确认）—— 见下方 registerDescriptor。
 *
 * 数据流：节点的完整属性（prompt/goal/members/filePath/role 等）以「本地标量」写入工程
 * .codenode/scalars.json，不随上下文返回云端；需要精确属性时用
 * retrieve_context mode=scalar（旧名 query_scalars 是它的别名）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { nodeToScalarRecords } = require('../../scalars/index.cjs');

const READ_VIEWS = Object.freeze(['full', 'counts']);
const UI_ACTIONS = Object.freeze(['view_all', 'focus', 'zoom', 'pan', 'resize', 'toggle_panel']);

function nodeValue(node) {
  const d = node.data || {};
  const v = {
    id: node.id,
    type: node.type,
    label: d.label || '',
    status: d.status || '',
    x: Math.round((node.position && node.position.x) || 0),
    y: Math.round((node.position && node.position.y) || 0),
  };
  if (d.objectName != null) v.objectName = d.objectName;
  if (d.parentId != null) v.parentId = d.parentId;
  if (Array.isArray(d.childIds) && d.childIds.length) v.childIds = d.childIds;
  return v;
}

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'get_workbench_model',
      version: '1',
      description:
        '读取工作台画布，或把视图定位到指定位置（只读，不改画布内容）。' +
        'view=full（默认）返回全部节点与连线；counts 只看统计；' +
        'view=focus(nodeId)/zoom(zoom)/pan(x,y)/view_all/resize(width,height)/toggle_panel(panel) 是**视口动作**，' +
        '只移动/缩放/调整界面，不会修改节点与连线。' +
        '节点的完整属性（prompt/goal/members/filePath 等）不会随此结果返回，而是存入本地标量库；' +
        '需要某个节点的精确属性时用 retrieve_context mode=scalar（keys=node:<id> 或 prefix=node:）。',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            description: 'full（默认）/counts 读画布；view_all/focus/zoom/pan/resize/toggle_panel 视口动作',
          },
          nodeId: { type: 'string', description: 'view=focus 的目标节点' },
          zoom: { type: 'number', description: 'view=zoom 的缩放倍率 0.25~2.5' },
          x: { type: 'integer', description: 'view=pan 的 x 偏移' },
          y: { type: 'integer', description: 'view=pan 的 y 偏移' },
          width: { type: 'integer', description: 'view=resize 的窗口宽度' },
          height: { type: 'integer', description: 'view=resize 的窗口高度' },
          panel: { type: 'string', description: 'view=toggle_panel 的目标面板：inspector' },
        },
        required: [],
      },
      // 族级：读画布是只读的；视口动作不改文档但会动界面状态（由 byKind 逐个声明审批）
      readOnly: false,
      idempotent: true,
      mutatesWorkspace: false,
      requiresConfirmation: false,
      requiredCapability: 'workspace.read',
      timeoutMs: 0,
      cachePolicy: { mode: 'none' },
      concurrencyPolicy: { parallelSafe: true },
      // 判别字段是 view（不是 kind）：本族用 view 同时承载「读画布」与「视口动作」
      kindField: 'view',
      defaultKind: 'full',
      byKind: {
        full: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', requiresConfirmation: false, effect: 'read', idempotent: true },
        counts: { readOnly: true, mutatesWorkspace: false, requiredCapability: 'workspace.read', requiresConfirmation: false, effect: 'read', idempotent: true },
        // 视口动作：不改文档，但会动界面 —— 保留 ui.interact 能力与 WRITE 级确认（与 ui_control 合并前一致）。
        // `mutatesWorkspace` 取 true 是**刻意的**：合并前 ui_control 就是 true（legacy 契约），
        // 而 A2 意图复核只对 mutatesWorkspace 的动作生效 —— 改成 false 会让「越权动界面」不再被复核问到
        // （实测：intent-cost-gate 的 ui-allow 场景直接没有任何 intent_action_review 事件）。
        view_all: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
        focus: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
        zoom: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
        pan: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
        resize: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
        toggle_panel: { readOnly: false, mutatesWorkspace: true, requiredCapability: 'ui.interact', requiresConfirmation: 'WRITE', effect: 'unknown' },
      },
    },
    async (context, args) => {
      const view = String(args.view || 'full').trim().toLowerCase();
      /**
       * 视口动作：走 context.ui（与合并前的 ui_control 完全同一条接线）。
       * 未接线时如实返回失败 —— 旧工具是 `ui_control 未接线`，这里保持同样的判据。
       */
      if (UI_ACTIONS.includes(view)) {
        const applied = await context.ui(view, args);
        if (!applied) {
          return AgentToolResult.error('界面动作未接线（当前上下文不支持 ' + view + '）', { view, applied: false });
        }
        context.audit('get_workbench_model view=' + view);
        return AgentToolResult.ok('已执行看视图口动作：' + view, { view, applied: true });
      }
      if (!READ_VIEWS.includes(view)) {
        return AgentToolResult.error(
          '未知 view: ' + view + '（读画布用 full/counts；视口动作用 ' + UI_ACTIONS.join('/') + '）',
          { code: 'ARG_SEMANTIC', tool: 'get_workbench_model', view },
        );
      }
      const model = context.model();
      if (!model) return AgentToolResult.error('当前没有可用的工作台模型');
      const nodes = model.nodes();
      const edges = model.edges();
      const stats = model.stats();

      // 完整节点属性 → 本地标量（不返回云端上下文）
      const scalarRecords = [];
      for (const node of nodes) scalarRecords.push(...nodeToScalarRecords(node));
      const stored = context.storeScalars(scalarRecords);

      if (view === 'counts') {
        return AgentToolResult.ok(
          '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线',
          { ...stats, view }
        );
      }

      const shown = nodes.map(nodeValue);
      const data = { ...stats, view, nodes: shown };
      if (view === 'full') {
        data.edges = edges.map((e) => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle || '',
          target: e.target,
          targetHandle: e.targetHandle || '',
        }));
      }
      const lines = [
        '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线（view=' + view + '）',
        '节点完整属性已写入本地标量库（' + stored + ' 条）；需要精确 prompt/goal 时用 retrieve_context mode=scalar（keys=node:<id> 或 prefix=node:）',
      ];
      for (const n of shown) {
        const members = Array.isArray(n.childIds) && n.childIds.length ? ' · childIds=' + n.childIds.join(',') : '';
        const parent = n.parentId ? ' · parent=' + n.parentId : '';
        lines.push('- ' + n.id + ': ' + (n.label || n.type) + ' [' + (n.type || 'node') + '/' + (n.status || 'pending') + '] @(' + n.x + ',' + n.y + ')' + members + parent);
      }
      if (view === 'full' && data.edges && data.edges.length) {
        lines.push('连线:');
        for (const e of data.edges) {
          lines.push('  ' + e.source + ' → ' + e.target);
        }
      }
      return AgentToolResult.ok(lines.join('\n'), data);
    }
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ["get_workbench_model"]);
}

module.exports = { register, READ_VIEWS, UI_ACTIONS };
