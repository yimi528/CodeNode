'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-trellis-connect-ui-')),project=path.join(temp,'project');fs.mkdirSync(project);
const userData=path.join(temp,'userdata');process.env.CODENODE_USER_DATA_DIR=userData;process.env.CODENODE_HOME=path.join(temp,'home');process.env.CODENODE_SOUL_FILE=path.join(temp,'soul.md');
const appRoot=process.env.CODENODE_PACKAGED_ASAR||path.resolve(__dirname,'../..');
const cli=require(path.join(appRoot,'electron/trellis/cli.cjs'));
const local=path.join(temp,'Trellis local');fs.mkdirSync(path.join(local,'packages/cli/bin'),{recursive:true});fs.copyFileSync(path.resolve(__dirname,'../fixtures/trellis-local-cli.cjs'),path.join(local,'packages/cli/bin/trellis.js'));
cli.saveSettings(userData,{executable:local,developer:'tester'});
fs.writeFileSync(path.join(project,'AGENTS.md'),'KEEP ORIGINAL RULES');
app.on('browser-window-created',(_event,win)=>win.hide());require(path.join(appRoot,'electron/main.cjs'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,preload:path.join(appRoot,'electron/preload.cjs')}});
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await sleep(100)}throw Error('UI wait failed: '+code)};
  const click=async text=>js(`(()=>{const b=[...document.querySelectorAll('.task-connect button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Button unavailable');b.click();})()`);
  try{
    await win.loadFile(path.join(appRoot,'dist/index.html'));
    await js(`window.__codenodeSession.getState().initProject();window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await wait(`!!document.querySelector('.global-settings-trigger')`);
    await js(`document.querySelector('.global-settings-trigger').click()`);
    await wait(`[...document.querySelectorAll('.settings-layout nav button')].some(b=>b.textContent==='项目与工具')`);
    await js(`[...document.querySelectorAll('.settings-layout nav button')].find(b=>b.textContent==='项目与工具').click()`);
    await wait(`document.querySelector('.project-integration-row button')?.textContent==='接入 Trellis'`);
    assert.equal(await js(`!!document.querySelector('.activity-bar [aria-label="任务"]')`),false);
    await js(`document.querySelector('.project-integration-row button').click()`);
    await wait(`document.querySelector('.task-connect')?.textContent.includes('本机 Trellis 已就绪')`);
    assert.equal(await js(`document.querySelector('[aria-label="接入开发者名称"]').value`),'tester');
    await click('生成接入预览');await wait(`!!document.querySelector('[aria-label="Trellis 接入预览"]')`);
    assert.equal(fs.existsSync(path.join(project,'.trellis')),false,'preview does not connect project');
    assert.equal(await js(`!!document.querySelector('.activity-bar [aria-label="任务"]')`),false,'preview does not expose the task entry');
    const before=await js(`document.querySelector('[aria-label="Trellis 接入预览"]').textContent`);
    await js(`document.querySelector('.project-integration-row button').click()`);
    assert.equal(await js(`document.querySelector('.task-connect').getClientRects().length`),0,'collapsing hides the connection form');
    await js(`document.querySelector('.project-integration-row button').click()`);
    assert.equal(await js(`document.querySelector('[aria-label="Trellis 接入预览"]').textContent`),before,'reopening preserves the preview');
    for(const theme of ['light','dark']){
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
      await wait(`!document.querySelector('.task-connect button').disabled`);
      assert.equal(await js(`document.querySelector('[aria-label="Trellis 接入预览"]').textContent`),before,'connection preview survives theme change');
    }
    await click('spec/index.md');await wait(`document.querySelector('.task-connect article')?.textContent.includes('Local CLI generated spec')`);
    await click('确认导入项目资料');
    await wait(`document.querySelector('.project-integration-row button')?.textContent==='查看任务' && !!document.querySelector('.activity-bar [aria-label="任务"]')`);
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),'KEEP ORIGINAL RULES');assert.equal(fs.existsSync(path.join(project,'.codex')),false);
    await js(`document.querySelector('.project-cli-toggle').click()`);await wait(`!!document.querySelector('[aria-label="Trellis CLI 路径"]')`);
    await wait(`document.querySelector('[aria-label="Trellis CLI 路径"]')?.value===${JSON.stringify(local)}`);
    assert.equal(await js(`document.querySelector('[aria-label="Trellis CLI 路径"]').value`),local);assert.equal(await js(`document.querySelector('[aria-label="Trellis 默认开发者"]').value`),'tester');
    await js(`document.querySelector('.project-integration-row button').click()`);
    await wait(`!document.querySelector('.settings-mask')&&document.querySelector('.task-page-heading')?.textContent.includes('本机 CLI 任务')`);
    await win.reload();await wait('!!window.__codenodeProject');await js(`window.__codenodeSession.getState().initProject();window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await wait(`!!document.querySelector('.activity-bar [aria-label="任务"]')`);await js(`document.querySelector('.activity-bar [aria-label="任务"]').click()`);await wait(`document.querySelector('.task-page-heading')?.textContent.includes('本机 CLI 任务')`);
    console.log('TRELLIS CONNECT UI: PASS (real local subprocess via IPC, default developer, preview file read, both themes preserve plan, task entry appears only after import, explicit shared-only import, settings persistence and reopen detection)');
  }finally{win.destroy()}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
app.on('quit',()=>{try{fs.rmSync(temp,{recursive:true,force:true})}catch{}});
