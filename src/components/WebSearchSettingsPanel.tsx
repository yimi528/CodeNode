import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';

const providers: Array<[WebSearchProviderDto, string, string]> = [
  ['searxng', 'SearxNG', '自建或内网实例，可不填 Key'],
  ['tavily', 'Tavily', '面向 Agent 的搜索 API'],
  ['brave', 'Brave Search', '独立网页索引'],
  ['serper', 'Serper', 'Google 搜索 API 中转'],
  ['google', 'Google Programmable Search', '需要 API Key 与搜索引擎 ID'],
  ['custom', '自定义 GET JSON', '兼容 results/items/裸数组响应'],
];
const endpoints: Record<WebSearchProviderDto, string> = {
  searxng: '', tavily: 'https://api.tavily.com/search', brave: 'https://api.search.brave.com/res/v1/web/search',
  serper: 'https://google.serper.dev/search', google: 'https://customsearch.googleapis.com/customsearch/v1', custom: '',
};
const initial: WebSearchSettingsDto = {
  enabled: false, provider: 'searxng', backend: 'searxng', endpoint: '', apiKey: '', apiKeySet: false,
  apiKeyPreview: '', engineId: '', maxResults: 5, timeoutMs: 15000, networkAllowed: false,
};

export default function WebSearchSettingsPanel() {
  const root = useProjectStore(state => state.root);
  const [settings, setSettings] = useState<WebSearchSettingsDto>(initial);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    void window.codenode?.agentConfig(root).then(config => {
      if (!alive) return;
      if (config.webSearch) setSettings({ ...initial, ...config.webSearch });
      setBusy(false);
    }).catch(error => { if (alive) { setMessage('读取失败：' + String(error)); setBusy(false); } });
    return () => { alive = false; };
  }, [root]);

  const payload = (): WebSearchSettingsInput => ({
    enabled: settings.enabled, provider: settings.provider, endpoint: settings.endpoint,
    apiKey, engineId: settings.engineId || '', maxResults: settings.maxResults,
    timeoutMs: settings.timeoutMs, networkAllowed: settings.networkAllowed,
  });
  const changeProvider = (provider: WebSearchProviderDto) => {
    setSettings(previous => ({ ...previous, provider, backend: provider, endpoint: endpoints[provider], apiKeySet: false, apiKeyPreview: '', engineId: provider === 'google' ? previous.engineId : '' }));
    setApiKey(''); setMessage('');
  };
  const check = async () => {
    setBusy(true); setMessage('正在连接搜索服务…');
    try {
      const api = window.codenode;
      if (!api) throw new Error('未检测到 Electron 环境');
      const result = await api.webSearchCheck(root, payload());
      setMessage(result.ok ? result.message || `连接成功：${result.provider} 返回 ${result.count || 0} 条测试结果${result.sample?.title ? ` · ${result.sample.title}` : ''}` : '连接失败：' + (result.error || '未知错误'));
    } catch (error) { setMessage('连接失败：' + String(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMessage('正在保存…');
    try {
      const api = window.codenode;
      if (!api) throw new Error('未检测到 Electron 环境');
      const result = await api.webSearchSave(root, payload());
      if (!result.ok || !result.settings) throw new Error(result.error || '保存失败');
      setSettings({ ...initial, ...result.settings }); setApiKey(''); setMessage('已保存；下一轮 Agent 对话生效。');
    } catch (error) { setMessage('保存失败：' + String(error)); }
    finally { setBusy(false); }
  };
  const keyRequired = !['searxng', 'custom'].includes(settings.provider);

  return <div className="web-search-settings">
    <section className="settings-group">
      <label className="settings-row"><span>联网搜索</span><input aria-label="启用联网搜索" type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => setSettings({ ...settings, enabled: event.target.checked })}/></label>
      <label className="settings-row"><span>搜索供应商<small>{providers.find(item => item[0] === settings.provider)?.[2]}</small></span><select aria-label="搜索供应商" value={settings.provider} disabled={busy} onChange={event => changeProvider(event.target.value as WebSearchProviderDto)}>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="settings-row"><span>API Key<small>{settings.apiKeySet ? `已保存 ${settings.apiKeyPreview}` : keyRequired ? '必填' : '可选'}</small></span><input aria-label="搜索 API Key" type="password" autoComplete="off" value={apiKey} disabled={busy} placeholder={settings.apiKeySet ? '留空沿用已保存 Key' : '输入搜索服务 API Key'} onChange={event => setApiKey(event.target.value)}/></label>
      {settings.provider === 'google' && <label className="settings-row"><span>搜索引擎 ID<small>Programmable Search cx</small></span><input aria-label="搜索引擎 ID" value={settings.engineId || ''} disabled={busy} onChange={event => setSettings({ ...settings, engineId: event.target.value })}/></label>}
      <label className="settings-row"><span>允许搜索端点联网<small>只放行 web_search，不开放终端或其他网络工具</small></span><input aria-label="允许联网搜索请求" type="checkbox" checked={settings.networkAllowed} disabled={busy} onChange={event => setSettings({ ...settings, networkAllowed: event.target.checked })}/></label>
    </section>
    <details className="settings-advanced settings-group"><summary>端点与限制</summary>
      <label className="settings-row"><span>API 地址</span><input aria-label="搜索 API 地址" value={settings.endpoint} disabled={busy} placeholder={settings.provider === 'searxng' ? 'http://127.0.0.1:8888/search' : 'https://search.example.com?q={query}'} onChange={event => setSettings({ ...settings, endpoint: event.target.value })}/></label>
      <label className="settings-row"><span>最多结果</span><input aria-label="搜索结果数量" type="number" min="1" max="20" value={settings.maxResults} disabled={busy} onChange={event => setSettings({ ...settings, maxResults: Number(event.target.value) })}/></label>
      <label className="settings-row"><span>超时（秒）</span><input aria-label="搜索超时" type="number" min="1" max="60" value={Math.round(settings.timeoutMs / 1000)} disabled={busy} onChange={event => setSettings({ ...settings, timeoutMs: Number(event.target.value) * 1000 })}/></label>
    </details>
    {settings.apiKeyError && <p className="settings-scope" role="alert">已保存的 API Key 无法解密，请重新填写。</p>}
    <div className="settings-row"><button disabled={busy || !settings.endpoint} onClick={() => void check()}>测试连接</button><button disabled={busy} onClick={() => void save()}>保存联网搜索</button></div>
    {message && <p className="settings-scope" role="status">{message}</p>}
    <p className="settings-scope">Key 使用系统安全存储加密，设置应用于本机所有项目。关闭联网授权时工具仍可配置，但 Agent 不会发送搜索请求。</p>
  </div>;
}
