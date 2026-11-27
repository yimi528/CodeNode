export interface TaskAcceptanceContract {
  version: 1;
  artifacts: {id: string; path: string}[];
  checks: {id: string; execution: {mode: 'argv'; program: string; args: string[]; timeoutSeconds: number}; inputs: string[]; reproduce?: {exitCode: number; outputIncludes: string}}[];
}
export interface AcceptanceDraft { enabled: boolean; program: string; args: string; inputs: string; artifacts: string; reproduce: boolean; exitCode: number; marker: string; timeout: number }
export const emptyAcceptanceDraft = (): AcceptanceDraft => ({enabled:false,program:'npm',args:'["test"]',inputs:'.',artifacts:'',reproduce:false,exitCode:1,marker:'',timeout:60});
export function buildAcceptance(draft: AcceptanceDraft): TaskAcceptanceContract | undefined {
  if (!draft.enabled) return undefined;
  const lines = (value: string) => [...new Set(value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];
  const artifacts = lines(draft.artifacts).map((path,i)=>({id:'file-'+i,path}));
  const checks: TaskAcceptanceContract['checks'] = [];
  if (draft.program.trim()) {
    let args: unknown;
    try { args = JSON.parse(draft.args); } catch { throw Error('命令参数必须是 JSON 字符串数组，例如 ["test"]'); }
    if (!Array.isArray(args) || args.some(a=>typeof a!=='string')) throw Error('命令参数必须是 JSON 字符串数组，例如 ["test"]');
    const inputs = lines(draft.inputs);
    if (!inputs.length) throw Error('请填写验收输入文件或目录，包含源码、测试与依赖配置');
    if (!Number.isInteger(draft.timeout) || draft.timeout<1 || draft.timeout>600) throw Error('超时须为 1–600 秒');
    const rule: TaskAcceptanceContract['checks'][number] = {id:'desktop-check',execution:{mode:'argv',program:draft.program.trim(),args,timeoutSeconds:draft.timeout},inputs};
    if (draft.reproduce) {
      if (!Number.isInteger(draft.exitCode) || draft.exitCode<1 || !draft.marker.trim()) throw Error('修改前复现需要非零退出码和明确错误标记');
      rule.reproduce={exitCode:draft.exitCode,outputIncludes:draft.marker.trim()};
    }
    checks.push(rule);
  } else if (draft.reproduce) throw Error('修改前复现需要配置验收命令');
  if (!checks.length && !artifacts.length) throw Error('请至少设置一条命令或一个必需产物');
  return {version:1,artifacts,checks};
}
