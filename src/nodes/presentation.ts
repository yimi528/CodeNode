// Storage and execution keep their original type IDs so saved workflows retain their contracts.
const task = { label: '任务', color: '#3b82f6', path: 'M5 4h14v16H5z M8 11l3 3 5-6' };
const material = { label: '资料', color: '#e79029', path: 'M4 8V5h6l2 3h8v12H4z M8 12h8 M8 16h5' };
const group = { label: '分组', color: '#9670e8', path: 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4 M8 9h4v4H8z M13 13h3v3h-3z' };
const sketch = { label: '草图', color: '#21aba3', path: 'M4 19l1-5L16 3l4 4L9 18z M13 6l4 4 M12 20h8' };
const presentations: Record<string, typeof task> = {
  task,
  tool: { ...task, path: 'M3 5h18v14H3z M6 9l3 3-3 3 M12 15h5' },
  stage: { ...task, path: 'M8 3h8v6H8z M12 9v4 M6 16v-3h12v3 M3 16h6v5H3z M15 16h6v5h-6z' },
  file: material,
  image: { ...material, path: 'M3 5h18v14H3z M3 17l6-6 5 5 3-3 4 4 M16 9h.01' },
  object: { ...material, path: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9' },
  scope: group,
  vector: sketch,
  start: { label: '入口', color: '#22c55e', path: 'M7 4l13 8-13 8z' },
  end: { label: '出口', color: '#ef4444', path: 'M5 5h14v14H5z' },
};

export function nodePresentation(type?: string) {
  return presentations[type || 'task'] ?? task;
}

export const taskModes = { task: '普通任务', tool: '工具调用', stage: '子代理任务' };
export const materialModes = { file: '文件', image: '图片', object: '命名对象' };

export function nodeModes(type: string) {
  if (Object.prototype.hasOwnProperty.call(taskModes, type)) return taskModes;
  if (Object.prototype.hasOwnProperty.call(materialModes, type)) return materialModes;
  return undefined;
}

export function boundaryLabel(value?: string) {
  return value === 'both' ? '起点和输出' : value === 'start' ? '起点' : value === 'end' ? '输出' : '';
}
