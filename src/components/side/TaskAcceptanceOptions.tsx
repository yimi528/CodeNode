import { useEffect, useRef, useState } from 'react';
import {useProjectStore} from '../../store/projectStore';
import {useSessionStore} from '../../store/sessionStore';
import type { AcceptanceDraft } from '../../lib/taskAcceptance';
import './TaskAcceptanceOptions.css';
export default function TaskAcceptanceOptions({value,onChange,disabled,error}:{value:AcceptanceDraft;onChange:(value:AcceptanceDraft)=>void;disabled:boolean;error:string}) {
  const panel=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(error&&panel.current){panel.current.open=true;panel.current.scrollTop=0;}},[error]);
  const [notice,setNotice]=useState('');
  const root=useProjectStore(s=>s.root), sessionId=useSessionStore(s=>s.activeId);
  const projectTest=async()=>{
    try {
      if(!root||!window.codenode)throw Error('请先打开项目');
      const result=await window.codenode.readProjectFile(root,'package.json');
      if(!result.ok || result.truncated)throw Error(result.error||'无法完整读取 package.json');
      if(!JSON.parse(result.content||'{}').scripts?.test)throw Error('项目未声明 test 脚本，请手动填写程序与参数');
      if(useProjectStore.getState().root===root&&useSessionStore.getState().activeId===sessionId){onChange({...value,enabled:true,program:'npm',args:'["test"]'});setNotice('已选用项目 npm test；输入范围请包含源码、测试与依赖配置。');}
    }catch(e){if(useProjectStore.getState().root===root&&useSessionStore.getState().activeId===sessionId)setNotice(e instanceof Error?e.message:String(e));}
  };
  useEffect(()=>setNotice(''),[root,sessionId]);
  const change=(patch:Partial<AcceptanceDraft>)=>{setNotice('');onChange({...value,...patch});};
  return <details ref={panel} className="task-acceptance-options"><summary>任务验收 · {value.enabled?'已启用':'未配置'}</summary>
    {error&&<p role="alert">{error}</p>}
    <fieldset disabled={disabled}>
      <label><input type="checkbox" aria-label="启用任务验收" checked={value.enabled} onChange={e=>change({enabled:e.target.checked})}/>本次任务启用验收</label>
      <button type="button" onClick={()=>void projectTest()}>使用项目测试</button>
      {notice&&<p role="status">{notice}</p>}
      {value.enabled && <>
        <p>发送时冻结规则，沿用现有命令权限与审批。输入范围用于核对验收证据，不限制 Agent 写入范围。</p>
        <label>程序<input aria-label="验收程序" placeholder="npm、python3 或程序路径；仅验收产物时留空" value={value.program} onChange={e=>change({program:e.target.value})}/></label>
        <label>参数（JSON 数组）<input aria-label="验收参数" value={value.args} onChange={e=>change({args:e.target.value})}/></label>
        <label>验收输入范围（每行一个）<textarea aria-label="验收输入范围" rows={2} value={value.inputs} onChange={e=>change({inputs:e.target.value})}/></label>
        <label>必需产物（每行一个文件路径）<textarea aria-label="必需产物" rows={2} value={value.artifacts} onChange={e=>change({artifacts:e.target.value})}/></label>
        <label>单项超时（秒）<input aria-label="验收超时" type="number" min={1} max={600} value={value.timeout} onChange={e=>change({timeout:Number(e.target.value)})}/></label>
        <label><input aria-label="要求修改前复现" type="checkbox" checked={value.reproduce} onChange={e=>change({reproduce:e.target.checked})}/>Bug 修复：要求修改前复现失败</label>
        {value.reproduce&&<><label>复现退出码<input aria-label="复现退出码" type="number" min={1} value={value.exitCode} onChange={e=>change({exitCode:Number(e.target.value)})}/></label><label>复现错误标记<input aria-label="复现错误标记" value={value.marker} onChange={e=>change({marker:e.target.value})}/></label></>}
      </>}
    </fieldset>
  </details>;
}
