import type { TaskAcceptanceReport } from '../../types';
const labels: Record<string, string> = { unconfigured: '未配置任务验收 · 需求尚未验收', not_run: '尚未验收', passed: '显式验收规则通过', failed: '验收未通过', stale: '验收证据已失效', unknown: '无法确认验收结果', cancelled: '验收已取消' };
export default function TaskAcceptanceCard({ report, rolledBack = false }: { report: TaskAcceptanceReport; rolledBack?: boolean }) {
  const status = rolledBack ? 'stale' : report.status === 'passed' && !report.verified ? 'unknown' : report.status;
  return <section className="code-verification" aria-label="任务验收" role="status" data-status={status}>
    <strong>任务验收 · {labels[status]}</strong>
    {(report.reason || rolledBack) && <div>{rolledBack ? '文件已回滚，原验收不代表当前产物。' : report.reason}</div>}
    {report.scope && <div><small>{report.scope}</small></div>}
    {!!report.checks.length && <details><summary>查看显式验收结果</summary>{report.checks.map(check => <div className="code-verification-check" key={`${check.kind}:${check.id}:${check.phase || ""}`}>
      <b>{check.id}{check.phase === 'before' ? ' · 修改前复现' : check.phase === 'after' ? ' · 修改后验收' : ''} · {check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '未确认'}</b>
      {check.path && <div>{check.path}{check.bytes != null ? ` · ${check.bytes} 字节` : ''}{check.maxBytes != null ? ` / 上限 ${check.maxBytes}` : ''}</div>}
      {check.toolOk != null && <div>工具调用{check.toolOk ? '成功' : '失败'} · 进程退出码 {check.exitCode ?? '未知'}</div>}
      {check.cwd && <div>工作目录：{check.cwd}</div>}
      {check.execution && <pre>{JSON.stringify(check.execution, null, 2)}</pre>}
      {check.evidenceId && <small>执行证据：{check.evidenceId}</small>}
      {check.reason && <div>{check.reason}</div>}{check.output && <pre>{check.output}</pre>}{check.truncated && <small>输出已截断</small>}
    </div>)}</details>}
  </section>;
}
