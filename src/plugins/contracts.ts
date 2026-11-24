import type { ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { useGraphStore } from '../store/graphStore';
import type { useUiStore } from '../store/uiStore';
import type { useSpacePan } from '../hooks/useSpacePan';

/** Trusted first-party plugin API. Runtime access is supplied by the host. */
export interface VectorEditorHost {
  graph: typeof useGraphStore;
  ui: typeof useUiStore;
  useSpacePan: typeof useSpacePan;
}
export interface VectorEditorPlugin {
  configureHost: (host: VectorEditorHost) => void;
  Node: ComponentType<NodeProps>;
  vectorPreview: (ctx: CanvasRenderingContext2D, nodeId: string, x: number, y: number, width: number, height: number) => void;
  getVectorStore: (nodeId: string) => { subscribe: (listener: () => void) => () => void };
  getActiveVectorNode: () => string | null;
  useVectorStore: unknown;
}
