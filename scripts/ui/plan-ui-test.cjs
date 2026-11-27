'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function installRequestFixture() {
  const { contextBridge } = require('electron');
  let listener;
  const responses = [];
  contextBridge.exposeInMainWorld('toolFixture', {
    emit: (request) => listener(request),
    responses: () => responses,
  });
  contextBridge.exposeInMainWorld('codenode', {
    onToolRequest: (handle) => { listener = handle; return () => { listener = undefined; }; },
    respondToolRequest: (id, result) => responses.push({ id, result }),
    agentReadPlan: async () => ({ ok: false }),
    agentConfig: async () => ({ configured: false }),
  });
}

async function exercise(root, window) {
  const { document, KeyboardEvent, HTMLInputElement } = window;
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const waitFor = async (read, reason) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(reason);
  };
  const session = window.__codenodeSession;
  const ui = window.__codenodeUi;
  const graph = window.__codenodeStore;
  const select = (selector) => document.querySelector(selector);
  const preview = () => [...document.querySelectorAll('.canvas-wrap .wf-agent-plan')];
  const statuses = () => preview().map((node) => node.querySelector('.wf-plan-status').dataset.status);
  const active = () => select('.wf-agent-plan.is-working');
  const emitPlan = (items, sessionId) => session.getState().streamDelta({ kind: 'plan', runId: 'run-ui', items, sessionId });

  await window.__codenodeProject.getState().loadRoot(root, null, []);
  ui.getState().updatePreferences({ workbenchView: 'conversation', conversationOpen: true });
  session.getState().startOnCurrent('');
  const firstId = session.getState().activeId;
  await waitFor(() => select('.canvas-wrap') && select('.pp-composer') && !select('.startup-splash'), 'workbench did not render');
  check(!preview().length && !select('.ap-plan'), 'empty plan should not reserve space');

  const read = { id: 'read', step: '检查现有实现', acceptanceCriteria: '核对文件和已有流程', status: 'completed' };
  const update = { id: 'update', step: '落地第一批改动', acceptanceCriteria: '保留现有工作流程', status: 'in_progress', dependsOn: ['read'] };
  const verify = { id: 'verify', step: '验证交互', acceptanceCriteria: '相关检查通过', status: 'pending', dependsOn: ['update'] };
  session.getState().beginTurn();
  emitPlan([read, update, verify]);
  await waitFor(() => preview().length === 3 && select('.react-flow__edge'), 'plan did not generate connected canvas nodes');
  check(!select('.conversation-right .ap-plan'), 'plan should not occupy the conversation');
  check(graph.getState().nodes.length === 0 && graph.getState().edges.length === 0, 'plan display changed the executable graph');
  check(statuses().join() === 'completed,in_progress,pending', 'plan status labels are out of sync');
  check(active()?.textContent.includes(update.step), 'current step is not highlighted');
  check(window.getComputedStyle(active(), '::after').animationName === 'agent-plan-glow', 'current step has no breathing animation');
  check(preview().filter((node) => window.getComputedStyle(node, '::after').animationName === 'agent-plan-glow').length === 1, 'only the active step should animate');
  check(document.querySelectorAll('.react-flow__edge').length === 2, 'only declared dependencies should produce edges');
  const ids = preview().map((node) => node.closest('.react-flow__node').dataset.id);

  const ask = { id: 'ask', type: 'ask', question: '下一步先验证哪部分？', options: ['先验证画布', '先验证对话'] };
  const confirm = { id: 'confirm', type: 'confirm', what: '写入项目文件\n'.repeat(50), detail: '将修改项目内容', level: 'HIGH', rememberActions: ['file.write'] };
  window.toolFixture.emit(ask);
  window.toolFixture.emit(confirm);
  const card = await waitFor(() => select('.tool-dialog-slot .tool-dialog'), 'request not mounted above composer');
  const rect = card.getBoundingClientRect();
  const composer = select('.pp-composer').getBoundingClientRect();
  check(rect.bottom <= composer.top && composer.top - rect.bottom <= 20 && Math.abs(rect.right - composer.right) < 2,
    'request card does not align with the composer: ' + JSON.stringify({ rect, composer }));
  check(!card.hasAttribute('aria-modal') && !select('.tool-dialog-mask'), 'request obscures the workbench');
  check(card.contains(document.activeElement), 'request is not keyboard accessible when shown');
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  card.querySelector('.tool-dialog-btn.allow').dispatchEvent(tab);
  check(!tab.defaultPrevented, 'Tab should be able to leave the request');
  card.querySelector('.tool-dialog-opt').click();
  await waitFor(() => select('.tool-dialog .lv-high'), 'queued confirmation did not open');
  check(select('.tool-dialog-content').scrollHeight > select('.tool-dialog-content').clientHeight, 'long confirmation must scroll separately');
  const allow = select('.tool-dialog-btn.allow');
  check(allow.getBoundingClientRect().bottom <= select('.tool-dialog').getBoundingClientRect().bottom, 'actions should remain visible with long commands');
  allow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor(() => !select('.tool-dialog'), 'Escape did not dismiss the confirmation');
  check(JSON.stringify(window.toolFixture.responses()) === JSON.stringify([{ id: 'ask', result: { answer: '先验证画布' } }, { id: 'confirm', result: { ok: false } }]), 'ask or confirmation response changed');

  ui.getState().toggleConversation();
  window.toolFixture.emit({ id: 'free', type: 'ask', question: '请输入补充说明', options: [] });
  await waitFor(() => select('.tool-dialog-floating .tool-dialog-input'), 'request is inaccessible when conversation is hidden');
  const input = select('.tool-dialog-input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '  继续验证  ');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !select('.tool-dialog-btn.allow').disabled, 'free answer did not update');
  ui.getState().toggleConversation();
  const inlineInput = await waitFor(() => select('.tool-dialog-slot .tool-dialog-input'), 'request did not move with restored conversation');
  check(inlineInput.value === '  继续验证  ', 'moving a request discarded its draft');
  inlineInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check(window.toolFixture.responses().at(-1)?.result.answer === '继续验证', 'free answer was not sent');

  emitPlan([read, { ...update, status: 'completed' }, { ...verify, status: 'in_progress' }]);
  await waitFor(() => active()?.textContent.includes(verify.step), 'breathing effect did not move to the next step');
  check(preview().map((node) => node.closest('.react-flow__node').dataset.id).join() === ids.join(), 'plan updates regenerated node IDs');
  session.getState().stopTurn();
  await waitFor(() => !active(), 'interrupted work is still animating');
  check(select('.wf-plan-status[data-status="in_progress"]').textContent.includes('已暂停'), 'interrupted task appears to be running');

  session.getState().beginWorkSession('第二个会话');
  await waitFor(() => preview().length === 0, 'old plan leaked into new conversation');
  emitPlan([{ ...verify, status: 'blocked', reason: '缺少输入' }], firstId);
  check(!preview().length, 'background plan replaced the selected conversation');
  session.getState().switchSession(firstId);
  await waitFor(() => statuses().join() === 'blocked', 'switching back did not restore plan');
  check(select('.wf-plan-status').textContent.includes('缺少输入'), 'blocked reason was lost');

  graph.getState().addNode({
    id: 'legacy-plan', type: 'task', position: { x: 65, y: 110 },
    data: { label: verify.step, prompt: verify.step, planSourceId: firstId + ':run-ui', status: 'pending' },
  });
  await waitFor(() => select('[data-id="legacy-plan"] .wf-agent-plan'), 'previously imported nodes did not pick up plan status');
  check(preview().length === 1, 'previously imported step was duplicated');
  const styledTask = select('[data-id="legacy-plan"] .wf-node');
  check(styledTask.querySelector('.wf-node-kind').textContent === '◆' &&
    window.getComputedStyle(styledTask).borderLeftColor === 'rgb(59, 130, 246)', 'task node did not pick up the reference shape and accent');
  check(!!styledTask.querySelector('textarea.wf-node-prompt'), 'reference styling removed the editable task prompt');
  emitPlan([{ ...verify, status: 'completed' }]);
  await waitFor(() => statuses().join() === 'completed', 'completed status not displayed');

  graph.getState().clear();
  session.getState().beginTurn();
  const longStep = {
    ...update,
    step: '提出改进方案，覆盖页面路由、二维交互、地图状态和问答流程',
    acceptanceCriteria: '逐项核对关键交互，并记录可复现的验证结果。'.repeat(4),
  };
  const parallel = { ...verify, id: 'parallel', step: '核对地图交互', dependsOn: ['read'] };
  emitPlan([read, longStep, parallel]);
  window.toolFixture.emit({ ...ask, id: 'snapshot' });
  await waitFor(() => active() && select('.tool-dialog-slot .tool-dialog'), 'final state did not render');
  await waitFor(() => {
    const source = active()?.querySelector('.wf-plan-summary');
    const next = preview().find((node) => node.textContent.includes(parallel.step));
    return source?.offsetHeight > 48 && next?.getBoundingClientRect().top > active()?.getBoundingClientRect().bottom;
  }, 'long plan text did not wrap, or neighboring cards overlap');
}

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-plan-ui-'));
  const preload = path.join(root, 'plan-ui-preload.cjs');
  fs.writeFileSync(preload, '(' + installRequestFixture.toString() + ')()');
  const win = new BrowserWindow({
    width: 1200, height: 760, show: false,
    webPreferences: { sandbox: true, preload, backgroundThrottling: false, offscreen: !!process.env.CODENODE_PLAN_UI_SCREENSHOT },
  });
  try {
    const appRoot = process.env.CODENODE_PACKAGED_ASAR || path.resolve(__dirname, '../..');
    await win.loadFile(path.join(appRoot, 'dist/index.html'));
    await win.webContents.executeJavaScript('(' + exercise.toString() + ')(' + JSON.stringify(root) + ', window)');
    const { debugger: devtools } = win.webContents;
    devtools.attach('1.3');
    await devtools.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const animation = await win.webContents.executeJavaScript('window.getComputedStyle(document.querySelector(".wf-agent-plan.is-working"), "::after").animationName');
    if (animation !== 'none') throw new Error('reduced motion should disable breathing animation');
    if (process.env.CODENODE_PLAN_UI_SCREENSHOT) {
      await devtools.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      await new Promise((resolve) => setTimeout(resolve, 350));
      fs.writeFileSync(process.env.CODENODE_PLAN_UI_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    console.log('PLAN UI TEST: PASS');
    app.exit(0);
  } catch (error) {
    console.error('PLAN UI TEST: FAIL', error);
    app.exit(1);
  } finally {
    win.destroy();
    fs.unlinkSync(preload);
    fs.rmdirSync(root);
  }
});
