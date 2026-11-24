import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { matchesTutorialQuery, SHORTCUT_GROUPS, shortcutLabel, TUTORIAL_TOPICS, type TutorialTopic } from '../lib/tutorialContent';
import { TutorialBookIcon, TutorialBrand } from './TutorialArtwork';
import TutorialDemo from './TutorialDemo';
import './TutorialPage.css';

const quickStart: TutorialTopic[] = ['create', 'edit', 'connect'];
const instructions: Record<Exclude<TutorialTopic, 'shortcuts'>, { text: string; tip: string; keys?: string }> = {
  create: { text: '点击画布底部的「＋」，选择「新建任务」，填写任务指令。', keys: 'Shift + A', tip: '在「插件」页启用矢量编辑器后，也可以从「＋」中选择「画草图」，直接开始自由绘制。画布节点会居中放置并自动取景。' },
  edit: { text: '在高级模式下选中任务节点，点击节点旁的「⋯」并选择「节点属性」打开属性面板，修改名称并填写任务内容。', tip: '先写清楚目标，再说明输入和完成条件。点击节点标题后，Delete 删除整个节点；Ctrl / ⌘ + Z 可以撤销。' },
  connect: { text: '在高级模式下按住前一个节点右侧的输出端口，拖到后一个节点左侧的输入端口。', tip: '最小工作流可以是单个任务，也可以把资料连接到任务。填写好任务指令后，点画布上的「运行…」查看执行范围。' },
  canvas: { text: '按住空格拖动或使用鼠标中键平移；滚轮缩放。拖动空白处可以框选节点。', keys: 'Z / Home', tip: 'Z 或 Home 显示全部节点。在「画布选项」中点「自动整理」，节点会按依赖分层，分支并排显示。' },
  drawing: { text: '在「插件」页启用矢量编辑器，开启高级模式并选择「画草图」，点击节点内部，再选择工具绘制图形。', keys: 'V / P / R / T', tip: '点击内部图形后，Delete 删除图形；点击外部节点标题后，Delete 删除整个节点。内部撤销只影响图形，外部撤销影响节点。' },
};

function ShortcutReference({ query, mac }: { query: string; mac: boolean }) {
  const groups = SHORTCUT_GROUPS.map(group => ({ ...group, items: group.items.filter(([keys, label]) => matchesTutorialQuery(query, group.title, label, keys, shortcutLabel(keys, mac))) })).filter(group => group.items.length);
  return <div className="tutorial-shortcuts">
    <p className="tutorial-shortcut-note">{mac ? '键盘组合已显示为 ⌘；鼠标组合中的 Ctrl 仍使用 Control。' : '键盘组合显示为 Ctrl；Mac 上对应 ⌘，鼠标组合仍使用 Control。'} 输入文字时，常用编辑按键优先交给输入框。</p>
    {groups.length ? groups.map(group => <section key={group.title} className="tutorial-shortcut-group"><h2>{group.title}</h2><p>{group.scope}</p><dl>{group.items.map(([keys, label]) => <div key={keys}><dt>{label}</dt><dd><kbd>{shortcutLabel(keys, mac)}</kbd></dd></div>)}</dl></section>) : <p className="tutorial-no-results" role="status">没有匹配的快捷键。试试「缩放」「删除」或「Ctrl」。</p>}
  </div>;
}

