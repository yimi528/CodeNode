import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import importlib.util
import hashlib
import io
from unittest.mock import patch
from codenode_benchmarks.recovery import atomic_json,save_state,inspect_job,grading_status,recover_grading,tree_sha,sha
from codenode_benchmarks.native_ab import config,report,run,FEATURES
from codenode_benchmarks.runtime import ROOT

class RecoveryTests(unittest.TestCase):
    def test_verified_node_cache_does_not_need_dns_and_rejects_changed_bytes(self):
        from codenode_benchmarks.runtime import node_archive,NODE_VERSION
        with tempfile.TemporaryDirectory() as directory:
            cache=Path(directory);payload=b'verified-node-runtime';digest=hashlib.sha256(payload).hexdigest()
            name=f'node-v{NODE_VERSION}-linux-x64.tar.gz'
            def fetch(url,**kwargs):return io.BytesIO((digest+'  '+name+'\n').encode() if url.endswith('SHASUMS256.txt') else payload)
            with patch('urllib.request.urlopen',side_effect=fetch):target=node_archive('x64',cache)
            with patch('urllib.request.urlopen',side_effect=OSError('DNS unavailable')) as network:
                self.assertEqual(node_archive('x64',cache),target);network.assert_not_called()
            target.write_bytes(b'corrupt')
            with patch('urllib.request.urlopen',side_effect=fetch):self.assertEqual(node_archive('x64',cache).read_bytes(),payload)

    def test_setup_recovery_excludes_any_started_agent(self):
        spec=importlib.util.spec_from_file_location('setup_recovery',ROOT/'scripts/benchmarks/recover-setup.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);node=root/'node.tar.gz';node.write_bytes(b'fixture')
            cases=[{'task':'fixture__repo-1','slug':'one','family':'swe','task_path':str(root/'task'),'order':['baseline']},
                   {'task':'fixture__repo-2','slug':'two','family':'swe','task_path':str(root/'task'),'order':['baseline']}]
            plan={'model':'openai/fixture','base_url':'http://fixture','bundle':'unused','limits':{'turns':60,'request_seconds':300},'features':{'baseline':dict.fromkeys(FEATURES,False)},'cases':cases}
            file=root/'plan.json';atomic_json(file,plan)
            for index,case in enumerate(cases):
                cfg=config(plan,root,case,index,'baseline');trial=root/'jobs'/cfg['job_name']/'trial';trial.mkdir(parents=True)
                atomic_json(trial/'result.json',{'task_name':case['task'],'exception_info':{'exception_type':'URLError'},'agent_execution':{'started_at':'now'} if index else None})
            with patch.object(module,'verify'):
                recovery=module.prepare(file,node,sha(node))
                self.assertEqual(len(recovery['items']),1);self.assertEqual(recovery['items'][0]['index'],0)
                with self.assertRaisesRegex(ValueError,'checksum'):module.prepare(file,node,'wrong')

    def test_static_service_recovery_uses_only_executed_literal_arguments(self):
        spec=importlib.util.spec_from_file_location('static_recovery',ROOT/'scripts/benchmarks/recover-static-service.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'events.jsonl'
            command="python -c \"subprocess.Popen([sys.executable,'-m','http.server','8080','--bind','0.0.0.0','--directory','/app/pkgroot'])\""
            row={'kind':'event','delta':{'kind':'tool_result','toolCalls':[{'name':'execute_shell','ok':True,'args':{'command':command},'data':{'exitCode':0}}]}}
            file.write_text(json.dumps(row));self.assertEqual(module.service_arguments(file),['-m','http.server','8080','--bind','0.0.0.0','--directory','/app/pkgroot'])
            row['delta']['toolCalls'][0]['data']['exitCode']=1;file.write_text(json.dumps(row))
            with self.assertRaisesRegex(ValueError,'successfully executed'):module.service_arguments(file)

    def test_analysis_distinguishes_usage_estimates_and_timeout(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);agent=root/'trial/agent';agent.mkdir(parents=True)
            atomic_json(root/'plan.json',{'cases':[{}],'manifest':{'source_sha256':'fixture'},'limits':{'tokens':600000}})
            rows=[{'kind':'event','delta':{'kind':'error','error':'本轮模型请求超过 300s 总时长上限'}},
                  {'kind':'result','state':'FAILED','iterations':1,'usage':{'total_tokens':30},'cost':{'totalTokens':50,'estimated':True}}]
            (agent/'codenode.jsonl').write_text('\n'.join(json.dumps(r) for r in rows))
            result={'complete':False,'cases':[{'task':'fixture','arms':{'baseline':{'result_path':str(root/'trial/result.json'),'original_reward':0,'finished_at':'now','grading_status':'graded'},'improved':{'phase':'not_started'}}}]}
            atomic_json(root/'results.json',result)
            subprocess.run(['node',str(ROOT/'scripts/benchmarks/analyze-native-ab.cjs'),str(root)],check=True,capture_output=True)
            analysis=json.loads((root/'analysis.json').read_text())
            self.assertEqual(analysis['summary']['baseline']['mainUsageTokens'],30)
            self.assertEqual(analysis['summary']['baseline']['ledgerTokensIncludingEstimates'],50)
            self.assertEqual(analysis['summary']['baseline']['requestTimeouts'],1)
            self.assertEqual(analysis['paired']['pending'],1)
            self.assertEqual(json.loads((root/'results.json').read_text()),result)

    def test_atomic_state_and_startup_failure_preserve_original_reward(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);trial=root/'job'/'trial';(trial/'verifier').mkdir(parents=True)
            state=root/'state.json';save_state(state,'prepared');save_state(state,'solving');save_state(state,'solving')
            self.assertEqual(len(json.loads(state.read_text())['history']),2)
            row={'task_name':'fixture__repo-1','finished_at':'now','verifier_result':{'rewards':{'reward':0}}}
            atomic_json(trial/'result.json',row);(trial/'verifier/test-stdout.txt').write_text('Failed to download package: Network is unreachable')
            self.assertEqual(grading_status(trial,row),'startup_failed')
            self.assertEqual(inspect_job(root/'job')['original_reward'],0)
            self.assertEqual(inspect_job(root/'job')['phase'],'grading_startup_failed')
            self.assertEqual(json.loads((trial/'result.json').read_text()),row)
            (trial/'verifier/test-stdout.txt').write_text('collected 2 items\n1 failed')
            self.assertEqual(inspect_job(root/'job')['phase'],'complete')

    def test_verifier_only_recovery_integrity_idempotency_and_no_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);task=root/'task';(task/'tests').mkdir(parents=True)
            (task/'task.toml').write_text('[verifier]\ntimeout_sec=12\n[environment]\ncpus=1\nmemory_mb=256\n')
            (task/'tests/test.sh').write_text('echo 1 > /logs/verifier/reward.txt')
            agent=root/'agent';agent.mkdir();(agent/'prediction.patch').write_text('original patch')
            checkpoint=agent/'solve-checkpoint.json';image='sha256:'+'1'*64
            saved={'filesystem_replay_supported':True,'task_sha256':tree_sha(task),'solved_image':image,'artifacts':{'prediction.patch':sha(agent/'prediction.patch')}}
            atomic_json(checkpoint,saved);output=root/'recovery';commands=[]
            def execute(command,**kwargs):
                commands.append(command)
                if 'run' in command:(output/'reward.txt').write_text('1')
                return SimpleNamespace(returncode=0)
            with patch('subprocess.check_output',return_value=json.dumps([{'Id':image}]).encode()),patch('subprocess.run',side_effect=execute):
                result=recover_grading(checkpoint,task,output)
                self.assertEqual(result['model_requests'],0);self.assertEqual(result['reward'],1)
                self.assertEqual(recover_grading(checkpoint,task,output),result)
            self.assertEqual(len([c for c in commands if 'run' in c]),1)
            self.assertTrue(all('harbor' not in ' '.join(c) for c in commands))
            (agent/'prediction.patch').write_text('changed')
            with self.assertRaisesRegex(ValueError,'artifact changed'):recover_grading(checkpoint,task,root/'other')
            saved['filesystem_replay_supported']=False;atomic_json(checkpoint,saved)
            with self.assertRaisesRegex(ValueError,'live processes'):recover_grading(checkpoint,task,root/'other')

    def test_interrupted_native_ab_never_replays_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);case={'task':'fixture__repo-1','slug':'fixture__repo-1','family':'swe','task_path':str(root/'task'),'order':['baseline','improved']}
            plan={'model':'openai/fixture','base_url':'http://fixture','bundle':'unused','limits':{'turns':60,'request_seconds':300},
                  'features':{'baseline':dict.fromkeys(FEATURES,False),'improved':dict.fromkeys(FEATURES,True)},'purpose':'test','cases':[case]}
            file=root/'plan.json';atomic_json(file,plan)
            for arm in case['order']:
                cfg=config(plan,root,case,0,arm);(root/'jobs'/cfg['job_name']).mkdir(parents=True)
                self.assertEqual(cfg['n_attempts'],1);self.assertEqual(cfg['retry']['max_retries'],0)
            with patch.dict(os.environ,{'CODENODE_API_KEY':'synthetic'}),patch('codenode_benchmarks.native_ab.verify'),patch('codenode_benchmarks.native_ab.run_logged') as launch:
                result=run(file);launch.assert_not_called();self.assertFalse(result['complete'])
            self.assertTrue(all(r['phase']=='interrupted' for r in result['cases'][0]['arms'].values()))

if __name__=='__main__':unittest.main()
