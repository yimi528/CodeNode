/**
 * workbench_edit：统一的工作台节点编辑工具（创建/编辑/连线/结构 一体）。
 *
 * 用法一（推荐，批量）：operations=[{action,...}, {action,...}, ...] 一次调用顺序执行全部操作，
 *   把所有需要「新建节点 / 改名 / 设 prompt / 设状态 / 连线」的变更一次性提交，避免多次调用。
 * 用法二（单操作）：action + 对应参数。
 *
 * action 支持：
 *   create(nodeId 自动)       参数：name/type/count/prompt/relativePath/connect(串联链)
 *   rename                    nodeId + name
 *   set_prompt / set_category / set_goal / set_status(nodeId,value)
 *   move                      nodeId + x + y
 *   delete                    nodeId 或 nodeIds
 *   duplicate                 nodeId + offsetX/offsetY
 *   connect                   sourceId + targetId，或 connections=[{sourceId,targetId}] 批量
 *   disconnect                sourceId/targetId
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { nodeToScalarRecords } = require('../../scalars/index.cjs');
const { accentForType } = require('./shared.cjs');
const { ConfirmationLevel } = require('../context.cjs');

const MAX_CREATE_COUNT = 50;

const KIND_TO_TYPE = {
  regular: 'task', calculation: 'task', condition: 'task', capture: 'task',
  asset: 'file', file: 'file', task: 'task',
  stage: 'stage', tool: 'tool', start: 'start', end: 'end', scope: 'scope',
  object: 'object', canvas: 'vector', vector: 'vector',
};

const STATUS_ALLOWED = ['pending', 'running', 'done', 'failed', 'blocked'];

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function intArg(args, key, fallback) {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.floor(args[key]) : fallback;
}

function nodeIdList(args) {
  const ids = [];
  if (args.nodeId != null && String(args.nodeId).trim() !== '') ids.push(String(args.nodeId));
  if (Array.isArray(args.nodeIds)) {
    for (const item of args.nodeIds) if (item != null && String(item).trim() !== '') ids.push(String(item));
  }
  return ids;
}

/** ---------- 单条操作执行 ---------- */

function opCreate(model, args, ctx, errors, created) {
  let n = intArg(args, 'count', 1);
  n = Math.max(1, Math.min(MAX_CREATE_COUNT, n));
  const baseName = stringArg(args, 'name', '节点');
  const prompt = stringArg(args, 'prompt', '');
  const kind = (stringArg(args, 'nodeKind', '') || stringArg(args, 'type', 'task')).toLowerCase();
  const type = KIND_TO_TYPE[kind] || 'task';
  const relativePath = stringArg(args, 'relativePath', '');
  const connect = args.connect === true;
  const customId = stringArg(args, 'id', '');
  const initialMembers = Array.isArray(args.members) ? args.members.map((m) => String(m).trim()).filter(Boolean) : [];
  // 未显式给坐标时自动错位，避免所有节点堆在 (120,120)（重启后聚到画面中心）
  let baseX = intArg(args, 'x', -1);
  let baseY = intArg(args, 'y', -1);
  if (baseX < 0) baseX = nextFreeX(model, 120);
  if (baseY < 0) baseY = 120;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const nodeName = n === 1 ? baseName : baseName + (i + 1);
    const data = { label: nodeName, status: 'pending', prompt, accent: accentForType(type) };
    if (type === 'file') data.filePath = relativePath || nodeName;
    if (type === 'object') data.objectName = stringArg(args, 'objectName', '') || nodeName;
    if (type === 'vector') {
      // 画布节点：内嵌矢量画布，尺寸/模式与前端新节点保持一致
      data.width = 1040; data.height = 640;
      data.mode = 'design'; data.dockOpen = true;
      data.accent = '#22d3ee';
    }
    if (type === 'scope') {
      data.width = 320; data.height = 200; data.fill = '#3b2f6b';
      data.opacity = 0.16; data.accent = '#8b5cf6';
      if (initialMembers.length) {
        data.members = initialMembers.slice();
        data.childIds = initialMembers.slice();
      }
    }
    // 自定义 id：允许同一批次内用该 id 连线/把节点放进范围节点
    const node = model.addNode(type, data, baseX, baseY + i * 110, n === 1 ? customId : '');
    if (type === 'scope' && initialMembers.length) {
      for (const m of initialMembers) {
        const member = model.byId(m);
        if (member) {
          member.data = member.data || {};
          member.data.parentId = node.id;
          member.data.memberBadge = 'in:' + node.data.label;
        }
      }
    }
    nodes.push(node);
    created.push(node.id);
  }
  if (connect && nodes.length >= 2) {
    for (let i = 0; i + 1 < nodes.length; i++) model.connect(nodes[i], nodes[i + 1]);
  }
  void ctx;
}

