import {useBackendSwitchStore} from './backendSwitchStore';
import { create } from 'zustand';
import { useProjectStore } from './projectStore';
import { useGraphStore } from './graphStore';
import { useUiStore } from './uiStore';
import { detachSession, mergeDetachedSession, useSessionStore } from './sessionStore';
import { useGoalControlStore } from './goalControlStore';
import { useProjectSaveStore } from './projectSaveStore';
import { useUsageStore, type UsageSnapshot } from './usageStore';
import { createInflightRegistry } from '../lib/inflight';
import { describeFailure } from '../lib/reportError';
import type { ResumePlanLike } from '../lib/resumePlan';
import type { AgentAttachment, ToolRecord } from '../types';
import { addPlanToCanvas } from '../lib/planCanvas';
import { captureProjectSnapshot, persistProjectSnapshot, updateSnapshotSession, type ProjectSnapshot } from '../lib/projectActions';
import { recentPathKey } from '../lib/recentProjects';

/**
 * #7 并发/竞态发送：`inflight` 是**按 requestId 索引的集合**（修复前是单值
 * `sending: boolean` + `requestId: string | null`）。
 *
 * 单值语义下必然发生三件事：① `RunsPanel` 的续跑绕过输入框守卫再发一次，其 `finally`
 * 会把 `requestId` 清成 `null`，旧请求的 controller 从此点不到（停止按钮失效）；
 * ② 全局 `requestId` 错配；③ 两次请求的 delta 都写进「最后一条 assistant」同一气泡。
 *
 * 现在：登记表按 id 存 controller，`sending` 由 `inflight.size() > 0` 派生
 * （见 `useChatStore((s) => s.inflight.size() > 0)`），`finally` 只删自己那一条。
 */
const inflight = createInflightRegistry<AbortController>();
type DetachedSession = NonNullable<ReturnType<typeof detachSession>>;
type ParkedProject = { snapshot: ProjectSnapshot; session: DetachedSession; savedFingerprint: string; pendingSave: boolean };
type ChatOwner = { sessionId: string | null; root: string | null; projectFile: string | null; detached?: DetachedSession; parked?: ParkedProject };
const requestOwners = new Map<string, ChatOwner>();

function ownsProject(owner: ChatOwner): boolean {
  const view = useProjectStore.getState();
  return view.root === owner.root && view.projectFile === owner.projectFile;
}

export function ownsActiveView(id: string): boolean {
  const owner = requestOwners.get(id);
  if (!owner || owner.detached || useSessionStore.getState().activeId !== owner.sessionId) return false;
  const view = useProjectStore.getState();
  return ownsProject(owner) || (!owner.projectFile && view.root === owner.root && !view.loading);
}

function sessionForRequest(id: string) {
  return requestOwners.get(id)?.detached?.getState() ?? (ownsActiveView(id) ? useSessionStore.getState() : null);
}

function detachVisibleRequest() {
  const id = inflight.ids().find(ownsActiveView);
  if (!id) return;
  const owner = requestOwners.get(id)!;
  const detached = detachSession();
  if (!detached || !owner.sessionId) return;
  owner.detached = detached;
  owner.projectFile = useProjectStore.getState().projectFile;
  useSessionStore.setState({ streaming: false });
  useChatStore.setState({ backgroundRun: { requestId: id, sessionId: owner.sessionId, projectKey: recentPathKey(owner.projectFile || owner.root || '') } });
}

/** Keep the running chat's project contents while a different project is on screen. */
export function parkChatProject() {
  detachVisibleRequest();
  const owner = inflight.ids().map(id => requestOwners.get(id)).find(candidate => candidate?.detached && ownsProject(candidate));
  if (!owner?.detached) return;
  const snapshot = captureProjectSnapshot();
  const save = useProjectSaveStore.getState();
  owner.parked = {
    snapshot, session: owner.detached, pendingSave: false,
    savedFingerprint: save.key === snapshot.key ? save.savedFingerprint : '',
  };
  publishParkedProject(owner.parked);
}