export default function TutorialPage() {
  const topic = useUiStore(s => s.tutorialTopic);
  const setTopic = useUiStore(s => s.setTutorialTopic);
  const close = useUiStore(s => s.closeTutorial);
  const appPage = useUiStore(s => s.appPage);
  const [query, setQuery] = useState('');
  const [mac] = useState(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const entry = TUTORIAL_TOPICS.find(item => item.id === topic) || TUTORIAL_TOPICS[0];
  const index = quickStart.indexOf(topic);
  const searching = query.trim().length > 0;
  const results = searching ? TUTORIAL_TOPICS.filter(item => matchesTutorialQuery(query, item.title, item.description, item.chapter)) : [];
  const backLabel = appPage === 'workbench' ? '返回画布' : appPage === 'tasks' ? '返回任务' : '返回插件';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
      else document.querySelector<HTMLButtonElement>('.global-settings-trigger')?.focus();
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); scroll.current?.scrollTo(0, 0); });
    return () => cancelAnimationFrame(frame);
  }, [topic]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (event.key !== 'Escape' || ui.settingsOpen || ui.modelManagerOpen) return;
      event.preventDefault();
      if (query) setQuery(''); else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, query]);

  const navigate = (next: TutorialTopic) => { setQuery(''); setTopic(next); };
  return <div className="tutorial-page">
    <aside className="tutorial-sidebar"><TutorialBrand /><h2>使用教程</h2>
      <label className="tutorial-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="搜索教程或快捷键" placeholder="搜索教程或快捷键" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <nav aria-label="教程章节">
        <button className="tutorial-chapter" aria-current={!searching && index >= 0 ? 'page' : undefined} onClick={() => navigate('create')}>快速开始</button>
        <div className="tutorial-subchapters">{TUTORIAL_TOPICS.filter(item => quickStart.includes(item.id)).map((item, step) => <button key={item.id} aria-current={!searching && item.id === topic ? 'step' : undefined} onClick={() => navigate(item.id)}><span aria-hidden="true">{step + 1}</span>{item.title}</button>)}</div>
        {TUTORIAL_TOPICS.filter(item => !quickStart.includes(item.id)).map(item => <button className="tutorial-chapter" key={item.id} aria-current={!searching && item.id === topic ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.chapter}</button>)}
      </nav><p className="tutorial-sidebar-note"><TutorialBookIcon />随时回来查阅</p>
    </aside>
    <div className="tutorial-main"><header className="tutorial-topbar"><button className="tutorial-back" onClick={close}>← {backLabel}</button><span>CodeNode 使用教程</span><button className="tutorial-help" aria-label="打开帮助与教程设置" onClick={() => useUiStore.getState().openSettings('help')}>?</button></header>
      <main className="tutorial-reading" ref={scroll} aria-label="使用教程内容"><article className="tutorial-article">
        <p className="tutorial-breadcrumb">使用教程 <span>/</span> {searching ? '搜索结果' : entry.chapter}</p>
        <div className="tutorial-title-row"><h1 tabIndex={-1} ref={heading}>{searching ? '搜索结果' : entry.title}</h1>{!searching && index >= 0 && <span>第 {index + 1} 步，共 3 步</span>}</div>
        <p className="tutorial-description">{searching ? `查找「${query.trim()}」相关的教程与操作。` : entry.description}</p>
        {searching ? <><div className="tutorial-search-results">{results.map(item => <button key={item.id} onClick={() => navigate(item.id)}><strong>{item.title}</strong><span>{item.description}</span></button>)}</div><ShortcutReference query={query} mac={mac}/></> : topic === 'shortcuts' ? <ShortcutReference query="" mac={mac}/> : <>
          {index >= 0 && <ol className="tutorial-steps" aria-label="快速开始步骤">{quickStart.map((id, step) => <li key={id}><button aria-current={topic === id ? 'step' : undefined} onClick={() => navigate(id)}><span>{step + 1}</span>{['创建节点','编辑内容','连接节点'][step]}</button></li>)}</ol>}
          <p className="tutorial-instruction">{instructions[topic].text}</p>
          {instructions[topic].keys && <p className="tutorial-inline-keys"><kbd>{instructions[topic].keys}</kbd><span>{topic === 'create' ? '打开添加节点菜单' : topic === 'canvas' ? '显示全部节点' : '选择 / 钢笔 / 矩形 / 文本'}</span></p>}
          <TutorialDemo key={topic} topic={topic}/>
          <p className="tutorial-tip"><span aria-hidden="true">☞</span>{instructions[topic].tip}</p>
          {topic === 'canvas' && <p className="tutorial-detail">Shift / {mac ? '⌘' : 'Ctrl'} + 单击增减选中，Alt + 单击取消选中。将节点拖入范围可编组，拖出范围即可移出。</p>}
          {topic === 'drawing' && <p className="tutorial-detail">工具：V 选择、P 钢笔、R 矩形、U 圆角矩形、E 椭圆、A 箭头、T 文本、H 平移。Enter 结束钢笔绘制，Esc 取消。</p>}
          <footer className="tutorial-footer"><div><button className="tutorial-text-link" onClick={() => navigate('shortcuts')}>查看全部快捷键 ↗</button><p>教程练习不会修改你的画布内容</p></div>{index >= 0 && index < 2 ? <button className="tutorial-primary" onClick={() => navigate(quickStart[index + 1])}>下一步：{index === 0 ? '编辑内容' : '连接节点'} →</button> : <button className="tutorial-primary" onClick={close}>{backLabel}，开始创作 →</button>}</footer>
        </>}
      </article></main>
    </div>
  </div>;
}
