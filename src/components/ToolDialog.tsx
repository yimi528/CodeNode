import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useToolStore } from '../store/toolStore';

export default function ToolDialog({ host }: { host?: HTMLElement | null } = {}) {
  const current = useToolStore((s) => s.current);
  const respond = useToolStore((s) => s.respond);
  const [draft, setDraft] = useState({ id: '', text: '' });
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestId = current?.id;

  useLayoutEffect(() => {
    if (!requestId) return;
    const card = dialogRef.current;
    if (!card) return;
    const previous = document.activeElement as HTMLElement | null;
    (card.querySelector<HTMLElement>('.tool-dialog-btn.cancel, .tool-dialog-opt, .tool-dialog-input') || card).focus();
    return () => {
      if (card.contains(document.activeElement) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [host, requestId]);

  if (!current) return null;

  const titleId = `tool-dialog-${current.id}-title`;
  const descId = `tool-dialog-${current.id}-what`;
  const actionsId = `tool-dialog-${current.id}-actions`;
  const confirm = current.type === 'confirm' ? current : null;
  const ask = current.type === 'ask' ? current : null;
  const text = draft.id === current.id ? draft.text : '';
  const answer = text.trim();
  const cancel = () => respond(current.id, closeResult(current));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  const card = (
    <div
      className={host ? 'tool-dialog' : 'tool-dialog tool-dialog-floating'}
      ref={dialogRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="tool-dialog-title" id={titleId}>{confirm ? 'Agent 请求确认' : 'Agent 向你提问'}</div>
      <div className="tool-dialog-content">
        <div className="tool-dialog-what" id={descId}>{confirm?.what ?? ask?.question}</div>
        {confirm && <>
          {confirm.detail && <div className="tool-dialog-detail">{confirm.detail}</div>}
          <div className={`tool-dialog-level lv-${(confirm.level || 'write').toLowerCase()}`}>
            级别：{confirm.level === 'HIGH' ? '高风险（需确认）' : confirm.level === 'WRITE' ? '写入/修改（默认放行）' : '低风险'}
          </div>
          {!!confirm.rememberActions?.length && <div id={actionsId} className="tool-dialog-detail">授权动作：{confirm.rememberActions.join('、')}</div>}
        </>}
        {!!ask?.options?.length && <div className="tool-dialog-options">
          {ask.options.map((option, index) => (
            <button type="button" key={index} className="tool-dialog-opt" onClick={() => respond(current.id, { answer: option })}>{option}</button>
          ))}
        </div>}
      </div>
      {ask && <input
        className="tool-dialog-input"
        value={text}
        placeholder={ask.options?.length ? '或输入自由回答…' : '输入回答…'}
        aria-label="自由回答"
        onChange={(event) => setDraft({ id: current.id, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && answer && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            respond(current.id, { answer });
          }
        }}
      />}
      <div className="tool-dialog-actions">
        <button type="button" className="tool-dialog-btn cancel" onClick={cancel}>取消</button>
        {!!confirm?.rememberActions?.length && <button
          type="button"
          className="tool-dialog-btn always"
          aria-describedby={actionsId}
          title="记住本项目中所列动作在当前能力和审批级别下的授权"
          onClick={() => respond(current.id, { ok: true, always: 'project' })}
        >本项目始终允许</button>}
        {confirm ? <button type="button" className="tool-dialog-btn allow" onClick={() => respond(current.id, { ok: true })}>允许</button>
          : <button type="button" className="tool-dialog-btn allow" disabled={!answer} onClick={() => respond(current.id, { answer })}>发送</button>}
      </div>
    </div>
  );
  return host ? createPortal(card, host) : card;
}

export function closeResult(current: { type: string }): { ok: false } | { answer: string } {
  return current.type === 'confirm' ? { ok: false } : { answer: '' };
}
