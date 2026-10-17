import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightCode(value: string) {
  const token = /(\/\/[^\n]*|#[^\n]*|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|true|false|null|undefined|try|catch|throw|interface|type|public|private|static|void|boolean|string|number)\b|\b\d+(?:\.\d+)?\b)/g;
  let result = '';
  let last = 0;
  value.replace(token, (match, _unused, offset) => {
    result += escapeHtml(value.slice(last, offset));
    const cls = /^(\/\/|#)/.test(match) ? 'comment' : /^("|'|`)/.test(match) ? 'string' : /^\d/.test(match) ? 'number' : 'keyword';
    result += `<span class="tok-${cls}">${escapeHtml(match)}</span>`;
    last = offset + match.length;
    return match;
  });
  return result + escapeHtml(value.slice(last));
}

function diagnoseCode(filePath: string, value: string) {
  const problems: { line: number; message: string }[] = [];
  const stack: { char: string; line: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  value.split(/\r?\n/).forEach((line, index) => {
    for (const char of line) {
      if ('([{'.includes(char)) stack.push({ char, line: index + 1 });
      else if (')]}'.includes(char)) {
        const top = stack.pop();
        if (!top || top.char !== pairs[char]) problems.push({ line: index + 1, message: `括号不匹配：${char}` });
      }
    }
  });
  for (const item of stack) problems.push({ line: item.line, message: `缺少闭合括号：${item.char}` });
  if (/\.json$/i.test(filePath) && value.trim()) {
    try { JSON.parse(value); } catch (error) { problems.push({ line: 1, message: `JSON 解析失败：${String(error).replace(/^SyntaxError:\s*/, '').slice(0, 120)}` }); }
  }
  return problems.slice(0, 30);
}

export default function EditorPanel() {
  const selected = useProjectStore((s) => s.selected);
  const draft = useProjectStore((s) => s.draft);
  const searchMatches = useProjectStore((s) => s.searchMatches);
  const searching = useProjectStore((s) => s.searching);
  const searchProject = useProjectStore((s) => s.searchProject);
  const openFile = useProjectStore((s) => s.openFile);
  const dirty = useProjectStore((s) => s.dirty);
  const updateDraft = useProjectStore((s) => s.updateDraft);
  const saveSelected = useProjectStore((s) => s.saveSelected);
  const revertDraft = useProjectStore((s) => s.revertDraft);
  const conflict = useProjectStore((s) => s.conflict);
  const forceSaveSelected = useProjectStore((s) => s.forceSaveSelected);
  const acceptExternalFile = useProjectStore((s) => s.acceptExternalFile);
  const mergeExternalFile = useProjectStore((s) => s.mergeExternalFile);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<string[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const editorTarget = useUiStore((s) => s.editorTarget);

  useEffect(() => {
    if (!selected || !editorTarget || selected.relPath !== editorTarget.path) return;
    const line = Math.max(1, Math.min(editorTarget.line, draft.split('\n').length));
    const offset = draft.split('\n').slice(0, line - 1).reduce((sum, part) => sum + part.length + 1, 0);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(offset, offset);
      editor.scrollTop = Math.max(0, (line - 4) * 18.6);
      if (highlightRef.current) highlightRef.current.scrollTop = editor.scrollTop;
      useUiStore.getState().setEditorTarget(null);
    });
  }, [selected, editorTarget, draft]);

  useEffect(() => {
    if (selected?.relPath) setTabs((list) => (list.includes(selected.relPath) ? list : [...list, selected.relPath]));
  }, [selected?.relPath]);

  const save = async () => {
    setSaving(true);
    const ok = await saveSelected();
    setSaving(false);
    if (ok) useUiStore.getState().setToast(`已保存 ${selected?.relPath || '文件'}`);
  };

  const problems = useMemo(() => (selected ? diagnoseCode(selected.relPath, draft) : []), [selected, draft]);

  if (selected?.relPath.toLowerCase().endsWith('.cnode')) return <div className="dock-empty">工程文件通过工作台修改。</div>;
  if (!selected) return <div className="dock-empty">从左侧项目树点击文件，开始编辑。支持多文件标签、保存、撤销和 Diff 对比。</div>;
  const lines = draft.split(/\r?\n/).length;
  const language = selected.relPath.split('.').pop()?.toUpperCase() || 'TEXT';
  const completionItems = ['const', 'function', 'return', 'async', 'await', 'if', 'else', 'for', 'try', 'catch', 'console.log'];
  const closeTab = (filePath: string) => {
    const next = tabs.filter((item) => item !== filePath);
    setTabs(next);
    if (filePath === selected.relPath && next.length) void openFile(next[next.length - 1]);
  };
  return <div className="dock-editor">
    <div className="dock-editor-tabs">{tabs.map((filePath) => <button key={filePath} className={filePath === selected.relPath ? 'active' : ''} onClick={() => { void openFile(filePath); }}><span>{filePath.split('/').pop()}</span><i onClick={(event) => { event.stopPropagation(); closeTab(filePath); }}>×</i></button>)}</div>
    <div className="dock-file-head">
      <span className="dock-file-path">{selected.relPath}{dirty ? ' · 未保存' : ''}</span>
      <span className="dock-language">{language}</span>
      <span className="dock-file-meta">{lines} 行 · {draft.length} 字符</span>
      <div className="dock-search"><input value={query} placeholder="搜索项目…" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchProject(query); }} /><button onClick={() => void searchProject(query)} disabled={!query.trim() || searching}>{searching ? '…' : '查找'}</button></div>
      <button onClick={revertDraft} disabled={!dirty}>撤销修改</button>
      <button className="dock-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? '保存中…' : '保存文件'}</button>
    </div>
    {query.trim() && <div className="dock-search-results">{searchMatches.length ? searchMatches.map((match) => <button key={`${match.path}:${match.line}`} onClick={() => { void openFile(match.path); }}>{match.path}:{match.line}<span>{match.text}</span></button>) : <span>{searching ? '搜索中…' : '没有匹配结果'}</span>}</div>}
    {conflict && <div className="dock-conflict"><span>文件在外部被修改，当前草稿未覆盖外部内容。</span><button onClick={mergeExternalFile}>三方合并</button><button onClick={acceptExternalFile}>载入外部版本</button><button className="dock-danger" onClick={() => void forceSaveSelected()}>强制覆盖外部版本</button></div>}
    <div className="dock-problems"><strong>{problems.length ? `问题 ${problems.length}` : '无问题'}</strong>{problems.map((problem, index) => <span key={index}>L{problem.line} {problem.message}</span>)}<button onClick={() => setShowCompletions((value) => !value)}>补全 ⌘Space</button></div>
    {showCompletions && <div className="dock-completions">{completionItems.map((item) => <button key={item} onClick={() => { const editor = editorRef.current; if (!editor) return; const start = editor.selectionStart; updateDraft(draft.slice(0, start) + item + draft.slice(editor.selectionEnd)); setShowCompletions(false); requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(start + item.length, start + item.length); }); }}>{item}</button>)}</div>}
    <div className="dock-code-wrap"><div className="dock-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div><div className="dock-code-surface">
      <pre ref={highlightRef} className="dock-code-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightCode(draft) + '\n' }} />
      <textarea ref={editorRef} className="dock-code-editor" value={draft} spellCheck={false} onChange={(event) => updateDraft(event.target.value)} onScroll={(event) => { if (highlightRef.current) { highlightRef.current.scrollTop = event.currentTarget.scrollTop; highlightRef.current.scrollLeft = event.currentTarget.scrollLeft; } }} onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
        if ((event.metaKey || event.ctrlKey) && event.code === 'Space') { event.preventDefault(); setShowCompletions((value) => !value); }
        if (event.key === 'Tab') { event.preventDefault(); const editor = event.currentTarget; const start = editor.selectionStart; updateDraft(draft.slice(0, start) + '  ' + draft.slice(editor.selectionEnd)); requestAnimationFrame(() => editor.setSelectionRange(start + 2, start + 2)); }
      }} />
    </div></div>
  </div>;
}
