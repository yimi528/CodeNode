import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode } from '../../types';
import { CanvasIcon } from '../CanvasIcons';

const modes = [
  ['request', '请求批准', 'hand'],
  ['assist', '帮我批准', 'terminal'],
  ['full', '完全访问权限', 'shield'],
  ['custom', '自定义', 'properties'],
] as const;

export default function ApprovalPicker({ mode, disabled, builtin, policyLocked, protocolApprovals, onChange }: {
  mode: ApprovalMode;
  disabled: boolean;
  builtin: boolean;
  policyLocked: boolean;
  protocolApprovals: boolean;
  onChange: (mode: ApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = modes.find(([id]) => id === mode) || modes[3];
  const fullUnavailable = builtin || policyLocked;
  const descriptions: Record<ApprovalMode, string> = {
    request: builtin ? '项目写入、联网工具和高风险操作先询问。' : 'Agent 请求操作授权时询问。',
    assist: builtin ? '自动批准常规编辑，高风险操作询问。' : '常规项目文本写入自动批准，其他授权请求询问。',
    full: builtin ? '内置工具限定项目范围。' : policyLocked ? '项目要求文件系统隔离。' : '本次运行允许外部 Agent 访问本机文件和网络。',
    custom: '使用当前项目和 Agent 的权限配置。',
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    host.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={host} className="approval-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'));
      const next = items.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (next + items.length) % items.length]?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="composer-permission" aria-label="执行权限" aria-haspopup="menu"
      aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
      <CanvasIcon name={selected[2]} /><span>{selected[1]}</span>
    </button>
    {open && <div className="approval-menu" role="menu" aria-label="操作审批方式">
      <div className="approval-heading">如何批准 Agent 操作？</div>
      {modes.map(([id, label, icon]) => {
        const noProtocol = !protocolApprovals && (id === 'request' || id === 'assist');
        return <button type="button" key={id} role="menuitemradio" data-mode={id} aria-checked={mode === id}
          disabled={noProtocol || (id === 'full' && fullUnavailable)}
          onClick={() => { onChange(id); setOpen(false); trigger.current?.focus(); }}>
          <CanvasIcon name={icon} /><span><strong>{label}</strong><small>{noProtocol ? '当前 Agent 不支持协议审批。' : descriptions[id]}</small></span>
          {mode === id && <span aria-hidden="true">✓</span>}
        </button>;
      })}
    </div>}
  </div>;
}
