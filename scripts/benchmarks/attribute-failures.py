"""Read-only attribution over recorded attempts and extracted, hashed image evidence."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from statistics import median

def sha(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()
def rows(file):
    if not Path(file).exists():return []
    result=[]
    for line,text in enumerate(Path(file).read_text(errors='replace').splitlines(),1):
        try:value=json.loads(text)
        except ValueError:continue
        if isinstance(value,dict):result.append((line,value))
    return result
def ref(file,line):return {'file':str(Path(file).resolve()),'line':line}
def clean(text,limit=500):return re.sub(r'sk-[A-Za-z0-9_-]+','[REDACTED]',str(text))[:limit]

def tool_calls(events,file):
    calls=[]
    for line,event in events:
        delta=event.get('delta',{})
        if delta.get('kind')!='tool_result' or not isinstance(delta.get('toolCalls'),list):continue
        for call in delta['toolCalls']:
            if not isinstance(call,dict):continue
            args=call.get('args') or {}
            if isinstance(args,str):
                try:args=json.loads(args)
                except ValueError:args={'raw':args}
            data=call.get('data') or {};text=str(call.get('result',''));output=str(data.get('output',text))
            flags=[]
            if call.get('name')=='execute_shell':
                if '命令不在白名单' in text:flags.append('allowlist_rejection')
                if 'ENOENT' in text:flags.append('executable_missing')
                if re.search(r'unrecognized arguments:.*(?:\||2>&1)|no such option: -[0-9]',text):flags.append('operators_received_as_argv')
                if 'ModuleNotFoundError' in text or 'ImportError' in text:flags.append('python_import_failure')
                if data.get('exitCode') not in (None,0):flags.append('command_nonzero_exit')
            signature=hashlib.sha256(json.dumps([call.get('name'),args,call.get('ok'),data.get('exitCode'),data.get('sourceSha256'),data.get('sha256'),output],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
            calls.append({'name':call.get('name'),'ok':call.get('ok'),'args':args,'exitCode':data.get('exitCode'),
              'status':data.get('status'),'sourceSha256':data.get('sourceSha256') or data.get('sha256'),
              'flags':flags,'outputExcerpt':clean(output),'signature':signature,'evidence':ref(file,line)})
    return calls

def stop_category(arm,trace,native):
    wraps=[v for _,v in trace if v.get('kind')=='budget_wrapup' and v.get('phase')=='start']
    if arm.get('stopReason')=='token_limit':return 'planned_handoff' if wraps and 'handoffInput' in (wraps[-1].get('budget') or {}) else 'hard_budget_refusal'
    if arm.get('requestTimeout'):return 'request_timeout'
    errors=[str(e.get('delta',{}).get('error','')) for _,e in native if e.get('delta',{}).get('kind')=='error']
    if any('HTTP 请求总次数上限' in e for e in errors):return 'http_attempt_limit'
    if arm.get('state')=='COMPLETED':return 'completed_but_verifier_failed'
    return 'other_runtime_error'

def inspect_case(root,task,arm,value,expected_runtime=None):
    trial=Path(value['resultPath']).parent;native_file=trial/'agent/codenode.jsonl';native=rows(native_file)
    directory=root/'failure-attribution/evidence'/(arm+'-'+task.rsplit('/',1)[-1]);source_file=directory/'sources.json'
    source=json.loads(source_file.read_text());checkpoint=json.loads((trial/'agent/solve-checkpoint.json').read_text())
    if source['solved_image']!=checkpoint['solved_image']:raise ValueError('Image evidence identity mismatch')
    if expected_runtime and checkpoint.get('runtime_source_sha256')!=expected_runtime:raise ValueError('Mixed runtime versions')
    expected=checkpoint.get('artifacts',{}).get('codenode.jsonl')
    if expected and sha(native_file)!=expected:raise ValueError('Original native trajectory changed')
    for item in source['files'].values():
        if sha(item['path'])!=item['sha256']:raise ValueError('Extracted evidence was modified')
    trace_file=directory/'tools_trace.jsonl';trace=rows(trace_file);cost_file=directory/'cost.jsonl';cost=rows(cost_file)
    calls=tool_calls(native,native_file);flags=Counter(f for c in calls for f in c['flags'])
    plans=[{**v,'evidence':ref(trace_file,line)} for line,v in trace if v.get('kind')=='request_budget_plan']
    unknown=[{**v,'evidence':ref(cost_file,line)} for line,v in cost if v.get('billingUnknown')]
    main=[(line,v) for line,v in cost if v.get('kind')=='main']
    helper=[v for _,v in cost if v.get('kind') not in ('main','failed-attempt') and not v.get('estimated')]
    ratios=[];tool_shares=[]
    for plan in plans:
        index=plan.get('turnId')
        if isinstance(index,int) and index<len(main) and not main[index][1].get('estimated'):
            prompt=(main[index][1].get('tokens') or {}).get('prompt',0)
            if prompt:ratios.append(plan['inputReserve']/prompt)
    for _,record in main:
        attribution=(record.get('meta') or {}).get('attribution') or {};total=attribution.get('total',0)
        if total:tool_shares.append((attribution.get('layers') or {}).get('tool_result',0)/total)
    signatures=Counter(c['signature'] for c in calls if c['status']!='running')
    patch=trial/'agent/prediction.patch';patch_text=patch.read_text(errors='replace') if patch.exists() else ''
    official=trial/'verifier/report.json';grading={}
    if official.exists():
        data=json.loads(official.read_text())
        for report in data.values():
            if isinstance(report,dict):grading['failToPassFailures']=((report.get('tests_status') or {}).get('FAIL_TO_PASS') or {}).get('failure',[])
    stdout=trial/'verifier/test-stdout.txt'
    if stdout.exists():
        text=stdout.read_text(errors='replace')
        grading['sslWithoutOfficialReport']='requests.exceptions.SSLError' in text and not official.exists()
        grading['testsRanBeforeReportError']=bool(grading['sslWithoutOfficialReport'] and re.search(r'Ran \d+ tests',text))
    effective=value.get('recoveredReward',value.get('originalReward'))
    return {'task':task,'arm':arm,'effectiveReward':effective,'failed':effective!=1,'state':value.get('state'),
      'terminalCategory':stop_category(value,trace,native) if effective!=1 else 'passed',
      'calls':calls,'counts':dict(flags),'shellCalls':sum(c['name']=='execute_shell' for c in calls),
      'fileWriteToolCalls':sum(c['name'] in ('write_file','edit_file','bulk_edit') and c['ok'] for c in calls),
      'exactDuplicateCalls':sum(count-1 for count in signatures.values()),
      'budgetPlans':plans,'budgetReasons':dict(Counter(v.get('reason') for v in plans)),
      'lastBudgetPlan':plans[-1] if plans else None,
      'unknownAttempts':len(unknown),'unknownAttemptReservedTokens':sum((v.get('meta') or {}).get('reservedUpperBoundTokens',0) for v in unknown),
      'knownMainTokens':sum((v.get('tokens') or {}).get('total',0) for _,v in main if not v.get('estimated')),
      'knownHelperTokens':sum((v.get('tokens') or {}).get('total',0) for v in helper),
      'medianPlanningBytesToReportedPromptRatio':round(median(ratios),3) if ratios else None,
      'lastHeuristicToolResultShare':round(tool_shares[-1],4) if tool_shares else None,
      'noProgressReasons':dict(Counter(v.get('reason') for _,v in trace if v.get('kind')=='no_progress_observation')),
      'wrapups':[{**v,'evidence':ref(trace_file,line)} for line,v in trace if v.get('kind')=='budget_wrapup'],
      'patchBytes':patch.stat().st_size if patch.exists() else None,'patchFiles':re.findall(r'^diff --git a/(.*?) b/',patch_text,re.M),
      'grading':grading,'nativeFile':str(native_file),'sourceEvidence':source,
      'errors':[{'text':clean(e['delta'].get('error','')),'evidence':ref(native_file,line)} for line,e in native if e.get('delta',{}).get('kind')=='error']}

def analyze(root):
    root=Path(root).resolve();analysis=json.loads((root/'analysis.json').read_text())
    plan=json.loads((root/'plan.json').read_text())
    if sha(plan['bundle'])!=plan['manifest']['archive_sha256'] or plan['manifest']['source_sha256']!=analysis['runtimeSourceSha256']:raise ValueError('Frozen experiment identity mismatch')
    cases=[inspect_case(root,c['task'],arm,value,analysis['runtimeSourceSha256']) for c in analysis['cases'] for arm,value in c['arms'].items()]
    failures=[c for c in cases if c['failed']];improved=[c for c in cases if c['arm']=='improved']
    result={'runtimeSourceSha256':analysis['runtimeSourceSha256'],'modelRequests':0,'cases':cases,
      'summary':{'attempts':len(cases),'failedAfterGradingRecovery':len(failures),'terminalCategories':dict(Counter(c['terminalCategory'] for c in failures)),
       'allAttemptFlags':dict(sum((Counter(c['counts']) for c in cases),Counter())),
       'failureFlags':dict(sum((Counter(c['counts']) for c in failures),Counter())),
       'improvedBudgetReasons':dict(sum((Counter(c['budgetReasons']) for c in improved),Counter())),
       'improvedNoProgressReasons':dict(sum((Counter(c['noProgressReasons']) for c in improved),Counter()))},
      'caveats':['Terminal stop categories are observed events, not exclusive root causes.','Exact repeats may be legitimate retests; no claim that all repeats waste work.',
       'Planning input is estimated before some injected notes; the ratio to sequential completed-main prompt usage is diagnostic, not tokenizer calibration.',
       'Unknown-attempt reservations are conservative accounting, not proof of provider billing.','Official verifier evidence is post-run only; it must not become hints to solving agents.']}
    target=root/'failure-attribution';(target/'attribution.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    lines=['# 失败轨迹机器核对表','',f'冻结来源：`{result["runtimeSourceSha256"]}`；{len(cases)} 次首次尝试中恢复评分后失败 {len(failures)} 条。分析新增模型请求 0。','',
      '| 任务 | 组别 | 记录的终止机制 | shell 调用 | 白名单拒绝 | 运算符进入 argv | 写工具次数 | 未知调用累计预留 |','| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |']
    for c in failures:lines.append(f'| {c["task"]} | {c["arm"]} | {c["terminalCategory"]} | {c["shellCalls"]} | {c["counts"].get("allowlist_rejection",0)} | {c["counts"].get("operators_received_as_argv",0)} | {c["fileWriteToolCalls"]} | {c["unknownAttemptReservedTokens"]} |')
    lines+=['','上述类别只描述停止机制，不把它直接当成唯一根因。精确重复不等于无效重复，未知预留不等于实际费用。','']
    for c in failures:
        lines += [f'## {c["task"]} / {c["arm"]}','',f'预算评估：`{c["budgetReasons"]}`；无进展排除／观测：`{c["noProgressReasons"]}`。','']
        if c['lastBudgetPlan']:
            p=c['lastBudgetPlan'];r=p['evidence'];lines.append(f'最后预算：[trace L{r["line"]}]({r["file"]}:{r["line"]})；已用 {p["used"]}，剩余 {p["remaining"]}，下一输入规划 {p["inputReserve"]}。')
        for call in c['calls']:
            if not call['flags']:continue
            r=call['evidence'];lines.append(f'- `{", ".join(call["flags"])}`：[native L{r["line"]}]({r["file"]}:{r["line"]})；`{clean(call["args"].get("command",""),140).replace(chr(10)," ").replace("|","¦")}`')
        lines.append('')
    (target/'inventory.md').write_text('\n'.join(lines))
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('directory',type=Path);args=parser.parse_args();print(json.dumps(analyze(args.directory)['summary'],ensure_ascii=False))