function publishParkedProject(parked: ParkedProject) {
  const state = parked.session.getState();
  const origin = state.current();
  if (origin) parked.snapshot = updateSnapshotSession(parked.snapshot, origin, state.messages);
  const key = recentPathKey(parked.snapshot.target || '');
  useChatStore.setState(state => ({ parkedProjects: { ...state.parkedProjects, [key]: parked } }));
}

function saveParkedProject(parked: ParkedProject) {
  const { snapshot } = parked;
  const view = useProjectStore.getState();
  // Wait until navigation has left the origin so the normal save queue won't reject its detached result as stale.
  if (!parked.pendingSave || !snapshot.file || (view.root === snapshot.root && view.projectFile === snapshot.file)) return;
  parked.pendingSave = false;
  void persistProjectSnapshot(snapshot, true).then(saved => {
    if (saved) parked.savedFingerprint = snapshot.fingerprint;
    else parked.pendingSave = true;
  });
}

export function restoreVisibleChat() {
  const { projectFile, root } = useProjectStore.getState();
  const key = recentPathKey(projectFile || root || '');
  const parked = useChatStore.getState().parkedProjects[key];
  if (parked) {
    mergeDetachedSession(parked.session.getState());
    if (projectFile) {
      const visible = captureProjectSnapshot();
      useProjectSaveStore.setState({
        key: visible.key, savedFingerprint: parked.savedFingerprint,
        status: visible.fingerprint === parked.savedFingerprint ? 'saved' : 'dirty', error: '',
      });
    }
    const parkedProjects = { ...useChatStore.getState().parkedProjects };
    delete parkedProjects[key];
    useChatStore.setState({ parkedProjects });
  }
  const id = useSessionStore.getState().activeId;
  for (const requestId of inflight.ids()) {
    const owner = requestOwners.get(requestId);
    if (!owner?.detached || !ownsProject(owner)) continue;
    owner.parked = undefined;
    if (owner.sessionId === id) {
      const detached = owner.detached;
      owner.detached = undefined;
      if (detached !== parked?.session) mergeDetachedSession(detached.getState());
      useChatStore.setState({ backgroundRun: null });
    }
  }
  Object.values(useChatStore.getState().parkedProjects).forEach(saveParkedProject);
}

export function openChatSession(id: string) {
  const view = useSessionStore.getState();
  if (!view.sessions[id] || view.sessions[id].archived) return false;
  if (view.activeId !== id) {
    detachVisibleRequest();
    view.switchSession(id);
  }
  restoreVisibleChat();
  return useSessionStore.getState().activeId === id;
}

function settleDetachedRequest(id: string) {
  const owner = requestOwners.get(id);
  if (!owner?.detached) return;
  if (owner.parked) {
    owner.parked.pendingSave = true;
    publishParkedProject(owner.parked);
    saveParkedProject(owner.parked);
  } else if (ownsProject(owner)) {
    mergeDetachedSession(owner.detached.getState());
  }
  if (useChatStore.getState().backgroundRun?.requestId === id) useChatStore.setState({ backgroundRun: null });
}
/** 最近一个「已受理」的 requestId：给「停止当前请求」用（不是全局唯一语义，只影响默认指向） */
let lastRequestId: string | null = null;

/** 输入框 / 续跑按钮共用的忙碌守卫（派生值，不再有单值全局标志可被覆盖） */
export function isSending(): boolean {
  return inflight.isSending();
}

/** 当前在跑请求的 id 列表（界面与测试都从这里取「谁在跑」） */
export function inflightRequestIds(): string[] {
  return inflight.ids();
}

export interface SendGuardInput {
  /** 当前在跑请求数（`inflight.size()`） */
  inflightCount: number;
  hasText: boolean;
  attachmentCount: number;
}

export interface SendGuardVerdict {
  allow: boolean;
  reason?: 'busy' | 'empty';
}

