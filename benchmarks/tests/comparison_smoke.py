"""Local scripted OpenAI model + real Terminus/Docker; no paid inference."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,os
from pathlib import Path
import subprocess,sys,tempfile,threading
from harbor.models.job.config import JobConfig
from harbor.models.trajectories import Trajectory


def main():
    class Model(BaseHTTPRequestHandler):
        count=0
        def log_message(self,*_):pass
        def do_POST(self):
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            Model.count+=1
            content={'analysis':'fixture','plan':'write answer','commands':[{'keystrokes':"printf 'CodeNode benchmark smoke passed\\n' > /testbed/answer.txt\n",'duration':.1}] if Model.count==1 else [],'task_complete':Model.count>1}
            response={'id':'fixture','object':'chat.completion','created':0,'model':'fixture','choices':[{'index':0,'message':{'role':'assistant','content':json.dumps(content)},'finish_reason':'stop'}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}}
            data=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('0.0.0.0',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
    root=Path(__file__).resolve().parents[1]
    try:
        with tempfile.TemporaryDirectory(prefix='codenode-reference-smoke-') as d:
            output=Path(d)
            config=JobConfig.model_validate({'job_name':'reference-smoke','jobs_dir':str(output),'n_concurrent_trials':1,'retry':{'max_retries':0},
                'agents':[{'import_path':'codenode_benchmarks.baseline:BudgetedTerminus2','model_name':'openai/fixture','base_url':f'http://127.0.0.1:{server.server_port}/v1','kwargs':{'max_turns':5,'turn_timeout':30}}],
                'tasks':[{'path':str(root/'smoke/fixture__repository-1')}]})
            path=output/'config.json';path.write_text(config.model_dump_json())
            env={**os.environ,'OPENAI_API_KEY':'fixture','PYTHONPATH':str(root),'NO_PROXY':'localhost,127.0.0.1,host.docker.internal','LITELLM_LOCAL_MODEL_COST_MAP':'True'}
            result=subprocess.run([sys.executable,'-m','harbor.cli.main','run','--config',str(path)],env=env,capture_output=True,text=True,timeout=360)
            files=list((output/'reference-smoke').glob('*/result.json'))
            assert len(files)==1,result.stdout+result.stderr
            row=json.loads(files[0].read_text());assert row['verifier_result']['rewards']['reward']==1,row
            assert not row.get('exception_info'),row.get('exception_info')
            agent=files[0].parent/'agent'
            assert 'new file mode' in (agent/'prediction.patch').read_text()
            budget=json.loads((agent/'comparison-budget.json').read_text());assert budget['used']==Model.count*30,budget
            assert budget['commands']>=1
            Trajectory.model_validate_json((agent/'trajectory.json').read_text())
            print(json.dumps({'baseline_smoke':'PASS','model_calls':Model.count,'reward':1,'new_file_patch':True,'atif_valid':True}))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
