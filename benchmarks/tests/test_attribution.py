import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('failure_attribution',ROOT/'scripts/benchmarks/attribute-failures.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class AttributionTests(unittest.TestCase):
    def test_transport_success_does_not_hide_nonzero_exit_or_shell_argument_error(self):
        events=[(10,{'kind':'event','delta':{'kind':'tool_result','toolCalls':[{'name':'execute_shell','ok':True,'args':'{"command":"python test.py 2>&1 | tail -5"}','result':'error: unrecognized arguments: 2>&1 | tail -5','data':{'exitCode':2}}]}}),
                (11,{'kind':'event','delta':{'kind':'tool','toolCalls':123}})]
        calls=module.tool_calls(events,Path('/tmp/fixture.jsonl'))
        self.assertEqual(len(calls),1);self.assertIn('command_nonzero_exit',calls[0]['flags']);self.assertIn('operators_received_as_argv',calls[0]['flags'])
        self.assertEqual(calls[0]['evidence']['line'],10)

    def test_planned_handoff_is_distinct_from_forced_hard_refusal(self):
        arm={'stopReason':'token_limit'}
        forced=[(1,{'kind':'budget_wrapup','phase':'start','budget':{'remaining':69845}})]
        planned=[(1,{'kind':'budget_wrapup','phase':'start','budget':{'remaining':100000,'handoffInput':9000}})]
        self.assertEqual(module.stop_category(arm,forced,[]),'hard_budget_refusal')
        self.assertEqual(module.stop_category(arm,planned,[]),'planned_handoff')
        self.assertEqual(module.stop_category({'requestTimeout':True},[],[]),'request_timeout')
        events=[(1,{'delta':{'kind':'error','error':'本次模型调用已达到 HTTP 请求总次数上限（5 次）'}})]
        self.assertEqual(module.stop_category({'state':'FAILED'},[],events),'http_attempt_limit')

    def test_changed_file_version_is_not_an_exact_duplicate(self):
        def row(version):return {'kind':'event','delta':{'kind':'tool_result','toolCalls':[{'name':'read_file','args':'{"path":"a.py"}','ok':True,'result':'same visible fragment','data':{'sourceSha256':version}}]}}
        calls=module.tool_calls([(1,row('old')),(2,row('new'))],Path('/tmp/fixture'))
        self.assertNotEqual(calls[0]['signature'],calls[1]['signature'])

    def test_redaction_and_partial_jsonl(self):
        self.assertNotIn('sk-'+ 'a'*32,module.clean('API key sk-'+'a'*32))
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'events.jsonl';file.write_text('{"kind":"first"}\npartial\n{"kind":"last"}\n')
            self.assertEqual([line for line,_ in module.rows(file)],[1,3])

if __name__=='__main__':unittest.main()
