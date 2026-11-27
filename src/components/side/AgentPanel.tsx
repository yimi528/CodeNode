import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AgentPanelOptions.css';
import BranchPanel from '../BranchPanel';
import TaskAcceptanceOptions from './TaskAcceptanceOptions';
import { buildAcceptance, emptyAcceptanceDraft } from '../../lib/taskAcceptance';
import ConversationTaskLink from '../ConversationTaskLink';
import { useProjectStore } from '../../store/projectStore';
import { projectNameOf, readRecentProjects, sameRecentProject } from '../../lib/recentProjects';
import { newProject, openProject, openProjectFile, openRecentProject } from '../../lib/projectActions';
import { useChatStore } from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useUsageStore } from '../../store/usageStore';
import { useSending } from '../../lib/useSending';
import { formatResumePlanNotice, summarizeResumePlan } from '../../lib/resumePlan';
import { reportError } from '../../lib/reportError';
import type { AgentAttachment, AgentBackendSettings, ComposerOverrides } from '../../types';
import backendConfig from '../../../config/agent.backends.json';
import {useBackendSwitchStore} from '../../store/backendSwitchStore';
import { ALLOWED_IMAGE_MIME, MAX_ATTACHMENTS_PER_MESSAGE, TEXT_FILE_ACCEPT, fileToAttachment, fileToResourceAttachment, filesFromDataTransfer, fmtBytes, imagesFromDataTransfer, readAsDataUrl } from '../../lib/imageAttach';
import { MessageViewMemo } from './MessageList';
import ResumePlanNotice from './ResumePlanNotice';
import HoverPopover from './HoverPopover';
import ModelPicker from './ModelPicker';
import ModelConnectionControl from './ModelConnectionControl';
import { agentLabel } from '../../lib/agentLabel';
import ApprovalPicker from './ApprovalPicker';
import ExternalModelPicker from './ExternalModelPicker';
import { CanvasIcon } from '../CanvasIcons';
import './PromptComposer.css';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtMoney(n: number): string {
  return n >= 0.01 ? '$' + n.toFixed(3) : '$' + n.toFixed(4);
}

/** 单个小饼图：上下文已使用比例 */
function ContextDonut({ ratio, size = 20 }: { ratio: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, ratio));
  const color = pct > 0.85 ? '#ef4444' : pct > 0.65 ? '#f59e0b' : '#22c55e';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pb-donut">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${pct * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * 用量仪表（饼图 + 成本/预算弹层）：挂在 Agent 面板头部的状态行里。
 * 不放输入区——侧栏窄，弹层会盖住输入框（这是之前「对话区像消失」的元凶）。
 */
function UsageMeter() {
  const models = useUsageStore((s) => s.models);
  const modelId = useUsageStore((s) => s.modelId);
  const budget = useUsageStore((s) => s.budget);
  const summary = useUsageStore((s) => s.summary);
  const lastUsage = useUsageStore((s) => s.lastUsage);
  const setBudget = useUsageStore((s) => s.setBudget);

  const model = models.find((m) => m.id === modelId) || models[0] || null;
  const ctxUsed = lastUsage ? lastUsage.promptTokens : 0;
  const contextRatio = model ? ctxUsed / model.contextWindow : 0;
  const budgetRatio = budget > 0 ? summary.cost / budget : 0;
  const ctxPct = Math.round(Math.min(1, contextRatio) * 100);

  return (
    <HoverPopover
      className="ap-usage-pop"
      anchorClassName="ap-usage-anchor"
      width={236}
      height={172}
      content={
        <>
          <div className="pb-usage-pop-title">
            {model ? model.label : '未配置模型'}
            <span className="pb-usage-pop-sub">{model ? '上下文 ' + fmtTokens(model.contextWindow) : ''}</span>
          </div>
          <div className="pb-metric-row">
            <span>上下文</span>
            <span>
              {fmtTokens(ctxUsed)} / {model ? fmtTokens(model.contextWindow) : '-'} · {ctxPct}%
            </span>
          </div>
          <div className="pb-metric-row">
            <span>Token</span>
            <span>
              入 {fmtTokens(summary.promptTokens)} · 出 {fmtTokens(summary.completionTokens)}
            </span>
          </div>
          <div className="pb-usage-pop-sep" />
          <div className="pb-metric-row">
            <span>成本</span>
            <span>{fmtMoney(summary.cost)}{summary.costUnknown ? ' + 未知外部费用' : ''}</span>
          </div>
          <div className="pb-metric-row">
            <span>预算</span>
            <input
              className="pb-budget-input"
              type="number"
              min="0.01"
              step="0.5"
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </div>
          <div className="pb-budget-bar">
            <div className="pb-budget-fill" style={{ width: Math.min(100, budgetRatio * 100) + '%' }} />
          </div>
        </>
      }
    >
      <span className="pb-usage ap-usage" title="悬停查看上下文 / Token / 成本 / 预算">
        <ContextDonut ratio={contextRatio} />
      </span>
    </HoverPopover>
  );
}