/** 未指定 x 时：取画布中最大的节点右缘 + 间距，作为新节点落点，避免重叠/聚中心。 */
function nextFreeX(model, fallback) {
  let maxX = 0;
  for (const n of model.nodes()) {
    const w = (n.measured && n.measured.width) || (n.data && n.data.width) || 170;
    maxX = Math.max(maxX, (n.position && n.position.x) + w);
  }
  return maxX > 0 ? Math.round(maxX + 80) : fallback;
}

function opRename(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  node.data = node.data || {};
  node.data.label = stringArg(args, 'name', node.data.label);
  affected.push(node.id);
}

function opSet(model, args, errors, affected, field, validate) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  const value = stringArg(args, 'value', '');
  if (validate && !validate(value)) { errors.push('非法状态: ' + value); return; }
  node.data = node.data || {};
  node.data[field] = field === 'status' ? value.toLowerCase() : value;
  affected.push(node.id);
}

function opMove(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  node.position = { x: intArg(args, 'x', node.position.x), y: intArg(args, 'y', node.position.y) };
  affected.push(node.id);
}

function opDelete(model, args, errors, affected) {
  const ids = nodeIdList(args);
  if (!ids.length) { errors.push('缺少要删除的 nodeId'); return; }
  const idSet = new Set(ids);
  for (const id of ids) {
    const node = model.byId(id);
    if (!node) { errors.push('节点不存在: ' + id); continue; }
    model.removeNode(node);
    // 同步清理父子对象集：从其他 scope childIds 移除，并让被删 scope 的子节点恢复顶层
    for (const other of model.nodes()) {
      if (other.data) {
        const beforeChild = Array.isArray(other.data.childIds) ? other.data.childIds.length : 0;
        if (Array.isArray(other.data.childIds)) {
          other.data.childIds = other.data.childIds.filter((m) => !idSet.has(m));
        }
        if (Array.isArray(other.data.members)) {
          other.data.members = other.data.members.filter((m) => !idSet.has(m));
        }
        if (other.data.parentId && idSet.has(other.data.parentId)) {
          other.data.parentId = null;
          other.data.memberBadge = null;
        }
        const afterChild = Array.isArray(other.data.childIds) ? other.data.childIds.length : 0;
        if (beforeChild !== afterChild) affected.push(other.id);
      }
    }
    affected.push(id);
  }
}

/** 提取 memberIds/members 参数为去重 id 列表。 */
function memberIdList(args) {
  const out = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      const s = String(m || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  };
  push(args.memberIds);
  push(args.members);
  return out;
}

/**
 * 范围节点成员操作：set_members / add_members / remove_members。
 * 用于把节点放进 scope（条件/循环子链路）或从中移出。
 */
function opMembers(model, args, errors, affected, mode) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  if (node.type !== 'scope') { errors.push('只有 scope（范围）节点能包含成员: ' + node.id); return; }
  const ids = memberIdList(args);
  if (!ids.length) { errors.push('缺少 memberIds（要放入/移出的节点 id 列表）'); return; }
  const invalid = ids.filter((id) => !model.byId(id));
  if (invalid.length) { errors.push('成员节点不存在: ' + invalid.join(',')); return; }
  node.data = node.data || {};
  const current = Array.isArray(node.data.childIds) ? node.data.childIds : [];
  let next;
  if (mode === 'set') next = [...ids];
  else if (mode === 'add') next = [...new Set([...current, ...ids])];
  else next = current.filter((m) => !ids.includes(m));
  node.data.childIds = next;
  node.data.members = next.slice();
  // set 模式下，被移除的旧成员要清空父关系
  if (mode === 'set') {
    for (const oldId of current) {
      if (ids.includes(oldId)) continue;
      const oldMember = model.byId(oldId);
      if (oldMember && oldMember.data && oldMember.data.parentId === node.id) {
        oldMember.data.parentId = null;
        oldMember.data.memberBadge = null;
      }
    }
  }
  // 同步成员节点的 parentId / memberBadge（唯一父）
  for (const id of ids) {
    const member = model.byId(id);
    if (!member) continue;
    member.data = member.data || {};
    if (mode === 'remove') {
      if (member.data.parentId === node.id) {
        member.data.parentId = null;
        member.data.memberBadge = null;
      }
    } else {
      // 从旧父 scope 的 childIds 中移除，再写入新父
      for (const other of model.nodes()) {
        if (other.type === 'scope' && other.id !== node.id && Array.isArray(other.data.childIds)) {
          other.data.childIds = other.data.childIds.filter((m) => m !== id);
        }
      }
      member.data.parentId = node.id;
      member.data.memberBadge = 'in:' + (node.data.label || node.id);
    }
  }
  affected.push(node.id);
}

