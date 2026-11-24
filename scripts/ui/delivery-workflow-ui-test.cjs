'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-delivery-ui-'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 950, show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async fn => { for(let i=0;i<100;i++){if(fn())return;await sleep(50)}throw Error('UI timeout: '+fn); };
      const ui=window.__codenodeUi, session=window.__codenodeSession, project=window.__codenodeProject;
      let applyCalls=0, chatCalls=0, planCalls=0;
      window.codenode=new Proxy({
        rollbackPlan:async()=>{planCalls++;return {ok:true,runId:'delivery-run',summary:{restore:1,delete:0,skip:1,conflict:1},items:[{path:'src/a.ts',action:'restore',restorable:true,conflict:false,tools:[]},{path:'src/conflict.ts',action:'skip',restorable:false,conflict:true,reason:'后续修改',tools:[]}]};},
        rollbackApply:async(_root,runId,options)=>{if(runId!=='delivery-run'||options.force!==false)throw Error('unsafe rollback');applyCalls++;return {ok:false,applied:[{path:'src/a.ts',action:'restore'}],refused:[{path:'src/conflict.ts',reason:'后续修改'}],skipped:[]};},
        agentChat:async()=>{chatCalls++;return {ok:true,reply:'已处理',toolCalls:[]};},
      },{get(target,name){if(name in target)return target[name];if(String(name).startsWith('on'))return()=>()=>{};return async()=>({ok:true,models:[],tools:[],runs:[],events:[],backend:{},settings:{},goals:[],summary:{}})}});
      project.setState({root:${JSON.stringify(root)}});
      ui.getState().updatePreferences({workbenchView:'conversation',typewriterEnabled:false,autoCollapseSidebars:false});
      ui.setState({appPage:'workbench',sideTab:'agent',conversationOpen:true,conversationAutoHidden:false});
      session.getState().startOnCurrent('修复示例');
      const message={role:'assistant',status:'done',content:'已修改示例',tools:[],run:{id:'delivery-run',state:'COMPLETED'},backendChanges:{complete:true,scope:'workspace',files:[{path:'src/a.ts',kind:'modified',before:'abc',after:'def'}]},codeVerification:{status:'passed',verified:true,files:['src/a.ts','read-only.ts'],checks:[{kind:'test',status:'passed',command:'npm test',exitCode:0,output:'passed'}]}};
      message.taskAcceptance={status:'passed',verified:true,contractHash:'fixture',scope:'仅覆盖显式规则',checks:[{id:'artifact',kind:'artifact',status:'passed',path:'src/a.ts'},{id:'public-example',kind:'command',phase:'before',status:'passed',toolOk:true,exitCode:1},{id:'public-example',kind:'command',phase:'after',status:'passed',toolOk:true,exitCode:0}]};
      session.setState({messages:[message]});
      await until(()=>document.querySelector('.delivery-card'));
      const card=()=>document.querySelector('.delivery-card');
      const click=text=>{const buttons=[...card().querySelectorAll('button')];const button=buttons.find(b=>b.textContent===text);if(!button)throw Error('missing '+text+': '+buttons.map(b=>b.textContent).join(','));button.click();};
      const out={};
      out.summary=card().innerText;out.acceptanceText=card().querySelector('[aria-label="任务验收"]').textContent;
      session.getState().streamDelta({kind:'task_acceptance',taskAcceptance:{status:'unconfigured',verified:false,contractHash:null,reason:'未配置任务验收，需求尚未验收',checks:[]}});
      await until(()=>card().innerText.includes('需求尚未验收'));out.unconfigured=card().innerText;
      session.getState().streamDelta({kind:'task_acceptance',taskAcceptance:message.taskAcceptance});
      await until(()=>card().innerText.includes('显式验收规则通过'));
      click('预览文件回滚');await until(()=>document.querySelector('.delivery-rollback'));
      out.noApplyBeforeConfirm=applyCalls===0;out.plan=card().innerText;
      click('取消');await until(()=>!document.querySelector('.delivery-rollback'));out.noApplyOnCancel=applyCalls===0;
      click('预览文件回滚');await until(()=>document.querySelector('.delivery-rollback'));
      click('确认回滚可恢复文件');await until(()=>card().innerText.includes('原校验不再代表当前代码'));
      out.applied=applyCalls;out.after=card().innerText;out.invalidated=session.getState().messages[0].codeVerification.status;out.acceptanceInvalidated=session.getState().messages[0].taskAcceptance.status;
      for(const theme of ['light','dark']){ui.setState({theme});await sleep(80);out[theme]=card().getBoundingClientRect().width>100;}
      click('继续修改');await until(()=>card().querySelector('textarea'));
      const input=card().querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'修正边界条件');input.dispatchEvent(new Event('input',{bubbles:true}));
      await sleep(80);click('发送修改要求');await until(()=>chatCalls===1);
      await until(()=>!session.getState().streaming);out.afterFollowup=session.getState().messages.find(m=>m.run?.id==='delivery-run')?.codeVerification?.status;out.chatCalls=chatCalls;return out;
    })()`);
    assert.match(result.summary,/1 个变更文件/);
    assert.match(result.summary,/所选局部校验通过/);assert.match(result.summary,/显式验收规则通过/);assert.match(result.unconfigured,/需求尚未验收/);assert.equal(result.acceptanceInvalidated,'stale');assert.match(result.acceptanceText,/修改前复现/);assert.match(result.acceptanceText,/修改后验收/);assert.match(result.acceptanceText,/进程退出码 1/);
    assert.equal(result.noApplyBeforeConfirm,true);assert.equal(result.noApplyOnCancel,true);
    assert.match(result.plan,/后续修改/);assert.equal(result.applied,1);assert.equal(result.invalidated,'stale');
    assert.match(result.after,/拒绝 1 项/);assert.equal(result.light,true);assert.equal(result.dark,true);assert.equal(result.chatCalls,1);assert.equal(result.afterFollowup,'stale');
    if(process.env.CODENODE_DELIVERY_PREVIEW_DIR){const dir=path.resolve(process.env.CODENODE_DELIVERY_PREVIEW_DIR);fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await win.webContents.executeJavaScript(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}});document.querySelector('.delivery-card').scrollIntoView({block:'center'})`);await new Promise(resolve=>setTimeout(resolve,150));fs.writeFileSync(path.join(dir,theme+'.png'),(await win.webContents.capturePage()).toPNG());}}
    console.log('DELIVERY WORKFLOW UI: PASS (external files, scoped verification, preview/cancel, conflict-safe rollback, stale evidence, follow-up, two themes)');
  } finally { win.destroy();fs.rmSync(root,{recursive:true,force:true}); }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
