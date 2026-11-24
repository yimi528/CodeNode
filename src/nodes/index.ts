import type { NodeTypes } from '@xyflow/react';
import type { WorkflowNodeData, ScopeData, VectorData } from '../types';
import WorkflowNode from './WorkflowNode';
import ScopeNode from './ScopeNode';
import FileNode from './FileNode';
import ImageNode from './ImageNode';
import VectorNode from '../plugins/VectorPluginNode';
import { nodePresentation } from './presentation';

export const nodeTypes: NodeTypes = {
  task: WorkflowNode,
  stage: WorkflowNode,
  tool: WorkflowNode,
  start: WorkflowNode,
  end: WorkflowNode,
  scope: ScopeNode,
  file: FileNode,
  image: ImageNode,
  object: WorkflowNode,
  vector: VectorNode,
};

export const NODE_TEMPLATES = {
  start: { label: '入口', status: 'pending', accent: nodePresentation('start').color },
  end: { label: '出口', status: 'pending', accent: nodePresentation('end').color },
  task: { label: '任务', status: 'pending', prompt: '', accent: nodePresentation('task').color },
  tool: { label: '工具调用', status: 'pending', prompt: '', accent: nodePresentation('tool').color },
  stage: { label: '子代理任务', status: 'pending', prompt: '', accent: nodePresentation('stage').color },
  file: { label: '项目文件', status: 'pending', accent: nodePresentation('file').color },
  image: { label: '图片', status: 'pending', accent: nodePresentation('image').color },
  object: { label: '命名对象', status: 'pending', objectName: '', accent: nodePresentation('object').color },
  scope: {
    label: '分组', status: 'pending', accent: nodePresentation('scope').color,
    width: 320, height: 220, fill: '#3b2f6b', opacity: 0.16, shrink: false,
  } satisfies ScopeData,
  vector: {
    label: '草图',
    status: 'pending',
    accent: nodePresentation('vector').color,
    width: 1040,
    height: 640,
    mode: 'design',
    dockOpen: true,
  } satisfies VectorData,
} satisfies Record<string, WorkflowNodeData>;
