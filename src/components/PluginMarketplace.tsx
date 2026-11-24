import { useState } from 'react';
import MarketIcon from './MarketIcon';
import VectorPluginCard from '../plugins/VectorPluginCard';
import vectorManifest from '../../plugins/vector-editor/plugin.json';

const projectPlugins = [
  { name: 'git_worktree_status', title: '工作区状态', icon: 'branch', command: 'git --no-optional-locks status --short --branch', description: '查看当前分支、暂存区和工作区中有变化的文件。' },
  { name: 'git_recent_commits', title: '提交速览', icon: 'history', command: 'git --no-pager log -12 --oneline --decorate', description: '读取最近 12 次提交的摘要、哈希和分支标记。' },
  { name: 'git_tracked_files', title: '受控文件清单', icon: 'file', command: 'git -c core.quotepath=false ls-files', description: '列出当前仓库纳入版本管理的文件及其路径。' },
] as const;
const categories = ['全部', '画布编辑', '版本控制'] as const;

type Props = {
  root: string | null;
  items: ProjectExtensionDto[];
  loading: boolean;
  error: string;
  refresh: () => void;
  manage: () => void;
};

export default function PluginMarketplace({root, items, loading, error, refresh, manage}: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('全部');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const showVector = category !== '版本控制' && matches(vectorManifest.name + ' vector editor 画布编辑 图形 路径');
  const visible = projectPlugins.filter(plugin => category !== '画布编辑' && matches([plugin.title, plugin.name, plugin.description, 'Git 版本控制'].join(' ')));

  async function install(plugin: typeof projectPlugins[number]) {
    if (!root || pending) return;
    setPending(plugin.name);
    setFailure('');
    setNotice('');
    try {
      const result = await window.codenode!.addExtensions(root, {
        name: plugin.name, description: plugin.description, command: plugin.command,
        kind: 'plugin', readOnly: true, parameters: {type: 'object', properties: {}, additionalProperties: false},
      });
      if (!result.ok) throw new Error(result.error || '安装失败');
      setNotice(plugin.title + '已安装到当前项目');
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending('');
    }
  }

  return <section className="plugin-market extensions-panel" aria-label="插件市场">
    <header className="market-header">
      <h2>插件市场</h2>
      <label className="extensions-search"><MarketIcon name="search"/><input type="search" aria-label="搜索市场插件" placeholder="搜索插件" value={query} onChange={e => setQuery(e.target.value)}/></label>
    </header>
    <div className="market-controls">
      <nav aria-label="市场分类">{categories.map(value => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</nav>
      <button className="market-manage" onClick={manage}>项目工具</button>
    </div>
    {error && <p role="alert">{error} <button onClick={refresh}>重新读取安装状态</button></p>}
    {notice && <p className="extensions-notice" role="status">{notice}</p>}
    {failure && <p className="extension-connect-error" role="alert">{failure}</p>}
    {showVector && <div className="market-vector">
      <VectorPluginCard featured/>
    </div>}
    {visible.length > 0 && <section className="market-project"><header><h3>版本控制</h3><small>需要本机安装 Git</small></header>
      <div className="market-grid">{visible.map(plugin => {
        const installed = items.find(item => item.name === plugin.name);
        return <article key={plugin.name}>
          <span className={'market-icon icon-' + plugin.icon}><MarketIcon name={plugin.icon}/></span>
          <div className="market-copy"><h4>{plugin.title}</h4><p>{plugin.description}</p></div>
          <details><summary aria-label={'查看命令 · ' + plugin.title} title="查看命令"><MarketIcon name="chevron"/></summary><code>{plugin.command}</code></details>
          <button disabled={!root || loading || !!error || !!pending || !!installed} onClick={() => void install(plugin)}>{installed ? (installed.enabled === false ? '已停用' : '已安装') : pending === plugin.name ? '安装中…' : '安装到项目'}</button>
        </article>;
      })}</div></section>}
    {!showVector && !visible.length && <div className="extensions-empty"><strong>没有匹配的插件</strong><p>尝试其他关键词或查看全部分类。</p><button onClick={() => {setCategory('全部');setQuery('');}}>查看全部插件</button></div>}
  </section>;
}
