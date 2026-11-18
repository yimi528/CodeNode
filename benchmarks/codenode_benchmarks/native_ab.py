"""Frozen same-runtime feature A/B. All attempts retained; incomplete solves never replayed."""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
from filelock import FileLock
from harbor.models.job.config import JobConfig
from .runtime import ROOT,build_bundle
from .comparison import run_logged,sha,tree_sha
from .recovery import atomic_json,inspect_job,save_state

FEATURES=['agent.compact.budget_aware','agent.context.archive_results','agent.budget.wrap_up','agent.no_progress.enabled','agent.working_state.enabled','agent.cache.workspace_versions']
ADAPTERS=['agent.py','native_ab.py','recovery.py','runtime.py','results.py','comparison.py','baseline.py']

def prepare(previous,output):
    previous=Path(previous).resolve();output=Path(output).resolve()
    if output.exists() and any(output.iterdir()):raise ValueError('Experiment output must be new')
    source=json.loads(previous.read_text());output.mkdir(parents=True,exist_ok=True)
    bundle=output/'snapshot/runtime.tar.gz';manifest=build_bundle(bundle)
    cases=[]
    for original in source['cases']:
        if original['task'] in source.get('known_invalid_before_run',{}):continue
        image=json.loads(subprocess.check_output(['docker','image','inspect',original['prepared_image']],text=True))[0]
        cases.append({'task':original['task'],'slug':original['slug'],'family':original['family'],'task_path':original['task_path'],
                      'task_sha256':tree_sha(Path(original['task_path'])),'image':original['prepared_image'],'image_id':image['Id'],
                      'order':['baseline','improved'] if len(cases)%2==0 else ['improved','baseline']})
    plan={'created_at':datetime.now(timezone.utc).isoformat(),'model':source['model'],'base_url':source['base_url'],
          'bundle':str(bundle),'manifest':manifest,'adapter_sha256':{name:sha(Path(__file__).parent/name) for name in ADAPTERS},
          'limits':source['limits'],'cases':cases,'features':{'baseline':dict.fromkeys(FEATURES,False),'improved':dict.fromkeys(FEATURES,True)},
          'attempts_per_task':1,'workers':1,'known_invalid_excluded':source.get('known_invalid_before_run',{}),
          'purpose':'diagnostic regression on previously observed tasks; not a holdout/generalization claim'}
    for name in [*ADAPTERS,'__init__.py']:
        target=output/'adapter-snapshot/codenode_benchmarks'/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(Path(__file__).parent/name,target)
    atomic_json(output/'plan.json',plan);return plan

def config(plan,output,case,index,arm):
    return JobConfig.model_validate({'job_name':f'{index:02d}-{arm}-{case["slug"]}','jobs_dir':str(output/'jobs'),
      'n_concurrent_trials':1,'n_attempts':1,'retry':{'max_retries':0},
      'agents':[{'import_path':'codenode_benchmarks.agent:CodeNodeAgent','model_name':plan['model'],'base_url':plan['base_url'],
        'override_setup_timeout_sec':600,'kwargs':{'bundle_path':plan['bundle'],'workspace':'/testbed' if case['family']=='swe' else '/',
          'max_iterations':plan['limits']['turns'],'turn_timeout':plan['limits']['request_seconds'],
          'feature_properties':plan['features'][arm],'checkpoint_environment':True}}],
      'tasks':[{'path':case['task_path']}]}).model_dump(mode='json',exclude_none=True)

def verify(plan,case=None):
    if sha(plan['bundle'])!=plan['manifest']['archive_sha256']:raise ValueError('Frozen runtime changed')
    for name,digest in plan['adapter_sha256'].items():
        if sha(Path(__file__).parent/name)!=digest:raise ValueError('Frozen adapter changed: '+name)
    if case:
        if tree_sha(Path(case['task_path']))!=case['task_sha256']:raise ValueError('Task changed')
        image=json.loads(subprocess.check_output(['docker','image','inspect',case['image']],text=True))[0]
        if image['Id']!=case['image_id']:raise ValueError('Prepared image changed')