function opDuplicate(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  const copy = model.duplicate(node, node.position.x + intArg(args, 'offsetX', 40), node.position.y + intArg(args, 'offsetY', 40));
  affected.push(copy.id);
}

function opConnect(model, args, errors, affected) {
  const pairs = [];
  if (Array.isArray(args.connections)) {
    for (const p of args.connections) {
      if (p && typeof p === 'object' && p.sourceId && p.targetId) {
        pairs.push({ sourceId: String(p.sourceId), targetId: String(p.targetId) });
      }
    }
  } else if (args.sourceId && args.targetId) {
    pairs.push({ sourceId: String(args.sourceId), targetId: String(args.targetId) });
  }
  if (!pairs.length) { errors.push('缺少 sourceId/targetId 或 connections'); return; }
  for (const p of pairs) {
    const source = model.byId(p.sourceId);
    const target = model.byId(p.targetId);
    if (!source) { errors.push('源节点不存在: ' + p.sourceId); continue; }
    if (!target) { errors.push('目标节点不存在: ' + p.targetId); continue; }
    if (model.edges().some((e) => e.source === p.sourceId && e.target === p.targetId)) {
      errors.push('已存在连线 ' + p.sourceId + '→' + p.targetId);
      continue;
    }
    model.connect(source, target);
    affected.push(p.sourceId + '→' + p.targetId);
  }
}

function opDisconnect(model, args, errors, affected) {
  const sourceId = stringArg(args, 'sourceId', '');
  const targetId = stringArg(args, 'targetId', '');
  const toRemove = model.edges().filter((e) => {
    if (sourceId && targetId) return e.source === sourceId && e.target === targetId;
    if (targetId) return e.target === targetId;
    return e.source === sourceId;
  });
  model.removeEdges(toRemove);
  affected.push('断开 ' + toRemove.length + ' 条');
}

/** 按 action 分发执行 */
function applyAction(model, args, errors, affected, created) {
  const action = String(args.action || '').trim().toLowerCase();
  switch (action) {
    case 'create':
      opCreate(model, args, null, errors, created);
      break;
    case 'rename':
      opRename(model, args, errors, affected);
      break;
    case 'set_prompt':
      opSet(model, args, errors, affected, 'prompt', null);
      break;
    case 'set_category':
      opSet(model, args, errors, affected, 'category', null);
      break;
    case 'set_goal':
    case 'add_goal':
      opSet(model, args, errors, affected, 'goal', null);
      break;
    case 'set_result_summary':
      opSet(model, args, errors, affected, 'result_summary', null);
      break;
    case 'set_status':
      opSet(model, args, errors, affected, 'status', (v) => STATUS_ALLOWED.includes(v.toLowerCase()));
      break;
    case 'set_collapsed':
      opSet(model, args, errors, affected, 'collapsed', null);
      break;
    case 'set_muted':
      opSet(model, args, errors, affected, 'muted', null);
      break;
    case 'set_color':
      opSet(model, args, errors, affected, 'accent', null);
      break;
    case 'move':
      opMove(model, args, errors, affected);
      break;
    case 'delete':
      opDelete(model, args, errors, affected);
      break;
    case 'duplicate':
      opDuplicate(model, args, errors, affected);
      break;
    case 'connect':
      opConnect(model, args, errors, affected);
      break;
    case 'disconnect':
      opDisconnect(model, args, errors, affected);
      break;
    case 'set_members':
    case 'add_members':
    case 'remove_members':
      opMembers(model, args, errors, affected, args.action === 'set_members' ? 'set' : args.action === 'add_members' ? 'add' : 'remove');
      break;
    default:
      errors.push('未知 action: ' + action);
  }
}

