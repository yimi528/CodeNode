from __future__ import annotations
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

from .runtime import ROOT, build_bundle
from .results import export_predictions, summarize

DATASETS = {"swebench-verified": "swebench-verified@1.0", "terminal-bench": "terminal-bench/terminal-bench-2-1@6"}


def command(args, bundle):
    target = ["-p", str(Path(args.tasks).resolve())] if args.tasks else ["-d", args.dataset or DATASETS[args.benchmark]]
    workspace = "/testbed" if args.benchmark == "swebench-verified" else "/"
    cmd = [sys.executable, "-m", "harbor.cli.main", "run", *target, "-a", "codenode_benchmarks.agent:CodeNodeAgent", "-m", args.model,
           "-n", str(args.workers), "-k", "1", "-r", "0", "-l", str(args.limit),
           "-o", str(Path(args.output).resolve()), "--job-name", "run-"+bundle.parent.name.removeprefix("snapshot-"), "--ak", f"bundle_path={bundle}",
           "--ak", f"workspace={workspace}", "--ak", f"max_iterations={args.max_iterations}",
           "--ak", f"turn_timeout={args.turn_timeout}"]
    if args.acceptance_file:
        cmd += ['--ak', 'acceptance_file=' + str(Path(args.acceptance_file).resolve())]
    if args.checkpoint_environment:
        cmd += ['--ak','checkpoint_environment=true']
    if args.task:
        cmd += ["-i", args.task]
    if args.base_url:
        cmd += ["--base-url", args.base_url]
    return cmd


def parser():
    result = argparse.ArgumentParser(description="Run CodeNode against official SWE-bench Verified / Terminal-Bench verifiers")
    subs = result.add_subparsers(dest="action", required=True)
    subs.add_parser("doctor")
    run = subs.add_parser("run")
    run.add_argument("benchmark", choices=DATASETS)
    run.add_argument("--model", required=True, help="Harbor provider/model slug; initial adapter supports OpenAI chat-compatible APIs")
    run.add_argument("--base-url")
    run.add_argument("--dataset", help="Override with an explicit registry version or revision")
    run.add_argument("--tasks", help="Local official Harbor task directories")
    run.add_argument("--task", help="Select task-name glob")
    run.add_argument("--limit", type=int, default=5)
    run.add_argument("--workers", type=int, default=1)
    run.add_argument("--max-iterations", type=int, default=60)
    run.add_argument("--turn-timeout", type=int, default=120)
    run.add_argument("--output", default=str(ROOT / "out/benchmarks"))
    run.add_argument("--dry-run", action="store_true")
    run.add_argument("--acceptance-file", type=Path, help="Explicit public-task acceptance contract; never infer from hidden verifiers")
    run.add_argument("--checkpoint-environment", action="store_true", help="Save a solved Docker image before grading, enabling verifier-only recovery")
    export = subs.add_parser("export-swe")
    export.add_argument("--jobs", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--model", required=True)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if args.action == "doctor":
        try:
            version = importlib.metadata.version("harbor")
        except importlib.metadata.PackageNotFoundError:
            version = None
        docker = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True) if shutil.which("docker") else None
        print(json.dumps({"python": sys.version.split()[0], "harbor": version, "expected_harbor": "0.25.0", "docker_ready": bool(docker and docker.returncode == 0), "api_key_present": bool(os.getenv("CODENODE_API_KEY") or os.getenv("OPENAI_API_KEY"))}, indent=2))
        return 0 if version == "0.25.0" and docker and docker.returncode == 0 else 2
    if args.action == "export-swe":
        print(json.dumps({"predictions": export_predictions(args.jobs, args.output, args.model)}))
        return 0
    if not 1 <= args.limit <= 10000 or not 1 <= args.workers <= 100:
        raise ValueError("Invalid task limit or concurrency")
    if not args.dry_run and not (os.getenv("CODENODE_API_KEY") or os.getenv("OPENAI_API_KEY")):
        raise ValueError("Set CODENODE_API_KEY (or OPENAI_API_KEY); credentials are never written into the runtime bundle")
    output = Path(args.output).resolve()
    snapshot_dir = output / ("snapshot-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f"))
    bundle = snapshot_dir / "runtime.tar.gz"
    manifest = build_bundle(bundle)
    cmd = command(args, bundle)
    manifest.update({"benchmark": args.benchmark, "dataset": args.tasks or args.dataset or DATASETS[args.benchmark], "model": args.model,
                     "attempts_per_task": 1, "task_limit": args.limit, "command": cmd, "harbor_version": "0.25.0"})
    (snapshot_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if args.dry_run:
        print(json.dumps(manifest, indent=2))
        return 0
    if importlib.metadata.version("harbor") != "0.25.0":
        raise ValueError("Install the pinned Harbor version from benchmarks/pyproject.toml")
    started=time.monotonic()
    status = subprocess.run(cmd, check=False).returncode
    run_dir = output / ("run-"+snapshot_dir.name.removeprefix("snapshot-"))
    report = summarize(run_dir)
    report.update({"benchmark":args.benchmark,"model":args.model,"snapshot":str(snapshot_dir),"harbor_exit_code":status,"duration_sec":round(time.monotonic()-started,3)})
    (snapshot_dir / "summary.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
    return status or (0 if report["total"] and report["resolved"]==report["total"] and not report["errors"] else 1)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, importlib.metadata.PackageNotFoundError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