/**
 * 对话面板底部的输入区。
 */
function PromptComposer({ optionsHost, requestHostRef }: { optionsHost?: HTMLElement | null; requestHostRef?: React.Ref<HTMLDivElement> }) {
  const [acceptanceDraft,setAcceptanceDraft] = useState(emptyAcceptanceDraft);
  const [acceptanceError,setAcceptanceError] = useState('');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const projectRoot = useProjectStore(s => s.root);
  const projectFile = useProjectStore(s => s.projectFile);
  const [projectChanging, setProjectChanging] = useState(false);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (acceptanceError && optionsRef.current) optionsRef.current.open = true; }, [acceptanceError]);
  const activeSessionId = useSessionStore(s=>s.activeId);
  const conversationId=useSessionStore(s=>s.memoryConversationId);
  const scope = JSON.stringify([projectRoot, projectFile, conversationId]);
  const [agentSettings, setAgentSettings] = useState<{
    scope: string;
    backend?: AgentBackendSettings;
    fullAccessLocked?: boolean;
  }>();
  const settings = agentSettings?.scope === scope ? agentSettings : undefined;
  const externalBackend = settings?.backend?.backend || 'builtin';
  const followLabel = `跟随 ${agentLabel(externalBackend)}`;
  const [choices, setChoices] = useState<{ scope: string; backend: string; values: ComposerOverrides }>();
  const overrides = choices?.scope === scope && choices.backend === externalBackend ? choices.values : undefined;
  const choose = (values: ComposerOverrides) => setChoices({ scope, backend: externalBackend, values: { ...overrides, ...values } });
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.codenode?.agentConfig(projectRoot,activeSessionId,conversationId).then(config => {
        if (alive) setAgentSettings({ scope, backend: config.backend?.sessionSettings || config.backend?.settings, fullAccessLocked: config.fullAccessLocked });
      }).catch(() => { if (alive) setAgentSettings(undefined); });
    };
    refresh(); window.addEventListener('codenode-backend-settings', refresh);
    return () => { alive = false; window.removeEventListener('codenode-backend-settings', refresh); };
  }, [projectRoot, activeSessionId, conversationId, scope]);
  useEffect(()=>{setAcceptanceDraft(emptyAcceptanceDraft());setAcceptanceError('');},[projectRoot,activeSessionId]);
  const draftRevision = useSessionStore(s => s.draftRevision);
  useEffect(() => { setText(''); setAttachments([]); if (draftRevision) window.setTimeout(() => taRef.current?.focus(), 0); }, [draftRevision]);
  useEffect(() => {
    const closePicker = (event: Event) => {
      if ((event.target as HTMLElement)?.closest?.('.agent-switch-layer,.branches-mask')) return;
      document.querySelectorAll<HTMLDetailsElement>('.composer-picker[open],.conversation-options[open]').forEach(picker => {
        if (event instanceof KeyboardEvent) {
          if (event.key !== 'Escape') return;
          if (picker.contains(document.activeElement)) picker.querySelector('summary')?.focus();
          picker.open = false;
        } else if (!picker.contains(event.target as Node)) {
          picker.open = false;
        }
      });
    };
    document.addEventListener('pointerdown', closePicker); document.addEventListener('keydown', closePicker);
    return () => { document.removeEventListener('pointerdown', closePicker); document.removeEventListener('keydown', closePicker); };
  }, []);
  const [dragOver, setDragOver] = useState(false);
  // #7：`sending` 是派生值（inflight.size() > 0），不再是可被并发覆盖的单值全局标志
  const sending = useSending();
  const streaming = useSessionStore((s) => s.streaming);
  const models = useUsageStore((s) => s.models);
  const modelId = useUsageStore((s) => s.modelId);
  const loadModels = useUsageStore((s) => s.loadModels);
  const backendSwitching=useBackendSwitchStore(s=>s.switching);
  const busy = sending || streaming || backendSwitching;
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const reference = (event: Event) => {
      const nodeText = (event as CustomEvent<string>).detail;
      setText(draft => draft ? draft + '\n' + nodeText : nodeText);
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener('codenode-reference-node', reference);
    return () => window.removeEventListener('codenode-reference-node', reference);
  }, []);
  const composing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // §4.2：运行中插话（steering）—— 长任务跑偏时不用整停，这句话会在下一轮进请求体
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const steer = async () => {
    const value = steerText.trim();
    if (!value) return;
    setSteering(true);
    try {
      const result = await useChatStore.getState().steer(value);
      if (result?.accepted) {
        setSteerText('');
        useUiStore.getState().setToast('已插话：下一轮生效');
      } else {
        // 没插上就直说（不静默）——运行可能刚好结束
        useUiStore.getState().setToast(String(result?.error || '插话未生效'));
      }
    } catch (error) {
      reportError('插话失败', error, (message) => useUiStore.getState().setToast(message));
    } finally {
      setSteering(false);
    }
  };

  const model = models.find((m) => m.id === modelId) || models[0] || null;
  const isAcp = backendConfig.acpBackends.includes(externalBackend);
  const isMsp = (backendConfig.mspBackends as readonly string[]).includes(externalBackend);
  const canVision = (isAcp || isMsp || externalBackend === 'builtin' && model?.vision === true);
  const project = { root: projectRoot || '', file: projectFile || undefined };
  const projectName = projectRoot ? projectNameOf(projectFile || projectRoot).replace(/\.cnode$/i, '') : '选择项目';
  const selectProject = async (event: React.MouseEvent<HTMLButtonElement>, open: () => Promise<boolean>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    if (busy || projectChanging) return;
    setProjectChanging(true);
    try {
      if (await open()) {
        const current = useProjectStore.getState();
        if (!sameRecentProject(project, { root: current.root || '', file: current.projectFile || undefined })) {
          useSessionStore.getState().newConversation({ preserveDraft: true });
        }
        requestAnimationFrame(() => taRef.current?.focus());
      }
    } finally {
      setProjectChanging(false);
    }
  };
  const dictate = async () => {
    taRef.current?.focus();
    try {
      const result = await window.codenode?.startDictation();
      if (!result?.ok) useUiStore.getState().setToast(result?.error || '请使用系统语音输入工具');
    } catch (error) {
      reportError('无法启动语音输入', error, message => useUiStore.getState().setToast(message));
    }
  };

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    if (room <= 0) {
      useUiStore.getState().setToast(`一次最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
      return;
    }
    const picked = files.slice(0, room);
    const next: AgentAttachment[] = [];
    for (const f of picked) {
      if (f.type.startsWith('image/')) {
        if (!canVision) {
          useUiStore.getState().setToast(`当前模型「${model?.label || '未配置'}」未开启视觉能力，不能添加图片`);
          continue;
        }
        const result = await fileToAttachment(f);
        if (!result.ok) { useUiStore.getState().setToast(result.error); continue; }
        next.push(result.attachment);
        continue;
      }
      if (!f.type.startsWith('image/')) {
        if (isMsp) { useUiStore.getState().setToast('Muse Code 当前只接收内联图片附件'); continue; }
        if (isAcp) {
          if (f.size > backendConfig.acpLimits.contentBytes / 2) { useUiStore.getState().setToast('附件超过 ACP 内容上限'); continue; }
          const dataUrl = await readAsDataUrl(f);
          next.push({ name: f.name, mime: f.type || 'application/octet-stream', bytes: f.size, dataUrl }); continue;
        }
      }
      const result = await fileToResourceAttachment(f);
      if (!result.ok) {
        useUiStore.getState().setToast(result.error);
        continue;
      }
      next.push(result.attachment);
    }
    if (next.length) {
      setAttachments((cur) => [...cur, ...next].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      const total = next.reduce((n, a) => n + (a.bytes || 0), 0);
      useUiStore.getState().setToast(`已添加 ${next.length} 个附件（${fmtBytes(total)}）`);
    }
  };

  const send = async () => {
    if (composing.current || projectChanging) return;
    const prompt = text.trim();
    if ((!prompt && !attachments.length) || busy) return;
    if (!projectRoot) {
      useUiStore.getState().setToast('请先选择对话项目');
      return;
    }
    let acceptance;
    try { acceptance=buildAcceptance(acceptanceDraft);setAcceptanceError(''); } catch(e) { const message = e instanceof Error ? e.message : String(e); setAcceptanceError(message); useUiStore.getState().setToast(message); return; }
    const toSend = attachments;
    setText('');
    setAttachments([]);
    if (taRef.current) taRef.current.style.height = 'auto';
    const res = await useChatStore.getState().send(prompt, { attachments: toSend, acceptance, composerOverrides: overrides });
    const msgs = useSessionStore.getState().messages;
    const last = msgs[msgs.length - 1];
    const aborted = last && last.role === 'assistant' && last.status === 'stopped';
    if (!res.reply && !res.tools.length && !aborted) {
      useUiStore.getState().setToast('Agent 未返回内容，请重试');
    }
  };

  return (
    <>
      <ConversationTaskLink />
      {optionsHost && createPortal(<details ref={optionsRef} className="conversation-options" open={acceptanceError ? true : undefined}>
        <summary>对话选项</summary>
        <div className="conversation-options-menu">
          <div className="conversation-options-actions"><BranchPanel /></div>
          <TaskAcceptanceOptions value={acceptanceDraft} onChange={value=>{setAcceptanceDraft(value);setAcceptanceError('');}} disabled={busy} error={acceptanceError}/>
        </div>
      </details>, optionsHost)}
    <div className="composer-dock">
      <div className="composer-context">
        <details className="composer-picker composer-project">
          <summary aria-label="选择对话项目" title={projectFile || projectRoot || '选择项目'}
            aria-disabled={busy || projectChanging} onClick={event => {
              if (busy || projectChanging) event.preventDefault();
            }}>
            <CanvasIcon name="folder" /><span>{projectName}</span><span aria-hidden="true" className="composer-chevron" />
          </summary>
          <div className="composer-menu">
            {projectRoot && <button type="button" className="composer-current" aria-current="true" onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}>
              <span>{projectName}</span><span aria-hidden="true">✓</span>
            </button>}
            {readRecentProjects().filter(entry => !sameRecentProject(entry, project)).map(entry => (
              <button key={entry.file || entry.root} type="button" title={entry.file || entry.root}
                onClick={event => void selectProject(event, () => openRecentProject(entry))}>
                <span>{entry.name.replace(/\.cnode$/i, '')}</span>
              </button>
            ))}
            <div className="composer-menu-actions">
              <button type="button" onClick={event => void selectProject(event, newProject)}>新增项目…</button>
              <button type="button" onClick={event => void selectProject(event, openProject)}>打开项目文件夹…</button>
              <button type="button" onClick={event => void selectProject(event, openProjectFile)}>打开工程文件…</button>
            </div>
          </div>
        </details>
      </div>
      {requestHostRef && <div className="tool-dialog-slot" ref={requestHostRef} />}
      <div
        className={`pp-composer${dragOver ? ' is-dragover' : ''}`}
        onDragOver={(e) => {
          const hasFile = Array.from(e.dataTransfer?.items || []).some((it) => it.kind === 'file');
          if (!hasFile) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          const files = filesFromDataTransfer(e.dataTransfer);
          if (!files.length) return;
          e.preventDefault();
          setDragOver(false);
          void addFiles(files);
        }}
      >

        {attachments.length > 0 && (
          <div className="pp-attach-list">
            {attachments.map((a, i) => (
              <div className="pp-attach" key={i} title={`${a.name || '附件'}（${fmtBytes(a.bytes || 0)}）`}>
                {a.mime.startsWith('image/') ? <img src={a.dataUrl} alt={a.name || '附件'} /> : <span>{a.name || '附件'}</span>}
                <button
                  className="pp-attach-del"
                  title="移除附件"
                  onClick={() => setAttachments((cur) => cur.filter((_, idx) => idx !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          className="pp-input"
          aria-label="输入 Prompt"
          value={text}
          rows={1}
          disabled={busy || projectChanging}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onChange={(e) => {
            setText(e.target.value);
            const el = taRef.current;
            if (el) {
              el.style.height = 'auto';
              el.style.height = Math.min(110, el.scrollHeight) + 'px';
            }
          }}
          onPaste={(e) => {
            const files = imagesFromDataTransfer(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current || e.nativeEvent.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />

        <div className="pp-controls">
          <input
            ref={fileRef}
            type="file"
            accept={isAcp ? [...ALLOWED_IMAGE_MIME, 'audio/*', 'text/*', 'application/pdf', TEXT_FILE_ACCEPT].join(',') : isMsp ? ALLOWED_IMAGE_MIME.join(',') : [...ALLOWED_IMAGE_MIME, TEXT_FILE_ACCEPT].join(',')}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              void addFiles(files);
            }}
          />
          <button
            className="pp-attach-btn"
            aria-label="添加附件"
            disabled={busy || projectChanging}
            title={canVision ? '添加文件或图片' : '添加文本或代码文件；当前模型不支持图片'}
            onClick={() => {
              fileRef.current?.click();
            }}
          >
            <CanvasIcon name="plus" />
          </button>
          <ApprovalPicker key={`approval:${scope}:${externalBackend}`} mode={overrides?.approvalMode ?? 'custom'}
            disabled={!settings || busy || projectChanging} builtin={externalBackend === 'builtin'}
            policyLocked={!!settings?.fullAccessLocked}
            protocolApprovals={(backendConfig.permissionEnforcement as Record<string, string>)[externalBackend] !== 'unavailable'}
            onChange={approvalMode => choose({ approvalMode })} />
          <ModelConnectionControl key={`${scope}:${externalBackend}`} backend={settings?.backend?.backend || 'builtin'}
            busy={busy || projectChanging || !settings}
            label={externalBackend === 'builtin' ? model?.label || '配置模型' : overrides?.externalModel || settings?.backend?.model || followLabel}>
            {externalBackend === 'builtin' ? <ModelPicker busy={busy || projectChanging} /> :
              settings?.backend && <ExternalModelPicker followLabel={followLabel} key={`${scope}:${externalBackend}`} settings={settings.backend} root={projectRoot}
                model={overrides?.externalModel ?? settings.backend.model} busy={busy || projectChanging} canList={isAcp}
                onChange={value => choose({ externalModel: value })} />}
          </ModelConnectionControl>
          <button type="button" className="composer-voice" aria-label="语音输入" title="语音输入"
            disabled={busy || projectChanging} onClick={() => void dictate()}>
            <CanvasIcon name="microphone" />
          </button>

          {busy ? (
            <>
            <button className="pp-send pp-stop" onClick={() => useChatStore.getState().stop()} aria-label="停止生成" title="停止生成">■</button>
            <div className="pp-steer" title="运行中插话：这句话会在下一轮送进模型，不中断当前运行">
              <input
                className="pp-steer-input"
                value={steerText}
                placeholder="插话纠偏…（如：别改 utils，只改 api 层）"
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void steer();
                  }
                }}
                disabled={steering}
                data-testid="pp-steer-input"
              />
              <button className="pp-steer-send" onClick={() => void steer()} disabled={steering || !steerText.trim()} data-testid="pp-steer-send">
                插话
              </button>

            </div>
            </>
          ) : (
            <button
              className="pp-send"
              onClick={() => void send()}
              disabled={!projectRoot || (!text.trim() && !attachments.length) || busy || projectChanging}
              aria-label="发送 Prompt"
              title={projectRoot ? '发送 (Enter)' : '请先选择对话项目'}
            >
              <CanvasIcon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

/** 主工作区对话：记录滚动，输入框固定在底部。 */
export default function AgentPanel({ optionsHost, requestHostRef }: { optionsHost?: HTMLElement | null; requestHostRef?: React.Ref<HTMLDivElement> } = {}) {
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const streamingMessage = streaming ? messages.map((message) => message.role).lastIndexOf('assistant') : -1;
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const countRef = useRef(messages.length);
  const automaticTop = useRef<number | null>(null);
  const scrollBottom = () => { const element = bodyRef.current; if (element) { element.scrollTop = element.scrollHeight; automaticTop.current = element.scrollTop; } };
  // 新消息 / 流式增量时保持贴底
  useEffect(() => {
    const el = bodyRef.current;
    if (messages.length > countRef.current && messages.some((message, index) => index >= countRef.current && message.role === 'user')) followRef.current = true;
    countRef.current = messages.length;
    if (el && followRef.current) scrollBottom();
  }, [messages, streaming]);
  useEffect(() => {
    const element = bodyRef.current;
    const latest = element?.lastElementChild;
    if (!element || !latest || typeof ResizeObserver === 'undefined') return;
    const scroll = () => {
      if (automaticTop.current !== null && Math.abs(element.scrollTop - automaticTop.current) < 1) return;
      automaticTop.current = null;
      followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    const observer = new ResizeObserver(() => { if (followRef.current) scrollBottom(); });
    observer.observe(latest); element.addEventListener('scroll', scroll);
    return () => { observer.disconnect(); element.removeEventListener('scroll', scroll); };
  }, [messages.length, active?.id]);
  useEffect(() => { followRef.current = true; scrollBottom(); }, [active?.id]);

  return (
    <div className="sp-pane sp-pane-agent">
      <div className="ap-head">
        <div className="ap-head-top">
          <span className="ap-session" title={active ? active.id : ''}>
            <span className={`cs-dot ${streaming ? 'cs-dot-running' : ''}`} />
            {active ? active.label : '未选择会话'}
          </span>
          <span className={`chat-win-status ${streaming ? 'st-running' : 'st-done'}`}>
            {streaming ? '思考中…' : '就绪'}
          </span>
        </div>
        <div className="ap-head-meta">
          <UsageMeter />
        </div>
      </div>

      {streaming && <div className="agent-run-status" role="status">正在回复…</div>}

{/* #25(b)：流式正文 / 「思考中」 / 已停止 / 失败原因都发生在这里，必须是 live region，
          否则键盘/读屏用户完全得不到「正在生成 / 已中断」的播报。 */}
      <div
        className="ap-body"
        ref={bodyRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Agent 对话记录"
      >

        {messages.map((m, i) => (
          <MessageViewMemo key={`${active?.id || 'session'}:${i}`} msg={m} isLatest={i === messages.length - 1} isStreaming={i === streamingMessage} />
        ))}
      </div>

      <ResumePlanNotice />
      <PromptComposer optionsHost={optionsHost} requestHostRef={requestHostRef} />
    </div>
  );
}
