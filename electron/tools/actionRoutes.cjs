'use strict';

// Action IDs are also the qualified selectors accepted by tools.allowed/deny.
// Each action still runs the existing executor with its original schema and approval identity.
const routes = new Map();
const byExecutor = new Map();
const families = new Map();

function family(name, field, fallback, members) {
  families.set(name, { field, fallback });
  for (const [action, member] of Object.entries(members)) {
    const [executor, legacyField, legacyValue] = Array.isArray(member) ? member : [member];
    const route = { id: name + '.' + action, executor, legacyField, legacyValue };
    routes.set(route.id, route);
    if (!byExecutor.has(executor)) byExecutor.set(executor, []);
    byExecutor.get(executor).push(route);
  }
}

family('list_files', 'kind', 'dir', { dir: 'list_directory', glob: 'find_files' });
family('symbol_nav', 'kind', 'definition', {
  definition: 'find_definition', references: 'find_references', callers: 'get_callers', callees: 'get_callees',
});
family('project_overview', 'kind', 'info', { info: 'project_info', structure: 'analyze_project', review: 'code_review' });
family('web', 'kind', 'fetch', { fetch: 'fetch_url', search: 'web_search', dify: 'dify_call' });
family('memory', 'action', 'search', { search: 'recall', save: 'remember' });
family('delegate', 'kind', '', { single: 'delegate_task', batch: 'delegate_tasks' });
family('subagent_read', 'kind', '', { get: 'get_subagent_task', inspect_retry: 'inspect_subagent_retry', merge: 'merge_subagent_results' });
family('subagent_control', 'kind', '', { cancel: 'cancel_subagent_task', retry: 'retry_subagent_task', review: 'review_subagent_result' });

function members(executor, field, values, prefix = '') {
  return Object.fromEntries(values.split(' ').map(value => [prefix + value, [executor, field, value]]));
}
family('get_workbench_model', 'view', 'full', {
  ...members('get_workbench_model', 'view', 'full counts'),
  ...members('ui_control', 'action', 'view_all focus zoom pan resize toggle_panel new_content'),
});
family('workbench_edit', 'kind', 'edit', {
  edit: 'workbench_edit', save_project: 'save_project', write_analysis: 'write_analysis_md',
  ...members('bulk_edit', 'action', 'create_nodes create_files create_assets delete_nodes', 'bulk_'),
});
family('retrieve_context', 'mode', 'auto', {
  ...members('retrieve_context', 'mode', 'auto file vector hybrid scalar'),
  exact: 'query_scalars',
});

const canvasActions = 'create rename set_prompt set_category set_goal add_goal set_result_summary set_status set_collapsed set_muted set_color move delete duplicate connect disconnect set_members add_members remove_members'.split(' ');
const canvasIds = canvasActions.map(action => 'workbench_edit.' + action);

// Keep qualified permissions distinct from extension names (which can also contain dots).
const actionIds = new Set([...routes.keys(), ...canvasIds]);
function compileSelectors(list, literalNames, deny = false) {
  const tools = new Set();
  const actions = new Set();
  for (const selector of list) {
    if (deny) tools.add(selector);
    if (!literalNames.has(selector) && actionIds.has(selector)) {
      actions.add(selector);
    } else if (!literalNames.has(selector) && families.has(selector) && !byExecutor.has(selector)) {
      for (const id of actionIds) {
        if (id.startsWith(selector + '.')) actions.add(id);
      }
    } else {
      tools.add(selector);
    }
  }
  return { tools, actions };
}

function selectors(executor) {
  if (executor === 'workbench_edit') return canvasIds;
  return byExecutor.get(executor)?.map(route => route.id) || [executor];
}

function matches(policy, executor, id) {
  return policy.tools.has(executor) || (id !== executor && policy.actions.has(id)) ||
    (executor === 'workbench_edit' && policy.actions.has('workbench_edit.edit'));
}

