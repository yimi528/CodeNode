import { NodeIcon } from '../nodes/NodeIcon';
import { useState } from 'react';
import type { TutorialTopic } from '../lib/tutorialContent';

export default function TutorialDemo({ topic }: { topic: TutorialTopic }) {
  const [created, setCreated] = useState(false);
  const [connected, setConnected] = useState(false);
  const [title, setTitle] = useState('整理项目说明');
  const [zoom, setZoom] = useState(100);
  const [shape, setShape] = useState('矩形');
  return <div className={`tutorial-demo demo-${topic}`} aria-label="独立操作演示">
    <span className="tutorial-demo-caption">可点击体验 · 不影响当前画布</span>
    {topic === 'create' && <div className="tutorial-demo-create">
      <div className="tutorial-demo-menu"><strong>添加节点</strong><button aria-pressed={created} onClick={() => setCreated(true)}><NodeIcon type="task" /> 新建任务 <span aria-hidden="true">↖</span></button><span>引用项目文件</span><span>添加图片</span><span>画草图</span></div>
      <span className="tutorial-demo-arrow" aria-hidden="true">╌╌→</span>
      <div className="tutorial-demo-result" aria-live="polite">{created ? <div className="tutorial-demo-node"><strong>任务节点</strong><span>节点已创建，可以继续编辑内容。</span></div> : <p>点击左侧「新建任务」，<br/>试着创建第一个节点。</p>}</div>
    </div>}
    {topic === 'edit' && <div className="tutorial-demo-editor"><label>节点名称<input aria-label="演示节点名称" value={title} onChange={event => setTitle(event.target.value)} maxLength={40}/></label><div className="tutorial-demo-node"><strong>{title || '未命名节点'}</strong><span>名称会同步显示在节点上。</span></div></div>}
    {topic === 'connect' && <div className="tutorial-demo-connect"><div className="tutorial-demo-chain"><div className="tutorial-demo-node"><strong>资料</strong><span>提供项目文件</span></div><span className={connected ? 'demo-wire connected' : 'demo-wire'} aria-hidden="true">╌╌→</span><div className="tutorial-demo-node"><strong>任务节点</strong><span>完成具体任务</span></div></div><button className="tutorial-secondary" onClick={() => setConnected(value => !value)}>{connected ? '断开示例连线' : '连接两个示例节点'}</button><p role="status">{connected ? '已连接：资料 → 任务' : '真实画布中，拖动节点端口即可连线。'}</p></div>}
    {topic === 'canvas' && <div className="tutorial-demo-view"><div className="tutorial-demo-node" style={{transform:`scale(${zoom / 100})`}}><strong>任务节点</strong><span>观察节点的缩放变化</span></div><div className="tutorial-demo-zoom"><button aria-label="缩小演示" disabled={zoom <= 50} onClick={() => setZoom(value => value - 25)}>−</button><output aria-live="polite">{zoom}%</output><button aria-label="放大演示" disabled={zoom >= 150} onClick={() => setZoom(value => value + 25)}>＋</button><button onClick={() => setZoom(100)}>重置</button></div></div>}
    {topic === 'drawing' && <div className="tutorial-demo-drawing"><div className="tutorial-demo-tools" aria-label="演示绘图工具">{['矩形','椭圆','文本'].map(tool => <button key={tool} aria-pressed={shape === tool} onClick={() => setShape(tool)}>{tool}</button>)}</div><div className={`tutorial-demo-shape shape-${shape}`} aria-live="polite">{shape === '文本' ? '写下你的想法' : <span className="sr-only">{shape}</span>}</div></div>}
  </div>;
}