def report(plan_path):
    plan_path=Path(plan_path).resolve();plan=json.loads(plan_path.read_text());output=plan_path.parent;rows=[]
    for index,case in enumerate(plan['cases']):
        row={'task':case['task'],'arms':{}}
        for arm in ('baseline','improved'):
            cfg=config(plan,output,case,index,arm);job=output/'jobs'/cfg['job_name']
            state=inspect_job(job) if job.exists() else {'phase':'not_started'}
            if state.get('result_path'):
                result=json.loads(Path(state['result_path']).read_text());state['finished_at']=result.get('finished_at')
                if result.get('task_name')!=case['task']:raise ValueError('Result task identity mismatch')
                state['tokens']={k:(result.get('agent_result') or {}).get(k) for k in ('n_input_tokens','n_output_tokens')}
            row['arms'][arm]=state
        rows.append(row)
    summary={arm:{'total':len(rows),'finished':sum(bool(r['arms'][arm].get('finished_at')) for r in rows),
      'resolved':sum(r['arms'][arm].get('original_reward')==1 for r in rows),
      'grading_startup_failed':sum(r['arms'][arm].get('grading_status')=='startup_failed' for r in rows)} for arm in ('baseline','improved')}
    data={'plan':str(plan_path),'complete':all(s['finished']==len(rows) for s in summary.values()),'summary':summary,'cases':rows,
          'method':plan['purpose'],'billing':'Provider invoice unavailable; no dollar savings claim'}
    atomic_json(output/'results.json',data)
    lines=['# CodeNode 原生功能 A/B 对照','',plan['purpose'],'',
      '| 组别 | 已结束 | 原始通过 | 评分启动失败 |','| --- | ---: | ---: | ---: |']
    for arm,s in summary.items():lines.append(f'| {arm} | {s["finished"]}/{s["total"]} | {s["resolved"]}/{s["total"]} | {s["grading_startup_failed"]} |')
    lines+=['','原始分数不会被恢复评分覆盖。未完成、环境异常和恢复评分独立保存。费用须以供应商账单为准。','']
    (output/'report.md').write_text('\n'.join(lines));return data

def run(plan_path):
    if not os.getenv('CODENODE_API_KEY'):raise ValueError('Explicit benchmark API credential required')
    plan_path=Path(plan_path).resolve();output=plan_path.parent;plan=json.loads(plan_path.read_text())
    with FileLock(str(output/'run.lock'),timeout=0):
        verify(plan)
        for index,case in enumerate(plan['cases']):
            for arm in case['order']:
                verify(plan,case);cfg=config(plan,output,case,index,arm);job=output/'jobs'/cfg['job_name']
                state_file=output/'states'/(cfg['job_name']+'.json')
                if job.exists():
                    state=inspect_job(job);save_state(state_file,state.pop('phase'),**state)
                    print(json.dumps({'existing':cfg['job_name'],'state':inspect_job(job)}),flush=True)
                    continue # An incomplete attempt is never silently sent to the model again.
                if state_file.exists() and json.loads(state_file.read_text())['phase']!='prepared':
                    print(json.dumps({'inspection_required':cfg['job_name']}),flush=True);continue
                save_state(state_file,'prepared',task=case['task'],task_sha256=case['task_sha256'],image_id=case['image_id'],bundle_sha256=plan['manifest']['archive_sha256'])
                config_file=output/'configs'/(cfg['job_name']+'.json');atomic_json(config_file,cfg)
                save_state(state_file,'solving')
                print(json.dumps({'starting':cfg['job_name']}),flush=True)
                env={**os.environ,'PYTHONPATH':str(ROOT/'benchmarks'),'DOCKER_DEFAULT_PLATFORM':'linux/amd64','LITELLM_LOCAL_MODEL_COST_MAP':'True'}
                status=run_logged([sys.executable,'-m','harbor.cli.main','run','--config',str(config_file)],config_file.with_suffix('.log'),env)
                state=inspect_job(job);save_state(state_file,state.pop('phase'),harbor_exit_code=status,**state)
                report(plan_path);print(json.dumps({'finished':cfg['job_name'],'exit_code':status}),flush=True)
        return report(plan_path)

def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('prepare');p.add_argument('--previous-plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    for name in ('run','report'):
        p=sub.add_parser(name);p.add_argument('--plan',type=Path,required=True)
    args=parser.parse_args()
    if args.action=='prepare':print(json.dumps(prepare(args.previous_plan,args.output)['manifest']))
    elif args.action=='run':print(json.dumps(run(args.plan)['summary']))
    else:print(json.dumps(report(args.plan)['summary']))
if __name__=='__main__':main()
