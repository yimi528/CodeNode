"""Create a credential-free runtime snapshot and acquire a verified Linux Node runtime."""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import urllib.request
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
NODE_VERSION = "22.23.1"


def build_bundle(destination: Path, root: Path = ROOT) -> dict:
    paths = [root / "bin/codenode-agent.cjs", root / "package.json", root / "LICENSE"]
    paths += sorted((root / "electron").rglob("*.cjs"))
    # Configuration schemas only; never include agent.properties, soul, histories, .git or eval answers.
    names = ("ui.costs.json", "ui.defaults.json", "ui.rag.json", "ui.workflow.json", "ui.editing.json", "trellis.compatibility.json", "ui.themes.json", "agent.backends.json", "trellis.cli.json", "goal.wait.json", "ui.extensions.json", "ui.scheduling.json", "ui.agent.json", "goal.task-priorities.json", "extension.setup.json", "ui.output.json", "goal.handoff.json")
    paths += [root / "config" / name for name in names]
    for package in ("@typescript/typescript6", "@typescript/old"):
        directory = root / "node_modules" / package
        if not directory.is_dir() and package == "@typescript/old":
            continue  # Legacy local alias is not a declared production dependency.
        if not directory.is_dir():
            raise RuntimeError(f"Missing runtime dependency: {package}; run npm ci")
        paths += sorted(p for p in directory.rglob("*") if p.is_file())
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz") as archive:
        for file in paths:
            if file.is_symlink():
                raise RuntimeError(f"Runtime snapshot cannot contain a symlink: {file.name}")
            name = file.relative_to(root).as_posix()
            content = file.read_bytes()
            digest.update(name.encode() + b"\0" + content + b"\0")
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(content), 0o644, 0
            archive.addfile(info, io.BytesIO(content))
        manifest = {"agent": "codenode", "version": json.loads((root / "package.json").read_text())["version"], "source_sha256": digest.hexdigest()}
        content = json.dumps(manifest).encode()
        info = tarfile.TarInfo("benchmark-manifest.json")
        info.size, info.mode = len(content), 0o644
        archive.addfile(info, io.BytesIO(content))
    return {**manifest, "archive_sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def node_archive(architecture: str, cache: Path) -> Path:
    if architecture not in ("x64", "arm64"):
        raise RuntimeError(f"Unsupported Linux architecture: {architecture}")
    name = f"node-v{NODE_VERSION}-linux-{architecture}.tar.gz"
    base = f"https://nodejs.org/dist/v{NODE_VERSION}/"
    target=cache/name;verified=cache/(name+'.verified.json')
    if target.exists() and verified.exists():
        try:
            metadata=json.loads(verified.read_text())
            if metadata.get('source')==base+'SHASUMS256.txt' and metadata.get('sha256')==hashlib.sha256(target.read_bytes()).hexdigest():return target
        except (ValueError,OSError):pass
    checksums = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60).read().decode()
    expected = next((line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name), None)
    if expected is None:
        raise RuntimeError("Official Node checksum is missing")
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / name
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        temporary = cache / (name + f".{uuid4().hex}.tmp")
        try:
            with urllib.request.urlopen(base + name, timeout=120) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
                raise RuntimeError("Node archive SHA-256 mismatch")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    from .recovery import atomic_json
    atomic_json(verified,{'source':base+'SHASUMS256.txt','sha256':expected,'version':NODE_VERSION})
    return target
