"""Explicit experiment-local domain stream: python -m harness2.earthnano_domain --config FILE.

The original scheduler owns task ordering, recursion, reflection and Library retention.
The platform owns executions, immutable outputs, independent grades and cleanup.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
from pathlib import Path

from . import earthnano
from .core import context, library, schedule, tree
from .core.earthnano_binding import (
    JsonLineClient, PlatformRequestFactory, PlatformResultReader, StdioExecutionPort,
    read_snapshot, safe_path, text_files,
)
from .core.execution_contract import ExecutionStopped
from .core.method_execution import PortMethodExecution
from .core.proposer import Proposer


def validate_config(value):
    fields = {"configVersion", "domain", "tasks", "baseHarnessFiles", "workRoot", "model",
              "method", "executionTimeoutMs", "rpcTimeoutMs"}
    if (not isinstance(value, dict) or set(value) != fields
            or type(value["configVersion"]) is not int or value["configVersion"] != 1):
        raise ValueError("Invalid EarthNano domain configuration fields or version")
    domain = value["domain"]
    if not isinstance(domain, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}", domain):
        raise ValueError("Domain must be a portable single path segment")
    safe_path(domain)
    tasks = value["tasks"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 4:
        raise ValueError("Expected one to four ordered tasks")
    common = {key: value[key] for key in fields - {"domain", "tasks"}}
    normalized = []
    prefix = None
    for index, item in enumerate(tasks, 1):
        if not isinstance(item, dict) or set(item) != {"taskId", "task"}:
            raise ValueError("Expected taskId and task")
        single = earthnano.validate_config(dict(common, **item))
        if "managedInputs" in single["task"]:
            raise ValueError("Managed scientific tasks do not support domain successors")
        match = re.fullmatch(r"([a-zA-Z0-9][a-zA-Z0-9_.-]*)-(\d{4})", single["taskId"])
        if not match or int(match.group(2)) != index or (prefix and match.group(1) != prefix):
            raise ValueError("Task IDs must be one root followed by ordered -0001 through -0004")
        prefix = match.group(1)
        safe_path(single["taskId"])
        normalized.append({"taskId": single["taskId"], "task": single["task"]})
    return dict(value, tasks=normalized, method=dict(single["method"]))


class DomainAdapter(earthnano.EarthNanoAdapter):
    def __init__(self, config, root, reader):
        self.domain = config["domain"]
        self.task_map = {item["taskId"]: item["task"] for item in config["tasks"]}
        first = config["tasks"][0]
        single = {key: value for key, value in config.items() if key not in ("domain", "tasks")}
        super().__init__(dict(single, **first), root, reader)
        self.sources = {first["taskId"]: self.source}
        for item in config["tasks"][1:]:
            source = root / "task-sources" / item["taskId"]
            source.mkdir(parents=True)
            for entry in text_files(item["task"]["files"]):
                path = source / safe_path(entry["path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(entry["content"], encoding="utf-8", newline="")
            self.sources[item["taskId"]] = source

    def tasks(self, split="all"):
        return list(self.task_map)

    def domain_of(self, task_id):
        self.task_prompt(task_id)
        return self.domain

    def task_prompt(self, task_id):
        if task_id not in self.task_map:
            raise ValueError("Unknown domain task")
        return self.task_map[task_id]["prompt"]

    def task_files(self, task_id):
        self.task_prompt(task_id)
        return self.sources[task_id]


class DomainRequestFactory(PlatformRequestFactory):
    """Remember local routing without adding fields to ExecutionRequest or opaque refs."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.task_by_request = {}

    def __call__(self, invocation):
        request = super().__call__(invocation)
        # PortMethodExecution serializes factory/admission under its existing lock.
        self.task_by_request[request["requestKey"]] = invocation.task_id
        return request