/**
 * `send()` 开头的硬守卫（#7 的判据所在）。
 *
 * 修复前 `send()` **没有任何 `if (get().sending) return`**，谁都能再进来一条；
 * 输入框的 `busy` 只挡得住输入框，挡不住 `RunsPanel` 那条直接调用。
 * 顺序：**busy 优先**（正在跑时就直说正忙），空消息其次 —— 空消息在 `send()` 里由更早的
 * `if (!text && !attachments.length) return` 处理（静默返回，保留老行为）；这里同时保留
 * `empty` 分支是为了让守卫本身可独立断言（否则测试只是在复刻某一处调用点）。
 */
export function checkSendGuard(input: SendGuardInput): SendGuardVerdict {
  if (input.inflightCount > 0) return { allow: false, reason: 'busy' };
  if (!input.hasText && input.attachmentCount === 0) return { allow: false, reason: 'empty' };
  return { allow: true };
}

const GUARD_MESSAGES: Record<string, string> = {
  busy: '已有 Agent 请求在执行中，请先停止或等它结束',
  empty: '没有可发送的内容',
};

interface ChatState {
  /** 在跑请求的登记表（按 requestId 索引）—— `sending` 的派生来源 */
  inflight: ReturnType<typeof createInflightRegistry<AbortController>>;
  backgroundRun: { requestId: string; sessionId: string; projectKey: string } | null;
  parkedProjects: Record<string, ParkedProject>;
  send: (
    prompt: string,
    options?: { resumeRunId?: string; resumeForce?: boolean; attachments?: AgentAttachment[]; projectRoot?: string; goalId?: string; taskId?: string; requestId?: string; autoAdvanceClaimId?: string }
  ) => Promise<{ reply: string; reasoning: string; tools: ToolRecord[] }>;
  /** 停止请求：不传 id 时停「最近一个已受理」的请求；传 id 精确停那一条 */
  stop: (requestId?: string) => void;
  /** 全部停止：并发下必须有一个能一次停干净所有 in-flight 的出口 */
  stopAll: () => string[];
  /**
   * §4.2 运行中插话（steering）：把一句话插进正在跑的 run，下一轮进请求体。
   * 没有在跑的请求 / run 已结束时返回 `accepted:false` + 原因（界面据此如实提示，不静默）。
   */
  steer: (text: string) => Promise<{ accepted: boolean; reason?: string; pending?: number; error?: string }>;
}

/** 把 DeepSeek usage 归一化为本应用结构 */
function normalizeUsage(u: unknown): UsageSnapshot | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, number>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const prompt = num(o.prompt_tokens);
  const hit = num(o.prompt_cache_hit_tokens);
  return {
    promptTokens: prompt,
    completionTokens: num(o.completion_tokens),
    totalTokens: num(o.total_tokens) || prompt + num(o.completion_tokens),
    promptCacheHit: hit,
    promptCacheMiss: num(o.prompt_cache_miss_tokens) || Math.max(0, prompt - hit),
  };
}

/** 从文档生成画布节点摘要（作为 Agent 读取上下文，写入系统提示） */
function summarizeDoc(doc: { nodes?: unknown[] } | null | undefined): string {
  const nodes = (doc && doc.nodes) || [];
  const items = (nodes as { id?: string; type?: string; data?: Record<string, unknown> }[]).map((n) => {
    const d = n.data || {};
    return {
      id: n.id,
      type: n.type,
      label: d.label || '',
      status: d.status || '',
      goal: d.goal || '',
      prompt: d.prompt || '',
    };
  });
  return JSON.stringify(items);
}

