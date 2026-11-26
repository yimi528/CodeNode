import { useEffect, useState, type ReactNode } from 'react';
import SettingsDisclosure from './SettingsDisclosure';
import defaults from '../../config/ui.costs.json';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import type { CostSettings, TaskCosts } from '../types';

const initial = (): CostSettings => ({ ...defaults.defaults, roleModels: { ...defaults.defaults.roleModels }, roleBudgets: structuredClone(defaults.defaults.roleBudgets) });
const budgetFields = [['maxTurns', '模型轮次'], ['tokenBudget', '总 token'], ['maxOutputTokens', '单次输出 token']] as const;
const money = (value: number | null) => value == null ? '未知' : '$' + value.toFixed(6);
const statuses: Record<string, string> = { completed: '已完成', failed: '失败', error: '失败', cancelled: '已取消', blocked: '受阻', limit_reached: '达到上限', unknown: '未记录结果' };
export default function CostSettingsPanel({ advancedOpen, children }: { advancedOpen: boolean; children: ReactNode }) {
  const root = useProjectStore(state => state.root);
  const streaming = useSessionStore(state => state.streaming);
  const [settings, setSettings] = useState<CostSettings>(initial);
  const [saved, setSaved] = useState<CostSettings>(initial);
  const [models, setModels] = useState<ModelSpecDto[]>([]);
  const [roles, setRoles] = useState<{ name: string; label: string }[]>([]);
  const [costs, setCosts] = useState<TaskCosts | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    setSettings(initial()); setSaved(initial()); setMessage(''); setCosts(null); setModels([]); setRoles([]);
    if (!root || !window.codenode) return;
    setBusy(true);
    void Promise.all([window.codenode.agentConfig(root), window.codenode.agentMetrics(root)]).then(([config, metrics]) => {
      if (!alive) return;
      setSettings(config.costSettings || initial()); setSaved(config.costSettings || initial()); setModels(config.models || []); setRoles(config.subagentRoles || []);
      setCosts(metrics.taskCosts || null);
    }).catch(error => { if (alive) setMessage(String(error)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [root]);
  const save = async () => {
    if (!root || busy || streaming || !window.codenode) return;
    setBusy(true); setMessage('');
    try {
      const result = await window.codenode.costSettingsSave(root, settings);
      if (useProjectStore.getState().root !== root) return;
      if (result.ok) setSaved(settings);
      setMessage(result.ok ? '已保存，下次任务生效。' : result.error || '保存失败');
    } catch (error) { if (useProjectStore.getState().root === root) setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const disabled = !root || busy || streaming;
  return <div className="cost-settings">
    <p className="settings-scope">{root ? '应用于当前项目' : '打开项目后可配置模型与执行策略'}</p>
    <h3>模型</h3><div className="settings-row"><span>主 Agent 模型</span><small>跟随对话选择</small></div>
    <details className="settings-disclosure"><summary>按角色配置<small>{roles.some(role => settings.roleModels[role.name]) ? '部分角色单独配置' : '全部跟随主 Agent'}</small></summary>
    {roles.map(role => <div key={role.name}><label className="settings-row"><span>{role.label}</span><select aria-label={role.label + '模型'} disabled={disabled} value={settings.roleModels[role.name] || ''} onChange={event => setSettings({ ...settings, roleModels: { ...settings.roleModels, [role.name]: event.target.value } })}>
      <option value="">跟随主 Agent</option>
      {settings.roleModels[role.name] && !models.some(model => model.id === settings.roleModels[role.name]) && <option value={settings.roleModels[role.name]}>模型已移除，请重新选择</option>}
      {models.filter(model => model.enabled !== false).map(model => <option key={model.id} value={model.id}>{model.label || model.model}</option>)}
    </select></label></div>)}
    </details>
    <h3>执行策略</h3>
    <label className="settings-row"><span>小任务由主 Agent 直接完成</span><input aria-label="小任务直接执行" type="checkbox" checked={settings.delegationGate} disabled={disabled} onChange={event => setSettings({ ...settings, delegationGate: event.target.checked })} /></label>
    <label className="settings-row"><span>复用重复的只读结果</span><input aria-label="重复结果使用引用" type="checkbox" checked={settings.repeatResultReferences} disabled={disabled} onChange={event => setSettings({ ...settings, repeatResultReferences: event.target.checked })} /></label>
    <SettingsDisclosure title="高级设置" hint="预算与限制" initialOpen={advancedOpen}>
    {children}
    {roles.map(role => <details key={role.name} className="role-budget"><summary>{role.label}预算 · 0 表示继承</summary>
      {budgetFields.map(([field, label]) => <label className="settings-row" key={field}><span>{label}</span><input type="number" aria-label={role.label + label} disabled={disabled} min="0" max={defaults.budgetLimits[field]} step="1" value={settings.roleBudgets[role.name]?.[field] || 0} onChange={event => setSettings({ ...settings, roleBudgets: { ...settings.roleBudgets, [role.name]: { ...settings.roleBudgets[role.name], [field]: Number(event.target.value) } } })} /></label>)}
      {role.name === 'explorer' && <button disabled={disabled} onClick={() => setSettings({ ...settings, roleBudgets: { ...settings.roleBudgets, explorer: { ...defaults.presets.lightExplorer } } })}>使用轻量探查预设</button>}
    </details>)}
    <p className="settings-scope">角色预算和工具参数只能收紧父任务上限。轻量探查预设为 6 轮、60000 总 token、8192 单次输出 token；复杂探查可保留继承。达到上限会如实标记未完成。</p>
    <h3>任务成本</h3>
    <p className="settings-scope">记录范围内共 {costs?.runCount || 0} 次运行，完成 {costs?.completedRuns || 0} 次，通过局部校验 {costs?.verifiedRuns || 0} 次。局部校验不代表完整任务正确率。</p>
    <p className="settings-scope">总成本 {money(costs?.totalCostUsd ?? null)} · 每次完成成本 {money(costs?.costPerCompletedRun ?? null)} · 每次通过局部校验成本 {money(costs?.costPerVerifiedRun ?? null)}。分子包含失败和取消的运行；缺失价格时显示未知。</p>
    <div className="task-cost-list">{costs?.tasks.length ? costs.tasks.slice(0, 20).map(task => <details key={task.runId + ':' + task.taskId + ':' + task.executionId}>
      <summary>{roles.find(role => role.name === task.role)?.label || (task.role === 'main' ? '主 Agent' : task.role)} · {statuses[task.status] || task.status} · {task.totalTokens.toLocaleString()} token · {money(task.costKnown ? task.costUsd : null)}</summary>
      <p className="settings-scope">{task.runId} / {task.taskId} · 模型：{task.models.join('、') || '未调用'} · 请求 {task.requests} · 重试 {task.retries} · {task.verified ? '局部校验通过' : '未记录通过的局部校验'}</p>
      <p className="settings-scope">输入 {task.promptTokens} · 输出 {task.completionTokens} · 缓存命中 {task.promptCachedTokens} · 估算请求 {task.estimated} · 调用分类 {Object.entries(task.kinds).map(([kind, count]) => kind + ' ' + count).join('、')}</p>
    </details>) : <p className="settings-scope">尚无任务成本记录</p>}</div>
    </SettingsDisclosure>
    {settings !== saved && JSON.stringify(settings) !== JSON.stringify(saved) && <button className="cost-settings-save" disabled={disabled} onClick={() => void save()}>保存更改</button>}
    {message && <p role="status" className="settings-scope">{message}</p>}
  </div>;
}
