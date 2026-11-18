"""Static Docker no-network verification without nftables or policy downgrades."""
from __future__ import annotations
import asyncio
import hashlib
import json
from pathlib import Path
import re

import yaml
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import NetworkMode


def validate_static_network(directory: Path, extra_compose=()):
    file = Path(directory) / "docker-compose.yaml"
    if extra_compose or not file.is_file():
        raise ValueError("Static no-network requires its own immutable compose definition")
    config = yaml.safe_load(file.read_text())
    services = config.get("services", {})
    if set(services) != {"main"} or services["main"].get("network_mode") != "none":
        raise ValueError("Verifier compose must enforce network_mode=none on its only service")
    if set(services["main"]) - {"build", "network_mode"} or config.get("networks"):
        raise ValueError("Verifier networking cannot be overridden by extra task settings")
    return hashlib.sha256(file.read_bytes()).hexdigest()


class StaticVerifierDocker(DockerEnvironment):
    """Public agent environment, or a separately created network_mode=none verifier.

    Only static policies are supported. Containers cannot transition from none
    to public. Dynamic allowlists still fail closed rather than losing isolation.
    """

    def __init__(self, *args, network_policy=None, environment_dir=None, **kwargs):
        self._static_verifier = network_policy is not None and network_policy.network_mode == NetworkMode.NO_NETWORK
        self._definition_hash = None
        if self._static_verifier:
            self._definition_hash = validate_static_network(Path(environment_dir), kwargs.get("extra_docker_compose", ()))
        super().__init__(*args, network_policy=network_policy, environment_dir=environment_dir, **kwargs)

    @classmethod
    def _egress_control_kernel_support(cls):
        # This adapter uses Docker's own static network namespace, never Harbor's nftables sidecar.
        return False

    @property
    def capabilities(self):
        capabilities = super().capabilities
        return capabilities.model_copy(update={"disable_internet": True}) if self._static_verifier else capabilities

    async def _attest_no_network(self):
        result = await self._run_docker_compose_command(["ps", "-q", "main"])
        identifiers = [line for line in (result.stdout or "").splitlines() if re.fullmatch(r"[a-f0-9]{12,64}", line)]
        if len(identifiers) != 1:
            raise RuntimeError("Could not identify the verifier container for network attestation")
        process = await asyncio.create_subprocess_exec(*self._engine_cmd("inspect", "--format", "{{json .HostConfig.NetworkMode}}", identifiers[0]),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        if process.returncode or json.loads(stdout) != "none":
            raise RuntimeError("Verifier network isolation was not enforced: " + stderr.decode(errors="replace"))
        record = {"schemaVersion": 1, "containerId": identifiers[0], "networkMode": "none", "enforced": True,
                  "composeSha256": self._definition_hash, "provider": "codenode-static-docker"}
        (self.trial_paths.verifier_dir.parent / "verifier-network.json").write_text(json.dumps(record, indent=2))

    async def start(self, force_build=False):
        await super().start(force_build)
        if self._static_verifier:
            await self._attest_no_network()

    async def _apply_network_policy(self, network_policy):
        if self._static_verifier and network_policy.network_mode == NetworkMode.NO_NETWORK:
            await self._attest_no_network()
            return
        raise ValueError("Static verifier cannot change network policy")
