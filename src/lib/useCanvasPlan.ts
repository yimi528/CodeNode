import { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore, type PlanItem } from '../store/sessionStore';

export function useCanvasPlan() {
  const root = useProjectStore((s) => s.root);
  const sessionId = useSessionStore((s) => s.activeId);
  const plan = useSessionStore((s) => s.activeId === s.activePlanSessionId ? s.plan : null);
  const runId = useSessionStore((s) => s.planRunId);
  const streaming = useSessionStore((s) => s.streaming);
  const hasCachedPlan = useSessionStore((s) => !!(s.activeId && s.plansBySessionId[s.activeId]));

  useEffect(() => {
    if (!root || !sessionId || hasCachedPlan || streaming || !window.codenode?.agentReadPlan) return;
    let live = true;
    window.codenode.agentReadPlan(root, sessionId).then((result) => {
      const store = useSessionStore.getState();
      if (!live || store.streaming || store.activeId !== sessionId ||
          useProjectStore.getState().root !== root || store.plansBySessionId[sessionId] || !result.ok || !result.plan) return;
      const snapshot = result.plan;
      store.setPlanForSession(sessionId, {
        items: snapshot.items.map((item, index) => ({
          id: String(item.id || 'step-' + (index + 1)),
          step: String(item.step || ''),
          acceptanceCriteria: String(item.acceptanceCriteria || ''),
          status: (['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(item.status) ? item.status : 'pending') as PlanItem['status'],
          evidenceCallIds: Array.isArray(item.evidenceCallIds) ? item.evidenceCallIds : [],
          reason: item.reason,
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
          ownerTaskId: item.ownerTaskId,
        })),
        updatedAt: snapshot.updatedAt || null,
        runId: snapshot.runId || null,
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [root, sessionId, hasCachedPlan, streaming]);

  return { plan, sourceId: sessionId ? `${sessionId}:${runId || 'current'}` : null };
}
