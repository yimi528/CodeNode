/**
 * 校验：① 开屏结束后直接显示主工作区，最近工程及对话位于左栏
 *      ② Shift+A 菜单含「图像节点」，点击后创建图像节点，并支持粘贴/读项目图片
 * 用法：node scripts/run-electron.cjs scripts/tools/gate-image-check.cjs
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "../..");
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

/** 内置测试图（红/绿/蓝三色条，144×48）——避免依赖外部临时文件 */
const TEST_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAJAAAAAwCAYAAAD+WvNWAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEqSURBVHhe1c8xDQAADMOw8SfdEQgBq/LTL7e7yfh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18GvsxDbA/xazRy8D5rBAAAAAElFTkSuQmCC';

/** 把内置测试图写到磁盘（返回路径） */
function writeTestImage(relPath) {
  fs.writeFileSync(relPath, Buffer.from(TEST_PNG_B64, 'base64'));
  return relPath;
}

let passed = 0;
const failures = [];
const ok = (n, c, extra = '') => {
  if (c) {
    passed += 1;
    console.log('  PASS ' + n);
  } else {
    failures.push(n);
    console.log('  FAIL ' + n + (extra ? ' - ' + extra : ''));
  }
};

let appWin = null;
let previousRecent = null;
process.env.CODENODE_USER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cn-workspace-check-'));
app.on('browser-window-created', (_e, win) => { if (!appWin) appWin = win; });
require("../../electron/main.cjs");

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 60 && !appWin; i += 1) await sleep(250);
    const win = appWin;
    win.show();
    await sleep(900);
    const js = (c) => win.webContents.executeJavaScript(c);
    previousRecent = await js(`(()=>{try{const items=JSON.parse(localStorage.getItem('codenode.recentProjects')||'[]').filter(item=>!String(item.root||'').includes('cn-gate-dirA-')&&!String(item.root||'').includes('cn-gate-dirB-'));return items.length?JSON.stringify(items):null}catch{return null}})()`);

    // ---------- 准备两个"工程"：一个目录 + 一个 .cnode 文件 ----------
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-gate-dirA-'));
    fs.writeFileSync(path.join(dirA, 'readme.md'), '# dirA\n');
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-gate-dirB-'));
    const fileB = path.join(dirB, 'proj-b.cnode');
    const canvas = { nodes: [], edges: [] };
    fs.writeFileSync(fileB, require('../../electron/cnode.cjs').encodeCnode({
      graph: canvas,
      canvases: { sessions: [{ id: 'fixture-chat', label: '工程交接', root: canvas, status: 'active', messages: [
        { role: 'user', content: '这条消息来自已保存的工程。' },
      ] }], messages: [] },
    }));
    // 一张项目内图片，供图像节点"读出"用
    // 内置测试图落盘（自带，不依赖 .cache）
    const imgSrc = writeTestImage(path.join(os.tmpdir(), 'cn-gate-test-' + Date.now() + '.png'));
    const projectImage = path.join(dirA, 'assets');
    fs.mkdirSync(projectImage, { recursive: true });
    fs.copyFileSync(imgSrc, path.join(projectImage, 'pic.png'));

    // ---------- ① 主工作区：重载后先显示最近工程及对话 ----------
    const seed = JSON.stringify([
      { root: dirB, file: fileB, name: 'proj-b.cnode', openedAt: Date.now() - 3600_000 },
      { root: dirA, name: path.basename(dirA), openedAt: Date.now() - 90_000 },
    ]);
    await js(`(()=>{ localStorage.setItem('codenode.recentProjects', ${JSON.stringify(seed)}); localStorage.setItem('codenode.lastWorkspace', JSON.stringify({ project: null })); return true; })()`);
    await win.webContents.reload();
    for (let i = 0; i < 100; i++) {
      if (await js(`!!document.querySelector('.workspace-home') && !document.querySelector('.startup-splash') && !!document.querySelector('.project-session-row button[title="工程交接"]')`).catch(() => false)) break;
      await sleep(80);
    }

    const workspace = await js(`(()=>{
      const main = document.querySelector('.workspace-home');
      const recent = document.querySelector('.project-navigation');
      const items = [...document.querySelectorAll('.project-group-label')];
      const mr = main ? main.getBoundingClientRect() : null;
      const rr = recent ? recent.getBoundingClientRect() : null;
      return {
        root: window.__codenodeProject.getState().root,
        actions: [...document.querySelectorAll('.workspace-home-actions button')].map(e => e.textContent.trim()),
        names: items.map(item => item.textContent.trim()),
        recentLeftOfMain: !!(mr && rr && rr.right <= mr.left + 1),
        savedChat: !!document.querySelector('.project-session-row button[title="工程交接"]')
      };
    })()`);
    ok('主界面保留三个工程入口', !workspace.root && workspace.actions.join('/') === '打开工程/新建工程/打开工程文件', JSON.stringify(workspace));
    ok('左栏显示最近工程和已保存对话', workspace.recentLeftOfMain && workspace.names.length === 2 && workspace.savedChat, JSON.stringify(workspace));
    fs.writeFileSync(path.join(OUT, 'workspace-home.png'), (await win.webContents.capturePage()).toPNG());

    await js(`document.querySelector('.project-session-row button[title="工程交接"]').click()`);
    for (let i = 0; i < 60; i++) {
      if (await js(`!!document.querySelector('.conversation-main:not([hidden])') && window.__codenodeSession.getState().activeId === 'fixture-chat'`)) break;
      await sleep(80);
    }
    ok('点击对话后在主区恢复原消息', await js(`document.querySelector('.conversation-main')?.textContent.includes('这条消息来自已保存的工程。')`));
    const beforeReload = await js('performance.timeOrigin');
    await win.webContents.reload();
    for (let i = 0; i < 100; i++) {
      if (await js(`performance.timeOrigin !== ${beforeReload} && window.__codenodeUi?.getState().booted && !!document.querySelector('.conversation-main:not([hidden])')`).catch(() => false)) break;
      await sleep(80);
    }
    ok('重载后直接恢复上次的工程、对话与页面', await js(`window.__codenodeProject.getState().projectFile===${JSON.stringify(fileB)} && window.__codenodeSession.getState().activeId==='fixture-chat' && document.querySelector('.conversation-main')?.textContent.includes('这条消息来自已保存的工程。')`));

    // 点最近列表里的目录工程，然后切到画布继续校验图像节点。
    await js(`[...document.querySelectorAll('.project-group')].find(group => group.dataset.projectPath === ${JSON.stringify(dirA)}).querySelector('.project-open').click()`);
    await sleep(2200);
    await js(`document.querySelector('[aria-label="切换到画布"]').click()`);
    const entered = await js(`({ workspace: !!document.querySelector('.canvas-wrap'), root: window.__codenodeProject.getState().root })`);
    console.log('  (debug) entered=' + JSON.stringify(entered));
    ok('点最近工程可进入画布', entered.workspace && entered.root === dirA, JSON.stringify(entered));

    // ---------- ② 图像节点 ----------
    // Shift+A 打开添加菜单
    await js(`(()=>{ const u=window.__codenodeUi.getState(); u.setLastMouse(420, 300); u.openAddMenu(420, 300); return true; })()`);
    await sleep(500);
    const menu = await js(`(()=>{
      const items=[...document.querySelectorAll('.add-menu-item')];
      return { count: items.length, labels: items.map(i=>i.querySelector('.add-menu-label').textContent.trim()) };
    })()`);
    console.log('  (debug) menu=' + JSON.stringify(menu));
    ok('Shift+A 菜单包含「图像节点」', menu.labels.includes('图像节点'), JSON.stringify(menu.labels));

    // 点击「图像节点」创建
    const before = await js(`window.__codenodeStore.getState().nodes.length`);
    await js(`(()=>{ const items=[...document.querySelectorAll('.add-menu-item')]; const it=items.find(i=>i.textContent.includes('图像节点')); it.click(); return true; })()`);
    await sleep(700);
    const created = await js(`(()=>{
      const st=window.__codenodeStore.getState();
      const n=st.nodes.find(x=>x.type==='image');
      const el=n?document.querySelector('[data-id="'+n.id+'"]'):null;
      const body=el?el.querySelector('.wf-image-body'):null;
      return { total: st.nodes.length, imageId: n?n.id:null, width: n?n.data.width:null,
        inDom: !!el, hasImageNodeClass: el? !!el.querySelector('.wf-image-node'):false,
        hasDashClass: el? el.classList.contains('react-flow__node-image'):false,
        hasEmptyHint: el? !!el.querySelector('.wf-image-empty'):false,
        hasTargetHandle: el? !!el.querySelector('.react-flow__handle-left'):false,
        hasSourceHandle: el? !!el.querySelector('.react-flow__handle-right'):false,
        hasTitleMark: el? !!el.querySelector('.wf-image-mark'):false,
        bodyHeight: body? Math.round(body.getBoundingClientRect().height):null };
    })()`);
    console.log('  (debug) created=' + JSON.stringify(created));
    ok('创建了图像节点', before === 0 && created.total === 1 && !!created.imageId, JSON.stringify(created));
    ok('图像节点渲染为图片节点（含空态提示与端口）', created.inDom === true && created.hasImageNodeClass && created.hasDashClass && created.hasEmptyHint && created.hasTargetHandle && created.hasSourceHandle && created.hasTitleMark, JSON.stringify(created));

    // 粘贴图片到节点
    const b64 = fs.readFileSync(imgSrc).toString('base64');
    await js(`(()=>{
      const el=document.querySelector('[data-id="${created.imageId}"] .wf-image-body');
      const bin=atob(${JSON.stringify(b64)}); const arr=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
      const file=new File([arr],'pasted.png',{type:'image/png'});
      const dt=new DataTransfer(); dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
      return true;
    })()`);
    await sleep(900);
    const pasted = await js(`(()=>{
      const n=window.__codenodeStore.getState().nodes.find(x=>x.type==='image');
      const img=document.querySelector('[data-id="${created.imageId}"] .wf-image-body img');
      return { hasData: !!n.data.dataUrl, src: img? img.src.slice(0,22):null, emptyGone: !document.querySelector('[data-id="${created.imageId}"] .wf-image-empty') };
    })()`);
    console.log('  (debug) pasted=' + JSON.stringify(pasted));
    ok('粘贴后节点内显示图片', pasted.hasData === true && String(pasted.src).startsWith('data:image/') && pasted.emptyGone, JSON.stringify(pasted));

    // 通过检查器设置项目路径并读出
    await js(`(()=>{ const st=window.__codenodeStore.getState(); st.setSelectedIds(['${created.imageId}']); st.updateNodeData('${created.imageId}', { imagePath: 'assets/pic.png' }); return true; })()`);
    await sleep(400);
    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('node'); return true; })()`);
    await sleep(500);
    const panel = await js(`(()=>{
      const labels=[...document.querySelectorAll('.inspector-field label')].map(l=>l.textContent.trim());
      const btn=[...document.querySelectorAll('.inspector-btn')].find(b=>b.textContent.includes('读取图片'));
      const sel=[...document.querySelectorAll('.inspector-field select')].find(s=>s.previousElementSibling && s.previousElementSibling.textContent.includes('选择图片'));
      return { labels, hasReadBtn: !!btn, imageOptions: sel? [...sel.options].map(o=>o.value).filter(Boolean):[] };
    })()`);
    console.log('  (debug) panel=' + JSON.stringify(panel));
    ok('检查器有图像节点专属字段', panel.labels.includes('项目内图片路径（相对路径）') && panel.hasReadBtn, JSON.stringify(panel.labels));
    ok('检查器图片下拉只列图片文件', panel.imageOptions.some((p) => p === 'assets/pic.png'), JSON.stringify(panel.imageOptions));

    await js(`(()=>{ window.__codenodeStore.getState().updateNodeData('${created.imageId}', { dataUrl: undefined }); const btn=[...document.querySelectorAll('.inspector-btn')].find(b=>b.textContent.includes('读取图片')); btn.click(); return true; })()`);
    await sleep(1200);
    const readBack = await js(`(()=>{ const n=window.__codenodeStore.getState().nodes.find(x=>x.type==='image'); return { hasData: !!n.data.dataUrl, isImage: String(n.data.dataUrl||'').startsWith('data:image/png') }; })()`);
    console.log('  (debug) readBack=' + JSON.stringify(readBack));
    ok('按项目路径能读出图片数据', readBack.hasData === true && readBack.isImage === true, JSON.stringify(readBack));
    fs.writeFileSync(path.join(OUT, 'image-node.png'), (await win.webContents.capturePage()).toPNG());
  } catch (e) {
    failures.push('harness error');
    console.error('CHECK ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    if (appWin && !appWin.isDestroyed()) {
      try {
        await appWin.webContents.executeJavaScript(previousRecent == null
          ? `localStorage.removeItem('codenode.recentProjects')`
          : `localStorage.setItem('codenode.recentProjects', ${JSON.stringify(previousRecent)})`);
      } catch {}
    }
    console.log('\nGATE+IMAGE CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
