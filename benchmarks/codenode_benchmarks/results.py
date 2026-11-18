from __future__ import annotations
import json
import re
from pathlib import Path


def parse_events(file: Path) -> list[dict]:
    if not file.exists():
        return []
    result = []
    for line in file.read_text(errors="replace").splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                result.append(value)
        except ValueError:
            pass  # Native human-readable tool diagnostics remain in the raw log.
    return result


def to_atif(events, version, model):
    steps, seen, definitions = [], set(), None
    def add(**data):
        steps.append({"step_id": len(steps) + 1, **data})
    for row in events:
        if row.get('kind') == 'benchmark_context':
            definitions=row.get('tools')
            add(source='system',message=row.get('system',''))
            add(source='user',message=row.get('prompt',''))
        delta = row.get("delta", {}) if row.get("kind") == "event" else {}
        if delta.get("kind") == "tool_result":
            for call in delta.get("toolCalls", []):
                identifier = call.get("toolCallId") or call.get("id") or f"call-{len(steps)+1}"
                if identifier in seen:
                    continue
                seen.add(identifier)
                arguments = call.get("args") or {}
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except ValueError:
                        arguments = {"raw": arguments}
                if not isinstance(arguments,dict):
                    arguments={'raw':arguments}
                add(source="agent", message="", tool_calls=[{"tool_call_id": identifier, "function_name": call.get("name", "unknown"), "arguments": arguments}],
                    observation={"results": [{"source_call_id": identifier, "content": str(call.get("result") or call.get("text") or "")} ]})
        if row.get("kind") == "result":
            add(source="agent", message=str(row.get("content") or ""))
    if not steps:
        add(source="agent", message="Execution ended before a final response; inspect stderr.log")
    return {"schema_version": "ATIF-v1.0", "agent": {"name": "codenode", "version": version, "model_name": model or "unknown", "tool_definitions": definitions}, "steps": steps}


def export_predictions(jobs: Path, output: Path, model: str):
    predictions = []
    ids = set()
    for trial_file in sorted(jobs.rglob("result.json")):
        trial = json.loads(trial_file.read_text())
        name = trial.get("task_name")
        patch = trial_file.parent / "agent/prediction.patch"
        if not name:
            continue
        name=name.rsplit('/',1)[-1]
        if not re.fullmatch(r'[\w.-]+__[\w.-]+-\d+',name):
            raise ValueError('Not a SWE-bench instance ID: '+name)
        if name in ids:
            raise ValueError("Multiple attempts for one task: choose a single attempt before official SWE scoring")
        ids.add(name)
        predictions.append({"instance_id": name, "model_name_or_path": model, "model_patch": patch.read_text() if patch.exists() else ""})
    if not predictions:
        raise ValueError("No SWE prediction artifacts found; CLI success alone is not a benchmark score")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row) + "\n" for row in predictions))
    return len(predictions)


def summarize(jobs: Path):
    from .recovery import grading_status
    rows=[];startup_failed=0
    for file in jobs.rglob("result.json"):
        row=json.loads(file.read_text())
        if row.get("task_name"):
            rows.append(row)
            startup_failed+=grading_status(file.parent,row)=='startup_failed'
    rewards=[]
    for row in rows:
        values=(row.get("verifier_result") or {}).get("rewards") or {}
        rewards.append(values.get("reward"))
    return {"total":len(rows),"grading_startup_failed":startup_failed,"resolved":sum(reward==1 for row,reward in zip(rows,rewards)),
            "errors":sum(bool(row.get("exception_info")) for row in rows),"ungraded":sum(value is None for value in rewards),
            "resolution_rate":sum(reward==1 for row,reward in zip(rows,rewards))/len(rows) if rows else None,
            "mean_reward":sum(value if isinstance(value,(int,float)) else 0 for value in rewards)/len(rows) if rows else None}
