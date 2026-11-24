'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const fixture = require('../fixtures/trellis-v0.6.17.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trellis-ui-'));
const asar = process.env.CODENODE_PACKAGED_ASAR;
const appRoot = asar || path.resolve(__dirname, '../..');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userdata');
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
for (const [source, text] of Object.entries(fixture.files)) {
  const full = path.join(root, 'project', source); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
}
const workspace = path.join(root, 'project/.trellis/workspace/tester'); fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'journal-1.md'), '# Journal - tester (Part 1)\n\nKEEP JOURNAL\n');
fs.writeFileSync(path.join(workspace, 'index.md'), '# Workspace Index - tester\nKEEP NOTES\n<!-- @@@auto:current-status -->\n- **Active File**: `journal-1.md`\n- **Total Sessions**: 0\n- **Last Active**: 2026-10-09\n<!-- @@@/auto:current-status -->\n<!-- @@@auto:active-documents -->\n| File | Lines | Status |\n|------|-------|--------|\n| `journal-1.md` | ~3 | Active |\n<!-- @@@/auto:active-documents -->\n<!-- @@@auto:session-history -->\n| # | Date | Title | Commits | Branch |\n|---|------|-------|---------|--------|\n<!-- @@@/auto:session-history -->\n');
app.on('browser-window-created', (_event, win) => win.hide());
require(path.join(appRoot, 'electron/main.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(win, script) { for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript(script)) return; await sleep(100); } throw new Error('UI wait failed: ' + script); }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1380, height: 920, webPreferences: { sandbox: true, offscreen:true, backgroundThrottling:false, preload: path.join(appRoot, 'electron/preload.cjs') } });
  let lastPaint=null;
  win.webContents.on('paint',(_event,_dirty,image)=>{lastPaint=image.toPNG()});
  win.webContents.setFrameRate(30);win.webContents.startPainting();
  const js = code => win.webContents.executeJavaScript(code);
  const click = async (text, scope='.task-workspace') => js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});b.click();})()`);
  const field = async (label,value) => js(`(()=>{const n=document.querySelector(${JSON.stringify('[aria-label='+JSON.stringify(label)+']')});if(!n)throw new Error('Field unavailable');if(n.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));}else{n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  const taskReady = () => waitFor(win, `document.querySelector('.task-document')?.textContent.includes('DEMO_PRD') && !document.querySelector('.task-bind')?.disabled`);
  const openTasks = async () => {
    await waitFor(win, `!!document.querySelector('.activity-bar [aria-label="任务"]')`);
    await js(`document.querySelector('.activity-bar [aria-label="任务"]').click()`);
    await taskReady();
  };
  const reopen = async file => {
    await win.reload();
    await waitFor(win,'!!window.__codenodeProject');
    await js(`(async()=>{const r=await window.codenode.loadProject(${JSON.stringify(file)});if(!r.ok)throw Error(r.error);const d=r.data.canvases;await window.__codenodeProject.getState().loadRoot(${JSON.stringify(path.join(root,'project'))});window.__codenodeSession.getState().restoreSessions(d.sessions.map(s=>({...s,doc:s.doc||{root:s.root}})),d.messages,d.activeId,d.memoryConversationId)})()`);
    await openTasks();
  };
  try {
    await win.loadFile(path.join(appRoot,'dist/index.html'));
    const empty=path.join(root,'empty');fs.mkdirSync(empty);
    await js(`window.__codenodeSession.getState().initProject();window.__codenodeSession.setState({memoryConversationId:'trellis-ui-conversation'});window.__codenodeProject.getState().loadRoot(${JSON.stringify(empty)})`);
    await waitFor(win,`!!document.querySelector('.global-settings-trigger')`);
    assert.equal(await js(`!!document.querySelector('.activity-bar [aria-label="任务"]')`),false,'unconnected projects hide the task entry');
    const project=path.join(root,'project');
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await openTasks();
    assert.equal(await js(`!!document.querySelector('.conversation-task-link')`),false,'browsing does not bind a task');
    await click('绑定到当前对话'); await waitFor(win,`document.querySelector('.conversation-task-link')?.textContent.includes('兼容测试任务')`);
    const before=await js(`(()=>{const n=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'保持草稿');n.dispatchEvent(new Event('input',{bubbles:true}));return {active:window.__codenodeSession.getState().activeId,conversation:window.__codenodeSession.getState().memoryConversationId,nav:window.__codenodeUi.getState().navigationOpen,model:document.querySelector('.model-connection-trigger')?.title};})()`);
    await click('工作日志'); await field('Trellis 写回说明','保留任务编辑草稿');
    for(const theme of ['light','dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
      await js(`document.querySelector('.activity-bar [aria-label="工作台"]').click()`);
      assert.equal(await js(`document.querySelector('.task-workspace').hidden`),true);
      assert.equal(await js(`!!document.querySelector('.pp-composer .trellis-write-panel')`),false,'composer contains no task management form');
      await click('查看任务','.conversation-task-link');
      assert.equal(await js(`document.querySelector('[aria-label="Trellis 写回说明"]').value`),'保留任务编辑草稿','task editor survives page/theme switching');
      const after=await js(`({active:window.__codenodeSession.getState().activeId,conversation:window.__codenodeSession.getState().memoryConversationId,nav:window.__codenodeUi.getState().navigationOpen,model:document.querySelector('.model-connection-trigger')?.title})`);
      assert.deepEqual(after,before);assert.equal(await js(`document.querySelector('.pp-input').value`),'保持草稿');
    }
    for(const [theme,status] of [['light','planning'],['dark','in_progress']]) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await field('Trellis 写回状态',status);await field('Trellis 写回说明','人工状态证据');await click('预览修改');
      await waitFor(win,`!!document.querySelector('[aria-label="Trellis 修改预览"]')`);
      const preview=await js(`document.querySelector('[aria-label="Trellis 修改预览"]').textContent`);
      await js(`document.querySelector('.activity-bar [aria-label="工作台"]').click()`);await click('查看任务','.conversation-task-link');
      assert.equal(await js(`document.querySelector('[aria-label="Trellis 修改预览"]').textContent`),preview);
      await click('应用预览修改');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('事务状态：applied')`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(project,fixture.taskPath,'task.json'),'utf8')).status,status);
      await click('重新读取写回结果');await taskReady();
    }
    await field('Trellis 修改类型','journal');await waitFor(win,`!!document.querySelector('[aria-label="Trellis 日志开发者"]')`);
    await field('Trellis 日志开发者','tester');await field('Trellis 写回说明','新任务页面工作摘要');await field('日志验证结果','局部界面验证');await field('日志下一步','继续审查');await click('预览修改');
    await waitFor(win,`document.querySelector('[aria-label="Trellis 修改预览"]')?.textContent.includes('journal')`);await click('应用预览修改');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('事务状态：applied')`);
    assert.match(fs.readFileSync(path.join(workspace,'journal-1.md'),'utf8'),/新任务页面工作摘要/);
    await click('添加任务执行流程');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('已添加准备')`);
    const file=await js('window.__codenodeProject.getState().projectFile');assert.ok(file);
    await click('查看生成的画布');assert.equal(await js(`window.__codenodeUi.getState().appPage`),'workbench');
    assert.equal(await js(`window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length`),4);
    await reopen(file);assert.equal(await js(`window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length`),4);
    const writes=require(path.join(appRoot,'electron/trellis/writes.cjs')),trellis=require(path.join(appRoot,'electron/trellis/index.cjs')),atomic=require(path.join(appRoot,'electron/atomicFile.cjs')).atomicWriteFile;
    const proposal=writes.proposeJournal(project,fixture.taskPath,{developer:'tester',summary:'重开后恢复',verification:'恢复测试',nextSteps:'继续审查',expectedFingerprint:trellis.readTask(project,fixture.taskPath).fingerprint});let count=0;
    assert.equal(writes.applyProposal(project,proposal.id,'apply',{write:(f,c,e,g)=>{if(++count===2)throw Error('injected index failure');atomic(f,c,e,g)}}).status,'needs-recovery');
    await reopen(file);await click('工作日志');await waitFor(win,`!!document.querySelector('[aria-label="Trellis 恢复事务"]')`);await field('Trellis 恢复事务',proposal.id);await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('恢复剩余写入')`);await click('恢复剩余写入');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('事务状态：applied')`);
    assert.equal((fs.readFileSync(path.join(workspace,'journal-1.md'),'utf8').match(/## Session 2:/g)||[]).length,1);
    await field('Trellis 修改类型','status');await field('Trellis 写回说明','保留原始编辑版本');
    const taskFile=path.join(project,fixture.taskPath,'task.json'),external=fs.readFileSync(taskFile,'utf8')+'\n';fs.writeFileSync(taskFile,external);
    await click('刷新任务');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('任务原始版本已变化')`);
    await click('预览修改');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('任务来源已变化')`);
    assert.equal(fs.readFileSync(taskFile,'utf8'),external,'refresh never silently rebases an edited draft');
    await click('重新载入原始版本');await waitFor(win,`document.querySelector('.trellis-write-panel').textContent.includes('已重新载入原始版本')`);
    assert.equal(await js(`document.querySelector('[aria-label="Trellis 写回说明"]').value`),'保留原始编辑版本');
    const shots=process.env.CODENODE_TRELLIS_SCREENSHOTS;
    if (shots) fs.mkdirSync(shots,{recursive:true});
    const screenshot = async (name,theme) => {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
      if (!shots) return;
      lastPaint=null;
      win.webContents.invalidate();
      await sleep(500);
      for(let i=0;i<100&&!lastPaint;i++)await sleep(50);
      assert.ok(lastPaint,'offscreen preview frame');
      fs.writeFileSync(path.join(shots,name+theme+'.png'),lastPaint);
    };
    await click('需求与规范');
    for (const theme of ['light','dark']) await screenshot('tasks-',theme);
    await js(`(async()=>{await window.codenode.trellisCliSave({executable:'missing-trellis-for-ui',developer:''});await window.__codenodeProject.getState().loadRoot(${JSON.stringify(empty)})})()`);
    await waitFor(win,`window.__codenodeUi.getState().appPage==='workbench'`);
    assert.equal(await js(`!!document.querySelector('.activity-bar [aria-label="任务"]')`),false,'switching to an unconnected project removes the previous task entry');
    await js(`document.querySelector('.global-settings-trigger').click()`);
    await waitFor(win,`[...document.querySelectorAll('.settings-layout nav button')].some(b=>b.textContent==='项目设置')`);
    await js(`[...document.querySelectorAll('.settings-layout nav button')].find(b=>b.textContent==='项目设置').click()`);
    await waitFor(win,`document.querySelector('.project-integration-row button')?.textContent==='接入 Trellis'`);
    for (const theme of ['light','dark']) await screenshot('project-settings-',theme);
    await js(`document.querySelector('.project-integration-row button').click()`);
    await waitFor(win,`document.querySelector('.task-connect')?.textContent.includes('尚未连接本机工具')`);
    await click('配置本机 Trellis','.task-connect');
    await waitFor(win,`!!document.querySelector('[aria-label="Trellis CLI 路径"]')`);
    console.log('TASK WORKSPACE UI: PASS (conditional rail entry, project-switch fallback, project settings, browse/bind separation, preserved composer/editor/preview, status/journal writeback, saved canvas, and reopened transaction recovery)');

  }finally{win.destroy();}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
app.on('quit',()=>{try{fs.rmSync(root,{recursive:true,force:true})}catch{}});
