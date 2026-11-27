'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-node-inspector-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, "../..");
const output = process.env.CODENODE_NODE_INSPECTOR_OUTPUT || path.join(__dirname, "../../release/node-inspector");
const userData = path.join(root, 'userData');
process.env.CODENODE_USER_DATA_DIR = userData;
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000,
    webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(moduleRoot, 'electron/preload.cjs') } });
  try {
    fs.mkdirSync(output, { recursive: true });
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(userData,
      [{ id: 'inspector-model', model: 'fixture-model', label: 'Inspector test', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-ui-key' }], 'inspector-model');
    await win.loadFile(path.join(moduleRoot, 'dist/index.html'));
    win.setPosition(-1900, -1900); win.showInactive();
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; !window.__codenodeProject && i < 120; i++) await new Promise(r => setTimeout(r, 50));
      window.__codenodeUi.getState().updatePreferences({advancedMode:true,vectorEditorEnabled:true});
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      if (!window.__codenodeSession.getState().current()) window.__codenodeSession.getState().newCanvas();
      for (let i = 0; (!document.querySelector('.canvas-add-trigger') || document.querySelector('.startup-splash')) && i < 120; i++) await new Promise(r => setTimeout(r, 50));
      if (!document.querySelector('.canvas-add-trigger') || document.querySelector('.startup-splash')) throw Error('Canvas did not finish starting');
    })()`);
    const reports = [];
    for (const theme of ['light', 'dark']) {
      const report = await win.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const click = selector => {
          const element = document.querySelector(selector);
          if (!element) throw Error('Missing ' + selector + ', selected=' + window.__codenodeStore.getState().selectedId + ', tab=' + window.__codenodeUi.getState().sideTab);
          element.click();
        };
        const ui = window.__codenodeUi, graph = window.__codenodeStore, session = window.__codenodeSession;
        ui.setState({ sideTab: 'agent', sideOpen: false });
        if (ui.getState().theme !== ${JSON.stringify(theme)}) ui.getState().toggleTheme();
        await sleep(200);
        const input = document.querySelector('.pp-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'draft stays');
        input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
        const before = { session: session.getState().activeId, draft: input.value,
          model: (await window.codenode.modelsList()).activeId, navigation: ui.getState().navigationOpen };
        const oldCount = graph.getState().nodes.length;
        click('.canvas-add-trigger'); await sleep(60); click('.add-menu-item[data-node-type=vector]'); await sleep(350);
        const vector = { count: graph.getState().nodes.length, type: graph.getState().nodes.find(n => n.id === graph.getState().selectedId)?.type,
          tab: ui.getState().sideTab, open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel') };
        input.blur();
        graph.getState().setSelectedIds([]); await sleep(60);
        const bounds = document.querySelector('.canvas-wrap').getBoundingClientRect();
        window.dispatchEvent(new MouseEvent('mousemove', {clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height/2}));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', shiftKey: true, bubbles: true, cancelable: true }));
        await sleep(70);
        const menu = { exists: !!document.querySelector('.add-menu'), open: ui.getState().sideOpen, tab: ui.getState().sideTab };
        const item = [...document.querySelectorAll('.add-menu-item')].find(el => el.textContent.includes('任务'));
        if (!item) throw Error('Task template not found: ' + JSON.stringify({ menu, focus: document.activeElement.tagName, selected: graph.getState().selectedId })); item.click(); await sleep(150);
        const task = { count: graph.getState().nodes.length, type: graph.getState().nodes.find(n => n.id === graph.getState().selectedId)?.type,
          open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel') };

        const inlineEditor = document.querySelector('.react-flow__node.selected .wf-node-prompt');
        if (!inlineEditor || document.querySelector('.node-editor')) throw Error('任务节点应显示内联编辑器');
        const previousHeight = inlineEditor.clientHeight;
        const longPrompt = '逐项检查交互与验收条件，并记录验证结果。'.repeat(6);
        inlineEditor.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(inlineEditor, longPrompt);
        inlineEditor.dispatchEvent(new Event('input', { bubbles: true })); await sleep(70);
        if (inlineEditor.clientHeight <= previousHeight || inlineEditor.scrollHeight > inlineEditor.clientHeight + 1 ||
            graph.getState().nodes.find(n => n.id === graph.getState().selectedId).data.prompt !== longPrompt)
          throw Error('内联指令编辑后应保存并随文案增高');
        inlineEditor.blur();
        click('.node-actions [aria-label="展开输入框"]'); await sleep(50);
        const editor = document.querySelector('.node-editor textarea');
        const editorBox = editor.closest('section').getBoundingClientRect();
        const cardBox = document.querySelector('.react-flow__node.selected').getBoundingClientRect();
        if (editorBox.top < cardBox.bottom - 1) throw Error('节点下方输入框位置错误');
        editor.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, '节点的独立指令');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(40);
        if (graph.getState().nodes.find(n => n.id === graph.getState().selectedId).data.prompt !== editor.value || input.value !== before.draft)
          throw Error('节点编辑未隔离对话草稿');
        click('.node-actions [aria-label="引用到对话"]'); await sleep(50);
        if (!input.value.startsWith(before.draft) || !input.value.includes(graph.getState().selectedId) || !input.value.endsWith(editor.value))
          throw Error('对话引用缺少节点内容');
        before.draft = input.value;
        click('.node-actions [aria-label="编辑节点"]');
        await sleep(150);
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        const layout = { panel: rect('.side-panel'), canvas: rect('.workspace-canvas'), conversation: rect('.conversation-right'),
          position: getComputedStyle(document.querySelector('.side-panel')).position, open: ui.getState().sideOpen };
        click('.sp-close'); await sleep(60);
        click('.canvas-add-trigger'); await sleep(60); click('.add-menu-item[data-node-type=vector]'); await sleep(300);
        const closed = { open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel'), tab: ui.getState().sideTab };
        click('.node-actions [aria-label="编辑节点"]'); await sleep(100);
        const selected = graph.getState().selectedId;
        click('.canvas-add-trigger'); await sleep(60); click('.add-menu-item[data-node-type=vector]'); await sleep(300);
        const preservedOpen = { open: ui.getState().sideOpen, selectedChanged: selected !== graph.getState().selectedId };
        ui.getState().toggleTheme(); await sleep(80); ui.getState().toggleTheme(); await sleep(80);
        const after = { session: session.getState().activeId, draft: input.value,
          model: (await window.codenode.modelsList()).activeId, navigation: ui.getState().navigationOpen };
        return { theme: ui.getState().theme, oldCount, vector, menu, task, layout, closed, preservedOpen, before, after };
      })()`);
      assert.equal(report.vector.count, report.oldCount + 1);
      assert.equal(report.vector.type, 'vector');
      assert.deepEqual([report.vector.open, report.vector.panel, report.vector.tab], [false, false, 'agent']);
      assert.deepEqual(report.menu, { exists: true, open: false, tab: 'agent' });
      assert.equal(report.task.count, report.oldCount + 2);
      assert.equal(report.task.type, 'task');
      assert.equal(report.task.open, false); assert.equal(report.task.panel, false);
      assert.equal(report.layout.open, true); assert.equal(report.layout.position, 'relative');
      assert.ok(report.layout.panel.width > 100 && report.layout.canvas.width > 100);
      assert.ok(report.layout.panel.right <= report.layout.canvas.left + 1, JSON.stringify(report.layout));
      assert.ok(report.layout.canvas.right <= report.layout.conversation.left + 1, JSON.stringify(report.layout));
      assert.deepEqual(report.closed, { open: false, panel: false, tab: 'node' });
      assert.deepEqual(report.preservedOpen, { open: true, selectedChanged: true });
      assert.deepEqual(report.after, report.before);
      if (process.env.CODENODE_CAPTURE_NODE_INSPECTOR === '1') {
        fs.writeFileSync(path.join(output, 'node-inspector-' + theme + '.png'),
          (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      }
      reports.push(report);
    }
    const settings = await win.webContents.executeJavaScript(`(async () => {
      const ui = window.__codenodeUi;
      ui.getState().openSettings('layout');
      for (let i = 0; !document.querySelector('.settings-menu-actions') && i < 120; i++) await new Promise(r => setTimeout(r, 50));
      if (!document.querySelector('.settings-menu-actions')) throw Error('Layout settings did not finish loading');
      // 画布菜单的可见操作在「界面 → 画布菜单」折叠项里，必须先展开。
      const advanced = document.querySelector('.settings-advanced'); if (advanced) advanced.open = true;
      await new Promise(r => setTimeout(r, 60));
      const label = [...document.querySelectorAll('.settings-menu-actions label')].find(el => el.textContent === '节点属性');
      if (!label) throw Error('Properties menu setting missing');
      const checkbox = label.querySelector('input'); checkbox.click(); await new Promise(r => setTimeout(r, 50));
      const hidden = !ui.getState().preferences.visibleActions.includes('properties');
      const savedHidden = !JSON.parse(localStorage.getItem('codenode.uiPreferences')).visibleActions.includes('properties');
      checkbox.click(); ui.getState().closeSettings();
      return { hidden, savedHidden, restored: ui.getState().preferences.visibleActions.includes('properties') };
    })()`);
    assert.deepEqual(settings, { hidden: true, savedHidden: true, restored: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, reports, settings }, null, 2) + '\n');
    console.log('NODE INSPECTOR UI: PASS (new-node button and Shift+A stay closed; manual properties do not overlap canvas; both themes and draft/session/model/navigation preserved; menu visibility persists)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('codenode-node-inspector-')) return;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
