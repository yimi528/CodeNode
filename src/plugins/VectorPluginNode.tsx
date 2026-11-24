import type { NodeProps } from '@xyflow/react';
import { useUiStore } from '../store/uiStore';
import { loadVectorPlugin, useVectorPlugin } from './vectorEditor';

export default function VectorPluginNode(props: NodeProps) {
  const enabled = useUiStore(s => s.preferences.vectorEditorEnabled);
  const {plugin, loading, error} = useVectorPlugin();
  if (enabled && plugin) return <plugin.Node {...props} />;
  return <div className="vector-plugin-placeholder" data-testid="vector-plugin-placeholder" style={{width: Number(props.data.width) || 1040, height: Number(props.data.height) || 640}}>
    <strong>{String(props.data.label || '矢量画布')}</strong>
    <p>{!enabled ? '矢量编辑器插件未启用。已有绘图数据保留，启用后可继续编辑。' : error ? '插件加载失败：' + error : '正在加载矢量编辑器…'}</p>
    {!enabled ? <button className="nodrag" onClick={() => useUiStore.getState().updatePreferences({vectorEditorEnabled: true})}>启用矢量编辑器</button> : error && !loading ? <button className="nodrag" onClick={() => void loadVectorPlugin()}>重试加载</button> : null}
  </div>;
}
