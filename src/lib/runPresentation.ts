import type { SessionMsg } from '../types';
import { summarizeFileChanges } from './fileChanges';

export function runPresentation(message?: SessionMsg, busy = false, request?: 'confirm' | 'ask' | null, review = false) {
  if (request) return { label: request === 'confirm' ? '等待授权' : '等待你的回答', owner: '你', next: '在弹出的请求中处理后，Agent 才会继续。', action: 'request' };
  if (review) return { label: '恢复前需复核', owner: '你', next: '核对下方恢复计划中的未知操作，再选择如何继续。', action: 'review' };
  const state = message?.run?.state;
  if (busy) {
    if (state === 'WAITING_USER') return { label: '等待你处理', owner: '你', next: '请处理当前授权或补充信息请求。', action: 'request' };
    if (state === 'WAITING_TOOL') return { label: '工具执行中', owner: 'Agent', next: '等待工具返回；需要调整方向时可以插话。', action: 'wait' };
    return { label: '正在执行', owner: 'Agent', next: '正在生成或整理结果；你可以插话或停止。', action: 'wait' };
  }
  if (state === 'LIMIT_REACHED' || message?.status === 'truncated') return { label: '达到运行上限', owner: '你', next: `本轮未完整交付${message?.run?.reason ? `（${message.run.reason}）` : ''}。请在运行面板核对预算和恢复计划。`, action: 'runs' };
  if (state === 'FAILED' || message?.status === 'failed') return { label: '执行失败', owner: '你', next: '查看本轮错误和文件变更，再决定重试或恢复。', action: 'runs' };
  if (state === 'CANCELLED' || message?.status === 'stopped') return { label: '已停止', owner: '你', next: '已经产生的变更会保留；可核对后继续或回滚。', action: 'runs' };
  return { label: '就绪', owner: '你', next: '可以发送任务或查看交付结果。', action: 'none' };
}

export function deliverySummary(message: SessionMsg) {
  const files = summarizeFileChanges(message.tools || [], [...(message.editedFiles || []), ...(message.backendChanges?.files.map(file => file.path) || [])]);
  const report = message.codeVerification;
  const failed = report?.checks.filter(check => check.status === 'failed').length || 0;
  const passed = report?.checks.filter(check => check.status === 'passed').length || 0;
  const verified = report?.status === 'passed' && report.verified && !message.run?.rolledBackAt;
  const checks = message.run?.rolledBackAt ? '文件已回滚，原校验不再代表当前代码' : verified ? '所选局部校验通过' : failed ? `${failed} 项校验失败` : report ? '校验尚未完整通过' : '未记录独立校验';
  const incomplete = ['FAILED', 'CANCELLED', 'LIMIT_REACHED'].includes(message.run?.state || '') || ['failed', 'stopped', 'truncated'].includes(message.status || '');
  return { files, passed, failed, verified: !!verified, checks, incomplete,
    title: incomplete ? '本轮阶段性结果' : '本轮交付',
    summary: message.content.trim().split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 180) || '本轮没有文字说明，请核对运行记录。' };
}
