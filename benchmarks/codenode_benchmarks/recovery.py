"""Atomic evaluation state and verifier-only recovery. Never calls an agent/model."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timezone

def sha(file): return hashlib.sha256(Path(file).read_bytes()).hexdigest()

def atomic_json(file, value):
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix=file.name+'.',suffix='.tmp',dir=file.parent)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,indent=2);stream.flush();os.fsync(stream.fileno())
        os.replace(name,file)
    finally:
        Path(name).unlink(missing_ok=True)

def tree_sha(root):
    digest=hashlib.sha256()
    for file in sorted(Path(root).rglob('*')):
        if file.is_symlink():raise ValueError('Snapshot inputs must not contain symlinks')
        if file.is_file():digest.update(str(file.relative_to(root)).encode()+b'\0'+bytes.fromhex(sha(file)))
    return digest.hexdigest()

def grading_status(trial, result):
    trial=Path(trial)
    output='\n'.join(file.read_text(errors='replace')[-100000:] for file in (trial/'verifier').glob('*.txt')) if (trial/'verifier').exists() else ''
    network=bool(re.search(r'could not resolve|failed to establish|connection (?:timed out|refused)|network is unreachable|temporary failure|failed to download|proxyerror|no matching distribution',output,re.I))
    started=bool(re.search(r'collected \d+ items?|\d+ (?:passed|failed)|test session starts',output,re.I))
    if network and not started:return 'startup_failed'
    if result.get('exception_info') and not (result.get('verifier_result') or {}).get('rewards'):return 'verifier_error'
    reward=((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')
    return 'graded' if reward is not None else 'ungraded'

def save_state(file, phase, **details):
    file=Path(file)
    old=json.loads(file.read_text()) if file.exists() else {}
    history=old.get('history',[])
    entry={'phase':phase,'at':datetime.now(timezone.utc).isoformat()}
    if not history or history[-1]['phase']!=phase:history.append(entry)
    value={**old,**details,'phase':phase,'history':history}
    atomic_json(file,value);return value

def inspect_job(job):
    job=Path(job);results=[p for p in job.glob('*/result.json') if json.loads(p.read_text()).get('task_name')]
    if len(results)>1:raise ValueError('Duplicate inference attempts detected')
    if results:
        result=json.loads(results[0].read_text());status=grading_status(results[0].parent,result)
        phase='complete' if result.get('finished_at') and status=='graded' else 'grading_pending'
        if result.get('exception_info') and not (result.get('agent_execution') or {}).get('started_at') and not ((result.get('verifier_result') or {}).get('rewards') or {}):phase='preparation_failed'
        elif status=='startup_failed':phase='grading_startup_failed'
        return {'phase':phase,
                'result_path':str(results[0]),'grading_status':status,'original_reward':((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')}
    checkpoints=list(job.glob('*/agent/solve-checkpoint.json'))
    if len(checkpoints)>1:raise ValueError('Duplicate solve checkpoints')
    return {'phase':'solve_complete' if checkpoints else 'interrupted','checkpoint':str(checkpoints[0]) if checkpoints else None}

def checkpoint_environment(environment, logs_dir, workspace, manifest):
    """Snapshot the solved Docker filesystem before the official verifier modifies it."""
    from harbor.environments.docker.docker import _sanitize_docker_compose_project_name
    project=_sanitize_docker_compose_project_name(environment.session_id)
    ids=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=main'],text=True).split()
    if len(ids)!=1:raise ValueError('Need one identified Docker main service for a solve checkpoint')
    inspect=json.loads(subprocess.check_output(['docker','inspect',ids[0]],text=True))[0]
    committed=subprocess.check_output(['docker','commit',ids[0]],text=True,timeout=180)
    image=next((line.strip() for line in committed.splitlines() if re.fullmatch(r'sha256:[0-9a-f]{64}',line.strip())),None)
    if not image:raise ValueError('Invalid solved image identity')
    if json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]['Id']!=image:raise ValueError('Solved image inspection mismatch')
    logs_dir=Path(logs_dir)
    artifacts={file.name:sha(file) for file in logs_dir.iterdir() if file.is_file() and file.name in ('prediction.patch','trajectory.json','codenode.jsonl','manifest.json')}
    value={'version':1,'phase':'solve_complete','container_id':ids[0],'solved_image':image,'base_image':inspect['Image'],
           'workspace':workspace,'projectRoot':manifest.get('projectRoot',workspace),'workingDirectory':manifest.get('workingDirectory',workspace),
           'accessRoot':manifest.get('accessRoot',workspace),'logDirectory':manifest.get('logDirectory',str(Path(workspace)/'.codenode')),'filesystem_replay_supported':workspace=='/testbed','runtime_source_sha256':manifest.get('source_sha256'),
           'artifacts':artifacts,'created_at':datetime.now(timezone.utc).isoformat()}
    atomic_json(logs_dir/'solve-checkpoint.json',value);return value

def recover_grading(checkpoint,task,output):
    checkpoint=Path(checkpoint).resolve();task=Path(task).resolve();output=Path(output).resolve()
    saved=json.loads(checkpoint.read_text())
    if not saved.get('filesystem_replay_supported'):raise ValueError('This task may require live processes; filesystem-only replay is not safe')
    for name,digest in saved['artifacts'].items():
        if sha(checkpoint.parent/name)!=digest:raise ValueError('Saved agent artifact changed: '+name)
    fingerprint=tree_sha(task)
    if saved.get('task_sha256')!=fingerprint:raise ValueError('Original verifier/task fingerprint does not match')
    image=json.loads(subprocess.check_output(['docker','image','inspect',saved['solved_image']],text=True))[0]
    if image['Id']!=saved['solved_image']:raise ValueError('Solved image identity changed')
    if output.exists() and any(output.iterdir()):
        record=output/'recovery.json'
        if record.exists():
            previous=json.loads(record.read_text())
            if previous.get('checkpoint_sha256')!=sha(checkpoint) or previous.get('task_sha256')!=fingerprint or previous.get('image')!=saved['solved_image']:raise ValueError('Existing recovery belongs to different inputs')
            return previous
        raise ValueError('Incomplete recovery output needs inspection; refusing duplicate scoring')
    output.mkdir(parents=True,exist_ok=True)
    import tomllib
    task_config=tomllib.loads((task/'task.toml').read_text());verifier=task_config.get('verifier',{});environment=task_config.get('environment',{})
    if verifier.get('env'):raise ValueError('Verifier environment needs explicit secure restoration; refusing an incomplete replay')
    timeout=float(verifier.get('timeout_sec',300))
    config={'checkpoint':str(checkpoint),'checkpoint_sha256':sha(checkpoint),'task_sha256':fingerprint,'image':saved['solved_image'],'timeout_seconds':timeout}
    atomic_json(output/'inputs.json',config)
    container='codenode-regrade-'+hashlib.sha256(str(output).encode()).hexdigest()[:16]
    command=['docker','run','--rm','--name',container,'--entrypoint','bash','--cpus',str(environment.get('cpus',1)),
      '--memory',str(environment.get('memory') or str(environment.get('memory_mb',4096))+'M'),
      '--mount',f'type=bind,source={task / "tests"},target=/tests,readonly','--mount',f'type=bind,source={output},target=/logs/verifier',saved['solved_image'],'/tests/test.sh']
    status=None;timed_out=False
    try:
        with (output/'recovery-stdout.txt').open('w') as log:
            status=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=timeout,check=False,env={k:v for k,v in os.environ.items() if not k.endswith('API_KEY')}).returncode
    except subprocess.TimeoutExpired:timed_out=True
    finally:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
    reward_file=output/'reward.txt';reward=None
    if reward_file.exists():
        try:reward=float(reward_file.read_text().strip())
        except ValueError:pass
    value={**config,'exit_code':status,'timed_out':timed_out,'reward':reward,'model_requests':0,'original_results_unchanged':True}
    atomic_json(output/'recovery.json',value);return value

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--checkpoint',type=Path,required=True);parser.add_argument('--task',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(recover_grading(args.checkpoint,args.task,args.output),indent=2))
if __name__=='__main__':main()
