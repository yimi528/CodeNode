import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useGraphStore } from '../store/graphStore';
import { useGoalControlStore } from '../store/goalControlStore';
import { useUiStore } from '../store/uiStore';
import { useSending } from '../lib/useSending';
import './BranchPanel.css';

export default function BranchPanel() {
  const root = useProjectStore(s => s.root), dirty = useProjectStore(s => s.dirty);
  const sending = useSending(), theme = useUiStore(s => s.theme);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [state,setState] = useState<BranchWorkspaceDto|null>(null), [name,setName] = useState('另一种方案');
  const [comparisons,setComparisons] = useState<Record<string,{name:string;patch:string;diff:string;truncated:boolean;context:BranchContextDto}>>({});
  const [preview,setPreview] = useState<{id:string;value:Record<string,unknown>}|null>(null);
  const capture = ():BranchContextDto => {
    useSessionStore.getState().syncActiveGraph();
    const ss=useSessionStore.getState();
    return {messages:ss.messages,graph:useGraphStore.getState().getDocument(),sessions:ss.sessions,order:ss.order,activeId:ss.activeId,label:ss.current()?.label,projectFile:useProjectStore.getState().projectFile};
  };
  const refresh = async () => { if(!root)return; const result=await window.codenode!.branchList(root);if(!result.ok||!result.value)throw Error(result.error||'读取失败');setState(result.value); };
  const invoke = async (action:()=>Promise<void>) => { if(sending||busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);} };
  useEffect(()=>{setPreview(null);setComparisons({});if(open)void invoke(refresh);},[root,open]);
  useEffect(()=>{if(!open)return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)setOpen(false)};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[open,busy]);
  const switchTo = async (id:string) => {
    if(!root||!state)return;
    if(dirty)throw Error('编辑器仍有未保存内容，请先保存文件再切换方案。');
    const saved=await window.codenode!.branchContext(root,capture());if(!saved.ok)throw Error(saved.error);
    const latest=await window.codenode!.branchList(root);if(!latest.ok||!latest.value)throw Error(latest.error);
    const next=latest.value, branch=next.branches.find(item=>item.id===id);
    const target=id==='main'?next.owner:branch?.available?branch.path:null;if(!target)throw Error('方案工作树不可用');
    const context=next.contexts[id];
    await useProjectStore.getState().loadRoot(target,id==='main'?context?.projectFile||null:null);
    const ss=useSessionStore.getState();ss.reset();ss.initProject();
    const fresh=useSessionStore.getState();
    if(context?.activeId&&context.sessions?.[context.activeId])useSessionStore.setState({sessions:context.sessions,order:context.order||Object.keys(context.sessions),activeId:context.activeId,messages:context.messages,streaming:false});
    else useSessionStore.setState({messages:context?.messages||[],activeId:fresh.activeId});
    useSessionStore.setState({memoryConversationId:crypto.randomUUID(),memoryTaskEpoch:0});
    useGraphStore.getState().loadDocument(context?.graph||{nodes:[],edges:[]});
    useGoalControlStore.getState().select(null);void useGoalControlStore.getState().refresh(target);
    setState({...next,activeId:id});setPreview(null);setComparisons({});
  };
  return <><button type="button" disabled={!root||sending} className="branch-panel-trigger" title="保存对话与代码检查点，尝试、比较和采用不同代码方案" onClick={()=>setOpen(true)}>代码方案</button>
    {open&&createPortal(<div className={`glass-theme theme-${theme} branches-mask`}><section className="branches-panel" role="dialog" aria-modal="true" aria-label="会话与代码方案">
      <header><strong>会话与代码方案</strong><button type="button" disabled={busy} onClick={()=>setOpen(false)}>关闭</button></header>
      <p>检查点同时保存当前对话和磁盘代码。每个方案在独立工作树执行，切换时同步切换对话、文件与工具工作目录。</p>
      <p>当前：{state?.activeId==='main'?'主工作区':state?.branches.find(item=>item.id===state.activeId)?.name||'读取中'} · {root}</p>
      <label>方案名称<input value={name} onChange={event=>setName(event.target.value)} maxLength={100}/></label>
      <button type="button" disabled={busy||sending||dirty} onClick={()=>void invoke(async()=>{if(!root)return;const result=await window.codenode!.branchCheckpoint(root,{label:name||'检查点',context:capture()});if(!result.ok)throw Error(result.error);await refresh();})}>保存当前检查点</button>
      {dirty&&<p role="status">先保存编辑器中的内容，检查点才会包含这些修改。</p>}
      <section><h3>从检查点尝试方案</h3>{state?.checkpoints.filter(item=>!item.label.startsWith('比较 ')).map(item=><div key={item.id}><span>{item.label} · {new Date(item.createdAt).toLocaleString()} · {item.commit.slice(0,10)}</span><button type="button" disabled={busy||sending} onClick={()=>void invoke(async()=>{const result=await window.codenode!.branchFork(root!,item.id,name);if(!result.ok)throw Error(result.error);await refresh();})}>创建隔离方案</button></div>)}</section>
      <section><h3>方案与产物</h3><button type="button" disabled={busy||sending||state?.activeId==='main'} onClick={()=>void invoke(()=>switchTo('main'))}>切回主工作区</button>
        {state?.branches.map(item=><article key={item.id} data-branch-id={item.id}><strong>{item.name}</strong><small>{item.status==='accepted'?'已采用，需重新验证':item.status==='archived'?'已归档':item.available?'独立工作树':'工作树不可用'}</small><div>
          <button type="button" disabled={busy||sending||!item.available||item.status==='archived'||state.activeId===item.id} onClick={()=>void invoke(()=>switchTo(item.id))}>切换方案</button>
          <button type="button" disabled={busy||sending||!item.available} onClick={()=>void invoke(async()=>{if(state.activeId===item.id){const saved=await window.codenode!.branchContext(root!,capture());if(!saved.ok)throw Error(saved.error);}
          const result=await window.codenode!.branchCompare(root!,item.id);if(!result.ok||!result.value)throw Error(result.error);setComparisons(current=>({...current,[item.id]:result.value!}));})}>比较产物</button>
          <button type="button" disabled={busy||sending||state.activeId!=='main'||item.status!=='active'} onClick={()=>void invoke(async()=>{const result=await window.codenode!.branchPreviewAdopt(root!,item.id);if(!result.ok||!result.value)throw Error(result.error);setPreview({id:item.id,value:result.value});})}>预览采用</button>
          <button type="button" disabled={busy||sending||state.activeId===item.id||item.status==='archived'} onClick={()=>void invoke(async()=>{const result=await window.codenode!.branchArchive(root!,item.id);if(!result.ok)throw Error(result.error);await refresh();})}>归档并保留证据</button>
        </div></article>)}
      </section>
      <div className="branches-comparison">{Object.entries(comparisons).map(([id,item])=><section key={id}><h3>{item.name}</h3><p>{item.context?.messages?.[item.context.messages.length-1]?.content?.slice(0,500)||'尚无对话交付'}</p><pre>{item.diff||'无代码差异'}</pre><details><summary>查看补丁{item.truncated?'（已截断）':''}</summary><pre>{item.patch||'无补丁'}</pre></details><button onClick={()=>setComparisons(current=>{const next={...current};delete next[id];return next;})}>移除对比</button></section>)}</div>
      {preview&&<section aria-label="采用方案预览"><strong>采用前检查</strong><pre>{JSON.stringify(preview.value.files,null,2)}</pre><p>主工作区必须没有未提交改动；采用后需要重新验证。外部操作不会随方案切换或合并撤销。</p><button type="button" disabled={busy||sending} onClick={()=>void invoke(async()=>{const result=await window.codenode!.branchAdopt(root!,preview.id,preview.value);if(!result.ok)throw Error(result.error);const invalidate=(msg:import('../types').SessionMsg)=>msg.codeVerification?{...msg,codeVerification:{...msg.codeVerification,status:'stale' as const,verified:false}}:msg;
      useSessionStore.setState(current=>({messages:[...current.messages.map(invalidate),{role:'user',content:`已采用方案 ${state?.branches.find(item=>item.id===preview.id)?.name||preview.id} 的代码。此前校验仅供历史参考，请基于当前工作区重新验证。`}],sessions:Object.fromEntries(Object.entries(current.sessions).map(([id,session])=>[id,{...session,messages:(session.messages||[]).map(invalidate)}]))}));
      await window.codenode!.branchContext(root!,capture());await useGoalControlStore.getState().refresh(root);
      useUiStore.getState().setToast(result.value?.message||'已采用，请重新验证');setPreview(null);await refresh();})}>确认采用代码</button><button onClick={()=>setPreview(null)}>取消采用</button></section>}
      {error&&<p role="alert">{error}</p>}
    </section></div>,document.body)}
  </>;
}
