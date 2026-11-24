'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { EventEmitter } = require('events');
async function main() {
  const { AgentToolContext } = require("../../electron/tools/context.cjs");
  assert.strictEqual(await new AgentToolContext({}).confirm('HIGH', 'write', ''), false);
  const cancelled = new AbortController();
  const ctx = new AgentToolContext({ signal: cancelled.signal, confirm: async () => { cancelled.abort(); return true; } });
  assert.strictEqual(await ctx.confirm('WRITE', 'write', ''), false);
  const ipcMain = new EventEmitter();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../electron/tools/bridge.cjs"), 'utf8'), {
    module, process: { env: {} }, setTimeout, clearTimeout,
    // bridge 的依赖：electron（ipcMain）+ 持久化审批规则模块（「本项目始终允许」落盘用）。
    // 只放行这两个 —— 出现别的依赖说明 bridge 边界被扩大了，要显式更新这条断言。
    require: name => {
      if (name === 'electron') return { ipcMain };
      if (name === '../approvalRules.cjs') return require("../../electron/approvalRules.cjs");
      assert.fail('bridge 依赖出现新增模块：' + name);
    },
  });
  const events = [];
  const sender = { id: 1, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) };
  const controller = new AbortController();
  const bridge = module.exports.makeBridge(sender, controller.signal);
  const waiting = bridge.confirm('HIGH', 'test', '');
  const id = events[0].payload.id;
  ipcMain.emit('tools:response', { sender: { id: 2 } }, { id, result: { ok: true } });
  controller.abort();
  assert.ok(!(await waiting), 'foreign response must not authorize operation');
  assert.ok(events.some(event => event.payload.type === 'cancel' && event.payload.id === id));
  assert.strictEqual(ipcMain.listenerCount('tools:response'), 0);
  assert.ok(!(await bridge.confirm('HIGH', 'closed', '')));
  const second = module.exports.makeBridge(sender);
  const next = second.confirm('HIGH', 'test', '');
  second.cleanup();
  assert.ok(!(await next));
  assert.strictEqual(ipcMain.listenerCount('tools:response'), 0);
  // Exercise the same registry → approval service → renderer bridge path as the desktop.
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codenode-action-approval-'));
  const store = require('../../electron/approvalRules.cjs');
  const registry = require('../../electron/tools/toolkit.cjs').buildDefaultRegistryWithConfig({toolsConfirmWrites:true});
  const prompts = [];
  const effects = [];
  let answer = {ok:true, always:'project'};
  const approvingSender = {id:3, isDestroyed:()=>false, send: (_channel, payload) => {
    prompts.push(payload);
    ipcMain.emit('tools:response', {sender:{id:3}}, {id:payload.id, result:answer});
  }};
  const live = module.exports.makeBridge(approvingSender, null, {projectRoot:root});
  const openContext = () => new AgentToolContext({ projectRoot:root, confirm:live.confirm,
    ui: async action => { effects.push(action); return true; }, saveProject:async () => path.join(root,'a.cnode') });
  try {
    const ctx = openContext();
    const execute = (name, args, context = ctx) => registry.execute(name, args, context);
    assert.equal((await execute('ui_control', {action:'focus', nodeId:'a'})).ok, true);
    assert.deepEqual(prompts[0].rememberActions, ['get_workbench_model.focus']);
    assert.equal((await execute('get_workbench_model', {view:'focus',nodeId:'b'})).ok, true);
    assert.equal(prompts.length, 1, 'same action immediately reuses the saved rule');
    assert.equal((await execute('get_workbench_model', {view:'zoom',zoom:1})).ok, true);
    assert.equal(prompts.length, 2, 'sibling with same capability and level still asks');
    assert.equal((await execute('ui_control', {action:'zoom',zoom:1}, openContext())).ok, true);
    assert.equal(prompts.length, 2, 'new spelling first, then legacy spelling after reopening');
    answer = {ok:false, always:'project'};
    assert.equal((await execute('get_workbench_model',{view:'pan',x:1,y:2})).ok, false);
    assert.deepEqual(effects, ['focus','focus','zoom','zoom']);
    assert.deepEqual(store.readRules(root).rules.map(r=>r.action), ['get_workbench_model.focus','get_workbench_model.zoom']);

    fs.writeFileSync(store.rulesFile(root), JSON.stringify({version:1,rules:[
      {id:'old-save',tool:'save_project',capability:'project.save',level:'WRITE'}
    ]}));
    assert.equal((await execute('save_project',{})).ok, true);
    assert.equal((await execute('workbench_edit',{kind:'save_project'})).ok, true);
    assert.equal(prompts.length, 3);
    assert.equal((await execute('workbench_edit',{action:'create',name:'node'})).ok, false);
    assert.equal((await execute('ui_control',{action:'focus',nodeId:'a'})).ok, false, 'removed rule no longer applies');
    assert.equal(prompts.length, 5);
    assert.equal(await live.confirm('HIGH','execute_shell','command'), false);
    assert.deepEqual(Array.from(prompts.at(-1).rememberActions), []);
    assert.equal(store.readRules(root).rules.length, 1);
  } finally {
    live.cleanup();
    fs.rmSync(root,{recursive:true,force:true});
  }
  console.log('BRIDGE CANCELLATION: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
