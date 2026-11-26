'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tutorial-test-'));
const project = path.join(temp, 'project');
fs.mkdirSync(project);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tutorial-evidence-'));
const root = path.resolve(__dirname, '../..');
process.env.CODENODE_USER_DATA_DIR = path.join(temp, 'userdata');
process.env.CODENODE_HOME = path.join(temp, 'home');
process.env.CODENODE_SOUL_FILE = path.join(temp, 'soul.md');
app.on('browser-window-created', (_event, win) => win.hide());
require(path.join(root, 'electron/main.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1536, height: 1000, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false, preload: path.join(root, 'electron/preload.cjs') } });
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    const details = /** @type {{level?:number|string,message?:string}} */ (event);
    if (String(details.level ?? level) === 'error' || Number(details.level ?? level) === 3) errors.push(details.message ?? message);
  });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(String(error) + '\nSCRIPT: ' + code + '\nCONSOLE: ' + errors.join('\n')); });
  const wait = async (code, label = code) => {
    for (let index = 0; index < 150; index++) { if (await js(code)) return; await sleep(60); }
    throw new Error('Timeout: ' + label);
  };
  const click = async selector => {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing control: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await sleep(120);
  };
  const clickText = async (scope, text) => {
    await wait(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(el=>el.textContent.trim()===${JSON.stringify(text)})`);
    await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Missing text: '+${JSON.stringify(text)});el.dataset.tutorialTest='click';})()`);
    await click('[data-tutorial-test="click"]');
    await js(`document.querySelector('[data-tutorial-test="click"]')?.removeAttribute('data-tutorial-test')`);
  };
  const input = async (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(100); };
  const shot = async name => { win.webContents.invalidate(); await sleep(250); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); };
  const snapshot = () => js(`JSON.stringify({nodes:window.__codenodeStore.getState().nodes,edges:window.__codenodeStore.getState().edges,selection:window.__codenodeStore.getState().selectedIds,viewport:window.__codenodeUi.getState().viewport,session:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input')?.value,navigation:window.__codenodeUi.getState().navigationOpen,conversation:window.__codenodeUi.getState().conversationOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
  try {
    await win.loadFile(path.join(root, 'dist/index.html'));
    await wait('!!window.__codenodeProject');
    await js(`window.__codenodeUi.getState().updatePreferences({advancedMode:true,autoSaveEnabled:false,workbenchView:'conversation'});window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await wait('!!document.querySelector(".pp-input")');
    await js(`window.__codenodeSession.getState().newCanvas();window.__codenodeUi.getState().setTutorialHintDismissed(false)`);
    await wait('!!document.querySelector(".canvas-wrap")');
    assert.match(win.webContents.getURL(), /dist\/index\.html$/);
    assert.match(await js('document.title'), /CodeNode/);
    assert.equal(await js(`document.querySelectorAll('.canvas-wrap .canvas-ornament').length`), 0);
    assert.equal(await js(`!!document.querySelector('.canvas-wrap .tutorial-brand')`), false);
    await shot('empty-canvas');
    const before = await snapshot();
    await click('.global-settings-trigger');
    await clickText('.settings-layout nav button', '常规与界面');
    await clickText('.settings-content summary', '帮助与教程');
    await clickText('.settings-content button', '打开使用教程');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='创建第一个节点'`);
    await shot('tutorial-create');
    assert.equal(await js(`!!document.querySelector('.app-body[inert]')`), true);
    await click('.tutorial-demo-menu button');
    await wait(`document.querySelector('.tutorial-demo-result')?.textContent.includes('节点已创建')`);
    assert.equal(await snapshot(), before, 'tutorial create must not change canvas, session or draft');
    await click('.tutorial-primary');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='编辑节点内容'`);
    await input('[aria-label="演示节点名称"]', '我的第一个练习');
    await wait(`document.querySelector('.tutorial-demo-node strong')?.textContent==='我的第一个练习'`);
    await click('.tutorial-primary');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='连接节点'`);
    await click('.tutorial-demo-connect .tutorial-secondary');
    await wait(`document.querySelector('.tutorial-demo-connect [role="status"]')?.textContent.includes('已连接')`);
    assert.equal(await snapshot(), before, 'all tutorial exercises must stay isolated');
    await input('[aria-label="搜索教程或快捷键"]', '缩放');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='搜索结果'`);
    assert.equal(await js(`document.querySelector('.tutorial-shortcuts').textContent.includes('缩放视图')`), true);
    assert.equal(await js(`document.querySelector('.tutorial-shortcuts').textContent.includes('新建项目')`), false);
    await input('[aria-label="搜索教程或快捷键"]', '不存在的操作987');
    await wait(`!!document.querySelector('.tutorial-no-results')`);
    await key('Escape');
    await wait(`document.querySelector('[aria-label="搜索教程或快捷键"]').value===''`);
    await click('.tutorial-back');
    await wait(`!document.querySelector('.tutorial-page')`);
    assert.equal(await snapshot(), before, 'return must restore original workspace');

    // Real creation/deletion events verify the empty-state lifecycle, not just store selectors.
    await click('.canvas-wrap .react-flow__pane');
    await key('A', ['shift']);
    await wait(`!!document.querySelector('.add-menu')`);
    await clickText('.add-menu-label', '新建任务');
    await wait(`window.__codenodeStore.getState().nodes.length===1`);
    assert.equal(await js(`!!document.querySelector('.canvas-tutorial-hint')`), false);
    await js(`document.activeElement?.blur();window.__codenodeStore.getState().setSelectedIds(window.__codenodeStore.getState().nodes.map(n=>n.id))`);
    await key('Delete');
    await wait(`window.__codenodeStore.getState().nodes.length===0`);
    assert.equal(await js(`!!document.querySelector('.canvas-tutorial-hint')`), false);

    await click('.global-settings-trigger');
    await wait('!!document.querySelector(".global-settings")');
    await clickText('.settings-layout nav button', '常规与界面');
    await clickText('.settings-content summary', '帮助与教程');
    await shot('settings-help');
    await clickText('.settings-content button', '打开快捷键速查');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='快捷键速查'`);
    assert.equal(await js(`document.querySelectorAll('.tutorial-shortcut-group').length`), 6);
    await click('.tutorial-back');
    await wait(`!document.querySelector('.tutorial-page')`);
    await js(`window.__codenodeStore.getState().addNode({id:'retained-node',type:'task',position:{x:200,y:180},data:{label:'保留的任务',status:'pending'}});window.__codenodeStore.getState().setSelectedIds(['retained-node']);window.__codenodeSession.getState().pushUser('保留这条对话')`);
    await input('.pp-input', '保留输入草稿');
    await sleep(200);
    const populated = await snapshot();
    await click('.global-settings-trigger');
    await clickText('.settings-layout nav button', '常规与界面');
    await clickText('.settings-content summary', '帮助与教程');
    await clickText('.settings-content button', '打开使用教程');
    await wait(`document.querySelector('.tutorial-page h1')?.textContent==='创建第一个节点'`);
    await js(`document.querySelector('.tutorial-page h1').focus()`);
    const guardedKeys = /** @type {[string,string[]][]} */ ([['Delete', []], ['X', []], ['A', ['shift']], ['D', ['control']], ['J', ['control']], ['P', ['control']], ['Z', ['control']], ['Home', []]]);
    for (const [code, modifiers] of guardedKeys) await key(code, modifiers);
    assert.equal(await js(`window.__codenodeUi.getState().addMenu`), null);
    assert.equal(await snapshot(), populated, 'tutorial keys must not mutate the background workspace');
    for (const theme of ['light', 'dark', 'bright']) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(120);
      assert.equal(await js(`document.querySelectorAll('.tutorial-sidebar nav button').length`), 7);
      await shot('tutorial-' + theme);
    }
    await js(`window.__codenodeUi.getState().setTheme('light')`);
    await clickText('.tutorial-sidebar .tutorial-chapter', '画布操作');
    await click('[aria-label="放大演示"]');
    assert.equal(await js(`document.querySelector('.tutorial-demo-zoom output').textContent`), '125%');
    await clickText('.tutorial-sidebar .tutorial-chapter', '画布节点');
    await clickText('.tutorial-demo-tools button', '椭圆');
    assert.equal(await js(`!!document.querySelector('.shape-椭圆')`), true);
    await click('.tutorial-back');
    assert.equal(await snapshot(), populated, 'themes and tutorial navigation preserve graph and drafts');
    await js(`window.__codenodeUi.getState().openTutorial('create')`);
    await wait(`!!document.querySelector('.tutorial-page h1')`);
    for (const [width, height] of [[900, 800], [430, 900]]) {
      win.setSize(width, height);
      await sleep(350);
      const overflow = await js(`(()=>{const page=document.querySelector('.tutorial-page'),main=document.querySelector('.tutorial-reading');return{page:page.scrollWidth-page.clientWidth,main:main.scrollWidth-main.clientWidth}})()`);
      assert.ok(overflow.page <= 1 && overflow.main <= 1, 'no horizontal overflow at ' + width + ': ' + JSON.stringify(overflow));
      await shot('tutorial-' + width);
    }
    assert.equal(await js(`!!document.querySelector('vite-error-overlay')`), false);
    assert.deepEqual(errors, [], 'renderer console must have no errors');
    console.log('TUTORIAL UI: PASS (reference empty canvas, both settings entries, isolated demos, search, background shortcut protection, state preservation, 3 themes, desktop/narrow layouts)');
    console.log('EVIDENCE=' + output);
    app.exit(0);
  } catch (error) { console.error(error); console.error('EVIDENCE=' + output); app.exit(1); }
});
app.on('quit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