export const useChatStore = create<ChatState>((set, get) => ({
  // 登记表本身进 state（界面可直接订阅它做派生值）；实例只创建一次。
  inflight,
  backgroundRun: null,
  parkedProjects: {},

  stop: (requestId) => {
    const api = window.codenode;
    // 不传 id = 停「最近一个已受理」的请求；传 id = 精确停那一条。
    // 无论哪种，都从登记表里**按 id** 摘除并 abort —— 不会再出现「controller 被覆盖后点不到」。
    const rid = requestId || lastRequestId;
    if (!rid || !inflight.has(rid)) return;
    sessionForRequest(rid)?.stopTurn();
    inflight.abort(rid);
    settleDetachedRequest(rid);
    if (lastRequestId === rid) lastRequestId = null;
    if (api && api.stopAgent) {
      const p = api.stopAgent(rid);
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        void (p as Promise<unknown>).catch((e: unknown) => {
          useUiStore.getState().setToast('停止 Agent 失败：' + String(e));
        });
      }
    }
  },

  stopAll: () => {
    for (const id of inflight.ids()) sessionForRequest(id)?.stopTurn();
    const ids = inflight.abortAll();
    lastRequestId = null;
    for (const rid of ids) {
      settleDetachedRequest(rid);
      const p = window.codenode?.stopAgent?.(rid);
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        void (p as Promise<unknown>).catch(() => {});
      }
    }
    return ids;
  },

  steer: async (text) => {
    const target = lastRequestId || inflight.ids()[inflight.ids().length - 1] || null;
    if (!target) return { accepted: false, reason: 'no-active-run', error: '当前没有正在运行的 Agent 请求' };
    const api = window.codenode;
    if (!api?.steerAgent) return { accepted: false, reason: 'unsupported', error: '当前环境不支持插话' };
    try {
      const result = await api.steerAgent(target, text);
      return result || { accepted: false, reason: 'unknown', error: '插话未生效' };
    } catch (error) {
      return { accepted: false, reason: 'failed', error: describeFailure(error) };
    }
  },

  send: async (prompt, options) => {
    const empty = { reply: '', reasoning: '', tools: [] };
    const api = window.codenode;
    if (!api) {
      useUiStore.getState().setToast('需要 Electron 环境');
      return empty;
    }
    if(options?.projectRoot&&useProjectStore.getState().root!==options.projectRoot){useUiStore.getState().setToast('自动推进已取消：当前工程已切换');return empty;}
    if(useBackendSwitchStore.getState().switching){useUiStore.getState().setToast('正在切换 Agent，请稍后发送');return empty;}
    const text = prompt.trim();
    const attachments = options?.attachments ?? [];
    // 允许「只有图片、没有文字」的消息（老行为，保持不变；空消息静默返回）
    if (!text && !attachments.length) {
      return empty;
    }
    // #7 硬守卫：进来就先看「是不是已经有请求在跑」。修复前这里什么都没有，
    // 于是 RunsPanel 的续跑可以直接插进第二个请求（它的 finally 会把旧请求的 requestId 清掉）。
    if (!checkSendGuard({ inflightCount: inflight.size(), hasText: true, attachmentCount: attachments.length }).allow) {
      useUiStore.getState().setToast(GUARD_MESSAGES.busy);
      return empty;
    }

    // Planning commands use the read-only planner. They do not start a normal Agent Run.
    if (/^\/(plan|goal)(?:\s|$)/i.test(text)) {
      const match=text.match(/^\/(plan|goal)(?:\s+([\s\S]*))?$/i);
      const command=match?.[1]?.toLowerCase(),objective=(match?.[2]||'').trim();
      const root=useProjectStore.getState().root;
      if (!root) { useUiStore.getState().setToast('先打开项目，再创建计划或目标'); return empty; }
      if (command==='goal') {
        useGoalControlStore.getState().startDraft(objective);
        useUiStore.getState().updatePreferences({ workbenchView:'overview' });
        return empty;
      }
      if (!objective) { useUiStore.getState().setToast('请在 /plan 后写明要规划的任务'); return empty; }
      if (attachments.length) { useUiStore.getState().setToast('/plan 暂不接受图片附件，请描述规划目标'); return empty; }
      const sessionId=useSessionStore.getState().activeId;
      try {
        useUiStore.getState().setToast('正在生成只读计划…');
        const planned=await api.goalPlanPropose(root,{kind:'plan',objective,modelId:useUsageStore.getState().modelId});
        if (useProjectStore.getState().root!==root || useSessionStore.getState().activeId!==sessionId || inflight.size()>0) {
          useUiStore.getState().setToast('规划期间会话或 Agent 运行状态已变化，未改动画布');
          return empty;
        }
        if (!planned.ok||!planned.value) throw new Error(planned.error||'规划失败');
        if (!useSessionStore.getState().current()) useSessionStore.getState().startOnCurrent(objective);
        const currentSession=useSessionStore.getState().activeId;
        const count=addPlanToCanvas(planned.value.steps,`plan-command:${currentSession||'canvas'}:${Date.now()}`);
        useUiStore.getState().setToast(`已生成 ${count} 个可编辑任务节点；核对内容和连线后可点击运行`);
      } catch (error) { useUiStore.getState().setToast('规划失败：'+String((error as Error).message||error)); }
      return empty;
    }

    // /compact（照 Codex 的手动压缩命令）：命令本身**不当作对话发出去**，只把 forceCompact
    // 传给主进程立刻压一次；命令后面若还跟了正文，就当作本轮的正式指令。
    let forceCompact = false;
    let userText = text;
    if (/^\/compact\b/i.test(text)) {
      forceCompact = true;
      userText = text.replace(/^\/compact\b/i, '').trim() || '（/compact：压缩上下文）';
    }

    const ss = useSessionStore.getState();
    // 指令前已有的对话（作为历史传给 Agent）
    // 被上下文压缩折叠掉的消息**不再发送**（它们的内容已经进了摘要卡）；压缩卡本身按 user 轮
    // 回传 —— 与主进程压缩后的历史形状（[system, ...人的轮次, 摘要]）逐字对齐，避免「刚压完又超线」。
    const prior = ss.messages
      .filter((m) => !m.compacted)
      .map((m) => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content }));
    // 当前画布内容：作为 Agent 的「读取上下文」，保证它能读到已有节点
    const ctx = useGraphStore.getState().getDocument();
    // 确保有当前画布（无会话时创建画布1）
    if (!ss.current()) {
      ss.startOnCurrent(userText);
    }
    const planSessionId = useSessionStore.getState().activeId;
    const memoryConversationId = useSessionStore.getState().memoryConversationId;
    const memoryTaskEpoch = useSessionStore.getState().memoryTaskEpoch;
    const selectedGoal = useGoalControlStore.getState();
    const goalBinding = !options?.resumeRunId && options?.goalId && options?.taskId
      ? { goalId: options.goalId, taskId: options.taskId }
      : !options?.resumeRunId && selectedGoal.selectedGoalId && selectedGoal.selectedTaskId
        ? { goalId: selectedGoal.selectedGoalId, taskId: selectedGoal.selectedTaskId }
        : {};
    const requestId = options?.requestId || 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    useSessionStore.getState().beginPlanRun(planSessionId);
    ss.pushUser(userText, attachments);
    ss.beginTurn(requestId);

    const controller = new AbortController();
    const requestRoot = options?.projectRoot || useProjectStore.getState().root;
    const us = useUsageStore.getState();
    const accepted = inflight.begin(requestId, controller, userText.slice(0, 80));
    if (!accepted) {
      useUiStore.getState().setToast(GUARD_MESSAGES.busy);
      useSessionStore.getState().stopTurn();
      return empty;
    }
    requestOwners.set(requestId, { sessionId: planSessionId, root: requestRoot, projectFile: useProjectStore.getState().projectFile });
    lastRequestId = requestId;
    let unsub: (() => void) | null = null;
    try {
      unsub = api.onAgentDelta ? api.onAgentDelta((d) => {
        if (d.requestId !== requestId || controller.signal.aborted) return;
        const session = sessionForRequest(requestId);
        if (!session) return;
        const visibleSave = d.kind === 'saved' && ownsActiveView(requestId);
        session.streamDelta(d);
        // A confirmed save can assign the first project file without changing request ownership.
        if (visibleSave) {
          const owner = requestOwners.get(requestId);
          if (owner) owner.projectFile = useProjectStore.getState().projectFile;
        }
      }) : null;
      const res = await api.agentChat({
        projectRoot: requestRoot,
        ...goalBinding,
        prompt: userText,
        attachments: attachments.length ? attachments : undefined,
        // /compact：让主进程无视阈值立刻压一次（见上面对命令的解析）
        forceCompact: forceCompact || undefined,
        history: prior,
        canvasSummary: summarizeDoc(ctx),
        nodeId: null,
        requestId,
        autoAdvanceClaimId: options?.autoAdvanceClaimId,
        sessionId: planSessionId || undefined,
        memoryConversationId: memoryConversationId || undefined,
        memoryTaskEpoch,
        modelId: us.modelId || undefined,
        reasoningEffort: us.effort,
        document: { root: ctx },
        projectFile: useProjectStore.getState().projectFile || undefined,
        // 断点续跑：带上原始 Run 与「是否已人工复核」；主进程按续跑计划决定走 auto 还是 review
        resumeRunId: options?.resumeRunId,
        resumeForce: options?.resumeForce === true ? true : undefined,
        // #7：把这一条请求自己的中止信号交出去，`stop(id)` / `stopAll()` 才停得准
        signal: controller.signal,
      });
      const session = sessionForRequest(requestId);
      if (controller.signal.aborted || !session) return empty;
      const visible = ownsActiveView(requestId);
      // 需要人工复核的续跑：主进程拒绝自动执行 —— #21 的关键点是**不能把 plan 丢掉**。
      // 后端回传 `{ok:false, needsReview:true, plan}`，plan 里有 reason / warning /
      // unknownEffects（哪些工具结果不可知）/ pendingSteps（还差哪几步），全部要落到界面上，
      // 否则用户只被告知「需要复核」却不知道复核什么。
      if (!res.ok && (res as { needsReview?: boolean }).needsReview) {
        const plan = (res as { plan?: ResumePlanLike | null }).plan || null;
        useUiStore.getState().setResumePlanNotice(plan, userText, { sessionId: planSessionId, root: requestRoot }, !visible);
        if (!plan && visible) {
          // 后端没带计划也要说清楚（不能因为字段缺失就什么都不显示）
          useUiStore.getState().setToast('该运行存在结果未知的副作用，需要人工复核后才能继续');
        }
        session.stopTurn('needs_review');
        return empty;
      }
      const usage = normalizeUsage(res.usage);
      if (usage) useUsageStore.getState().recordUsage({ ...usage, costUnknown: res.costUnknown === true });

      if (res.aborted) {
        session.failTurn(res.error || 'Agent 运行意外中断');
        return empty;
      }

      // Agent 改图完成：画布是独立系统。
      // 若 Agent 只是对当前画布做修改（保留了画布中已有节点）→ 就地应用到当前画布，不新开画布；
      // 否则（当前画布为空 / Agent 输出了与现有画布完全无关的全新内容）→ 新开一个画布承载新内容。
      let newSessionDocument: Parameters<typeof ss.applyAgentDoc>[0] | undefined;
      if (res.document) {
        const doc = res.document as {
          root?: { nodes?: { id?: string; type?: string }[]; edges?: { source?: string; target?: string }[] };
        };
        if (doc && doc.root) {
          const rawNodes = (doc.root.nodes || []) as { id?: string; type?: string }[];
          const rawEdges = (doc.root.edges || []) as { source?: string; target?: string }[];
          const current = session.getDocument().root;
          const currentIds = new Set(current.nodes.map((n) => n.id));
          // 会话开始时画布存在的 id：用于识别 Agent 运行期间被用户删除的节点（不让它复活）
          const ctxIds = new Set((ctx.nodes || []).map((n) => n.id));
          const deletedDuringRun = [...ctxIds].filter((id) => !currentIds.has(id));
          const cleanNodes = rawNodes.filter(
            (n) =>
              n &&
              n.id &&
              !deletedDuringRun.includes(n.id) &&
              n.type !== 'group' &&
              n.type !== 'group-input' &&
              n.type !== 'group-output'
          );
          const kept = cleanNodes.filter((n) => n.id != null && currentIds.has(n.id));
          const isModification = current.nodes.length > 0 && kept.length > 0;
          const keepIds = new Set(cleanNodes.map((n) => n.id));
          const cleanEdges = rawEdges.filter((e) => keepIds.has(e.source || '') && keepIds.has(e.target || ''));
          const clean = { root: { nodes: cleanNodes, edges: cleanEdges } };
          if (isModification || !visible) {
            // 就地修改当前画布：画布内容 = Agent 在当前画布基础上的完整结果
            session.applyAgentDoc(clean as never);
          } else {
            // 新画布创建时会保存当前会话，等本轮结算后再切换。
            newSessionDocument = clean as never;
          }
        }
      }

      let tools: ToolRecord[] = [];
      const reply = res.reply;
      const reachedLimit = !!(res.limitReached && reply);
      const delivered = reply != null && (res.ok || reachedLimit);
      if (delivered) {
        const rawTools = (res.toolCalls as ToolRecord[] | null) || null;
        tools = (rawTools || []).map((t) => ({ name: t.name || 'tool', args: t.args, result: t.result, ok: t.ok, data: t.data, callId: t.callId, actor: t.actor }));
        const status = reachedLimit ? 'limit_reached' : res.stopReason === 'length_truncated' ? 'truncated' : 'done';
        session.finishTurn(reply, res.reasoning || '', tools, res.grounding, status);
        // 交付形态如实告知：被长度上限截断的回答不是完整答案，别让用户以为写完了
        if (visible && status === 'truncated') {
          useUiStore.getState().setToast('回答触到模型长度上限被截断，可回复「继续」让它接着写完');
        } else if (visible && reachedLimit) {
          useUiStore.getState().setToast('本次运行达到步数上限（任务未完成）：已列出阶段性结果，可在「工作流运行」里续跑');
        }
        // 上下文压缩的兜底路径：正常情况下 compressed 的消息已由 `compacted` 增量折叠好；
        // 增量丢失（例如续跑重放）时，用结果里的信封补一张卡，保证「旧历史不会再被整段重发」。
        if (res.ok && Number(res.compacted) > 0 && res.contextSummaryEnvelope) {
          session.compactHistory({
            envelope: String(res.contextSummaryEnvelope),
            summary: res.contextSummary ? String(res.contextSummary) : undefined,
          });
        }
      } else {
        session.failTurn(res.error || '未知错误');
        if (visible) useUiStore.getState().setToast('Agent 调用失败：' + (res.error || '未知错误'));
      }

      if (newSessionDocument) {
        session.beginWorkSession(userText, delivered ? reply : undefined);
        session.applyAgentDoc(newSessionDocument);
      }
      if (!delivered) return empty;
      // 当前画布仍可继续编辑；会话完成状态记录在本轮消息上。
      session.markActive();
      return { reply, reasoning: res.reasoning || '', tools };
    } catch (e) {
      if (!controller.signal.aborted) {
        sessionForRequest(requestId)?.failTurn(String(e));
        if (ownsActiveView(requestId)) useUiStore.getState().setToast('Agent 调用异常：' + String(e));
      }
      return empty;
    } finally {
      try { if (unsub) unsub(); } catch { /* A disposed IPC listener cannot retain a request lock. */ }
      // #7 只清自己那一条：修复前这里无条件 `set({ sending:false, requestId:null })`，
      // 会把**别人的**在跑请求一起标成空闲（旧请求的 controller 也就此失联）。
      inflight.end(requestId);
      if (!controller.signal.aborted) settleDetachedRequest(requestId);
      requestOwners.delete(requestId);
      if (lastRequestId === requestId) lastRequestId = null;
    }
  },
}));
