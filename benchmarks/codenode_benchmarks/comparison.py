"""Paired, preregistered CodeNode/Terminus-2 experiment using pinned local tasks."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

from harbor.models.job.config import JobConfig
from .runtime import ROOT

AGENTS={'codenode':'codenode_benchmarks.agent:CodeNodeAgent',
        'terminus-2':'codenode_benchmarks.baseline:BudgetedTerminus2'}
ADAPTER_FILES=['agent.py','baseline.py','comparison.py']
KNOWN_INVALID={'astropy__astropy-7606':'Reference patch also grades 0: [] versus [unit0] test-ID mismatch'}


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree_sha(path):
    digest=hashlib.sha256()
    for p in sorted(Path(path).rglob('*')):
        if p.is_file():
            digest.update(str(p.relative_to(path)).encode());digest.update(bytes.fromhex(sha(p)))
    return digest.hexdigest()


def warm_recipe(family,name,base):
    uv='0.7.13' if family=='swe' else '0.9.5'
    lines=[f'FROM {base}','USER root',
           'RUN apt-get update && apt-get install -y curl ca-certificates tmux && rm -rf /var/lib/apt/lists/*',
           f'RUN curl -LsSf https://astral.sh/uv/{uv}/install.sh | sh',
           'ENV PATH="/root/.local/bin:${PATH}"']
    if family=='swe':
        lines+=['WORKDIR /testbed','COPY grader-deps.py /opt/codenode-eval/grader-deps.py',
                'RUN uv run /opt/codenode-eval/grader-deps.py']
    elif name.endswith('kv-store-grpc'):
        lines+=['RUN pip install pytest==8.4.2 requests==2.32.5 psutil==7.0.0 pytest-json-ctrf==0.3.5']
    else:
        extras=' -w torch==2.7.0' if name.endswith('torch-tensor-parallelism') else ' -w pip==25.2' if name.endswith('pypi-server') else ''
        lines+=[f'RUN uvx -p 3.13 -w pytest==8.4.1 -w pytest-json-ctrf==0.3.5{extras} pytest --version']
    return '\n'.join(lines)+'\n'


def replace_image(text,image):
    if re.search(r'^docker_image\s*=',text,re.M):
        return re.sub(r'^docker_image\s*=.*$',f'docker_image = {json.dumps(image)}',text,flags=re.M)
    return text.replace('[environment]','[environment]\ndocker_image = '+json.dumps(image),1)


def run_logged(command,log_path,env=None):
    secret=(env or os.environ).get('CODENODE_API_KEY') or (env or os.environ).get('OPENAI_API_KEY')
    with Path(log_path).open('w') as log:
        proc=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        for line in proc.stdout:
            if secret:line=line.replace(secret,'[REDACTED]')
            log.write(line);log.flush()
        return proc.wait()


def prepare(previous,output,build_proxy=None):
    previous=Path(previous).resolve();output=Path(output).resolve()
    if output.exists() and any(output.iterdir()):raise ValueError('Output already exists; use run --plan to resume it')
    old=json.loads(previous.read_text());output.mkdir(parents=True,exist_ok=True)
    snapshot=Path(old['swe']['original_batch_summary']['snapshot'])
    frozen=json.loads((snapshot/'manifest.json').read_text())
    bundle=snapshot/'runtime.tar.gz'
    if sha(bundle)!=frozen['archive_sha256']:raise ValueError('Frozen native runtime hash mismatch')
    plan={'created_at':datetime.now(timezone.utc).isoformat(),'previous_report':str(previous),
          'harbor_version':'0.25.0','model':old['model'],'base_url':old['endpoint'],
          'bundle':str(bundle),'bundle_sha256':sha(bundle),'native_source_sha256':frozen['source_sha256'],
          'adapter_sha256':{name:sha(Path(__file__).parent/name) for name in ADAPTER_FILES},
          'limits':{'request_seconds':300,'turns':60,'tokens':600000,'actions':100,'workers':1},
          'known_invalid_before_run':KNOWN_INVALID,'build_proxy':build_proxy,'cases':[]}
    for family in ('swe','terminal'):
        for row in old[family]['cases']:
            prior=Path(row['result_path']).parent
            config=json.loads((prior/'config.json').read_text())
            task=config['task'];name=row['task'];slug=name.rsplit('/',1)[-1]
            if family=='swe':source=Path(task['path'])
            else:source=Path.home()/'.cache/harbor/tasks/packages'/name/task['ref'].removeprefix('sha256:')
            source=source.resolve();original=tomllib.loads((source/'task.toml').read_text())
            image=original['environment'].get('docker_image')
            if not image:
                dockerfile=(source/'environment/Dockerfile').read_text()
                image=re.search(r'^FROM\s+(\S+)',dockerfile,re.M).group(1)
            probe=subprocess.run(['docker','image','inspect',image],capture_output=True,text=True)
            if probe.returncode:
                print(json.dumps({'fetching_base_image':image}),flush=True)
                subprocess.run(['docker','pull','--platform','linux/amd64',image],check=True)
                probe=subprocess.run(['docker','image','inspect',image],capture_output=True,text=True,check=True)
            inspect=json.loads(probe.stdout)[0]
            digests=inspect.get('RepoDigests') or []
            if not digests:raise ValueError('Need immutable public base digest: '+image)
            base=digests[0]
            context=output/'prewarm'/slug;context.mkdir(parents=True)
            (context/'Dockerfile').write_text(warm_recipe(family,name,base))
            (context/'grader-deps.py').write_text('# /// script\n# requires-python = ">=3.11"\n# dependencies = ["swebench==4.0.3", "datasets==2.16.1", "fastcore<1.11"]\n# ///\nprint("grading dependencies ready; no benchmark tests or solutions included")\n')
            image_tag='codenode-paired-'+slug.lower()+':'+output.name.lower().removeprefix('comparison-')
            target=output/'tasks'/family/slug
            shutil.copytree(source,target)
            (target/'task.toml').write_text(replace_image((target/'task.toml').read_text(),image_tag))
            case={'family':family,'task':name,'slug':slug,'original_path':str(source),
                  'original_sha256':tree_sha(source),'task_path':str(target),
                  'prepared_sha256':tree_sha(target),'base_image':base,'base_image_id':inspect['Id'],
                  'prepared_image':image_tag,'warm_context':str(context),
                  'warm_recipe_sha256':sha(context/'Dockerfile'),
                  'warm_helper_sha256':sha(context/'grader-deps.py'),
                  'order':['codenode','terminus-2'] if len(plan['cases'])%2==0 else ['terminus-2','codenode']}
            plan['cases'].append(case)
    (output/'plan.json').write_text(json.dumps(plan,indent=2))
    print(json.dumps({'plan':str(output/'plan.json'),'cases':len(plan['cases']),'model_trials':2*len(plan['cases'])}),flush=True)
    return plan


def build_images(plan,output):
    for case in plan['cases']:
        marker=output/'prewarm'/case['slug']/'image.json'
        if sha(Path(case['warm_context'])/'Dockerfile')!=case['warm_recipe_sha256']:
            raise ValueError('Warm recipe changed')
        if case.get('warm_helper_sha256') and sha(Path(case['warm_context'])/'grader-deps.py')!=case['warm_helper_sha256']:
            raise ValueError('Warm dependency helper changed')
        if marker.exists():continue
        print(json.dumps({'prewarming':case['task']}),flush=True)
        cmd=['docker','build','--platform','linux/amd64','-t',case['prepared_image']]
        if plan.get('build_proxy'):
            cmd+=['--build-arg','HTTP_PROXY='+plan['build_proxy'],'--build-arg','HTTPS_PROXY='+plan['build_proxy']]
        cmd+=[case['warm_context']]
        status=run_logged(cmd,marker.with_suffix('.log'))
        if status:raise RuntimeError('Neutral environment preparation failed; inspect '+str(marker.with_suffix('.log')))
        metadata=json.loads(subprocess.check_output(['docker','image','inspect',case['prepared_image']],text=True))[0]
        marker.write_text(json.dumps({'id':metadata['Id'],'base':case['base_image'],'recipe_sha256':case['warm_recipe_sha256']},indent=2))
        print(json.dumps({'prepared':case['task'],'image_id':metadata['Id']}),flush=True)


def job_config(plan,output,case,agent,index):
    common={'model_name':plan['model'],'base_url':plan['base_url'],'override_setup_timeout_sec':600}
    if agent=='codenode':
        kwargs={'bundle_path':plan['bundle'],'workspace':'/testbed' if case['family']=='swe' else '/',
                'max_iterations':60,'turn_timeout':300}
    else:
        kwargs={'max_turns':60,'max_total_tokens':600000,'max_commands':100,'turn_timeout':300,
                'record_terminal_session':False,'llm_kwargs':{'num_retries':0,'timeout':300}}
    config={'job_name':f'{index:02d}-{agent}-{case["slug"]}','jobs_dir':str(output/'jobs'),
            'n_concurrent_trials':1,'n_attempts':1,'retry':{'max_retries':0},
            'agents':[{'import_path':AGENTS[agent],**common,'kwargs':kwargs}],
            'tasks':[{'path':case['task_path']}]}
    return JobConfig.model_validate(config).model_dump(mode='json',exclude_none=True)


def run(plan_path):
    plan_path=Path(plan_path).resolve();output=plan_path.parent;plan=json.loads(plan_path.read_text())
    if not (os.getenv('CODENODE_API_KEY') or os.getenv('OPENAI_API_KEY')):raise ValueError('Explicit API credential required')
    if sha(plan['bundle'])!=plan['bundle_sha256']:raise ValueError('Native runtime changed')
    for name,fingerprint in plan['adapter_sha256'].items():
        if sha(Path(__file__).parent/name)!=fingerprint:raise ValueError('Adapter changed after preregistration: '+name)
    build_images(plan,output)
    (output/'configs').mkdir(exist_ok=True)
    for index,case in enumerate(plan['cases']):
        if tree_sha(case['task_path'])!=case['prepared_sha256']:raise ValueError('Prepared task changed')
        image=json.loads(subprocess.check_output(['docker','image','inspect',case['prepared_image']],text=True))[0]
        expected=json.loads((output/'prewarm'/case['slug']/'image.json').read_text())['id']
        if image['Id']!=expected:raise ValueError('Prepared image changed')
        for agent in case['order']:
            config=job_config(plan,output,case,agent,index)
            job=output/'jobs'/config['job_name']
            if job.exists():
                results=[p for p in job.glob('*/result.json') if json.loads(p.read_text()).get('task_name')]
                if len(results)==1 and json.loads(results[0].read_text()).get('finished_at'):continue
                raise ValueError('Incomplete job needs inspection before resume: '+str(job))
            # Child processes import adapters afresh: recheck at every launch,
            # including between the two arms of a pair.
            if sha(plan['bundle'])!=plan['bundle_sha256']:raise ValueError('Native runtime changed during experiment')
            for name,fingerprint in plan['adapter_sha256'].items():
                if sha(Path(__file__).parent/name)!=fingerprint:raise ValueError('Adapter changed during experiment: '+name)
            if tree_sha(case['task_path'])!=case['prepared_sha256']:raise ValueError('Task changed between paired launches')
            current=json.loads(subprocess.check_output(['docker','image','inspect',case['prepared_image']],text=True))[0]
            if current['Id']!=expected:raise ValueError('Image changed between paired launches')
            path=output/'configs'/(config['job_name']+'.json');path.write_text(json.dumps(config,indent=2))
            print(json.dumps({'starting':case['task'],'agent':agent}),flush=True)
            env={**os.environ,'PYTHONPATH':str(ROOT/'benchmarks'),'DOCKER_DEFAULT_PLATFORM':'linux/amd64',
                 'LITELLM_LOCAL_MODEL_COST_MAP':'True'}
            status=run_logged([sys.executable,'-m','harbor.cli.main','run','--config',str(path)],path.with_suffix('.log'),env)
            print(json.dumps({'finished':case['task'],'agent':agent,'harbor_exit_code':status}),flush=True)
            report(plan_path)
    return report(plan_path)


def report(plan_path):
    plan_path=Path(plan_path).resolve();output=plan_path.parent;plan=json.loads(plan_path.read_text())
    rows=[]
    for index,case in enumerate(plan['cases']):
        pair={'task':case['task'],'family':case['family'],'known_invalid':case['task'] in plan['known_invalid_before_run'],'agents':{}}
        for agent in AGENTS:
            config=job_config(plan,output,case,agent,index)
            files=list((output/'jobs'/config['job_name']).glob('*/result.json'))
            if not files:continue
            if len(files)!=1:raise ValueError('Unexpected duplicate attempts')
            result=json.loads(files[0].read_text())
            if result.get('task_name')!=case['task']:raise ValueError('Result does not match preregistered task')
            reward=((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')
            pair['agents'][agent]={'reward':reward,'exception_type':(result.get('exception_info') or {}).get('exception_type'),
                                   'agent_result':result.get('agent_result'),'result_path':str(files[0])}
        rows.append(pair)
    summary={}
    for agent in AGENTS:
        completed=[r for r in rows if agent in r['agents']]
        valid=[r for r in completed if not r['known_invalid']]
        summary[agent]={'completed':len(completed),'total':len(rows),
                        'resolved':sum(r['agents'][agent]['reward']==1 for r in completed),
                        'ungraded':sum(r['agents'][agent]['reward'] is None for r in completed),
                        'valid_resolved':sum(r['agents'][agent]['reward']==1 for r in valid),
                        'valid_total':sum(not r['known_invalid'] for r in rows)}
    paired={'codenode_wins':0,'terminus_wins':0,'ties':0,'not_comparable':0}
    for row in rows:
        values=[row['agents'].get(a,{}).get('reward') for a in AGENTS]
        if row['known_invalid'] or any(v is None for v in values):paired['not_comparable']+=1
        elif values[0]>values[1]:paired['codenode_wins']+=1
        elif values[1]>values[0]:paired['terminus_wins']+=1
        else:paired['ties']+=1
    complete=all(len(r['agents'])==len(AGENTS) for r in rows)
    data={'plan_path':str(plan_path),'complete':complete,'summary':summary,'paired':paired,'cases':rows}
    (output/'comparison-results.json').write_text(json.dumps(data,indent=2))
    lines=['# CodeNode / Terminus-2 同模型对照','',
           '状态：'+('全部任务已结束。' if complete else '尚未完成；下表已结束列为当前进度，不是最终成绩。'),
           '模型 '+plan['model']+'；每组同样 10 题，单题首次尝试；同一预热镜像、并发 1、每次请求 300 秒、60 轮及 600000 Token 预算。',
           '本轮两组均预装评分依赖、保持测试原文与官方时限。预热也改变了初始环境，因此与上一轮 120 秒成绩的差异不能单独归因为请求超时。',
           '已事先标记 astropy 首题的测试 ID 判分异常：保留原始 reward，单列有效题目统计；未评分仍在全部题目分母中。','',
           '| Agent | 已结束 | 原始通过/全部 | 有效题通过/全部 | 未评分 |',
           '| --- | ---: | ---: | ---: | ---: |']
    for a,s in summary.items():lines.append(f'| {a} | {s["completed"]} | {s["resolved"]}/{s["total"]} | {s["valid_resolved"]}/{s["valid_total"]} | {s["ungraded"]} |')
    lines+=['','| 任务 | CodeNode | Terminus-2 | 备注 |','| --- | --- | --- | --- |']
    for row in rows:
        cells=[]
        for a in AGENTS:
            value=row['agents'].get(a)
            cells.append('未结束' if not value else '未评分' if value['reward'] is None else str(value['reward']))
        lines.append('| '+row['task']+' | '+' | '.join(cells)+' | '+('预先标记的判分异常' if row['known_invalid'] else '')+' |')
    lines+=['','配对统计：'+json.dumps(paired,ensure_ascii=False)+'。',
            '原生工具调用与参考 Agent 的终端命令是不同动作单位；两组各设 100 次防失控上限。Token 预留使用 CodeNode 相同的文本字节估算规则，缺少实际 usage 时保留整次预留，不按免费请求处理。',
            'Terminus-2 的求解提示词、JSON 解析、终端反馈与压缩流程保留固定 Harbor 原实现；外层仅添加相同资源上限、请求计账和 SWE 补丁收集。API 金额未知，不能将默认 0 当作实际费用。',
            '',f'[固定输入与环境清单]({plan_path}) · [逐题原始结果]({output/"comparison-results.json"})','']
    (output/'comparison-report.md').write_text('\n'.join(lines))
    return data


def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('prepare');p.add_argument('--previous-report',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--build-proxy')
    for name in ('warm','run','report'):
        p=sub.add_parser(name);p.add_argument('--plan',type=Path,required=True)
    args=parser.parse_args()
    if args.action=='prepare':prepare(args.previous_report,args.output,args.build_proxy)
    elif args.action=='warm':build_images(json.loads(args.plan.read_text()),args.plan.resolve().parent)
    elif args.action=='run':run(args.plan)
    else:print(json.dumps(report(args.plan)['summary'],indent=2))


if __name__=='__main__':main()
