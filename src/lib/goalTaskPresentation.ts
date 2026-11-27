import type { GoalItem } from '../store/goalControlStore';
export function goalTaskPresentation(goal: GoalItem, task: GoalItem['tasks'][number]) {
  const upstream = goal.tasks.filter(item => (task.dependsOn || []).includes(item.id));
  const decisions = goal.decisions.filter(item => item.status === 'open' && (!(item.taskIds || []).length || item.taskIds.includes(task.id)));
  const evidence = goal.evidence.filter(item => item.taskId === task.id);
  const valid = evidence.filter(item => item.status === 'passed' && item.freshness?.valid === true).length;
  const pending = upstream.filter(item => item.status !== 'completed');
  const reason = task.executionStatus === 'unknown' ? '上次运行结果未知，需先复核' : decisions.length ? `等待 ${decisions.length} 项业务决定` : pending.length ? `等待上游：${pending.map(item => item.title).join('、')}` : task.status === 'waiting' ? task.waitCondition?.description || '等待条件满足' : task.status === 'blocked' ? '阶段未通过验收，请查看运行与证据' : '';
  return { upstream, decisions, evidence, valid, reason, evidenceLabel: evidence.length ? `${valid}/${evidence.length} 项有效验收` : '暂无独立验收' };
}
