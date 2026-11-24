'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-workflow-canvas-'));
const source = path.join(__dirname, '../..');
process.env.CODENODE_USER_DATA_DIR = path.join(project, 'userData');
process.env.CODENODE_HOME = path.join(project, 'home');
process.env.CODENODE_SOUL_FILE = path.join(project, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(source, 'electron/main.cjs'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(source, 'electron/preload.cjs') } });
  try {
    const rendererErrors = [];
    win.webContents.on('console-message', event => {
      if (event.level === 'error') rendererErrors.push(event.message);
    });
    await win.loadFile(path.join(source, 'dist/index.html'));
    const screenshotDir = process.env.CODENODE_CANVAS_SCREENSHOTS;
    win.webContents.debugger.attach('1.3');
    const setContrast = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-contrast', value },
      ],
    });
    await setContrast('no-preference');
    const setup = await win.webContents.executeJavaScript(`(async()=>{
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(let i=0;!window.__codenodeProject&&i<120;i++)await sleep(50);
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)});
      window.__codenodeSession.getState().newCanvas();
      window.__codenodeUi.getState().updatePreferences({advancedMode:true,vectorEditorEnabled:true});
      window.__codenodeUi.setState({sideOpen:false,sideTab:'agent'});
      window.__codenodeStore.getState().load([
        {id:'source',type:'start',position:{x:100,y:120},data:{label:'开始',status:'pending',accent:'#22c55e'}},
        {id:'work',type:'task',position:{x:430,y:120},data:{label:'处理任务',status:'running',prompt:'检查并修复问题',accent:'#3b82f6'}},
        {id:'finish',type:'end',position:{x:760,y:120},data:{label:'结束',status:'pending',accent:'#ef4444'}}
      ],[{id:'edge-a',source:'source',target:'work',type:'waypoint'},{id:'edge-b',source:'work',target:'finish',type:'waypoint'}]);
      await sleep(350);
      const canvas=document.querySelector('.workflow-canvas-layer');
      const node=document.querySelector('.react-flow__node[data-id="work"]');
      return {hasCanvas:canvas instanceof HTMLCanvasElement,nodeOpacity:getComputedStyle(node).opacity};
    })()`);
    assert.deepEqual(setup, { hasCanvas: true, nodeOpacity: '0' });
    win.setPosition(-1900, -1900); win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await win.webContents.executeJavaScript(`(()=>{
      const canvas=document.querySelector('.workflow-canvas-layer'),node=document.querySelector('.react-flow__node[data-id="work"]');
      const rect=node.getBoundingClientRect(),screen=canvas.getBoundingClientRect(),ratio=canvas.width/screen.width;
      const pixelAt = (x, y) => [...canvas.getContext('2d').getImageData(
        Math.floor((rect.left + rect.width * x - screen.left) * ratio),
        Math.floor((rect.top + rect.height * y - screen.top) * ratio), 1, 1).data];
      return {width:canvas.width,height:canvas.height,pixel:pixelAt(.5,.5),
        highlight:pixelAt(.65,.12),base:pixelAt(.65,.69),
        center:{x:rect.left+rect.width/2,y:rect.top+rect.height/2},position:window.__codenodeStore.getState().nodes.find(item=>item.id==='work').position};
    })()`);
    assert.ok(before.width > 500 && before.height > 300, JSON.stringify(before));
    assert.ok(before.pixel[3] > 100 && before.pixel[3] < 255, 'Canvas card must remain translucent');
    const brightnessDifference = before.highlight[0] - before.base[0];
    assert.ok(brightnessDifference >= 7 && brightnessDifference <= 24, 'The graphite finish should have a restrained highlight');
    for (const [r, g, b] of [before.highlight, before.pixel, before.base]) {
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, 'Node surfaces should remain neutral grey');
    }
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(before.center.x),y:Math.round(before.center.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(before.center.x),y:Math.round(before.center.y),button:'left',clickCount:1});
    await new Promise(resolve => setTimeout(resolve, 90));
    const selected = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().selectedId`);
    assert.equal(selected, 'work', 'Canvas-painted node must remain clickable');
    const dragFrom = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.react-flow__node[data-id="work"]').getBoundingClientRect();return{x:Math.round(r.left+45),y:Math.round(r.top+14)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:dragFrom.x,y:dragFrom.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:dragFrom.x,y:dragFrom.y,button:'left',clickCount:1});
    for (let step=1;step<=5;step++) {
      win.webContents.sendInputEvent({type:'mouseMove',x:dragFrom.x+step*15,y:dragFrom.y+step*6,button:'left'});
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    win.webContents.sendInputEvent({type:'mouseUp',x:dragFrom.x+75,y:dragFrom.y+30,button:'left',clickCount:1});
    await new Promise(resolve=>setTimeout(resolve,80));
    const moved = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().nodes.find(item=>item.id==='work').position`);
    assert.ok(moved.x > before.position.x+30 && moved.y > before.position.y+10, JSON.stringify({before:before.position,moved}));
    const handles = await win.webContents.executeJavaScript(`(()=>{try{
      const point=(selector)=>{const el=document.querySelector(selector);if(!el)throw Error('Missing handle: '+selector+' / '+[...document.querySelectorAll('.react-flow__handle')].map(item=>item.className).join(' | '));const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
      return {source:point('.react-flow__node[data-id="source"] .react-flow__handle.source'),target:point('.react-flow__node[data-id="finish"] .react-flow__handle.target')};
    }catch(error){return{error:String(error)}}})()`);
    assert.ok(!handles.error, JSON.stringify(handles));
    win.webContents.sendInputEvent({type:'mouseMove',x:handles.source.x,y:handles.source.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:handles.source.x,y:handles.source.y,button:'left',clickCount:1});
    for (let step=1;step<=7;step++) {
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(handles.source.x+(handles.target.x-handles.source.x)*step/7),y:Math.round(handles.source.y+(handles.target.y-handles.source.y)*step/7),button:'left'});
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    win.webContents.sendInputEvent({type:'mouseUp',x:handles.target.x,y:handles.target.y,button:'left',clickCount:1});
    await new Promise(resolve=>setTimeout(resolve,90));
    const connected = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().edges.some(edge=>edge.source==='source'&&edge.target==='finish')`);
    assert.equal(connected,true,'Canvas-painted handles must retain connection interaction');
    const theme = await win.webContents.executeJavaScript(`(async()=>{
      const ui=window.__codenodeUi;
      const previous=ui.getState().theme;
      ui.getState().toggleTheme();
      await new Promise(resolve=>setTimeout(resolve,180));
      const canvas=document.querySelector('.workflow-canvas-layer'),node=document.querySelector('.react-flow__node[data-id="work"]');
      const rect=node.getBoundingClientRect(),screen=canvas.getBoundingClientRect(),ratio=canvas.width/screen.width;
      const pixel=canvas.getContext('2d').getImageData(Math.floor((rect.left+rect.width/2-screen.left)*ratio),Math.floor((rect.top+rect.height/2-screen.top)*ratio),1,1).data;
      return {changed:ui.getState().theme!==previous,pixel:[...pixel],selected:window.__codenodeStore.getState().selectedId};
    })()`);
    assert.equal(theme.changed, true);
    assert.equal(theme.selected, 'work');
    assert.notDeepEqual(theme.pixel, before.pixel, 'theme switch must repaint the Canvas card');
    const editor = await win.webContents.executeJavaScript(`(async()=>{
      const graph=window.__codenodeStore.getState();
      graph.addNode({id:'drawing',type:'vector',position:{x:100,y:320},data:{label:'画布节点',status:'pending',width:560,height:380,mode:'design',accent:'#22d3ee'}});
      await new Promise(resolve=>setTimeout(resolve,180));
      const node=document.querySelector('.react-flow__node[data-id="drawing"]');
      const material=getComputedStyle(node.querySelector('.wf-vector'));
      return {opacity:getComputedStyle(node).opacity,editor:!!node.querySelector('.vs-svg'),
        glass:material.backgroundImage.startsWith('linear-gradient(') && material.backdropFilter.includes('blur(')};
    })()`);
    assert.deepEqual(editor, {opacity:'1',editor:true,glass:true}, 'embedded drawing editor must keep its glass surface and interactive content');
    const js = code => win.webContents.executeJavaScript(code);
    if (screenshotDir) {
      await js(`document.querySelector('.canvas-view-strip [data-action="fit"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 180));
      fs.writeFileSync(path.join(screenshotDir, 'glass-editor.png'), (await win.webContents.capturePage()).toPNG());
    }
    await setContrast('more');
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(await js(`getComputedStyle(document.querySelector('.wf-vector')).backdropFilter`), 'none');
    const solidAlpha = await js(`(() => {
      const canvas = document.querySelector('.workflow-canvas-layer');
      const rect = document.querySelector('.react-flow__node[data-id="work"]').getBoundingClientRect();
      const origin = canvas.getBoundingClientRect();
      const scale = canvas.width / origin.width;
      return canvas.getContext('2d').getImageData(
        Math.floor((rect.left + rect.width * .88 - origin.left) * scale),
        Math.floor((rect.top + rect.height * .69 - origin.top) * scale), 1, 1).data[3];
    })()`);
    assert.equal(solidAlpha, 255, 'High contrast should use an opaque card');
    await setContrast('no-preference');
    await js(`window.__codenodeStore.getState().setSelectedIds([])`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.react-flow__node[data-id="drawing"]')).opacity`), '0');
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const button = label => `.canvas-wrap button[aria-label="${label}"]`;
    assert.ok(win.webContents.getURL().endsWith('/dist/index.html'));
    assert.equal(await js(`!!document.querySelector('.crash,.vite-error-overlay')`), false);
    assert.equal(await js(`!!document.querySelector('.node-actions')`), false);
    await js(`document.querySelector('.react-flow__node[data-id="work"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
    assert.deepEqual(await js(`[...document.querySelectorAll('.node-action-list button')].map(b=>b.textContent)`), ['节点属性','复制节点','删除节点']);
    await click('.node-action-list [data-action=duplicate]');
    assert.equal(await js(`window.__codenodeStore.getState().nodes.length`), 5);
    await click(button('撤销'));
    await js(`window.__codenodeStore.getState().setSelectedIds(['work'])`);
    await click('.node-actions > button');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.ok(await js(`document.activeElement.matches('.node-actions > button') && !document.querySelector('.node-action-list')`));
    await js(`window.__codenodeStore.getState().setSelectedIds([])`);
    await click(button('运行工作流'));
    for (let i=0; i<60 && !await js(`!!document.querySelector('.workflow-scope')`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.ok(await js(`document.querySelector('.workflow-scope') && [...document.querySelectorAll('.dock-runs button')].some(b=>b.textContent==='计算数据流')`));
    await click('.dock-close');
    const visibleControls = `[...document.querySelectorAll('.canvas-actions button, .canvas-actions summary, .canvas-quick-actions button')].filter(el => el.checkVisibility()).length`;
    assert.equal(await js(visibleControls), 10);
    const menuClick = async label => {
      await click('.canvas-command-menu summary');
      assert.ok(await js(`document.querySelector(${JSON.stringify(button(label))}).checkVisibility()`));
      await click(button(label));
    };
    await click('.canvas-command-menu summary');
    const tip = '.canvas-tool-tip[role="tooltip"]';
    async function waitTip(fragment) {
      for (let i = 0; i < 40; i++) {
        if (await js(`document.querySelector('${tip}')?.textContent.includes(${JSON.stringify(fragment)})`)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.fail('未显示工具提示：' + fragment);
    }
    assert.ok(await js(`[...document.querySelectorAll('.canvas-actions button, .canvas-actions summary, .canvas-quick-actions button')].every(el => el.dataset.tipHeading && el.getAttribute('aria-description'))`));
    const layoutPoint = await js(`(() => {const r=document.querySelector('.canvas-command-menu [data-action="arrange"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', ...layoutPoint});
    await waitTip('按依赖关系');
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'canvas-tooltip.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', x:2, y:2});
    assert.equal(await js(`!!document.querySelector('${tip}')`), false);
    await click('.canvas-command-menu summary');
    await js(`document.querySelector('.canvas-quick-actions [aria-label="添加节点"]').focus()`);
    await waitTip('打开节点菜单');
    assert.ok(await js(`document.querySelector('${tip}').getBoundingClientRect().bottom <= document.activeElement.getBoundingClientRect().top`));
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js(`!!document.querySelector('${tip}')`), false);
    const edgeCount = await js(`window.__codenodeStore.getState().edges.length`);
    await menuClick('显示连线');
    assert.equal(await js(`document.querySelectorAll('.react-flow__edge').length`), 0);
    assert.equal(await js(`window.__codenodeStore.getState().edges.length`), edgeCount);
    await menuClick('显示连线');
    assert.equal(await js(`document.querySelectorAll('.react-flow__edge').length`), edgeCount);

    await click(button('适应画布'));
    await new Promise(resolve => setTimeout(resolve, 160));
    const zoomLabel = `document.querySelector('.canvas-zoom-controls span').textContent`;
    const zoom = await js(zoomLabel);
    await click(button('放大画布'));
    assert.ok(parseInt(await js(zoomLabel), 10) > parseInt(zoom, 10));
    assert.equal(await js(zoomLabel), await js(`Math.round(window.__codenodeUi.getState().viewport.zoom * 100) + '%'`));
    await menuClick('小地图');
    assert.equal(await js(`document.querySelectorAll('.canvas-minimap .react-flow__minimap-node').length`), 4);

    await click(button('拖动画布'));
    const pan = await js(`(() => {
      const rect = document.querySelector('.canvas-wrap').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom - 90),
        before: window.__codenodeUi.getState().viewport };
    })()`);
    win.webContents.sendInputEvent({type:'mouseDown',x:pan.x,y:pan.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:pan.x+60,y:pan.y+15,button:'left'});
    win.webContents.sendInputEvent({type:'mouseUp',x:pan.x+60,y:pan.y+15,button:'left',clickCount:1});
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.ok(await js(`window.__codenodeUi.getState().viewport.x > ${pan.before.x + 30}`), '手形工具应平移画布');
    assert.deepEqual(await js(`window.__codenodeStore.getState().nodes.find(node => node.id==='work').position`), moved);
    await click(button('选择工具'));
    assert.equal(await js(`document.querySelector('[aria-label="选择工具"]').getAttribute('aria-pressed')`), 'true');
    await menuClick('吸附网格');
    assert.equal(await js(`document.querySelector('[aria-label="吸附网格"]').getAttribute('aria-pressed')`), 'true');
    await click(button('适应画布'));

    await click(button('添加节点'));
    assert.equal(await js(`document.activeElement.matches('.add-menu-item')`), true);
    assert.deepEqual(await js(`[...document.querySelectorAll('.add-menu-label')].map(el => el.textContent)`),
      ['新建任务', '调用工具', '交给子代理', '引用项目文件', '添加图片', '记录对象', '入口', '出口', '创建分组', '画草图']);
    assert.equal(await js(`new Set([...document.querySelectorAll('.add-menu-item svg path')].map(el => el.getAttribute('d'))).size`), 10);
    assert.equal(await js(`document.querySelector('#canvas-add-menu').getBoundingClientRect().bottom < document.querySelector('.canvas-add-trigger').getBoundingClientRect().top`), true);
    if (screenshotDir) {
      await new Promise(resolve => setTimeout(resolve, 180));
      const bounds = await js(`(() => {
        const {x,y,width,height} = document.querySelector('#canvas-add-menu').getBoundingClientRect();
        return {x:Math.floor(x),y:Math.floor(y),width:Math.ceil(width),height:Math.ceil(height)};
      })()`);
      fs.writeFileSync(path.join(screenshotDir, 'canvas-add.png'), (await win.webContents.capturePage(bounds)).toPNG());
    }
    await click('.add-menu-item:has(.add-menu-label)');
    assert.equal(await js(`!!document.querySelector('#canvas-add-menu')`), false);
    assert.equal(await js(`window.__codenodeStore.getState().nodes.length`), 5);
    await click(button('撤销'));
    assert.equal(await js(`window.__codenodeStore.getState().nodes.length`), 4);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', metaKey: true, shiftKey: true, cancelable: true }))`);
    assert.equal(await js(`window.__codenodeStore.getState().nodes.length`), 5);
    await click(button('撤销'));

    const merged = await js(`(async () => {
      const graph = window.__codenodeStore;
      const ui = window.__codenodeUi;
      const wait = () => new Promise(resolve => setTimeout(resolve, 90));
      const pick = (select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const field = label => [...document.querySelectorAll('.inspector-field label')]
        .find(el => el.firstChild?.textContent.trim() === label)?.querySelector('select');
      graph.getState().updateNodeData('work', { status: 'pending' });
      graph.getState().setSelectedIds(['work']);
      ui.getState().setSideTab('node');
      await wait();
      pick(field('执行方式'), 'stage');
      await wait();
      pick(field('流程标记'), 'end');
      await wait();
      const task = graph.getState().nodes.find(node => node.id === 'work');
      const connected = graph.getState().edges.filter(edge => edge.target === task.id || edge.source === task.id).length;
      document.querySelector('.canvas-add-trigger').click();
      await wait();
      document.querySelector('.add-menu-item[data-node-type=file]').click();
      await wait();
      const materialId = graph.getState().selectedId;
      const chooser = document.querySelector('.side-panel input[type=file]');
      const image = new DataTransfer();
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCj8AAAAASUVORK5CYII='), c => c.charCodeAt(0));
      image.items.add(new File([bytes], 'example.png', { type: 'image/png' }));
      chooser.files = image.files;
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20 && graph.getState().nodes.find(node => node.id === materialId)?.type !== 'image'; i++) await wait();
      const material = graph.getState().nodes.find(node => node.id === materialId);
      const preview = await new Promise(resolve => setTimeout(() => resolve(!!document.querySelector('.wf-image-node img')), 90));
      graph.getState().setSelectedIds(['work', materialId]);
      document.querySelector('.canvas-add-trigger').click();
      await wait();
      const groupButton = [...document.querySelectorAll('.add-menu-item')].find(el => el.querySelector('.add-menu-label')?.textContent === '将所选节点编组');
      const groupIcon = !!groupButton?.querySelector('svg');
      groupButton?.click();
      await wait();
      const group = graph.getState().nodes.find(node => node.id === graph.getState().selectedId);
      const memberCount = graph.getState().nodes.filter(node => node.data.parentId === group.id).length;
      graph.getState().undo();
      graph.getState().deleteNodes([materialId]);
      graph.getState().changeNodeMode('work', 'task');
      graph.getState().updateNodeData('work', { status: 'running', boundary: undefined });
      ui.getState().setSideTab('agent');
      return { mode: task.type, boundary: task.data.boundary, connected, material: material.type, preview, groupIcon, memberCount };
    })()`);
    assert.deepEqual(merged, { mode: 'stage', boundary: 'end', connected: 2, material: 'image', preview: true, groupIcon: true, memberCount: 2 });

    await js(`window.__codenodeUi.setState({navigationOpen:true})`);
    await click('.project-row-menu summary');
    assert.ok(await js(`['保存项目','打开项目文件','项目终端','检查点与恢复'].every(text => [...document.querySelectorAll('.project-row-menu[open] button')].some(b => b.textContent===text))`));
    await js(`[...document.querySelectorAll('.project-row-menu[open] button')].find(b=>b.textContent==='打开项目文件').click()`);
    assert.equal(await js(`window.__codenodeUi.getState().sideTab`), 'project');
    await js(`window.__codenodeUi.getState().setSideTab('agent')`);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (screenshotDir) {
      fs.writeFileSync(path.join(screenshotDir, 'canvas-desktop.png'), (await win.webContents.capturePage()).toPNG());
    }

    if (await js('window.__codenodeUi.getState().conversationOpen')) await click('.conversation-toggle');
    win.setSize(720, 700);
    await new Promise(resolve => setTimeout(resolve, 480));
    assert.equal(await js(visibleControls), 10);
    await click('.canvas-command-menu summary');
    const compact = await js(`(() => {
      const canvas = document.querySelector('.canvas-wrap').getBoundingClientRect();
      const menu = document.querySelector('.canvas-command-menu .toolbar-menu');
      const rect = menu.getBoundingClientRect();
      return { fits: rect.width > 0 && rect.left >= canvas.left && rect.right <= canvas.right && rect.bottom <= canvas.bottom,
        interactive: menu.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 20)),
        noScroll: menu.scrollHeight <= menu.clientHeight + 1,
        icons: menu.querySelectorAll('button svg').length };
    })()`);
    assert.deepEqual(compact, { fits: true, interactive: true, noScroll: true, icons: 4 });
    assert.equal(await js(zoomLabel), await js(`[...document.querySelectorAll('.status-bar span')].find(span => span.textContent.startsWith('缩放 ')).textContent.slice(3)`));
    if (screenshotDir) {
      await new Promise(resolve => setTimeout(resolve, 120));
      fs.writeFileSync(path.join(screenshotDir, 'canvas-compact.png'), (await win.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('.canvas-command-menu button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js(`document.querySelector('.canvas-command-menu').open`), false);
    assert.equal(await js(`document.activeElement.matches('.canvas-command-menu summary')`), true);
    const layoutChecks = await js(`(() => {
      const store = window.__codenodeStore, graph = store.getState(), ui = window.__codenodeUi.getState();
      ui.updatePreferences({ visibleActions: ['layout', 'arrange'] });
      const migrated = window.__codenodeUi.getState().preferences.visibleActions;
      const fixture = ['root','left','right'].map(id => ({id,type:'task',position:{x:0,y:0},data:{label:id}}));
      const edges = ['left','right'].map(id => ({id,source:'root',target:id}));
      const positions = () => store.getState().nodes.map(n => n.position);
      graph.load(fixture,edges);
      document.querySelector('.canvas-command-menu summary').click();
      document.querySelector('.canvas-command-menu [data-action=arrange]').click();
      const fromMenu = positions();
      const fromKeys = ['l','a'].map(key => {
        graph.load(fixture,edges);
        window.dispatchEvent(new KeyboardEvent('keydown',{key,metaKey:true,shiftKey:key==='a',bubbles:true,cancelable:true}));
        return positions();
      });
      return { migrated, fromMenu, fromKeys };
    })()`);
    assert.deepEqual(layoutChecks.migrated, ['arrange']);
    assert.notEqual(layoutChecks.fromMenu[1].y, layoutChecks.fromMenu[2].y);
    for (const result of layoutChecks.fromKeys) assert.deepEqual(result, layoutChecks.fromMenu);
    await js(`window.__codenodeStore.getState().clear()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await js(`!!document.querySelector('.canvas-welcome, .canvas-tutorial-hint')`), false);
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'canvas-first-task.png'), (await win.webContents.capturePage()).toPNG());
    await click(button('添加节点'));
    await click('.add-menu-item[data-node-type="task"]');
    assert.equal(await js(`window.__codenodeStore.getState().nodes[0].type`), 'task');
    assert.equal(await js(`!!document.querySelector('.canvas-welcome')`), false);

    for (const type of ['stage', 'tool', 'image', 'object', 'scope', 'start', 'end']) {
      await click(button('添加节点'));
      const item = `.add-menu-item[data-node-type="${type}"]`;
      await click(item);
      assert.equal(await js(`window.__codenodeStore.getState().nodes.find(n => n.id === window.__codenodeStore.getState().selectedId)?.type`), type);
      assert.equal(await js(`!!document.querySelector('#canvas-add-menu')`), false);
    }
    const boundaryHandles = type => js(`[...document.querySelectorAll('.react-flow__node-${type} .wf-handle')].map(el => el.classList.contains('source') ? 'source' : 'target')`);
    assert.deepEqual(await boundaryHandles('start'), ['source']);
    assert.deepEqual(await boundaryHandles('end'), ['target']);
    assert.deepEqual(rendererErrors, []);
    console.log('WORKFLOW CANVAS UI: PASS (glass material, high contrast, raster interactions, view and quick controls, keyboard redo, compact actions, renderer errors)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => {
  if (path.dirname(project) !== os.tmpdir() || !path.basename(project).startsWith('codenode-workflow-canvas-')) return;
  try { fs.rmSync(project, { recursive: true, force: true }); } catch {}
});