function buildSummary(args) {
  const created = [];
  const affected = [];
  const errors = [];
  const ops = Array.isArray(args.operations) && args.operations.length ? args.operations : null;
  return { created, affected, errors, ops };
}

function register(registry) {
  registry.register(
    'workbench_edit',
    '画布统一入口。两种用法：' +
      '①画布编辑：把全部节点变更放进 operations=[{action,...}] 一次提交 —— action 支持 ' +
      'create(新建，name/type/count/prompt/objectName/connect串联)、rename、set_prompt、set_status、set_category/' +
      'set_goal/set_result_summary/set_color/set_members/move/delete/duplicate/connect(或 connections 批量)/disconnect。' +
      '②批量与持久化（kind 参数）：kind=bulk_create_nodes(批量建节点，count/name/prompt/connect)、' +
      'bulk_create_files(list=[{path,content}] 批量写文件)、bulk_create_assets(list=[{path}] 批量建文件节点)、' +
      'bulk_delete_nodes(nodeIds 批量删除)、save_project(保存工程到磁盘)、write_analysis(写 Markdown 分析节点与文件，' +
      'content 缺省时自动从画布生成)。' +
      '【画布操作 = 你的操作】新建节点、连线、移动、删除、放进范围节点、改名/设属性全部用本工具完成，不能只停留在文字描述。' +
      'create 支持自定义 id（如 {action:"create",id:"start-1",name:"开始",type:"start"}），同批内即可用该 id 连线或放进 scope。' +
      '【节点建模规则】a) 一条完整链路必须有 start 与 end，且必须把 start 连线到链路第一个执行节点、最后一个执行节点连线到 end；' +
      'b) 条件判断/分支/重复循环用 scope 节点包裹，且必须用 add_members/set_members 把子链路节点 id 放进 members；' +
      'c) 需要子代理负责部分工作用 stage 节点；d) 对象用 object 节点并把名称填到 objectName，可自由绘制的矢量画布用 canvas；' +
      'e) 节点类型按语义选择，禁止一律用 task：文件→file、工具→tool、子代理→stage、条件循环→scope、对象→object、矢量画布→canvas。' +
      'f) 画布为空时无需读取，直接按需求创建完整链路；画布已有节点时先 get_workbench_model 读取现状，复用已有节点 id，不重复创建。',
    {
      type: 'object',
      properties: {
        // ---- 族动作（从 bulk_edit / save_project / write_analysis_md 收编）----
        kind: {
          type: 'string',
          enum: ['bulk_create_nodes', 'bulk_create_files', 'bulk_create_assets', 'bulk_delete_nodes', 'save_project', 'write_analysis'],
          description: '批量/持久化动作；不给则按 operations 或 action 做画布编辑。bulk_*/save_project/write_analysis 会请求确认。',
        },
        list: { type: 'array', items: { type: 'object' }, description: 'kind=bulk_create_files 的 [{path,content}] 或 bulk_create_assets 的 [{path}]' },
        // ---- 画布编辑 ----
        operations: {
          type: 'array',
          items: { type: 'object' },
          description: '批量操作数组，每项 {action, ...对应参数}，按顺序一次执行',
        },
        action: { type: 'string', description: '单操作模式（未给 operations 时）' },
        nodeId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' } },
        id: { type: 'string', description: 'create 的自定义节点 id，便于同批连线/放进 scope' },
        name: { type: 'string' },
        type: {
          type: 'string',
          description: 'create 的节点类型：start(入口，只有输出端口)/task/stage(子代理工作)/tool/end(出口，只有输入端口)/file/scope(条件循环容器)/object(对象名称)，agent/user 已废弃传入回退为 task',
        },
        count: { type: 'integer', description: 'create / bulk_create_nodes 的节点数量，默认 1' },
        prompt: { type: 'string' },
        objectName: { type: 'string', description: 'object 类型节点的对象名称' },
        value: { type: 'string', description: 'set_* 的新值' },
        memberIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'add_members/set_members/remove_members 要放入/移出的节点 id 列表；scope 的 members 决定哪些节点被范围节点包裹',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'create scope 时的初始成员节点 id 列表；也兼容 add_members/remove_members 传参',
        },
        x: { type: 'integer' },
        y: { type: 'integer' },
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        connections: { type: 'array', items: { type: 'object' }, description: '批量连线 [{sourceId,targetId}]' },
        connect: { type: 'boolean', description: 'create 时是否按顺序串联成链' },
        // ---- write_analysis ----
        content: { type: 'string', description: 'kind=write_analysis 的分析内容（markdown）；缺省自动从画布生成' },
        relativePath: { type: 'string', description: 'kind=write_analysis 的文件路径，默认 analysis/<时间戳>.md' },
        regenerate: { type: 'boolean', description: 'kind=write_analysis 且缺 content 时是否重新从画布生成，默认 true' },
      },
      required: [],
    },
    async (context, args) => {
      /**
       * 族动作先分流：它们用的是**另一套参数**（list / nodeIds / content），不走 operations。
       * 走完 byKind 的安全门之后才到这里（kind 级审批在 registry 里已判定）。
       */
      const kind = resolveKind(args);
      if (kind === 'save_project') return runSaveProject(context);
      if (kind === 'write_analysis') return runWriteAnalysis(context, args);
      if (kind === 'bulk_create_files') return runBulkFiles(context, args);
      if (kind === 'bulk_create_assets') return runBulkAssets(context, args);
      if (kind === 'bulk_delete_nodes') return runBulkDelete(context, args);
      if (kind === 'bulk_create_nodes') return runBulkCreateNodes(context, args);
      const { created, affected, errors } = buildSummary(args);
      const ops = Array.isArray(args.operations) && args.operations.length ? args.operations : null;
      const reviewLib = require('../canvasChangeReview.cjs');
      const before = reviewLib.graphSnapshot(context.model());
      let applied = false;
      try {
        applied = await context.mutateWorkbench((model) => {
          if (ops) {
            for (const op of ops) {
              if (!op || typeof op !== 'object') { errors.push('非法操作项'); continue; }
              applyAction(model, op, errors, affected, created);
            }
          } else {
            applyAction(model, args, errors, affected, created);
          }
        });
      } catch (e) {
        return AgentToolResult.error('workbench_edit 执行失败：' + ((e && e.message) || e));
      }
      if (!applied && !errors.length) return AgentToolResult.error('工作台不可用（无变更应用）');
      const review = reviewLib.canvasChangeReview(before, reviewLib.graphSnapshot(context.model()));
      const parts = [];
      if (created.length) parts.push('新建 ' + created.length + ' 个节点: ' + created.join(', '));
      if (affected.length) parts.push('操作 ' + affected.length + ' 项: ' + affected.join(', '));
      let summary = parts.join('；') || '操作完成';
      // 链路完整性诊断：提示还有哪些节点没接成 start→end 完整链路（让 Agent 继续补全）
      const chain = chainReport(context.model());
      if (chain) summary += '；【链路提示】' + chain;
      // 受影响节点的完整属性写入本地标量（不返回云端），Agent 需要时用 retrieve_context mode=scalar 读取
      const stored = storeAffectedScalars(context, created, affected);
      if (stored > 0) summary += '；节点属性已入本地标量库（' + stored + ' 条）';
      if (errors.length) {
        return AgentToolResult.ok('部分操作失败：' + errors.join('；') + '。' + summary, { created, affected, errors, applied, review });
      }
      return AgentToolResult.ok(summary, { created, affected, applied, review });
    }
  );

  // S7：workbench_edit 是画布的主要写入口 —— 声明为需要用户批准（令牌由 ApprovalService 签发，
  // 模型在参数里自填 confirmed 之类字段会被注册表剥离，不可能自己批准自己）。
  // 族化之后**族级保持 WRITE**（画布编辑），各 kind 在 byKind 里声明自己的语义：
  //   - 只读 kind 不存在（本族全是写），所以族级 readOnly=false 是对的；
  //   - bulk_* 与 save_project 是 HIGH（旧 bulk_edit 内部就是 HIGH 确认、save_project 是 WRITE）；
  //   - write_analysis 是 WRITE。
  registry.declareContract('workbench_edit', {
    requiresConfirmation: 'WRITE',
    /**
     * 各 kind 的确认归属**必须与合并前一致**，否则会问两遍：
     *   - `bulk_*` / `write_analysis`：原 `bulk_edit` / `write_analysis_md` 是**在工具体内**自己
     *     `context.confirm(...)` 的（legacy register，没有注册表门）。族级再声明一次就等于
     *     「先被门拦一次问一遍，进函数又问一遍」——实测就是双弹窗。
     *     所以这里标 false，确认仍由 runBulk 系列与 runWriteAnalysis 内部的 confirm 负责。
     *   - `save_project`：原 `save_project` 是**靠 descriptor 的 WRITE 门**确认的（函数体不自确认），
     *     所以这里保留 WRITE。
     */
    byKind: {
      bulk_create_nodes: { requiresConfirmation: false, effect: 'write' },
      bulk_create_files: { requiresConfirmation: false, effect: 'write' },
      bulk_create_assets: { requiresConfirmation: false, effect: 'write' },
      bulk_delete_nodes: { requiresConfirmation: false, effect: 'write' },
      save_project: { requiresConfirmation: 'WRITE', requiredCapability: 'project.save', idempotent: true, effect: 'write' },
      write_analysis: { requiresConfirmation: false, effect: 'write' },
    },
  });
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ["workbench_edit"]);
}

