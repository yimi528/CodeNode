'use strict';

// Verify theme controls, workspace colors, persistence, and window opacity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const themesJson = require('../../config/ui.themes.json');

const packageRoot = process.env.CODENODE_UI_TEST_PACKAGE ? path.resolve(process.env.CODENODE_UI_TEST_PACKAGE) : null;
const runtimeAsar = packageRoot ? path.join(packageRoot, 'resources', 'app.asar') : null;
const sourceRoot = (relative) => (runtimeAsar ? path.join(runtimeAsar, relative) : path.join(__dirname, '../..', relative));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-bright-theme-ui-'));
const projectDir = path.join(root, 'demo-project');
const projectFile = path.join(projectDir, 'demo.cnode');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(projectFile, JSON.stringify({ graph: { nodes: [], edges: [] }, workspace: { viewport: { x: 0, y: 0, zoom: 1 } }, manifest: { format: 'codenode', formatVersion: '1' } }));
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');

let win = null;
app.on('browser-window-created', (_event, window) => { if (!win) win = window; });
require(sourceRoot('electron/main.cjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(80);
  }
  throw new Error('等待超时：' + label);
}

let backdrop = null;

function windowBg() { return String(win.getBackgroundColor() || '').slice(0, 7).toUpperCase(); }

/** 窗口在屏幕上的取样区域（物理像素），避开标题栏与边框。 */
function sampleRegion(scale) {
  const b = win.getBounds();
  const insetX = Math.round(46 * scale);
  const insetTop = Math.round(72 * scale);
  return {
    x: Math.round(b.x * scale) + insetX,
    y: Math.round(b.y * scale) + insetTop,
    width: Math.round(b.width * scale) - insetX * 2,
    height: Math.round(b.height * scale) - insetTop - Math.round(54 * scale),
  };
}

function luminanceStats(image) {
  const buf = image.toBitmap();
  let n = 0, sum = 0, sumSq = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += lum; sumSq += lum * lum; n++;
  }
  const mean = sum / n;
  return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2) };
}

// A light conversation pane beside a dark canvas has high spatial contrast even when fully opaque.
// Measure changes in the same foreground pixels while inverting the backdrop.
function meanPixelChange(first, second) {
  assert.equal(first.length, second.length);
  let sum = 0;
  for (let i = 0; i < first.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) sum += Math.abs(first[i + channel] - second[i + channel]);
  }
  return sum / (first.length * 0.75);
}

async function grabScreen(scale) {
  const display = screen.getPrimaryDisplay();
  const physical = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
  assert.ok(sources.length, '需要一块可捕获的屏幕');
  return sources[0].thumbnail;
}

