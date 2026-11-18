from __future__ import annotations
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shlex
import tempfile

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.capabilities import AgentCapabilities
from harbor.models.model_api_format import ModelApiFormat

from .runtime import build_bundle, node_archive


class CodeNodeAgent(BaseInstalledAgent):
    """Run the native CodeNode CLI inside the task; Harbor owns grading and isolation."""
    capabilities = AgentCapabilities(atif=True, base_url=True)
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="openai",
        agent_provider_access=ProviderAccess(
            api_key_candidate_names=["CODENODE_API_KEY", "OPENAI_API_KEY"],
            base_url_candidate_names=["CODENODE_BASE_URL", "OPENAI_BASE_URL"],
        ),
        supported_api_formats=[ModelApiFormat.OPENAI_CHAT_COMPLETIONS],
        default_api_format_by_provider={"default": ModelApiFormat.OPENAI_CHAT_COMPLETIONS},
        api_key_destination_names={"default": "CODENODE_API_KEY"},
        base_url_destination_names={"default": "CODENODE_BASE_URL"},
    )

    def __init__(self, *args, bundle_path=None, workspace="auto", max_iterations=60,
                 turn_timeout=120, node_archive_path=None, node_sha256=None, checkpoint_environment=False, feature_properties=None, acceptance_file=None, argv_guide=False, inject_failure=None, profile="benchmark-controlled", **kwargs):
        super().__init__(*args, **kwargs)
        self.bundle_path = Path(bundle_path).resolve() if bundle_path else None
        if profile not in ("benchmark-controlled", "native-product"):
            raise ValueError("Unknown evaluation profile")
        self.profile = profile
        self.inject_failure = inject_failure
        self.argv_guide = bool(argv_guide)
        self.workspace = workspace
        self.acceptance_file = Path(acceptance_file).resolve() if acceptance_file else None
        self.max_iterations = int(max_iterations)
        self.turn_timeout = int(turn_timeout)
        if not 1 <= self.max_iterations <= 1000 or not 10 <= self.turn_timeout <= 3600:
            raise ValueError("Invalid CodeNode iteration or request time budget")
        self.node_archive_path = Path(node_archive_path) if node_archive_path else None
        self.node_sha256 = node_sha256
        self._manifest = {}
        self._node = "node"
        self.checkpoint_environment = bool(checkpoint_environment)
        self.feature_properties = feature_properties or {}
        allowed={'agent.compact.budget_aware','agent.context.archive_results','agent.budget.wrap_up','agent.no_progress.enabled','agent.working_state.enabled','agent.cache.workspace_versions'}
        if any(key not in allowed or not isinstance(value,bool) for key,value in self.feature_properties.items()):raise ValueError('Unsupported experiment feature configuration')

    @staticmethod
    def name():
        return "codenode"

    def version(self):
        return self._manifest.get("version", "0.13.0")

    async def setup(self, environment):
        # Harbor 0.25.0's installed base invokes install only; explicitly sequence
        # both phases rather than relying on the newer upstream configure hook.
        await self.install(environment)
        await self.configure(environment)

    async def install(self, environment):
        await self.exec_as_root(environment, "mkdir -p /opt/codenode/app /opt/codenode/node")
        found = await environment.exec("node -e 'let [a,b]=process.versions.node.split(\".\").map(Number);process.exit(a>22||a===22&&b>=12?0:1)'", timeout_sec=20)
        if found.return_code == 0:
            self._node = "node"
            return
        architecture = await environment.exec("uname -m", timeout_sec=20)
        arch = {"x86_64": "x64", "aarch64": "arm64"}.get((architecture.stdout or "").strip())
        if not arch:
            raise RuntimeError("CodeNode benchmark adapter requires Linux x64 or arm64")
        if self.node_archive_path:
            archive = self.node_archive_path
            actual = hashlib.sha256(archive.read_bytes()).hexdigest()
            if not self.node_sha256 or actual != self.node_sha256:
                raise RuntimeError("Offline Node runtime requires matching node_sha256")
        else:
            archive = await asyncio.to_thread(node_archive, arch, (self.bundle_path.parent if self.bundle_path else self.logs_dir.parent.parent) / ".node-cache")
        await environment.upload_file(archive, "/opt/codenode/node.tar.gz")
        await self.exec_as_root(environment, "tar -xzf /opt/codenode/node.tar.gz --strip-components=1 -C /opt/codenode/node")
        self._node = "/opt/codenode/node/bin/node"

    async def configure(self, environment):
        # Upload the frozen source snapshot on every trial and infer the runtime.
        detect = await environment.exec("test ! -x /opt/codenode/node/bin/node || printf /opt/codenode/node/bin/node")
        self._node = (detect.stdout or "").strip() or "node"
        with tempfile.TemporaryDirectory(prefix="codenode-bundle-") as temporary:
            bundle = self.bundle_path or Path(temporary) / "runtime.tar.gz"
            if not self.bundle_path:
                self._manifest = await asyncio.to_thread(build_bundle, bundle)
            await environment.upload_file(bundle, "/opt/codenode/runtime.tar.gz")
            await self.exec_as_root(environment, "mkdir -p /opt/codenode/app && tar -xzf /opt/codenode/runtime.tar.gz -C /opt/codenode/app")
        manifest = await environment.exec("cat /opt/codenode/app/benchmark-manifest.json")
        self._manifest = json.loads(manifest.stdout or "{}")
        probe = await environment.exec(f"{shlex.quote(self._node)} --version")
        if probe.return_code:
            raise RuntimeError("Node runtime is unavailable; install it before skip_install")
        self._manifest["node_version"] = (probe.stdout or "").strip()
        layout=await environment.exec("ls -la /opt/codenode/app/bin; test -f /opt/codenode/app/bin/codenode-agent.cjs")
        if self.feature_properties:
            with tempfile.TemporaryDirectory(prefix='codenode-features-') as directory:
                features=Path(directory)/'agent.properties'
                features.write_text('\n'.join(key+'='+str(value).lower() for key,value in self.feature_properties.items())+'\n')
                await environment.upload_file(features,'/opt/codenode/app/config/agent.properties')
        self.logs_dir.mkdir(parents=True,exist_ok=True)
        (self.logs_dir / 'runtime-layout.txt').write_text(str(layout))
        if layout.return_code:
            raise RuntimeError('Runtime archive did not install the native CLI: '+str(layout))

    @with_prompt_template
    async def run(self, instruction, environment, context):
        connection = self.model_connection
        if not connection.api_key:
            raise RuntimeError("CodeNode benchmark requires an explicit model API key")
        installed=await environment.exec("ls -la /opt/codenode/app/bin; test -f /opt/codenode/app/bin/codenode-agent.cjs")
        if installed.return_code:
            raise RuntimeError('Installed CLI missing before run: '+str(installed))
        cwd = await environment.exec("pwd", timeout_sec=20)
        task_cwd = (cwd.stdout or "/").strip()
        project = task_cwd
        access_root = task_cwd if self.workspace == "auto" else self.workspace
        if not project.startswith("/") or not access_root.startswith("/"):
            raise RuntimeError("workspace must be an absolute container path")
        remote_logs = str(self.environment_logs_dir)
        await self.exec_as_agent(environment, f"mkdir -p {shlex.quote(remote_logs)}")
        with tempfile.TemporaryDirectory(prefix="codenode-instruction-") as temporary:
            prompt = Path(temporary) / "instruction.txt"
            terminal_guide = "execute_shell command uses POSIX /bin/sh -c; mode=argv with program/args passes literal arguments." if self.profile == "benchmark-controlled" else "Use execute_shell according to its exposed schema and approval policy."
            prompt.write_text(f"Task working directory: {task_cwd}\nCodeNode project/default cwd: {project}. File access boundary: {access_root}. Relative file paths and commands start at the task directory. {terminal_guide} Explicit cwd applies to one invocation only.\n\n{instruction}", encoding="utf8")
            await environment.upload_file(prompt, remote_logs + "/instruction.txt")
        model = self._parse_model_name(self.model_name)[1]
        env = {**connection.env, "CODENODE_API_KEY": connection.api_key,
               "CODENODE_BASE_URL": connection.execution_base_url or "https://api.openai.com/v1",
               "CODENODE_MODEL": model, "CODENODE_MODEL_PROTOCOL": "openai",
               "CODENODE_BENCHMARK_CONTAINER": "1", "CODENODE_HOME": remote_logs + "/state",
               "CODENODE_SOUL_FILE": remote_logs + "/state/soul.md", "CODENODE_EVAL_CONTEXT": "1", "CODENODE_BENCHMARK_ARGV_GUIDE": "1" if self.argv_guide else "0"}
        if self.inject_failure:
            env["CODENODE_BENCHMARK_FAULT"] = json.dumps(self.inject_failure)
        acceptance_args = []
        if self.acceptance_file:
            if self.acceptance_file.stat().st_size > 65536:
                raise RuntimeError("Acceptance contract exceeds 64 KiB")
            await environment.upload_file(self.acceptance_file, remote_logs + "/acceptance.json")
            acceptance_args = ["--acceptance-file", remote_logs + "/acceptance.json"]
        command = " ".join(shlex.quote(part) for part in [self._node, "/opt/codenode/app/bin/codenode-agent.cjs",
                  *(["--benchmark"] if self.profile == "benchmark-controlled" else []), "--project", project, *(["--access-root", access_root] if self.profile == "benchmark-controlled" else []), "--prompt-file", remote_logs + "/instruction.txt",
                  "--yes", "--json", "--max-iterations", str(self.max_iterations), "--timeout", str(self.turn_timeout), *acceptance_args])
        try:
            await self.exec_as_agent(environment, command + " > " + shlex.quote(remote_logs + "/codenode.jsonl") + " 2> " + shlex.quote(remote_logs + "/stderr.log"), env=env, cwd=task_cwd)
        finally:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            for name in ("codenode.jsonl", "stderr.log"):
                try:
                    await environment.download_file(remote_logs + "/" + name, self.logs_dir / name)
                except Exception:
                    self.logger.warning("Could not download CodeNode %s", name)
            self.populate_context_post_run(context)
            (self.logs_dir / "manifest.json").write_text(json.dumps({**self._manifest, "workspace": access_root, "projectRoot": project, "workingDirectory": project, "accessRoot": access_root, "logDirectory": str(Path(project) / ".codenode"), "model": self.model_name, "profile": self.profile}, indent=2))
            # Keep partial SWE predictions even when the native CLI fails or times out.
            # Harbor still runs its independent verifier after a nonzero agent exit.
            if project == "/testbed":
                staged = await environment.exec("git add -N --all -- . ':!.codenode' && git diff --binary --no-ext-diff HEAD -- . ':!.codenode'", cwd=project, timeout_sec=60)
                if staged.return_code:
                    raise RuntimeError("Failed to collect SWE-bench prediction patch")
                (self.logs_dir / "prediction.patch").write_text(staged.stdout or "")
                # Preserve the generated artifact when providers replace local logs on sync.
                with tempfile.TemporaryDirectory(prefix="codenode-patch-") as temporary:
                    patch=Path(temporary)/'prediction.patch'
                    patch.write_text(staged.stdout or '')
                    await environment.upload_file(patch,remote_logs+'/prediction.patch')
            if self.checkpoint_environment:
                try:
                    from .recovery import checkpoint_environment,tree_sha,atomic_json
                    saved=await asyncio.to_thread(checkpoint_environment,environment,self.logs_dir,access_root,{**self._manifest,"projectRoot":project,"workingDirectory":project,"accessRoot":access_root,"logDirectory":str(Path(project)/".codenode")})
                    task_dir=getattr(environment,'environment_dir',None)
                    if task_dir:
                        saved['task_sha256']=tree_sha(Path(task_dir).parent)
                        atomic_json(self.logs_dir/'solve-checkpoint.json',saved)
                    await environment.upload_file(self.logs_dir/'solve-checkpoint.json',remote_logs+'/solve-checkpoint.json')
                    state_file=self.logs_dir.parents[3]/'states'/(self.logs_dir.parents[1].name+'.json')
                    if state_file.exists():
                        from .recovery import save_state
                        save_state(state_file,'grading',checkpoint=str(self.logs_dir/'solve-checkpoint.json'))
                except Exception as error:
                    self.logger.warning('Solve checkpoint unavailable: %s',type(error).__name__)
                    from .recovery import atomic_json
                    atomic_json(self.logs_dir/'solve-checkpoint-error.json',{'error_type':type(error).__name__,'message':str(error),'phase':'checkpoint_unavailable'})
                    try:await environment.upload_file(self.logs_dir/'solve-checkpoint-error.json',remote_logs+'/solve-checkpoint-error.json')
                    except Exception:pass

    def populate_context_post_run(self, context):
        from .results import parse_events, to_atif
        events = parse_events(self.logs_dir / "codenode.jsonl")
        result = next((row for row in reversed(events) if row.get("kind") == "result"), None)
        trajectory = to_atif(events, self.version(), self.model_name)
        (self.logs_dir / "trajectory.json").write_text(json.dumps(trajectory, ensure_ascii=False, indent=2))
        if result:
            cost = result.get("cost") or {}
            context.n_input_tokens = cost.get("promptTokens")
            context.n_output_tokens = cost.get("completionTokens")
            context.n_cache_tokens = cost.get("promptCachedTokens")
            context.cost_usd = cost.get("costUsd") if cost.get("costKnown") else None
            context.metadata = {"codenode_state": result.get("state"), "iterations": result.get("iterations"), "source_sha256": self._manifest.get("source_sha256")}