/** 把 created/affected 中的真实节点 id 对应的完整属性写入本地标量。 */
function storeAffectedScalars(context, created, affected) {
  const model = context.model();
  if (!model) return 0;
  const ids = new Set();
  for (const id of created.concat(affected)) {
    if (id && typeof id === 'string' && !id.includes('→')) ids.add(id);
  }
  if (ids.size === 0) return 0;
  const records = [];
  for (const id of ids) {
    const node = model.byId(id);
    if (node) records.push(...nodeToScalarRecords(node));
  }
  return context.storeScalars(records);
}

/**
 * 链路完整性诊断：找出不在「start → … → end」任何完整路径上的节点。
 * 返回提示文本（无问题时为空串）。用于让 Agent 知道还有节点没接成完整链路。
 */
function chainReport(model) {
  if (!model || typeof model.nodes !== 'function') return '';
  const nodes = model.nodes();
  if (!nodes.length) return '';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = model.edges().filter((e) => byId.has(e.source) && byId.has(e.target));
  const hasStart = nodes.some((n) => n.type === 'start');
  const hasEnd = nodes.some((n) => n.type === 'end');
  if (!hasStart || !hasEnd) {
    const missing = [];
    if (!hasStart) missing.push('start(入口)');
    if (!hasEnd) missing.push('end(出口)');
    return '当前画布缺 ' + missing.join('、') + ' 节点，未形成 start→end 完整链路；请补建并连线。';
  }
  // 从每个 start 可达的集合
  const startReach = new Set();
  {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) adj.get(e.source).push(e.target);
    const stack = nodes.filter((n) => n.type === 'start').map((n) => n.id);
    for (const id of stack) startReach.add(id);
    while (stack.length) {
      const id = stack.pop();
      for (const t of adj.get(id) || []) {
        if (!startReach.has(t)) { startReach.add(t); stack.push(t); }
      }
    }
  }
  // 能到达某个 end 的集合（反向可达）
  const endReach = new Set();
  {
    const rev = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) rev.get(e.target).push(e.source);
    const stack = nodes.filter((n) => n.type === 'end').map((n) => n.id);
    for (const id of stack) endReach.add(id);
    while (stack.length) {
      const id = stack.pop();
      for (const t of rev.get(id) || []) {
        if (!endReach.has(t)) { endReach.add(t); stack.push(t); }
      }
    }
  }
  const bad = nodes.filter((n) => n.type !== 'start' && n.type !== 'end' && (!startReach.has(n.id) || !endReach.has(n.id)));
  if (!bad.length) return '';
  return bad.length + ' 个节点不在 start→end 完整路径上（' + bad.map((n) => n.id).slice(0, 12).join(',') + '），请补全连线使其成为完整链路';
}

