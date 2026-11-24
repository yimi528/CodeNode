import { useState } from 'react';
import type { AgentBackendSettings } from '../../types';

type ModelChoice = { id: string; label: string };
type AcpModelOption = { value?: string; name?: string; options?: AcpModelOption[] };
type AcpModelInfo = {
  models?: { availableModels?: { modelId: string; name?: string }[] };
  configOptions?: { category?: string; options?: AcpModelOption[] }[];
};

export default function ExternalModelPicker({ settings, root, model, followLabel, busy, canList, onChange }: {
  settings: AgentBackendSettings;
  root: string | null;
  model: string;
  followLabel: string;
  busy: boolean;
  canList: boolean;
  onChange: (model: string) => void;
}) {
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const loadModels = async () => {
    const api = window.codenode;
    if (!api) return;
    setLoading(true);
    setNotice('');
    try {
      const response = await api.backendControl(root, settings, 'inspect');
      if (!response.ok) throw new Error(response.error || '读取模型失败');
      const info = response.value as AcpModelInfo;
      const options = info.configOptions?.find(option => option.category === 'model')?.options ?? [];
      const configured = options.flatMap(option => option.options || [option]).flatMap(option =>
        typeof option.value === 'string' ? [{ id: option.value, label: option.name || option.value }] : []);
      const available = configured.length ? configured : (info.models?.availableModels ?? []).map(item =>
        ({ id: item.modelId, label: item.name || item.modelId }));
      setChoices(Array.from(new Map(available.map(item => [item.id, item])).values()));
      if (!available.length) setNotice('Agent 未公布可选模型，可填写模型 ID。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '读取模型失败');
    } finally {
      setLoading(false);
    }
  };
  return <details className="composer-picker pp-model-picker composer-external-model">
    <summary className="pp-model" aria-label="选择对话模型" aria-disabled={busy}
      onClick={event => { if (busy) event.preventDefault(); }}>
      <span className="model-picker-label">{choices.find(item => item.id === model)?.label || model || followLabel}</span>
      <span className="composer-chevron" aria-hidden="true" />
    </summary>
    <div className="composer-menu">
      {canList && <button type="button" disabled={busy || loading} onClick={() => void loadModels()}>
        {loading ? '正在读取模型…' : '读取可选模型'}
      </button>}
      {choices.map(item => <button key={item.id} type="button" disabled={busy} aria-current={item.id === model ? 'true' : undefined}
        className={item.id === model ? 'composer-current' : undefined} onClick={event => {
          onChange(item.id);
          event.currentTarget.closest('details')?.removeAttribute('open');
        }}>
        <span>{item.label}</span>{item.id === model && <span aria-hidden="true">✓</span>}
      </button>)}
      {notice && <p role="status">{notice}</p>}
      <form className="composer-menu-actions" onSubmit={event => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get('model') || '').trim();
        if (value && !busy) {
          onChange(value);
          event.currentTarget.closest('details')?.removeAttribute('open');
        }
      }}>
        <label>Agent 模型 ID<input name="model" key={model} disabled={busy} maxLength={200} required defaultValue={model} /></label>
        <button type="submit" disabled={busy}>使用此模型</button>
      </form>
    </div>
  </details>;
}