def task_result(config, task_id, summary, adapter, reader, records):
    """Project the original summary and committed result views, as the single-task entry does."""
    method = config["method"]
    mode = schedule.mode_token(method["mode"])
    selection = summary.get("selections", {}).get(mode, {})
    chosen_path = selection.get("chosen_run_dir")
    chosen = reader.view(chosen_path) if chosen_path else None
    namespace = schedule.Namespace(adapter.spec.name, adapter.substrate.name, mode, method["k"])
    chosen_tree = tree.read_tree(earthnano.TEXT_SURFACE,
                                namespace.task_dir(adapter.spec.runs_root, task_id)
                                / "harnesses" / selection.get("chosen_label", "missing"))
    base_tree = tree.read_tree(earthnano.TEXT_SURFACE, adapter.base_harness())
    stages = summary.get("modes", {}).get(mode, {}).get("stages", [])
    result = {
        "taskId": task_id, "status": summary["status"], "summary": summary,
        "chosenArtifacts": chosen["artifacts"] if chosen else [],
        "configurationChanged": bool(chosen_tree and chosen_tree != base_tree),
        "fallbackStages": [stage["label"] for stage in stages if stage["fell_back"]],
        "method": method,
        "selection": {
            "chosenLabel": selection.get("chosen_label", ""),
            "candidateCount": selection.get("n_candidates", 0),
            "trivial": selection.get("trivial", False),
            "fallback": selection.get("fallback", False),
            "reason": selection.get("why") or selection.get("error", ""),
        },
        "executionIds": [record["executionId"] for record in records],
    }
    reflected = [record for record in records if record["request"]["role"] == "reflection"
                 and record["phase"] == "completed" and record["cleanup"] == "confirmed"
                 and record["evidence"]["status"] == "complete"]
    if reflected:
        record = reflected[-1]
        result["reflection"] = {"executionId": record["executionId"],
                                "artifacts": record["evidence"]["artifacts"]}
    return result


def run(config, client):
    config = validate_config(config)
    root = Path(config["workRoot"])
    root.mkdir(mode=0o700)
    reader = PlatformResultReader(client, root / "results")
    adapter = DomainAdapter(config, root, reader)
    factory = DomainRequestFactory(client, timeout_ms=config["executionTimeoutMs"])
    execution = PortMethodExecution(StdioExecutionPort(client), factory, reader, poll_interval=0.02)
    prop = Proposer(adapter.spec.channels["proposer"], attempts=1)
    method = config["method"]
    mode = schedule.mode_token(method["mode"])
    ordered = schedule.task_stream(adapter, seed=None)[config["domain"]]
    library_root = root / "library"
    library_root.mkdir(mode=0o700)
    stream = schedule.run_domain(config["domain"], ordered, method["k"], adapter=adapter,
                                 prop=prop, runs_root=adapter.spec.runs_root,
                                 library_root=library_root, modes=(mode,), seed=None,
                                 execution=execution)
    experiment_library = library.Library(library_root / mode, config["domain"], earthnano.TEXT_SURFACE)
    entries = experiment_library.entries()
    records = list(execution.records)
    tasks = []
    # Upstream stores shared bases and summary.port.json under the agg Namespace for both modes.
    summary_namespace = schedule.Namespace(adapter.spec.name, adapter.substrate.name, "agg", method["k"])
    for index, row in enumerate(stream["tasks"]):
        task_id = row["task"]
        path = summary_namespace.task_dir(adapter.spec.runs_root, task_id) / "summary.port.json"
        summary = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {
            "task_id": task_id, "domain": config["domain"], "k": method["k"],
            "seed": None, "status": row["status"], "base": [], "modes": {}, "selections": {},
            "errors": [row.get("error", "Domain task did not persist a summary")],
        }
        own_records = [record for record in records
                       if factory.task_by_request[record["requestKey"]] == task_id]
        projected = task_result(config, task_id, summary, adapter, reader, own_records)
        projected["libraryEntriesBefore"] = row.get("library_entries_before", {}).get(
            mode, sum(task in entries for task in ordered[:index]))
        tasks.append(projected)
    files = read_snapshot(library_root)
    context.assert_tree_has_no_grader_verdicts({entry["path"]: entry["content"] for entry in files})
    return {"status": "ok" if stream["failed"] == 0 else "partial", "domain": config["domain"],
            "order": ordered, "tasks": tasks, "records": records,
            "library": {"files": files, "entries": entries}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    client = None
    try:
        config = validate_config(json.loads(args.config.read_text(encoding="utf-8")))
        client = JsonLineClient(sys.stdin, sys.stdout, timeout_ms=config["rpcTimeoutMs"])
        with contextlib.redirect_stdout(sys.stderr):
            result = run(config, client)
        client.exchange("done", result=result)
        return 0 if result["status"] == "ok" else 1
    except ExecutionStopped:
        if client is not None and not client.stopped:
            try:
                client.exchange("done", result={"status": "stopped"})
            except ExecutionStopped:
                pass
        print("EarthNano domain stopped; platform retains execution/cleanup ownership.", file=sys.stderr)
        return 2
    except Exception:
        print("EarthNano domain failed; inspect platform-owned records for details.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
