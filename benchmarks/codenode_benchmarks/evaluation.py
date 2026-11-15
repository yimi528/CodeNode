"""Export controlled coding contracts to pinned Harbor tasks with separate verifiers."""
from __future__ import annotations
import argparse
import hashlib
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib
from harbor.models.task.config import TaskConfig
from harbor.models.job.config import JobConfig
from .runtime import build_bundle


def export_tasks(plan_file, output):
    plan = json.loads(Path(plan_file).read_text())
    output = Path(output)
    if output.exists():
        raise ValueError("Harbor export already exists")
    output.mkdir(parents=True)
    runtime = Path(plan["runtime"]["directory"])
    bundle = output / "runtime.tar.gz"
    manifest = build_bundle(bundle, root=runtime)
    exported = []
    for task in plan["taskSpecs"]:
        if not task.get("behaviorCases"):
            raise ValueError("Separate coding verifier requires behavioral contracts")
        directory = output / "tasks" / task["id"]
        environment = directory / "environment"
        tests = directory / "tests"
        tests.mkdir(parents=True)
        for relative, text in task["fixture"].items():
            if relative.startswith("/") or ".." in Path(relative).parts:
                raise ValueError("Fixture path traversal")
            file = environment / "fixture" / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text)
        (directory / "instruction.md").write_text(task["prompt"])
        (environment / "Dockerfile").write_text("FROM node:22.23.1-bookworm-slim\nWORKDIR /workspace\nCOPY fixture/ /workspace/\n")
        if platform.system() == "Linux":
            # Linux Docker does not provide Docker Desktop's built-in host DNS alias.
            (environment / "docker-compose.yaml").write_text("services:\n  main:\n    extra_hosts:\n      - host.docker.internal:host-gateway\n")
        (tests / "Dockerfile").write_text("FROM node:22.23.1-bookworm-slim\nCOPY . /tests/\nRUN chmod -R go-rwx /tests\nWORKDIR /workspace\n")
        (tests / "docker-compose.yaml").write_text("services:\n  main:\n    build:\n      context: .\n    network_mode: none\n")
        for name in ("coding-grader.cjs", "coding-candidate.cjs"):
            shutil.copyfile(runtime / "scripts/lib" / name, tests / name)
        (tests / "contract.json").write_text(json.dumps(task))
        (tests / "verify.cjs").write_text("const fs=require('node:fs');const {gradeCoding}=require('/tests/coding-grader.cjs');const task=JSON.parse(fs.readFileSync('/tests/contract.json','utf8'));const r=gradeCoding('/workspace',task,{backend:'process',restrictedUser:true});fs.mkdirSync('/logs/verifier',{recursive:true});fs.writeFileSync('/logs/verifier/result.json',JSON.stringify(r));if(r.status==='ERROR')process.exit(2);fs.writeFileSync('/logs/verifier/reward.txt',r.pass?'1':'0');\n")
        (tests / "test.sh").write_text("#!/bin/sh\nset -eu\nnode /tests/verify.cjs\n")
        config = f'''schema_version = "1.4"
[task]
name = "codenode/{task['id']}"
version = "1.0.0"
[agent]
timeout_sec = 180.0
[environment]
cpus = 1
memory_mb = 1024
storage_mb = 1024
workdir = "/workspace"
[verifier]
timeout_sec = 30.0
environment_mode = "separate"
[verifier.environment]
cpus = 1
memory_mb = 512
storage_mb = 1024
network_mode = "no-network"
[[artifacts]]
source = "/workspace"
destination = "candidate"
exclude = [".codenode"]
'''
        TaskConfig.model_validate(tomllib.loads(config))
        (directory / "task.toml").write_text(config)
        exported.append({"taskId": task["id"], "path": str(directory.resolve()), "injectFailure": task.get("injectFailure")})
    result = {"schemaVersion": 1, "plan": str(Path(plan_file).resolve()), "runtime": manifest,
              "bundle": str(bundle.resolve()), "tasks": exported, "profile": plan.get("profile", "benchmark-controlled"), "verifierIsolation": "separate", "testedWith": "harbor==0.25.0"}
    result["planSha256"] = hashlib.sha256(Path(plan_file).read_bytes()).hexdigest()
    result["files"] = [{"path": p.relative_to(output).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(output.rglob("*")) if p.is_file()]
    (output / "export.json").write_text(json.dumps(result, indent=2))
    return result


def run_one(export_file, task_id, output, model, base_url, argv_guide=False):
    manifest = json.loads(Path(export_file).read_text())
    task = next(t for t in manifest["tasks"] if t["taskId"] == task_id)
    output = Path(output)
    if output.exists():
        raise ValueError("Attempt output exists; do not restart unknown paid attempts")
    output.mkdir(parents=True)
    config = JobConfig.model_validate({"job_name": "attempt", "jobs_dir": str(output),
        "n_concurrent_trials": 1, "n_attempts": 1, "retry": {"max_retries": 0},
        "environment": {"import_path": "codenode_benchmarks.environment:StaticVerifierDocker"},
        "agents": [{"import_path": "codenode_benchmarks.agent:CodeNodeAgent", "model_name": "openai/" + model,
                    "base_url": base_url, "kwargs": {"workspace": "/workspace", "bundle_path": manifest["bundle"],
                    "max_iterations": 24, "turn_timeout": 120, "argv_guide": argv_guide, "inject_failure": task.get("injectFailure"), "profile": manifest.get("profile", "benchmark-controlled")}}],
        "tasks": [{"path": task["path"]}]})
    file = output / "job.json"
    file.write_text(json.dumps(config.model_dump(mode="json", exclude_none=True), indent=2))
    status = subprocess.run([sys.executable, "-m", "harbor.cli.main", "run", "--config", str(file)]).returncode
    results = [str(p.resolve()) for p in output.rglob("result.json") if json.loads(p.read_text()).get("task_name")]
    value = {"exitCode": status, "results": results}
    (output / "import.json").write_text(json.dumps(value))
    return value


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export"); export.add_argument("--plan", required=True); export.add_argument("--output", required=True)
    run = sub.add_parser("run-one")
    for name in ("export", "task", "output", "model", "base-url"):
        run.add_argument("--" + name, required=True)
    run.add_argument("--argv-guide", action="store_true")
    args = parser.parse_args()
    result = export_tasks(args.plan, args.output) if args.command == "export" else run_one(args.export, args.task, args.output, args.model, args.base_url, args.argv_guide)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
