export type TutorialTopic = 'create' | 'edit' | 'connect' | 'canvas' | 'drawing' | 'shortcuts';

export const TUTORIAL_TOPICS: { id: TutorialTopic; chapter: string; title: string; description: string }[] = [
  { id: 'create', chapter: '快速开始', title: '创建第一个节点', description: '从一个节点开始，搭建你的第一个工作流。' },
  { id: 'edit', chapter: '快速开始', title: '编辑节点内容', description: '给节点起一个清晰的名字，再写下它需要完成的任务。' },
  { id: 'connect', chapter: '快速开始', title: '连接节点', description: '从输出端口连向下一个节点的输入端口，表达执行顺序。' },
  { id: 'canvas', chapter: '画布操作', title: '自由浏览与整理画布', description: '学会平移、缩放和选择，让复杂的工作流保持清晰。' },
  { id: 'drawing', chapter: '画布节点', title: '在节点里自由绘制', description: '画布节点是一张可编辑的画纸，支持图形、文本与钢笔路径。' },
  { id: 'shortcuts', chapter: '快捷键速查', title: '快捷键速查', description: '按场景查找操作，或搜索动作名称与按键。' },
];

export const SHORTCUT_GROUPS = [
  { title: '节点编辑', scope: '高级模式下在工作流画布中使用；编辑文字时让位给输入框。', items: [
    ['Shift + A', '添加节点'], ['Mod + D', '复制选中节点'], ['Delete / Backspace / X', '删除选中节点或连线'],
    ['Mod + J', '将选中节点放入新范围'], ['Mod + Z', '撤销节点操作'], ['Mod + Y / Mod + Shift + Z', '重做节点操作'],
  ] },
  { title: '选择与连线', scope: '连线与编组操作需开启高级模式；鼠标组合中的 Ctrl 在 Mac 上仍为 Control。', items: [
    ['拖动空白处', '框选节点'], ['Shift / Mod + 单击', '增减选中节点'], ['Alt + 单击', '取消选中节点'],
    ['拖动端口', '连接节点'], ['Ctrl + 右键单击连线', '断开连线'], ['Ctrl + 右键划过连线', '批量切断连线'],
    ['Ctrl + Shift + 单击连线', '添加中转点'], ['Ctrl + Shift + 右键划线', '批量添加中转点'],
    ['拖入 / 拖出范围', '加入 / 移出编组'], ['Alt + 拖动节点', '强制移出范围'],
  ] },
  { title: '视图与布局', scope: '在工作流画布中使用；节点排版需开启高级模式。', items: [
    ['Space + 拖动 / 中键拖动', '平移画布'], ['滚轮', '缩放视图'], ['Z / Home', '显示全部节点'],
    ['Mod + Shift + A / Mod + L', '自动整理'], ['Mod + B', '显示或隐藏左侧导航栏'],
  ] },
  { title: '项目操作', scope: '在工作台中使用；画布节点内部编辑时请先退出该编辑区。', items: [
    ['Mod + N', '新建项目'], ['Mod + O', '打开项目'], ['Mod + S', '保存项目；文件页中保存当前文件'], ['Mod + P', '打开项目文件搜索'],
  ] },
  { title: '画布节点 · 绘图工具', scope: '启用矢量编辑器插件后，仅在画布节点内部获得焦点、且未输入文字时生效。', items: [
    ['V', '选择工具'], ['P', '钢笔工具'], ['R', '矩形'], ['U', '圆角矩形'], ['E', '椭圆'], ['A', '箭头'],
    ['T', '文本'], ['H', '平移工具'], ['Enter', '结束钢笔绘制'], ['Esc', '取消绘制、退出编辑或清除选择'],
  ] },
  { title: '画布节点 · 图形编辑', scope: '仅在画布节点内部生效；选择图形后删除操作作用于图形。', items: [
    ['Mod + C / X / V', '复制 / 剪切 / 粘贴图形'], ['Mod + A', '全选图形'], ['Mod + D', '复制选中图形'],
    ['Mod + Z', '撤销图形操作'], ['Mod + Y / Mod + Shift + Z', '重做图形操作'],
    ['Delete / Backspace', '删除选中图形或锚点'], ['方向键', '微移 1 px'], ['Shift + 方向键', '微移 10 px'],
    ['Shift + 拖动缩放手柄', '等比缩放'], ['Shift + 旋转', '按 15° 旋转'], ['滚轮', '缩放节点内部画纸'],
  ] },
];

export function shortcutLabel(keys: string, mac: boolean): string {
  return keys.replace(/Mod/g, mac ? '⌘' : 'Ctrl');
}

export function matchesTutorialQuery(query: string, ...text: string[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.join(' ').toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}