function resolve(name, input, registered) {
  const args = input == null ? {} : input;
  const spec = families.get(name);
  // An existing extension may already own a newly introduced family name.
  if (spec && (!registered || byExecutor.has(name))) {
    if (typeof args !== 'object' || Array.isArray(args)) throw Error('工具参数必须是对象');
    const action = args[spec.field] === undefined ? spec.fallback : args[spec.field];
    if (typeof action !== 'string') throw Error('无效的动作字段 ' + spec.field);
    let key = action.trim().toLowerCase();
    // Preserve the original scalar retrieval (query required, RAG output shape).
    // Exact scalar lookup additionally accepts the legacy key/prefix/max parameters.
    if (name === 'retrieve_context' && key === 'scalar' &&
        ('key' in args || 'prefix' in args || 'max' in args || (!args.query && Array.isArray(args.keys)))) key = 'exact';
    const route = routes.get(name + '.' + key);
    if (!route) throw Error('未知工具动作：' + name + '.' + key);
    if (route.executor !== name) {
      const translated = { ...args };
      delete translated[spec.field];
      if (route.legacyField) {
        if (Object.hasOwn(translated, route.legacyField)) throw Error('动作字段冲突：' + route.legacyField);
        translated[route.legacyField] = route.legacyValue;
      }
      if (route.executor === 'remember' && Object.hasOwn(translated, 'memoryKind')) {
        if (Object.hasOwn(translated, 'kind')) throw Error('重复指定记忆类型');
        translated.kind = translated.memoryKind;
        delete translated.memoryKind;
      }
      if (route.executor === 'query_scalars' && Object.hasOwn(translated, 'keys')) {
        if (Object.hasOwn(translated, 'key') || !Array.isArray(translated.keys) ||
            !translated.keys.every(key => typeof key === 'string')) throw Error('无效的标量键列表');
        translated.key = translated.keys.join(',');
        delete translated.keys;
      }
      return { name: route.executor, args: translated, ids: [route.id] };
    }
    if (name !== 'workbench_edit') return { name, args, ids: [route.id] };
  }
  if (name === 'workbench_edit') {
    const operations = Array.isArray(args.operations) && args.operations.length ? args.operations : [args];
    const ids = operations.map(op => 'workbench_edit.' + String(op?.action || '').trim().toLowerCase());
    if (ids.some(id => !canvasIds.includes(id))) throw Error('未知或缺少画布动作');
    if (!Object.hasOwn(args, 'kind')) return { name, args, ids };
    const translated = { ...args };
    delete translated.kind;
    return { name, args: translated, ids };
  }
  const entries = byExecutor.get(name);
  if (!entries) return { name, args, ids: [name] };
  const route = entries.length === 1 ? entries[0] :
    entries.find(entry => entry.legacyValue === String(args[entry.legacyField] || '').trim().toLowerCase());
  if (!route) throw Error('未知或缺少工具动作：' + name);
  return { name, args, ids: [route.id] };
}

// Restrict the advertised selectors when policy permits only part of a legacy tool.
function projectSpec(spec, allowed) {
  const ids = selectors(spec.name);
  const permitted = ids.filter(id => allowed(spec.name, id));
  if (!permitted.length) return null;
  if (permitted.length === ids.length) return spec;
  const schema = spec.inputSchema;
  const entries = byExecutor.get(spec.name);
  const field = spec.name === 'workbench_edit' ? 'action' : entries[0].legacyField;
  const values = spec.name === 'workbench_edit' ? permitted.map(id => id.split('.')[1]) :
    entries.filter(entry => permitted.includes(entry.id)).map(entry => entry.legacyValue);
  const properties = { ...schema.properties, [field]: { ...schema.properties[field], enum: values } };
  let required = schema.required;
  if (spec.name === 'workbench_edit') {
    properties.operations = { ...properties.operations, items: { type: 'object', properties: { action: properties.action }, required: ['action'] } };
  } else if (!values.includes(families.get(spec.name)?.fallback)) {
    required = [...new Set([...(required || []), field])];
  }
  return { ...spec, inputSchema: { ...schema, properties, required } };
}

// Resolve before parallel scheduling, result reuse and the side-effect ledger.
function prepareModelCall(registry, call) {
  if (!registry.resolveCall || call.argsValid === false) return call;
  let parsed;
  try { parsed = JSON.parse(call.args || '{}'); } catch { return call; }
  const resolved = registry.resolveCall(call.name, parsed);
  if (resolved.error) return { ...call, actionError: resolved.error };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return call;
  if (resolved.args === parsed && resolved.name === call.name) return call;
  return { ...call, requestedName: call.name, name: resolved.name, args: JSON.stringify(resolved.args) };
}

module.exports = { resolve, matches, selectors, projectSpec, prepareModelCall, compileSelectors };