/**
 * `kind` 分发（工具面收敛 L1）：`workbench_edit` 现在是**画布族**，除了原有的
 * operations/action 画布编辑，还承载从 `bulk_edit` / `save_project` / `write_analysis_md`
 * 收编过来的动作。安全语义按 kind 走 `byKind`（见 descriptor.cjs），所以这里只做分发。
 *
 * kind 与旧工具的对应关系（旧名保留为别名，见 toolkit.registerLegacyAliases）：
 *   bulk_create_nodes / bulk_create_files / bulk_create_assets / bulk_delete_nodes ← bulk_edit
 *   save_project                                                                  ← save_project
 *   write_analysis                                                                ← write_analysis_md
 */
const KIND_ALIASES = Object.freeze({
    bulk_create_nodes: 'bulk_create_nodes',
    bulk_create_files: 'bulk_create_files',
    bulk_create_assets: 'bulk_create_assets',
    bulk_delete_nodes: 'bulk_delete_nodes',
    bulk: 'bulk_create_nodes',
    save: 'save_project',
    save_project: 'save_project',
    write_analysis: 'write_analysis',
    analysis: 'write_analysis',
});

function resolveKind(args) {
  const raw = String((args && args.kind) || '').trim().toLowerCase();
  if (!raw) return '';
  return KIND_ALIASES[raw] || raw;
}

