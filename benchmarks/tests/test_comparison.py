import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from codenode_benchmarks.baseline import BudgetedTerminus2,CallBudget,ComparisonStop,estimate_text_input
from codenode_benchmarks.comparison import job_config,report,warm_recipe
from codenode_benchmarks.runtime import ROOT
from harbor.llms.base import LLMResponse
from harbor.models.metric import UsageInfo


class ComparisonTests(unittest.TestCase):
    def test_text_budget_matches_native_estimator(self):
        messages=[{'role':'system','content':'rules'},{'role':'user','content':'中文\n"quoted" 😀'},{'role':'assistant','content':'done'}]
        script="const {estimateInputTokens}=require('./electron/requestBudget.cjs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(estimateInputTokens(JSON.parse(s),[])))"
        result=subprocess.run(['node','-e',script],cwd=ROOT,input=json.dumps(messages),text=True,capture_output=True,check=True)
        self.assertEqual(estimate_text_input(messages),int(result.stdout))

    def test_reservation_shrinks_output_and_preserves_unknown_cost(self):
        messages=[{'role':'user','content':'task'}];need=estimate_text_input(messages)
        budget=CallBudget(need+11,2);entry=budget.reserve(messages,32000)
        self.assertEqual(entry['max_output_tokens'],11)
        budget.settle(entry,error='timeout');budget.settle(entry)
        self.assertEqual(budget.used,need+11)
        with self.assertRaises(ComparisonStop):budget.reserve(messages)

    def test_warm_images_do_not_copy_test_or_solution_contents(self):
        recipe=warm_recipe('swe','repo__repo-1','public@sha256:fixture')
        self.assertIn('grader-deps.py',recipe)
        self.assertNotIn('/tests',recipe);self.assertNotIn('/solution',recipe)
        self.assertIn('torch==2.7.0',warm_recipe('terminal','terminal-bench/torch-tensor-parallelism','fixture'))

    def test_missing_rewards_and_preregistered_invalid_tasks_do_not_become_wins(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);plan={'model':'openai/fixture','base_url':'http://localhost','bundle':'/tmp/frozen.tar.gz',
                'known_invalid_before_run':{'bad__repo-1':'oracle mismatch'},'cases':[]}
            for i,(name,a,b) in enumerate([('bad__repo-1',0,0),('missing__repo-2',1,None),('valid__repo-3',0,1)]):
                case={'family':'swe','task':name,'slug':name,'task_path':str(root/name)};plan['cases'].append(case)
                for agent,reward in [('codenode',a),('terminus-2',b)]:
                    cfg=job_config(plan,root,case,agent,i)
                    self.assertEqual(cfg['n_concurrent_trials'],1)
                    self.assertEqual(cfg['retry']['max_retries'],0)
                    self.assertEqual(cfg['agents'][0]['kwargs']['turn_timeout'],300)
                    self.assertEqual(cfg['tasks'][0]['path'],case['task_path'])
                    path=root/'jobs'/cfg['job_name']/'trial';path.mkdir(parents=True)
                    (path/'result.json').write_text(json.dumps({'task_name':name,'verifier_result':{'rewards':{'reward':reward}} if reward is not None else None}))
            path=root/'plan.json';path.write_text(json.dumps(plan));data=report(path)
            self.assertEqual(data['paired'],{'codenode_wins':0,'terminus_wins':1,'ties':0,'not_comparable':2})
            self.assertEqual(data['summary']['terminus-2']['valid_total'],2)
            self.assertEqual(data['summary']['terminus-2']['ungraded'],1)
            result_file=next((root/'jobs').glob('*/trial/result.json'))
            changed=json.loads(result_file.read_text());changed['task_name']='unregistered__repo-99'
            result_file.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'preregistered task'):report(path)


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_reference_transport_budget_timeout_and_no_debug_credential_dump(self):
        class FakeLLM:
            def __init__(self):self.calls=[];self.hang=False
            async def call(self,prompt,**kwargs):
                self.calls.append(kwargs)
                if self.hang:await asyncio.sleep(5)
                return LLMResponse(content='{}',usage=UsageInfo(prompt_tokens=20,completion_tokens=10,cache_tokens=0,cost_usd=0))
        llm=FakeLLM()
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'OPENAI_API_KEY':'fixture'}),patch.object(BudgetedTerminus2,'_init_llm',return_value=llm):
            agent=BudgetedTerminus2(logs_dir=Path(d),model_name='openai/fixture',max_turns=60,turn_timeout=300,max_total_tokens=12345,max_commands=9)
            self.assertEqual(agent.options.max_total_tokens,12345)
            self.assertEqual(agent.options.max_commands,9)
            await agent._llm.call('task',logging_path=Path(d)/'unsafe.json')
            self.assertEqual(agent.call_budget.used,30)
            self.assertIsNone(llm.calls[0]['logging_path'])
            self.assertEqual(llm.calls[0]['num_retries'],0)
            llm.hang=True;agent.turn_timeout=.01
            with self.assertRaises(ComparisonStop):await agent._llm.call('task')
            self.assertEqual(len(llm.calls),2)
            self.assertEqual(agent.call_budget.reserved,0)
            self.assertEqual(agent.call_budget.requests[-1]['error_type'],'request_timeout')


if __name__=='__main__':unittest.main()
