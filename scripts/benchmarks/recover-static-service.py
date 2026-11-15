"""Verifier-only replay of a proven stateless Python static server; never replays agent commands."""
import argparse
import ast
import hashlib
import json
import re
import subprocess
import time
import tomllib
from pathlib import Path
from codenode_benchmarks.recovery import atomic_json,sha,tree_sha

def service_arguments(log):
    choices=set()
    for line in Path(log).read_text(errors='replace').splitlines():
        try:event=json.loads(line)
        except ValueError:continue
        delta=event.get('delta',{});calls=delta.get('toolCalls',[])
        if delta.get('kind')!='tool_result' or not isinstance(calls,list):continue
        for call in calls:
            if call.get('name')!='execute_shell' or not call.get('ok') or call.get('data',{}).get('exitCode')!=0:continue
            args=call.get('args') or {}
            if isinstance(args,str):args=json.loads(args)
            match=re.search(r'subprocess\.Popen\(\[sys\.executable,([^\]]+)\]',args.get('command',''))
            if not match:continue
            values=ast.literal_eval('['+match.group(1)+']')
            if len(values)==7 and values[:2]==['-m','http.server'] and values[3:6]==['--bind','0.0.0.0','--directory'] and values[2].isdigit() and 1<=int(values[2])<=65535 and values[6].startswith('/'):
                choices.add(tuple(values))
    if len(choices)!=1:raise ValueError('Need one successfully executed, stateless Python http.server configuration')
    return list(next(iter(choices)))

def recover(checkpoint,task,output,filesystem_only=False):
    checkpoint=Path(checkpoint).resolve();task=Path(task).resolve();output=Path(output).resolve()
    saved=json.loads(checkpoint.read_text())
    for name,digest in saved['artifacts'].items():
        if name not in {'trajectory.json','codenode.jsonl','manifest.json','prediction.patch'} or sha(checkpoint.parent/name)!=digest:raise ValueError('Agent artifact mismatch')
    if tree_sha(task)!=saved['task_sha256']:raise ValueError('Task/verifier fingerprint changed')
    image=json.loads(subprocess.check_output(['docker','image','inspect',saved['solved_image']],text=True))[0]
    if image['Id']!=saved['solved_image'] or image['Config'].get('User','') not in ('','root','0'):raise ValueError('Unsupported image identity/user')
    arguments=['infinity'] if filesystem_only else service_arguments(checkpoint.parent/'codenode.jsonl')
    executable='sleep' if filesystem_only else 'python'
    if output.exists() and any(output.iterdir()):raise ValueError('Recovery output must be new; original records are retained')
    output.mkdir(parents=True)
    config=tomllib.loads((task/'task.toml').read_text());verifier=config.get('verifier',{});environment=config.get('environment',{})
    if verifier.get('env'):raise ValueError('Additional verifier environment needs secure explicit restoration')
    container='codenode-static-regrade-'+hashlib.sha256((sha(checkpoint)+str(output)).encode()).hexdigest()[:16]
    inputs={'checkpoint':str(checkpoint),'checkpoint_sha256':sha(checkpoint),'task_sha256':saved['task_sha256'],'image':saved['solved_image'],
      'restored_service':None if filesystem_only else ['python',*arguments],
      'restoration_mode':'operator-audited-filesystem-only' if filesystem_only else 'recorded-stateless-http-server',
      'agent_command_replayed':False,'model_requests':0,
      'preparation_environment':{'UV_OFFLINE':'1'},'reason':'Original grading failed while fetching dependencies, before test execution'}
    atomic_json(output/'inputs.json',inputs)
    try:
        subprocess.run(['docker','run','-d','--name',container,'--entrypoint',executable,'--cpus',str(environment.get('cpus',1)),
          '--memory',str(environment.get('memory') or str(environment.get('memory_mb',4096))+'M'),
          '--mount',f'type=bind,source={task / "tests"},target=/tests,readonly','--mount',f'type=bind,source={output},target=/logs/verifier',saved['solved_image'],*arguments],check=True,capture_output=True,text=True)
        # Socket readiness only; no benchmark assertions or changes to saved source files.
        if not filesystem_only:subprocess.run(['docker','exec',container,'python','-c',f'import socket,time\nfor i in range(50):\n try:\n  s=socket.create_connection(("127.0.0.1",{int(arguments[2])}),1);s.close();break\n except OSError: time.sleep(.1)\nelse: raise RuntimeError("service not ready")'],check=True,capture_output=True)
        with (output/'test-stdout.txt').open('w') as log:
            result=subprocess.run(['docker','exec','-e','UV_OFFLINE=1',container,'bash','/tests/test.sh'],stdout=log,stderr=subprocess.STDOUT,timeout=float(verifier.get('timeout_sec',300)),check=False)
        reward_file=output/'reward.txt';reward=float(reward_file.read_text()) if reward_file.exists() else None
        value={**inputs,'exit_code':result.returncode,'reward':reward,'original_results_unchanged':True}
        atomic_json(output/'recovery.json',value);return value
    finally:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--checkpoint',type=Path,required=True);p.add_argument('--task',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--confirm-filesystem-only',action='store_true',help='Operator confirms from the original task contract that no live process/memory state is required')
    args=p.parse_args();print(json.dumps(recover(args.checkpoint,args.task,args.output,args.confirm_filesystem_only),indent=2))
