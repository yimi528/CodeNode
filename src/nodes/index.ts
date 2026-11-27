import type { NodeTypes } from '@xyflow/react';
import type { WorkflowNodeData, ScopeData, VectorData } from '../types';
import WorkflowNode from './WorkflowNode';
import ScopeNode from './ScopeNode';
import FileNode from './FileNode';
import ImageNode from './ImageNode';
import VectorNode from '../plugins/VectorPluginNode';
import { workflowNodeAccent } from '../lib/workflowNodeAppearance';

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

export function isWorkflowCard(type?: string): boolean {
  return !!type && nodeTypes[type] === WorkflowNode;
}

export const NODE_TEMPLATES = {
  start: { label: '入口', status: 'pending', accent: workflowNodeAccent('start') },
  end: { label: '出口', status: 'pending', accent: workflowNodeAccent('end') },
  task: { label: '任务', status: 'pending', prompt: '', accent: workflowNodeAccent('task') },
  tool: { label: '工具调用', status: 'pending', prompt: '', accent: workflowNodeAccent('tool') },
  stage: { label: '子代理任务', status: 'pending', prompt: '', accent: workflowNodeAccent('stage') },
  file: { label: '项目文件', status: 'pending', accent: workflowNodeAccent('file') },
  image: { label: '图片', status: 'pending', accent: workflowNodeAccent('image') },
  object: { label: '命名对象', status: 'pending', objectName: '', accent: workflowNodeAccent('object') },
  scope: {
    label: '分组', status: 'pending', accent: workflowNodeAccent('scope'),
    width: 320, height: 220, fill: '#3b2f6b', opacity: 0.16, shrink: false,
  } satisfies ScopeData,
  vector: {
    label: '草图',
    status: 'pending',
    accent: workflowNodeAccent('vector'),
    width: 1040,
    height: 640,
    mode: 'design',
    dockOpen: true,
  } satisfies VectorData,
} satisfies Record<string, WorkflowNodeData>;
