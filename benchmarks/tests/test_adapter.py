from pathlib import Path
import json
import os
import tempfile
import subprocess
import sys
import unittest
import tarfile
from unittest.mock import patch
from types import SimpleNamespace

from harbor.models.trajectories import Trajectory
from harbor.models.agent.context import AgentContext
from codenode_benchmarks.runtime import build_bundle
from codenode_benchmarks.agent import CodeNodeAgent
from codenode_benchmarks.results import to_atif, export_predictions, summarize
from codenode_benchmarks.cli import parser, command


class AdapterTests(unittest.TestCase):
    def test_snapshot_excludes_private_and_answers(self):
        with tempfile.TemporaryDirectory() as d:
            bundle=Path(d)/'runtime.tar.gz'
            manifest=build_bundle(bundle)
            self.assertEqual(len(manifest['source_sha256']),64)
            with tarfile.open(bundle) as tar:
                names=tar.getnames()
            self.assertIn('bin/codenode-agent.cjs',names)
            self.assertIn('node_modules/@typescript/typescript6/lib/typescript.js',names)
            self.assertFalse(any(name.startswith(('.git/','docs/','benchmarks/','scripts/')) for name in names))
            self.assertNotIn('config/agent.properties',names)
            self.assertNotIn('config/soul.md',names)
            self.assertNotIn('config/project-eval.example.json',names)

    def test_native_trajectory_and_context(self):
        events=[{'kind':'benchmark_context','system':'rules','prompt':'fix','tools':[]},{'kind':'event','delta':{'kind':'tool_result','toolCalls':[{'id':'c1','name':'write_file','args':{'path':'a'},'result':'written'}]}},{'kind':'result','content':'done','state':'COMPLETED','cost':{'promptTokens':10,'completionTokens':4,'promptCachedTokens':2,'costKnown':False}}]
        trajectory=to_atif(events,'0.13.0','openai/test')
        self.assertEqual(len(Trajectory.model_validate(trajectory).steps),4)
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d);(directory/'codenode.jsonl').write_text('\n'.join(json.dumps(e) for e in events))
            agent=CodeNodeAgent(logs_dir=directory,model_name='openai/test')
            context=AgentContext();agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens,10);self.assertIsNone(context.cost_usd)

    def test_failed_tasks_stay_in_denominator_and_export(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for i,reward in [(1,1),(2,0),(3,None)]:
                directory=root/str(i);directory.mkdir()
                (directory/'result.json').write_text(json.dumps({'task_name':f'fixture__repo-{i}','verifier_result':{'rewards':{'reward':reward}} if reward is not None else None,'exception_info':{'exception_type':'failure'} if i==3 else None}))
            report=summarize(root);self.assertEqual(report['total'],3);self.assertEqual(report['resolved'],1);self.assertEqual(report['errors'],1);self.assertEqual(report['ungraded'],1)
            export=root/'prediction.jsonl';self.assertEqual(export_predictions(root,export,'model'),3)
            self.assertTrue(all(row['model_patch']=='' for row in map(json.loads,export.read_text().splitlines())))

    def test_cli_uses_our_agent_and_pinned_datasets(self):
        args=parser().parse_args(['run','swebench-verified','--model','openai/test','--dry-run'])
        cmd=command(args,Path('/tmp/snapshot-123/runtime.tar.gz'))
        self.assertEqual(cmd[0],sys.executable)
        # The npm wrapper selects a venv without activating its bin directory.
        probe=subprocess.run(cmd[:3]+['--help'],env={**os.environ,'PATH':os.defpath},capture_output=True,text=True)
        self.assertEqual(probe.returncode,0,probe.stderr)
        self.assertIn('swebench-verified@1.0',cmd);self.assertIn('codenode_benchmarks.agent:CodeNodeAgent',cmd);self.assertIn('workspace=/testbed',cmd)
        args=parser().parse_args(['run','terminal-bench','--model','openai/test','--dry-run'])
        self.assertIn('terminal-bench/terminal-bench-2-1@6',command(args,Path('/tmp/snapshot-123/runtime.tar.gz')))


class FailedExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_task_cwd_is_independent_of_access_root(self):
        class Agent(CodeNodeAgent):
            @property
            def model_connection(self):
                return SimpleNamespace(api_key='fixture',env={},execution_base_url='http://fixture.invalid/v1')

            async def exec_as_agent(self, environment, command, **kwargs):
                if 'codenode-agent.cjs --benchmark' in command:
                    environment.invocation = (command, kwargs)
                return SimpleNamespace(return_code=0, stdout='')

        class Environment:
            def __init__(self): self.uploaded = {}
            async def exec(self, command, **kwargs):
                return SimpleNamespace(return_code=0,stdout='/app' if command=='pwd' else '')
            async def upload_file(self, source, destination): self.uploaded[destination] = Path(source).read_text()
            async def download_file(self, source, destination):
                Path(destination).write_text(json.dumps({'kind':'result','state':'COMPLETED','cost':{}}) if source.endswith('codenode.jsonl') else '')

        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); contract=root/'acceptance.json'
            contract.write_text(json.dumps({'version':1,'artifacts':[{'id':'public-file','path':'answer.txt'}]}))
            agent=Agent(logs_dir=root/'logs',model_name='openai/test',workspace='/',acceptance_file=contract)
            environment=Environment()
            await agent.run('create answer.txt',environment,AgentContext())
            command,kwargs=environment.invocation
            self.assertIn('--project /app --access-root /',command)
            self.assertIn('--acceptance-file ',command)
            self.assertEqual(kwargs['cwd'],'/app')
            manifest=json.loads((root/'logs/manifest.json').read_text())
            self.assertEqual(manifest['workspace'],'/')
            self.assertEqual(manifest['projectRoot'],'/app')
            self.assertEqual(manifest['logDirectory'],'/app/.codenode')
            prompt=next(value for name,value in environment.uploaded.items() if name.endswith('/instruction.txt'))
            self.assertIn('POSIX /bin/sh -c',prompt)

    async def test_partial_swe_patch_survives_native_failure(self):
        class FailingAgent(CodeNodeAgent):
            @property
            def model_connection(self):
                return SimpleNamespace(api_key='fixture',env={},execution_base_url='http://fixture.invalid/v1')

            async def exec_as_agent(self,environment,command,**kwargs):
                if 'codenode-agent.cjs --benchmark' in command:
                    raise RuntimeError('native request timeout')
                return SimpleNamespace(return_code=0,stdout='')

        class Environment:
            uploaded={}

            async def exec(self,command,**kwargs):
                output='/testbed' if command=='pwd' else 'partial prediction' if command.startswith('git add') else ''
                return SimpleNamespace(return_code=0,stdout=output)

            async def upload_file(self,source,destination):
                self.uploaded[destination]=Path(source).read_text()

            async def download_file(self,source,destination):
                Path(destination).write_text(json.dumps({'kind':'result','state':'FAILED','cost':{}}) if source.endswith('codenode.jsonl') else '')

        with tempfile.TemporaryDirectory() as d:
            agent=FailingAgent(logs_dir=Path(d),model_name='openai/test',workspace='/testbed')
            environment=Environment();context=AgentContext()
            with self.assertRaisesRegex(RuntimeError,'native request timeout'):
                await agent.run('fix issue',environment,context)
            self.assertEqual((Path(d)/'prediction.patch').read_text(),'partial prediction')
            self.assertTrue(any(path.endswith('/prediction.patch') and value=='partial prediction' for path,value in environment.uploaded.items()))
            self.assertEqual(context.metadata['codenode_state'],'FAILED')


if __name__=='__main__':
    unittest.main()
