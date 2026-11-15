from pathlib import Path
import json
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch
from harbor.models.task.config import TaskConfig
from codenode_benchmarks.evaluation import export_tasks
from codenode_benchmarks.runtime import ROOT


class EvaluationContractTests(unittest.TestCase):
    def test_private_separate_verifier_export(self):
        task=json.loads(subprocess.check_output(['node','-e',"process.stdout.write(JSON.stringify(require('./scripts/eval/coding-tasks.cjs')[0]))"],cwd=ROOT))
        with tempfile.TemporaryDirectory() as directory:
            directory=Path(directory)
            plan=directory/'plan.json'
            plan.write_text(json.dumps({'runtime':{'directory':str(ROOT)},'taskSpecs':[task]}))
            with patch('codenode_benchmarks.evaluation.platform.system',return_value='Linux'):
                result=export_tasks(plan,directory/'export')
            folder=Path(result['tasks'][0]['path'])
            config=TaskConfig.model_validate(tomllib.loads((folder/'task.toml').read_text()))
            self.assertEqual(config.verifier.environment_mode.value,'separate')
            self.assertEqual(config.verifier.environment.network_mode.value,'no-network')
            self.assertEqual(config.artifacts[0].source,'/workspace')
            self.assertIn('host.docker.internal:host-gateway',(folder/'environment/docker-compose.yaml').read_text())
            self.assertFalse((folder/'environment/fixture/contract.json').exists())
            self.assertTrue((folder/'tests/contract.json').exists())
            self.assertTrue(result['files'])
            verify_code = "require('./scripts/eval/eval-harbor.cjs').verifyExport(" + json.dumps(str(directory/'export')) + "," + json.dumps(str(plan)) + ")"
            verified = subprocess.run(['node','-e',verify_code],cwd=ROOT,capture_output=True,text=True)
            self.assertEqual(verified.returncode,0,verified.stderr)
            (folder/'environment/Dockerfile').write_text('FROM changed-image\n')
            changed = subprocess.run(['node','-e',verify_code],cwd=ROOT,capture_output=True,text=True)
            self.assertNotEqual(changed.returncode,0)

            self.assertIn('restrictedUser:true',(folder/'tests/verify.cjs').read_text())
            self.assertIn('chmod -R go-rwx /tests',(folder/'tests/Dockerfile').read_text())
            with self.assertRaises(ValueError):export_tasks(plan,directory/'export')
