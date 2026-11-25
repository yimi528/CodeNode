'use strict';
// No Browser plugin is supplied; use the project's real Electron/preload/main path.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
app.disableHardwareAcceleration();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-acceptance-ui-'));
const source=path.join(__dirname,'../..'),userData=path.join(root,'userData');
process.env.CODENODE_USER_DATA_DIR=userData;process.env.CODENODE_HOME=path.join(root,'home');process.env.CODENODE_SOUL_FILE=path.join(root,'soul.md');
fs.mkdirSync(path.join(root,'.codenode'),{recursive:true});
fs.writeFileSync(path.join(root,'.codenode/agent.properties'),'sandbox.mode=off\nrag.enabled=false\nsoul.evolution.enabled=false\nediting.auto_verify=false\n');
fs.writeFileSync(path.join(root,'value.txt'),'bad');
fs.writeFileSync(path.join(root,'verify.cjs'),`if(require('fs').readFileSync('value.txt','utf8')!=='good'){console.error('public example');process.exit(1)}`);
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node verify.cjs'}}));
app.on('browser-window-created',(_e,win)=>{win.show=()=>{};win.hide();});
require(path.join(source,'electron/main.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false,preload:path.join(source,'electron/preload.cjs')}});
 let model,approvals;
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=code=>win.webContents.executeJavaScript(code);
 const wait=async(code,label=code)=>{for(let i=0;i<400;i++){if(await js(code))return;await sleep(50);}throw Error('Timeout '+label+' console: '+errors.join(' | '));};
 const change=async(label,value)=>{await js(`(()=>{const el=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(30);};
 try{
  require(path.join(source,'electron/modelStore.cjs')).writeModels(userData,[{id:'desktop-fixture',model:'fixture-model',label:'Offline acceptance',apiBase:'http://127.0.0.1:1',apiKey:'synthetic-ui-key'}],'desktop-fixture');
  await win.loadFile(path.join(source,'dist/index.html'));await wait('!!window.__codenodeUi && window.__codenodeUi.getState().booted && (!!document.querySelector(".workspace-home") || !!document.querySelector(".pp-input"))');
  assert.match(await js('document.title'),/CodeNode/);assert.match(win.webContents.getURL(),/dist\/index.html$/);
  await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false,typewriterEnabled:false,autoCollapseSidebars:false});window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});window.__codenodeSession.getState().newCanvas()`);
  await wait('!!document.querySelector(".task-acceptance-options")');
  assert.equal(await js('window.__codenodeUi.getState().preferences.advancedMode'),false);
  await js(`document.querySelector('.task-acceptance-options').open=true;[...document.querySelectorAll('.task-acceptance-options button')].find(b=>b.textContent==='使用项目测试').click()`);
  await wait(`document.querySelector('[aria-label="启用任务验收"]').checked`);
  assert.equal(await js(`document.querySelector('[aria-label="验收程序"]').value`),'npm');
  await change('验收程序','node');await change('验收参数','["verify.cjs"]');await change('验收输入范围','value.txt\nverify.cjs');await change('必需产物','value.txt');
  await js(`document.querySelector('[aria-label="要求修改前复现"]').click()`);await sleep(60);await change('复现错误标记','public example');
  await js(`(()=>{const el=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'修复 value.txt 并按规则验收');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(80);
  model=require('../lib/scripted-model.cjs').installScriptedModel([{toolCalls:[{name:'write_file',args:{path:'value.txt',content:'good'}}]},{content:'已完成'}],{loopLast:true});
  approvals=setInterval(()=>{void js(`document.querySelector('.tool-dialog-btn.allow')?.click()`).catch(()=>{});},50);
  await js(`document.querySelector('.pp-send').click()`);
  await wait(`window.__codenodeSession.getState().messages.some(m=>m.taskAcceptance?.status==='passed')`,'frozen rule real IPC run passes');
  await wait(`!window.__codenodeSession.getState().streaming`,'settled');
  const report=await js(`window.__codenodeSession.getState().messages.find(m=>m.taskAcceptance?.status==='passed').taskAcceptance`);
  assert.equal(report.verified,true);assert.equal(report.checks.find(c=>c.phase==='before').exitCode,1);assert.equal(report.checks.find(c=>c.phase==='after').exitCode,0);
  assert.equal(fs.readFileSync(path.join(root,'value.txt'),'utf8'),'good');
  const records=require('../../electron/runStore.cjs').listRuns(root);assert.ok(records.length);
  assert.equal(await js(`!!document.querySelector('[aria-label="任务验收"]')`),true);
  // A malformed draft must never dispatch another model request or clear the prompt.
  await change('验收参数','not JSON');
  await js(`(()=>{const el=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'保留草稿');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(50);
  const calls=model.calls;await js(`document.querySelector('.pp-send').click()`);await wait(`!!document.querySelector('.task-acceptance-options [role="alert"]')`);
  assert.equal(model.calls,calls);assert.equal(await js(`document.querySelector('.pp-input').value`),'保留草稿');
  await change('验收参数','["verify.cjs"]');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-acceptance-evidence-'));
  for(const theme of ['xiaohuang','dark']){
   await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);await sleep(150);win.webContents.invalidate();await sleep(100);
   fs.writeFileSync(path.join(output,theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }
  win.setSize(900,900);await sleep(200);
  await js(`if(!window.__codenodeUi.getState().conversationOpen)document.querySelector('.conversation-toggle').click()`);await sleep(100);
  assert.equal(await js(`(()=>{const r=document.querySelector('.task-acceptance-options').getBoundingClientRect();return r.width>200&&r.right<=innerWidth})()`),true);
  win.webContents.invalidate();await sleep(150);fs.writeFileSync(path.join(output,'narrow.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  assert.deepEqual(errors,[]);
  console.log('DESKTOP ACCEPTANCE UI: PASS (normal mode, project test selection, real IPC/model loop/tools, red→green, frozen evidence, invalid input, two themes, narrow viewport)');console.log('EVIDENCE='+output);
 }finally{if(approvals)clearInterval(approvals);model?.restore();win.destroy();}
 app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
