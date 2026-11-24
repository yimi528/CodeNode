import { useEffect } from 'react';
import { create } from 'zustand';
import { useUiStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { useSpacePan } from '../hooks/useSpacePan';
import type { VectorEditorPlugin } from './contracts';

type Plugin = VectorEditorPlugin;
export const useVectorPlugin = create<{
  plugin: Plugin | null; loading: boolean; error: string;
}>(() => ({ plugin: null, loading: false, error: '' }));
let pending: Promise<void> | null = null;

export function loadVectorPlugin(): Promise<void> {
  if (useVectorPlugin.getState().plugin) return Promise.resolve();
  if (pending) return pending;
  useVectorPlugin.setState({loading: true, error: ''});
  if (import.meta.env.VITE_VECTOR_EDITOR_PLUGIN === 'disabled') {
    useVectorPlugin.setState({loading: false, error: '此构建未包含矢量编辑器插件'});
    return Promise.resolve();
  }
  const loader = Object.values(import.meta.glob<Plugin>('../../plugins/vector-editor/src/vector-editor.ts'))[0];
  if (!loader) {
    useVectorPlugin.setState({loading: false, error: '未找到矢量编辑器插件'});
    return Promise.resolve();
  }
  pending = loader().then(plugin => {
    plugin.configureHost({graph: useGraphStore, ui: useUiStore, useSpacePan});
    // Legacy diagnostic APIs become available only after explicit activation.
    Object.assign(window, {
      __codenodeVector: plugin.useVectorStore,
      __codenodeVectorNode: plugin.getVectorStore,
      __codenodeVectorActive: plugin.getActiveVectorNode,
    });
    useVectorPlugin.setState({plugin, loading: false});
  }).catch(error => {
    useVectorPlugin.setState({loading: false, error: error instanceof Error ? error.message : String(error)});
  }).finally(() => { pending = null; });
  return pending;
}

export function useVectorPluginLifecycle() {
  const enabled = useUiStore(s => s.preferences.vectorEditorEnabled);
  useEffect(() => { if (enabled) void loadVectorPlugin(); }, [enabled]);
}
