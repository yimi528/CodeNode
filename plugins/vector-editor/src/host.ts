import type { VectorEditorHost } from '../../../src/plugins/contracts';
export let useGraphStore: VectorEditorHost['graph'];
export let useUiStore: VectorEditorHost['ui'];
export let useSpacePan: VectorEditorHost['useSpacePan'];
export function configureHost(host: VectorEditorHost) {
  useGraphStore = host.graph; useUiStore = host.ui; useSpacePan = host.useSpacePan;
}
