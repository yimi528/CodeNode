"""Real Docker + Harbor verifier integration with a local scripted model, not a benchmark score."""
from __future__ import annotations
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]


def run(negative=False, swe=False, checkpoint=False):
    class Model(BaseHTTPRequestHandler):
        count = 0
        def log_message(self, *_):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            Model.count += 1
            has_tool = any(item.get("role") == "tool" for item in body.get("messages", []))
            if has_tool:
                delta, finish = {"content": "Done."}, "stop"
            else:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "smoke-write", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "answer.txt", "content": "wrong\n" if negative else "CodeNode benchmark smoke passed\n"})}}]}
                delta["tool_calls"].insert(0,{"index":0,"id":"smoke-shell","type":"function","function":{"name":"execute_shell","arguments":json.dumps({"command":"printf '%s\\n' 'shell works' | cat && pwd"})}})
                delta["tool_calls"][1]["index"]=1
                finish = "tool_calls"
            packets = [{"choices": [{"index": 0, "delta": delta}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(("".join("data: " + json.dumps(packet) + "\n\n" for packet in packets) + "data: [DONE]\n\n").encode())
    server = ThreadingHTTPServer(("0.0.0.0", 0), Model)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    with tempfile.TemporaryDirectory(prefix="codenode-harbor-smoke-") as temporary:
        output = Path(temporary) / "jobs"
        env = {**os.environ, "CODENODE_API_KEY": "local-smoke-key", "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")}
        cmd = [sys.executable, "-m", "codenode_benchmarks.cli", "run", "swebench-verified" if swe else "terminal-bench", "--tasks", str(ROOT / ("benchmarks/smoke/fixture__repository-1" if swe else "benchmarks/smoke/task")), "--model", "openai/mock",
               "--base-url", f"http://host.docker.internal:{server.server_port}/v1", "--limit", "1", "--max-iterations", "5", "--output", str(output)]
        acceptance = Path(temporary) / 'acceptance.json'
        acceptance.write_text(json.dumps({'version':1,'artifacts':[{'id':'required-answer','path':'answer.txt','maxBytes':100}]}))
        cmd += ['--acceptance-file',str(acceptance)]
        if checkpoint:cmd+=['--checkpoint-environment']
        try:
            result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=240)
            print(result.stdout)
            if result.returncode != (1 if negative else 0):
                raise AssertionError(result.stderr + "\n" + result.stdout)
            trials = [json.loads(file.read_text()) for file in output.rglob("result.json") if json.loads(file.read_text()).get("task_name")]
            assert len(trials) == 1, f"Expected one trial; got {trials}"
            trial = trials[0]
            reward = (trial.get("verifier_result") or {}).get("rewards", {}).get("reward")
            assert reward == (0 if negative else 1), trial
            assert trial.get("exception_info") is None, trial.get("exception_info")
            if swe:
                from codenode_benchmarks.results import export_predictions
                predictions=Path(temporary)/'predictions.jsonl'
                assert export_predictions(output,predictions,'openai/mock')==1
                prediction=json.loads(predictions.read_text())
                assert prediction['instance_id']=='fixture__repository-1',prediction
                assert 'new file mode' in prediction['model_patch'],prediction
                assert '+CodeNode benchmark smoke passed' in prediction['model_patch'],prediction
            manifest=json.loads(next(output.rglob('agent/manifest.json')).read_text())
            expected='/testbed' if swe else '/app'
            assert manifest['projectRoot']==manifest['workingDirectory']==expected,manifest
            assert manifest['logDirectory']==expected+'/.codenode',manifest
            events=[json.loads(line) for line in next(output.rglob('agent/codenode.jsonl')).read_text().splitlines() if line.strip().startswith('{')]
            shell=[call for event in events if event.get('kind')=='event' and event.get('delta',{}).get('kind')=='tool_result' for call in event['delta'].get('toolCalls',[]) if call.get('name')=='execute_shell']
            assert shell and shell[0]['data']['executionMode']=='shell' and shell[0]['data']['cwd']==expected,shell
            final=next(event for event in reversed(events) if event.get('kind')=='result')
            assert final['taskAcceptance']['status']=='passed',final
            assert Model.count >= 2, "CodeNode did not call the model/tool loop"
            if checkpoint:
                from codenode_benchmarks.recovery import recover_grading
                checkpoints=list(output.rglob('agent/solve-checkpoint.json'))
                if not checkpoints:
                    raise AssertionError('Missing solve checkpoint: '+str([json.loads(p.read_text()) for p in output.rglob('agent/solve-checkpoint-error.json')]))
                saved=checkpoints[0]
                count=Model.count
                recovered=recover_grading(saved,ROOT/'benchmarks/smoke/fixture__repository-1',Path(temporary)/'recovered-verifier')
                assert recovered['reward']==1,recovered
                assert Model.count==count,'Verifier-only recovery made model requests'
                print('DOCKER RECOVERY: PASS (original reward retained, solved image restored, zero extra model requests)')
            from harbor.utils.trajectory_validator import TrajectoryValidator
            trajectory = next(output.rglob("agent/trajectory.json"))
            validator = TrajectoryValidator()
            assert validator.validate(str(trajectory)), validator.get_errors()
            print(f"HARBOR DOCKER SMOKE: PASS (native CodeNode, model calls={Model.count}, official verifier reward={reward}, valid ATIF)")
        except Exception:
            for file in output.rglob('runtime-layout.txt'):
                print(file.read_text(),file=sys.stderr)
            for file in output.rglob("exception.txt"):
                print(file.read_text(), file=sys.stderr)
            for file in output.rglob("stderr.log"):
                print(file.read_text(), file=sys.stderr)
            raise
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--negative", action="store_true")
    args.add_argument("--swe", action="store_true")
    args.add_argument("--checkpoint", action="store_true")
    options=args.parse_args()
    run(options.negative,options.swe,options.checkpoint)