/* -------------------------------------------------------------------------------------------- */
/* 收编的动作：bulk_edit / save_project / write_analysis_md（实现直接复用旧模块，避免两套代码   */
/* -------------------------------------------------------------------------------------------- */

const bulkImpl = require('./bulkEditTool.cjs');
const analysisImpl = require('./writeAnalysisMdTool.cjs');
const saveImpl = require('./saveProjectTool.cjs');

async function runSaveProject(context) {
  const filePath = await context.saveProject();
  if (!filePath) {
    const reason = typeof context.saveError === 'function' ? context.saveError() : null;
    return AgentToolResult.error(
      '保存工程失败：' + (reason || '未写入任何文件（项目未打开、上下文只读或保存被拒绝）'),
      { filePath: '', kind: 'save_project' },
    );
  }
  return AgentToolResult.ok('已保存当前工程到 ' + filePath, { filePath, kind: 'save_project' });
}

async function runWriteAnalysis(context, args) {
  const result = await analysisImpl.execute(context, args);
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    result.data = { ...result.data, kind: 'write_analysis' };
  }
  return result;
}

async function runBulkCreateNodes(context, args) {
  const ok = await context.confirm(ConfirmationLevel.HIGH, '批量创建 ' + intArg(args, 'count', 1) + ' 个工作台节点', 'Agent 请求批量创建节点；此操作会一次改动画布结构，请确认。');
  if (!ok) return AgentToolResult.error('已取消批量操作');
  const result = await bulkImpl.createNodes(context, args);
  if (result && result.data) result.data = { ...result.data, kind: 'bulk_create_nodes' };
  return result;
}

async function runBulkFiles(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  const ok = await context.confirm(ConfirmationLevel.HIGH, '批量写入 ' + list.length + ' 个文件', bulkImpl.detailFor('create_files', args));
  if (!ok) return AgentToolResult.error('已取消批量操作');
  const result = await bulkImpl.createFiles(context, args);
  if (result && result.data) result.data = { ...result.data, kind: 'bulk_create_files' };
  return result;
}

async function runBulkAssets(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  const ok = await context.confirm(ConfirmationLevel.HIGH, '批量创建 ' + list.length + ' 个文件节点', 'Agent 请求批量创建文件节点；此操作会一次改动画布结构，请确认。');
  if (!ok) return AgentToolResult.error('已取消批量操作');
  const result = await bulkImpl.createAssets(context, args);
  if (result && result.data) result.data = { ...result.data, kind: 'bulk_create_assets' };
  return result;
}

async function runBulkDelete(context, args) {
  const ids = Array.isArray(args.nodeIds) ? args.nodeIds : (args.nodeId ? [args.nodeId] : []);
  const ok = await context.confirm(ConfirmationLevel.HIGH, '批量删除 ' + ids.length + ' 个工作台节点', '此操作不可撤销，请确认。');
  if (!ok) return AgentToolResult.error('已取消批量操作');
  const result = await bulkImpl.deleteNodes(context, args);
  if (result && result.data) result.data = { ...result.data, kind: 'bulk_delete_nodes' };
  return result;
}

module.exports = { register, resolveKind, KIND_ALIASES };