async function captureRegion(region, scale, file = '') {
  const shot = await grabScreen(scale);
  const crop = shot.crop(region);
  if (file) fs.writeFileSync(file, crop.toPNG());
  return { ...luminanceStats(crop), pixels: crop.toBitmap() };
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const ids = Object.keys(themesJson);
    const packagedThemes = JSON.parse(fs.readFileSync(sourceRoot('config/ui.themes.json'), 'utf8'));
    assert.deepEqual(Object.keys(packagedThemes), ['light', 'dark']);
    assert.deepEqual(Object.keys(packagedThemes.light).sort(), Object.keys(packagedThemes.dark).sort());

    await waitFor(async () => win && await win.webContents.executeJavaScript('!!document.querySelector(".canvas-wrap") && window.__codenodeUi.getState().booted').catch(() => false), '启动页');
    const js = (code) => win.webContents.executeJavaScript(code);
    win.setBounds({ x: 200, y: 110, width: 900, height: 620 });

    // ---- 2. 进入工作台 ----
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(projectDir)})`);
    await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
    await waitFor(async () => await js('!!document.querySelector(".app") && !!document.querySelector(".toolbar")'), '进入工作台');
    win.showInactive();
    win.webContents.setBackgroundThrottling(false);
    await sleep(400);

    await js('window.__codenodeUi.getState().openSettings()');
    await waitFor(() => js('!!document.querySelector(".theme-switch")'), '主题开关');
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-theme-choice]'), el => el.getAttribute('aria-label'))`), ['日间', '夜间']);
    for (const theme of ids) {
      await js(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
      await waitFor(() => js(`document.documentElement.dataset.theme === "${theme}" && document.querySelector('[data-theme-choice="${theme}"]').getAttribute('aria-pressed') === 'true'`), theme);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await js("Promise.allSettled(document.getAnimations().filter(a => a.effect?.pseudoElement?.includes('view-transition')).map(a => a.finished))");
      await sleep(350);
      for (const selector of ['.global-settings', '.canvas-wrap', '.settings-layout > nav', '.conversation-right']) {
        const bg = await js(`getComputedStyle(document.querySelector('${selector}')).backgroundColor`);
        const red = Number(/^rgb\((\d+)/.exec(bg)?.[1]);
        assert.ok(theme === 'light' ? red > 215 : red < 75, theme + ' ' + selector + ' ' + bg);
      }
      if (process.env.CODENODE_THEME_SHOTS) {
        fs.writeFileSync(path.join(process.env.CODENODE_THEME_SHOTS, theme + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    await js('window.__codenodeUi.getState().closeSettings()');

    // ---- 4. 窗口本身必须不是透明窗口，底色始终保持不透明深色 ----
    for (const theme of ids) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(200);
      assert.equal(await js('window.__codenodeUi.getState().theme'), theme);
      assert.equal(windowBg(), '#222222', theme + ' 主题下窗口底色必须始终不透明，实际 ' + JSON.stringify(win.getBackgroundColor()));
    }

    // ---- 5. 像素级不透明：两套主题都不允许把背后的棋盘格透出来 ----
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const region = sampleRegion(scale);
    const checkerboard = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body style="margin:0;width:100vw;height:100vh;background-image:repeating-linear-gradient(45deg,#000 0 8px,#fff 8px 16px)"></body>');
    backdrop = new BrowserWindow({ ...win.getBounds(), show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#000000' });
    await backdrop.loadURL(checkerboard);
    backdrop.setAlwaysOnTop(true, 'floating');
    backdrop.showInactive();
    await sleep(500);

    const outDir = path.join(__dirname, '../../out');
    fs.mkdirSync(outDir, { recursive: true });
    const shotPath = (name) => path.join(outDir, 'bright-theme-' + name + (packageRoot ? '-packaged' : '') + '.png');

    // 四次像素测量必须处在同一套布局，否则量到的是界面内容差异而不是不透明度。
    await js(`window.__codenodeUi.setState({navigationOpen:false,conversationOpen:false,sideOpen:false,dockOpen:false,sideTab:'agent',appPage:'workbench'}); window.__codenodeUi.getState().closeSettings()`);
    await sleep(300);

    win.hide();
    backdrop.show();
    backdrop.moveTop();
    await sleep(500);
    const backdropOnly = await captureRegion(region, scale, shotPath('backdrop-reference'));
    assert.ok(backdropOnly.sd > 60, '参照棋盘格必须是高频图案，实际标准差 ' + backdropOnly.sd);

    const invertBackdrop = async inverted => {
      await backdrop.webContents.executeJavaScript(`document.documentElement.style.filter = ${JSON.stringify(inverted ? 'invert(1)' : 'none')}`);
      await sleep(250);
    };
    await invertBackdrop(true);
    const inverse = await captureRegion(region, scale);
    assert.ok(meanPixelChange(backdropOnly.pixels, inverse.pixels) > 100, '参照背景必须实际翻转');
    await invertBackdrop(false);

    const opaqueOf = async (theme) => {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(250);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
      win.moveTop();
      await sleep(700);
      return captureRegion(region, scale, shotPath(theme));
    };

    for (const theme of ids) {
      const shot = await opaqueOf(theme);
      await invertBackdrop(true);
      const inverted = await captureRegion(region, scale);
      const change = meanPixelChange(shot.pixels, inverted.pixels);
      console.log('OPACITY', theme, { foregroundChange: change });
      assert.ok(change < 2, theme + ' 主题的前景像素随背景变化，平均差值 ' + change);
      await invertBackdrop(false);
    }
    win.setAlwaysOnTop(false);

    // ---- 6. 切换主题不得重置会话 / 草稿 / 模型 / 侧栏 ----
    await js(`window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,sideOpen:true,sideTab:'project',dockOpen:true,dockTab:'runs',appPage:'workbench'})`);
    await js(`window.__codenodeSession.getState().pushUser('主题切换前的消息')`);
    const snapshot = `JSON.stringify({
      root: window.__codenodeProject.getState().root,
      file: window.__codenodeProject.getState().projectFile,
      messages: window.__codenodeSession.getState().messages.length,
      model: JSON.stringify(window.__codenodeUi.getState().preferences),
      ui: (({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage})=>({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage}))(window.__codenodeUi.getState())
    })`;
    const before = await js(snapshot);
    for (const theme of ['light', 'dark', 'light']) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(160);
    }
    const after = await js(snapshot);
    assert.equal(JSON.parse(after).root, JSON.parse(before).root);
    assert.equal(JSON.parse(after).file, JSON.parse(before).file);
    assert.equal(JSON.parse(after).messages, JSON.parse(before).messages);
    assert.equal(JSON.parse(after).model, JSON.parse(before).model);
    assert.equal(JSON.parse(after).ui.theme, 'light');
    for (const key of ['navigationOpen', 'conversationOpen', 'sideOpen', 'sideTab', 'dockOpen', 'dockTab', 'appPage']) {
      assert.equal(JSON.parse(after).ui[key], JSON.parse(before).ui[key], '切换主题不得改动 ' + key);
    }

    // ---- 7. 主题选择持久化 ----
    assert.equal(await js(`localStorage.getItem('codenode.theme')`), 'light');
    if (backdrop && !backdrop.isDestroyed()) { backdrop.destroy(); backdrop = null; }
    await js("localStorage.setItem('codenode.theme', 'bright')");
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await reloaded;
    await waitFor(() => js("document.documentElement.dataset.theme === 'light' && localStorage.getItem('codenode.theme') === 'light'"), '旧主题迁移到日间');

    console.log('BRIGHT THEME UI TEST: PASS (两套主题全部不透明；切换保留会话/草稿/模型/侧栏)' + (packageRoot ? ' [交付包 ' + packageRoot + ']' : ' [源码]'));
    process.exitCode = 0;
    app.quit();
  } catch (error) {
    console.error('BRIGHT THEME UI TEST: FAIL', error);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  if (backdrop && !backdrop.isDestroyed()) backdrop.destroy();
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-bright-theme-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
