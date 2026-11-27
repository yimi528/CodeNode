import manifest from '../../plugins/vector-editor/plugin.json';
import { useUiStore } from '../store/uiStore';
import { loadVectorPlugin, useVectorPlugin } from './vectorEditor';

export default function VectorPluginCard({featured = false}: {featured?: boolean}) {
  const enabled = useUiStore(s => s.preferences.vectorEditorEnabled);
  const {loading, error} = useVectorPlugin();
  return <section className="vector-plugin-card" aria-label="矢量编辑器插件">
    <h3>{manifest.name} <small>v{manifest.version} · 桌面插件</small></h3>
    <p>{featured ? '在画布节点中绘制图形，调整锚点与路径。' : '在画布节点中绘制图形与编辑路径。按需加载，停用后保留已有数据。'}</p>
    <button aria-label={enabled ? '停用矢量编辑器' : '启用矢量编辑器'} aria-pressed={enabled} onClick={() => useUiStore.getState().updatePreferences({vectorEditorEnabled: !enabled})}>{enabled ? '停用' : '启用'}</button>
    <span role="status">{!enabled ? '未启用' : loading ? '正在加载…' : error ? '加载失败' : '已启用'}</span>
    {enabled && error && <p role="alert">{error} <button onClick={() => void loadVectorPlugin()}>重试加载</button></p>}
  </section>;
}
