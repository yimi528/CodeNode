from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from harbor.models.task.config import NetworkMode
from codenode_benchmarks.environment import StaticVerifierDocker, validate_static_network


class StaticNetworkTests(unittest.TestCase):
    def test_only_explicit_single_service_none_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            file = directory / "docker-compose.yaml"
            file.write_text("services:\n  main:\n    build:\n      context: .\n    network_mode: none\n")
            self.assertEqual(len(validate_static_network(directory)), 64)
            with self.assertRaises(ValueError):
                validate_static_network(directory, [directory / "override.yaml"])
            for text in ["services:\n  main:\n    network_mode: host\n",
                         "services:\n  main:\n    network_mode: none\n    privileged: true\n",
                         "services:\n  main:\n    network_mode: none\n  relay:\n    image: relay\n"]:
                file.write_text(text)
                with self.assertRaises(ValueError):
                    validate_static_network(directory)


class StaticPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifier_cannot_be_switched_to_public_network(self):
        environment = SimpleNamespace(_static_verifier=True)
        with self.assertRaises(ValueError):
            await StaticVerifierDocker._apply_network_policy(environment, SimpleNamespace(network_mode=NetworkMode.PUBLIC))
