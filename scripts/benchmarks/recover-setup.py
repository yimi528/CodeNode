"""Continue only preregistered slots proven to have failed before agent execution."""
import argparse
import json
import os
from pathlib import Path
import sys
from filelock import FileLock
from codenode_benchmarks.native_ab import config,verify
from codenode_benchmarks.comparison import run_logged,sha
from codenode_benchmarks.recovery import atomic_json,inspect_job
from codenode_benchmarks.runtime import ROOT

def prepare(plan_path,node_archive,node_sha256):
    plan_path=Path(plan_path).resolve();output=plan_path.parent;plan=json.loads(plan_path.read_text());verify(plan)
    node_archive=Path(node_archive).resolve()
    if sha(node_archive)!=node_sha256:raise ValueError('Offline Node checksum mismatch')
    items=[]
    for index,case in enumerate(plan['cases']):
        for arm in case['order']:
            cfg=config(plan,output,case,index,arm);files=list((output/'jobs'/cfg['job_name']).glob('*/result.json'))
            if len(files)!=1:continue
            file=files[0];result=json.loads(file.read_text())
            if (result.get('agent_execution') or {}).get('started_at'):continue
            usage=result.get('agent_result') or {}
            if any((usage.get(key) or 0)>0 for key in ('n_input_tokens','n_output_tokens')):raise ValueError('Usage exists despite missing execution timing; manual inspection required')
            if (result.get('exception_info') or {}).get('exception_type')!='URLError':continue
            log=file.parent/'agent/codenode.jsonl'
            if log.exists() and log.stat().st_size:raise ValueError('Unexpected model log in a preparation-only failure')
            if ((result.get('verifier_result') or {}).get('rewards') or {}).get('reward') is not None:raise ValueError('Cannot replace a graded attempt')
            if result.get('task_name')!=case['task']:raise ValueError('Task identity mismatch')
            items.append({'index':index,'arm':arm,'job_name':cfg['job_name'],'original_result':str(file),'original_result_sha256':sha(file)})
    recovery={'original_plan':str(plan_path),'original_plan_sha256':sha(plan_path),'node_archive':str(node_archive),
      'node_sha256':node_sha256,'reason':'Node checksum hostname DNS failed during installation; no agent execution or model log',
      'policy':'Only not-yet-started first model attempts. Never retry an executed agent. Original results retained.','items':items}
    target=output/'setup-recovery/plan.json'
    if target.exists():
        if json.loads(target.read_text())!=recovery:raise ValueError('Setup recovery inputs changed')
    else:atomic_json(target,recovery)
    return recovery

def run(recovery_path):
    recovery_path=Path(recovery_path).resolve();recovery=json.loads(recovery_path.read_text());directory=recovery_path.parent
    if not os.getenv('CODENODE_API_KEY'):raise ValueError('Explicit credential required')
    source=Path(recovery['original_plan']);plan=json.loads(source.read_text());output=source.parent
    if sha(source)!=recovery['original_plan_sha256'] or sha(recovery['node_archive'])!=recovery['node_sha256']:raise ValueError('Recovery input integrity mismatch')
    results=[]
    with FileLock(str(directory/'run.lock'),timeout=0):
        for item in recovery['items']:
            if sha(item['original_result'])!=item['original_result_sha256']:raise ValueError('Original record changed')
            original=json.loads(Path(item['original_result']).read_text())
            if (original.get('agent_execution') or {}).get('started_at'):raise ValueError('Refusing a second model attempt')
            case=plan['cases'][item['index']];verify(plan,case)
            cfg=config(plan,output,case,item['index'],item['arm']);cfg['jobs_dir']=str(directory/'jobs')
            cfg['agents'][0]['kwargs'].update({'node_archive_path':recovery['node_archive'],'node_sha256':recovery['node_sha256']})
            job=directory/'jobs'/cfg['job_name'];config_file=directory/'configs'/(cfg['job_name']+'.json')
            if not job.exists() and not config_file.exists():
                atomic_json(config_file,cfg)
                print(json.dumps({'starting_first_model_attempt':cfg['job_name']}),flush=True)
                env={**os.environ,'PYTHONPATH':str(ROOT/'benchmarks'),'DOCKER_DEFAULT_PLATFORM':'linux/amd64','LITELLM_LOCAL_MODEL_COST_MAP':'True'}
                status=run_logged([sys.executable,'-m','harbor.cli.main','run','--config',str(config_file)],config_file.with_suffix('.log'),env)
                print(json.dumps({'finished':cfg['job_name'],'exit_code':status}),flush=True)
            state=inspect_job(job);results.append({**item,'task':case['task'],**state})
            atomic_json(directory/'results.json',{'original_results_unchanged':True,'no_executed_agent_retried':True,'items':results})
    return results

if __name__=='__main__':
    p=argparse.ArgumentParser();mode=p.add_mutually_exclusive_group(required=True);mode.add_argument('--original-plan',type=Path);mode.add_argument('--run',type=Path)
    p.add_argument('--node-archive',type=Path);p.add_argument('--node-sha256')
    args=p.parse_args()
    if not args.run and (not args.node_archive or not args.node_sha256):p.error('preparation requires --node-archive and --node-sha256')
    if args.run:run(args.run)
    else:print(json.dumps({'eligible_first_attempts':len(prepare(args.original_plan,args.node_archive,args.node_sha256)['items'])}))
