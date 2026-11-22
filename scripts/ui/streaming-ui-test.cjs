'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-streaming-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, "../..");
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
fs.writeFileSync(path.join(root, '.codenode/agent.properties'), 'agent.intent.enabled=false\nagent.intent_action_review=off\nediting.autoVerify=false\nsoul.evolution.enabled=false\n');
let win;
app.on('browser-window-created', (_event, window) => { win = window; window.show = () => {}; window.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));
const { installScriptedModel } = require("../lib/scripted-model.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function createGate() {
  let release = () => {};
  const ready = new Promise(resolve => { release = () => resolve(undefined); });
  return { ready, release };
}
function hasToolResponse(body) {
  if (typeof body !== 'string') return false;
  return (JSON.parse(body).messages || []).some(message => message.role === 'tool');
}
let stub;
function cleanup() {
  stub?.restore();
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-streaming-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
app.whenReady().then(async () => {
  try {
    const deadline = Date.now() + 8000;
    while (!win && Date.now() < deadline) await sleep(30);
    assert.ok(win); win.setSize(1280, 960); win.webContents.setBackgroundThrottling(false);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw Error('Renderer step failed: ' + code.slice(0, 160) + ' :: ' + String(error)); }
    };
    const wait = async (expression, label) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) { if (await js(expression)) return; await sleep(20); }
      throw Error('UI wait timed out: ' + label);
    };
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(path.join(root, 'userData'), [
      { id: 'streaming-fixture', model: 'fixture-model', label: '流式测试模型', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-test-key' },
    ], 'streaming-fixture');
    await wait('!!window.__codenodeProject', 'project store');
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
    await wait('!!document.querySelector(".pp-input") && !document.querySelector(".startup-splash")', 'visible workbench');
    await js('window.__codenodeUi.setState({navigationOpen:true})');
    const sidebarStatus = 'document.querySelector(".project-session-row .active .project-session-status")';
    const reply = '流式显示验证：你好世界 👨‍👩‍👧‍👦 é 🚀。'.repeat(12);
    stub = installScriptedModel([{ content: reply }], { loopLast: false });
    const mockedFetch = global.fetch;
    /** @returns {Promise<any>} */
    global.fetch = async (url, init) => {
      const response = await mockedFetch(url, init);
      if (!response.body) return response;
      const chunks = Array.from(reply);
      let index = 0, ending = 0, closed = false;
      const encoder = new TextEncoder();
      return { ...response, body: { getReader: () => ({
        read: async () => {
          await sleep(60);
          if (closed || init?.signal?.aborted) throw Object.assign(Error('aborted'), { name: 'AbortError' });
          if (index < chunks.length) {
            const text = chunks.slice(index, index + 8).join(''); index += 8;
            return { done: false, value: encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n') };
          }
          if (ending++ === 0) return { done: false, value: encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\n') };
          return { done: true };
        }, cancel: async () => { closed = true; }, releaseLock: () => {},
      }) } };
    };
    await js(`void (window.__streamingSend=window.__codenodeChat.getState().send('请用文字说明本次结果，不调用工具'))`);
    await wait(`${sidebarStatus}?.dataset.status==='running' && !!${sidebarStatus}.querySelector('svg')`, 'sidebar working orb');
    await wait(`window.__codenodeSession.getState().messages.at(-1)?.content.length>24 && document.querySelector('.cs-msg-agent:last-child .cs-msg-text')?.getAttribute('data-revealing')==='true'`, 'incremental arrival');
    const read = () => js(`(()=>{const message=window.__codenodeSession.getState().messages.at(-1);const element=document.querySelector('.cs-msg-agent:last-child .cs-msg-text');return{raw:message.content,shown:element.textContent,status:message.status};})()`);
    const first = await read();
    assert.ok(first.shown.length > 0 && first.shown.length < first.raw.length);
    assert.ok(reply.startsWith(first.shown));
    const stable = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model').textContent,side:window.__codenodeUi.getState().sideTab,navigation:window.__codenodeUi.getState().navigationOpen})`);
    const before = await stable();
    fs.mkdirSync(path.join(__dirname, "../../out"), { recursive: true });
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(100);
      assert.equal(await stable(), before);
      const panelColors = await js(`['.project-navigation', '.conversation-right', '.pp-composer'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor)`);
      assert.deepEqual(panelColors, ['rgb(30, 30, 30)', 'rgb(30, 30, 30)', 'rgb(48, 48, 48)']);
      const live = await read(); assert.ok(reply.startsWith(live.shown)); assert.ok(live.raw.startsWith(first.raw));
      fs.writeFileSync(path.join(__dirname, '../../out/streaming-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await js('window.__streamingSend');
    await wait(`${sidebarStatus}?.dataset.status==='done'`, 'sidebar completion');
    await wait(`document.querySelector('.cs-msg-agent:last-child .cs-msg-text')?.textContent===${JSON.stringify(reply)}`, 'drain final text');
    assert.equal((await read()).raw, reply);
    assert.equal((await read()).shown, reply);
    stub.restore(); stub = null;
    stub = installScriptedModel([
      { toolCalls: [{ name: 'ask_user', args: { question: '请选择一个颜色', options: ['蓝色', '黄色'] } }] },
      { content: '已收到选择。' },
    ], { loopLast: false });
    const askFetch = global.fetch;
    const replyGate = createGate();
    global.fetch = async (url, init) => {
      if (hasToolResponse(init?.body)) await replyGate.ready;
      return askFetch(url, init);
    };
    await js(`void (window.__streamingSend=window.__codenodeChat.getState().send('请让我选择一个颜色'))`);
    await wait(`${sidebarStatus}?.dataset.status==='waiting' && !!document.querySelector('.tool-dialog-opt')`, 'sidebar waits for a real Agent choice');
    assert.equal(await js(`getComputedStyle(${sidebarStatus}, '::before').borderTopStyle`), 'solid');
    await js(`document.querySelector('.tool-dialog-opt').click()`);
    await wait(`${sidebarStatus}?.dataset.status==='running'`, 'sidebar resumes after selection');
    replyGate.release();
    await js('window.__streamingSend');
    await wait(`${sidebarStatus}?.dataset.status==='done'`, 'sidebar completes after selection');
    stub.restore(); stub = null;
    // Coalesced content_reset plus a replacement must never leak the old tail.
    await js(`window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().streamDelta({kind:'content',text:'共同开头'+ '旧'.repeat(200)});`);
    await sleep(120);
    const replacement = '共同开头' + '新'.repeat(30);
    await js(`window.__codenodeSession.getState().streamDelta({kind:'content_reset'});window.__codenodeSession.getState().streamDelta({kind:'content',text:${JSON.stringify(replacement)}})`);
    await sleep(80);
    const reset = await read(); assert.equal(reset.raw, replacement); assert.ok(replacement.startsWith(reset.shown)); assert.ok(!reset.shown.includes('旧'));
    await js(`window.__codenodeSession.getState().stopTurn()`); await sleep(50);
    assert.equal((await read()).shown, replacement); assert.equal((await read()).status, 'stopped');
    assert.equal(await js(`${sidebarStatus}?.dataset.status`), 'stopped');
    await sleep(150); assert.equal((await read()).shown, replacement);
    // Settings persist and disabling typing drains the current queue immediately.
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await wait(`!!document.querySelector('[aria-label="逐字显示 Agent 回复"]')`, 'display settings');
    await js(`document.querySelector('[aria-label="逐字显示 Agent 回复"]').click()`); await sleep(50);
    assert.equal(await js(`JSON.parse(localStorage.getItem('codenode.uiPreferences')).typewriterEnabled`), false);
    await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('general')`); await sleep(80);
    assert.equal(await js(`document.querySelector('[aria-label="逐字显示 Agent 回复"]').checked`), false);
    await js(`document.querySelector('[aria-label="逐字显示 Agent 回复"]').click();const range=document.querySelector('[aria-label="回复显示速度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(range,'120');range.dispatchEvent(new Event('input',{bubbles:true}));`); await sleep(60);
    assert.equal(await js(`JSON.parse(localStorage.getItem('codenode.uiPreferences')).typewriterCharsPerSecond`), 120);
    await js(`window.__codenodeUi.getState().closeSettings()`);
    // A failed request flushes received text; history switches show full records.
    await js(`window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().streamDelta({kind:'content',text:'已收到的部分'.repeat(50)});window.__codenodeSession.getState().failTurn('测试中断')`); await sleep(80);
    const failure = await read();
    assert.ok(failure.shown.startsWith('已收到的部分'.repeat(50)));
    assert.match(failure.shown, /测试中断/);
    assert.equal(await js(`${sidebarStatus}?.dataset.status`), 'failed');
    const paragraphs = Array.from({length:120}, (_,index) => '逐字滚动第 ' + index + ' 行').join('\n');
    await js(`window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().streamDelta({kind:'content',text:${JSON.stringify(paragraphs)}})`);
    await wait(`(()=>{const body=document.querySelector('.ap-body');return body.scrollHeight>body.clientHeight+100;})()`, 'typing scroll growth');
    await sleep(60);
    assert.ok(await js(`(()=>{const body=document.querySelector('.ap-body');return body.scrollHeight-body.scrollTop-body.clientHeight<10;})()`), 'Live typing follows the bottom');
    await js(`(()=>{const body=document.querySelector('.ap-body');body.scrollTop=0;body.dispatchEvent(new Event('scroll'));window.__codenodeSession.getState().streamDelta({kind:'content',text:${JSON.stringify('追加内容\n'.repeat(20))}});})()`);
    await sleep(100); assert.equal(await js(`document.querySelector('.ap-body').scrollTop`), 0, 'Reading earlier text is not pulled down by typing/new deltas');
    await js(`window.__codenodeSession.getState().stopTurn();window.__codenodeSession.getState().pushUser('新的提问');window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().streamDelta({kind:'content',text:'新的回答'});window.__codenodeSession.getState().stopTurn()`); await sleep(100);
    assert.ok(await js(`(()=>{const body=document.querySelector('.ap-body');return body.scrollHeight-body.scrollTop-body.clientHeight<10;})()`), 'A new user turn resumes following');
    const sessionId = await js('window.__codenodeSession.getState().activeId');
    await js(`window.__codenodeSession.getState().newCanvas()`); await sleep(60);
    await js(`window.__codenodeSession.getState().switchSession(${JSON.stringify(sessionId)})`); await sleep(80);
    assert.equal((await read()).shown, (await read()).raw);
    // Browse both another chat and another project while the same reply runs.
    const otherRoot = path.join(root, 'other-project');
    fs.mkdirSync(otherRoot);
    const tabs = await js(`(async () => {
      const ss = window.__codenodeSession.getState();
      ss.newConversation(); ss.startOnCurrent('同工程对话'); ss.pushUser('同工程提问');
      ss.beginTurn(); ss.finishTurn('同工程的原有回复', '', []); ss.syncActiveGraph();
      const sibling = window.__codenodeSession.getState().activeId;
      ss.switchSession(${JSON.stringify(sessionId)});
      const graph = { nodes: [], edges: [] };
      const origin = await window.codenode.saveProject(${JSON.stringify(root)}, { graph });
      const other = await window.codenode.saveProject(${JSON.stringify(otherRoot)}, { graph, canvases: { sessions: [{
        id: 'external-chat', label: '另一个工程的对话', status: 'active', root: graph,
        messages: [{ role: 'user', content: '另一个工程的提问' }, { role: 'assistant', content: '另一个工程的原有回复', status: 'done' }],
      }] } });
      if (!origin.ok || !other.ok) throw Error(JSON.stringify({ origin, other }));
      localStorage.setItem('codenode.recentProjects', JSON.stringify([
        { root: ${JSON.stringify(root)}, file: origin.filePath, name: '原工程', openedAt: Date.now() },
        { root: ${JSON.stringify(otherRoot)}, file: other.filePath, name: '另一个工程', openedAt: Date.now() },
      ]));
      window.__codenodeProject.getState().setProjectFile(origin.filePath);
      return { sibling, originFile: origin.filePath };
    })()`);
    const row = id => `document.querySelector(${JSON.stringify(`.project-session-row[data-session-id="${id}"]`)})`;
    const rowStatus = id => `${row(id)}?.querySelector('.project-session-status')?.dataset.status`;
    const chooseSession = async id => {
      await wait(`!!${row(id)}?.querySelector('button:not(:disabled)')`, 'selectable chat ' + id);
      await js(`${row(id)}.querySelector('button').click()`);
      await wait(`window.__codenodeSession.getState().activeId===${JSON.stringify(id)}`, 'active chat ' + id);
    };
    await wait(`${rowStatus('external-chat')}==='done'`, 'other project saved chat');
    stub = installScriptedModel([
      { toolCalls: [{ name: 'ask_user', args: { question: '后台会话需要你的选择', options: ['继续'] } }] },
      { content: '原会话后台任务完成。' },
    ], { loopLast: false });
    const detachedFetch = global.fetch;
    const questionGate = createGate();
    const resultGate = createGate();
    global.fetch = async (url, init) => {
      await (hasToolResponse(init?.body) ? resultGate : questionGate).ready;
      return detachedFetch(url, init);
    };
    await js(`void (window.__detachedSend=window.__codenodeChat.getState().send('测试切换到别的会话'))`);
    await wait(`${rowStatus(sessionId)}==='running'`, 'original chat is working');
    await chooseSession(tabs.sibling);
    await wait(`${rowStatus(tabs.sibling)}===undefined && ${rowStatus(sessionId)}==='running'`, 'read sibling badge and keep original spinner');
    assert.equal(await js('window.__codenodeSession.getState().messages.at(-1).content'), '同工程的原有回复');
    await chooseSession('external-chat');
    await wait(`${rowStatus('external-chat')}===undefined && ${rowStatus(sessionId)}==='running'`, 'cross-project chat and read badge');
    questionGate.release();
    await wait(`${rowStatus(sessionId)}==='waiting' && !document.querySelector('.tool-dialog-opt')`, 'background choice only appears on the original row');
    await chooseSession(sessionId);
    await wait(`!!document.querySelector('.tool-dialog-opt') && ${rowStatus(sessionId)}===undefined`, 'reopen original chat and read pending choice');
    await js(`document.querySelector('.tool-dialog-opt').click()`);
    await chooseSession('external-chat');
    resultGate.release();
    await js('window.__detachedSend');
    await wait(`${rowStatus(sessionId)}==='done'`, 'background completion appears on the original row');
    assert.equal(await js('window.__codenodeSession.getState().messages.at(-1).content'), '另一个工程的原有回复');
    await wait(`window.codenode.loadProject(${JSON.stringify(tabs.originFile)}).then(result => result.data.canvases.sessions.find(session => session.id===${JSON.stringify(sessionId)})?.messages.at(-1)?.content==='原会话后台任务完成。')`, 'background result saved to the original project');
    await chooseSession(sessionId);
    await wait(`${rowStatus(sessionId)}===undefined && window.__codenodeSession.getState().messages.at(-1)?.content==='原会话后台任务完成。'`, 'completed badge cleared when opened');
    await chooseSession('external-chat');
    await chooseSession(sessionId);
    assert.equal(await js(`${rowStatus(sessionId)}`), undefined);
    stub.restore(); stub = null;
    // Native reduced-motion preference suppresses typing, even when enabled.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(80);
    const reduced = '减少动画偏好下立即显示'.repeat(30);
    await js(`window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().streamDelta({kind:'content',text:${JSON.stringify(reduced)}})`); await sleep(80);
    assert.equal((await read()).shown, reduced);
    win.webContents.debugger.detach();
    console.log('STREAMING UI: PASS (delayed SSE/IPC, background chat and project switching, read badges, themes, history and reduced motion)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', cleanup);
