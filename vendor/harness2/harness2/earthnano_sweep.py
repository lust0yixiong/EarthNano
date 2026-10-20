"""Private original-scheduler sweep entry. Preview never constructs execution owners."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import re
import sys
from pathlib import Path

from .core import schedule
from .cli._common import parse_modes

MAX_BYTES = 32 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1


def fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Invalid fixed sweep fields")
    return value


def catalog_id(value):
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value)
            or value.endswith(".") or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", value, re.I)):
        raise ValueError("Invalid fixed catalog identity")
    return value


def normalize_catalog(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError("Expected bounded fixed catalog")
    result, tasks, domains = [], set(), {}
    for item in value:
        fields(item, ("taskId", "domain"))
        task, domain = catalog_id(item["taskId"]), catalog_id(item["domain"])
        if task.lower() in tasks or domain.lower() in domains and domains[domain.lower()] != domain:
            raise ValueError("Ambiguous catalog identity")
        tasks.add(task.lower())
        domains[domain.lower()] = domain
        result.append({"taskId": task, "domain": domain})
    return result


def normalize_options(value):
    fields(value, ("modes", "k", "concurrency", "stream"))
    modes = value["modes"]
    if (not isinstance(modes, list) or not modes or len(set(modes)) != len(modes)
            or any(mode not in ("parallel", "sequential") for mode in modes)):
        raise ValueError("Invalid original mode selection")
    for key, maximum in (("k", 8), ("concurrency", 4)):
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise ValueError("Invalid bounded method control")
    stream = fields(value["stream"], ("seed", "onlyDomains", "onlyTasks", "maxTasks", "workers"))
    seed, cap = stream["seed"], stream["maxTasks"]
    if seed is not None and (type(seed) is not int or abs(seed) > MAX_SAFE_INTEGER):
        raise ValueError("Invalid original seed")
    if cap is not None and (type(cap) is not int or not 1 <= cap <= MAX_SAFE_INTEGER):
        raise ValueError("Invalid per-domain cap")
    if type(stream["workers"]) is not int or not 1 <= stream["workers"] <= 4:
        raise ValueError("Invalid domain worker count")
    for key in ("onlyDomains", "onlyTasks"):
        names = stream[key]
        if not isinstance(names, list) or len(names) > 32:
            raise ValueError("Invalid stream filter")
        for name in names:
            catalog_id(name)
        if len(set(names)) != len(names):
            raise ValueError("Duplicate stream filter")
    tokens = parse_modes(",".join(modes))
    return dict(value, modes=[schedule.MODE_NAMES[token] for token in tokens], stream=dict(stream))


class IdentityCatalog:
    def __init__(self, catalog):
        self.catalog = catalog
        self.domain_map = {entry["taskId"]: entry["domain"] for entry in catalog}

    def tasks(self, split="all"):
        if split != "all":
            raise ValueError("Fixed catalog has no declared partition")
        return list(self.domain_map)

    def domain_of(self, task_id):
        return self.domain_map[task_id]


def planned_domains(catalog, options):
    stream = options["stream"]
    ordered = schedule.task_stream(IdentityCatalog(catalog), split="all", seed=stream["seed"],
                                   only_domains=stream["onlyDomains"], only_tasks=stream["onlyTasks"],
                                   max_tasks=stream["maxTasks"])
    return [{"domain": domain, "taskIds": ids} for domain, ids in ordered.items()]


def preview(value):
    fields(value, ("configVersion", "catalog", "options"))
    if type(value["configVersion"]) is not int or value["configVersion"] != 2:
        raise ValueError("Invalid sweep preview version")
    catalog, options = normalize_catalog(value["catalog"]), normalize_options(value["options"])
    return {"resultVersion": 2, "domains": planned_domains(catalog, options)}


def canonical_digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":")).encode("utf-8")).hexdigest()


def normalize_binding(value):
    fields(value, ("schemaVersion", "bindingProfile", "k", "seed", "modes", "baseScope", "modeScopes", "digest"))
    modes, k, seed = value["modes"], value["k"], value["seed"]
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 2
            or value["bindingProfile"] != "earthnano-harness-binding-v2"
            or type(k) is not int or not 1 <= k <= 8
            or seed is not None and (type(seed) is not int or abs(seed) > MAX_SAFE_INTEGER)
            or not isinstance(modes, list) or not modes
            or modes != [mode for mode in schedule.MODES if mode in modes]):
        raise ValueError("Invalid v2 namespace identity")
    scope = lambda mode: str(schedule.Namespace("earthnano", "claude-text", mode, k, seed))
    expected = {"schemaVersion": 2, "bindingProfile": "earthnano-harness-binding-v2", "k": k,
                "seed": seed, "modes": modes, "baseScope": scope("agg"),
                "modeScopes": {mode: scope(mode) for mode in modes}}
    expected["digest"] = canonical_digest(expected)
    if value != expected:
        raise ValueError("Changed original namespace identity")
    return expected


def validate_config(value):
    from . import earthnano
    required = {"configVersion", "bindingIdentity", "catalog", "tasks", "stream", "expectedDomains",
                "catalogDigest", "planDigest", "baseHarnessFiles", "model", "workRoot",
                "executionTimeoutMs", "rpcTimeoutMs", "coreConcurrency"}
    if not isinstance(value, dict) or required - set(value) or set(value) - required - {"resume"}:
        raise ValueError("Invalid private sweep configuration")
    if type(value["configVersion"]) is not int or value["configVersion"] != 2:
        raise ValueError("Invalid sweep configuration version")
    if "resume" in value and value["resume"] is not True:
        raise ValueError("Resume must be explicit")
    binding = normalize_binding(value["bindingIdentity"])
    catalog = normalize_catalog(value["catalog"])
    options = normalize_options({"modes": [schedule.MODE_NAMES[mode] for mode in binding["modes"]],
                                 "k": binding["k"], "concurrency": value["coreConcurrency"],
                                 "stream": value["stream"]})
    if options["stream"]["seed"] != binding["seed"]:
        raise ValueError("Stream seed differs from namespace identity")
    domains = planned_domains(catalog, options)
    if not domains or value["expectedDomains"] != domains:
        raise ValueError("Selected original stream differs from frozen plan")
    if (value["catalogDigest"] != canonical_digest(catalog)
            or not isinstance(value["planDigest"], str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["planDigest"])):
        raise ValueError("Invalid frozen plan identity")
    selected = {task for row in domains for task in row["taskIds"]}
    if not isinstance(value["tasks"], list) or len(value["tasks"]) != len(selected):
        raise ValueError("Selected payload inventory mismatch")
    tasks, seen = [], set()
    for entry in value["tasks"]:
        fields(entry, ("taskId", "task"))
        task_id = catalog_id(entry["taskId"])
        if task_id not in selected or task_id in seen:
            raise ValueError("Unselected or duplicate task payload")
        seen.add(task_id)
        single = {"configVersion": 1, "taskId": task_id, "task": entry["task"],
                  "baseHarnessFiles": value["baseHarnessFiles"], "model": value["model"],
                  "workRoot": value["workRoot"], "executionTimeoutMs": value["executionTimeoutMs"],
                  "rpcTimeoutMs": value["rpcTimeoutMs"]}
        if value.get("resume"):
            single["resume"] = True
        normalized = earthnano.validate_config(single)
        tasks.append({"taskId": task_id, "task": normalized["task"]})
    return dict(value, tasks=tasks, catalog=catalog, bindingIdentity=binding, stream=options["stream"])


def execution_run(config, client):
    from . import earthnano
    from .core import context, library, tree
    from .core.earthnano_binding import (
        PlatformRequestFactory, PlatformResultReader, StdioExecutionPort,
        read_snapshot, safe_path, text_files,
    )
    from .core.method_execution import PortMethodExecution
    from .core.proposer import Proposer

    config = validate_config(config)
    root = Path(config["workRoot"])
    root.mkdir(mode=0o700, exist_ok=config.get("resume", False))
    reader = PlatformResultReader(client, root / "results", resume=config.get("resume", False))

    class CatalogAdapter(earthnano.EarthNanoAdapter, IdentityCatalog):
        def __init__(self):
            first = config["tasks"][0]
            single = {key: config[key] for key in ("baseHarnessFiles", "model", "workRoot", "executionTimeoutMs", "rpcTimeoutMs")}
            single.update(configVersion=1, **first)
            if config.get("resume"):
                single["resume"] = True
            earthnano.EarthNanoAdapter.__init__(self, single, root, reader)
            IdentityCatalog.__init__(self, config["catalog"])
            self.task_map = {row["taskId"]: row["task"] for row in config["tasks"]}
            self.sources = {first["taskId"]: self.source}
            for row in config["tasks"][1:]:
                source = root / "task-sources" / safe_path(row["taskId"])
                source.mkdir(parents=True, exist_ok=config.get("resume", False))
                for entry in text_files(row["task"]["files"]):
                    path = source / safe_path(entry["path"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(entry["content"], encoding="utf-8", newline="")
                if "managedInputs" in row["task"]:
                    (source / "managed-inputs.json").write_text(json.dumps(
                        row["task"]["managedInputs"], ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                self.sources[row["taskId"]] = source

        def tasks(self, split="all"):
            return IdentityCatalog.tasks(self, split)

        def domain_of(self, task_id):
            return IdentityCatalog.domain_of(self, task_id)

        def task_prompt(self, task_id):
            if task_id not in self.task_map:
                raise ValueError("Unselected task has no execution payload")
            return self.task_map[task_id]["prompt"]

        def task_files(self, task_id):
            self.task_prompt(task_id)
            return self.sources[task_id]

    adapter = CatalogAdapter()
    execution = PortMethodExecution(StdioExecutionPort(client),
                                    PlatformRequestFactory(client, timeout_ms=config["executionTimeoutMs"]),
                                    reader, poll_interval=0.02)
    execution.resume = config.get("resume", False)
    binding, stream = config["bindingIdentity"], config["stream"]
    prop = Proposer(adapter.spec.channels["proposer"], attempts=1)
    library_root = root / "library"
    library_root.mkdir(mode=0o700, exist_ok=config.get("resume", False))
    sweep = schedule.run_sweep(
        binding["k"], adapter=adapter, prop=prop, runs_root=adapter.spec.runs_root,
        library_root=library_root, split="all", modes=tuple(binding["modes"]), seed=stream["seed"],
        tag="", domain_parallel=stream["workers"], only_domains=stream["onlyDomains"],
        only_tasks=stream["onlyTasks"], max_tasks=stream["maxTasks"], pool_policy="finals", execution=execution)
    task_rows = {row["task"]: row for domain in sweep["domains"] for row in domain.get("tasks", [])}
    tasks = []
    summary_ns = schedule.Namespace("earthnano", "claude-text", "agg", binding["k"], binding["seed"])
    base_tree = tree.read_tree(earthnano.TEXT_SURFACE, adapter.base_harness())
    for domain in config["expectedDomains"]:
        for task_id in domain["taskIds"]:
            path = summary_ns.task_dir(adapter.spec.runs_root, task_id) / "summary.port.json"
            summary = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {
                "status": task_rows.get(task_id, {}).get("status", "exception"), "selections": {}, "modes": {}}
            records = client.exchange("taskRecords", taskId=task_id)
            modes = {}
            for mode in binding["modes"]:
                own = client.exchange("taskRecords", taskId=task_id, scope=binding["modeScopes"][mode])
                selection = summary.get("selections", {}).get(mode, {})
                chosen_path = selection.get("chosen_run_dir")
                chosen = reader.view(chosen_path) if chosen_path else None
                namespace = schedule.Namespace("earthnano", "claude-text", mode, binding["k"], binding["seed"])
                chosen_tree = tree.read_tree(earthnano.TEXT_SURFACE, namespace.task_dir(adapter.spec.runs_root, task_id)
                                             / "harnesses" / selection.get("chosen_label", "missing"))
                projected = {"taskId": task_id, "status": "ok" if summary["status"] == "skipped" else summary["status"],
                             "chosenArtifacts": chosen["artifacts"] if chosen else [],
                             "configurationChanged": bool(chosen_tree and chosen_tree != base_tree),
                             "fallbackStages": [stage["label"] for stage in summary.get("modes", {}).get(mode, {}).get("stages", []) if stage["fell_back"]],
                             "method": {"mode": schedule.MODE_NAMES[mode], "k": binding["k"], "concurrency": config["coreConcurrency"]},
                             "selection": {"chosenLabel": selection.get("chosen_label", ""), "candidateCount": selection.get("n_candidates", 0),
                                           "trivial": selection.get("trivial", False), "fallback": selection.get("fallback", False),
                                           "reason": selection.get("why") or selection.get("error", "")},
                             "executionIds": [record["executionId"] for record in own]}
                reflected = [record for record in own if record["request"]["role"] == "reflection"
                             and record["phase"] == "completed" and record["cleanup"] == "confirmed"
                             and record["evidence"]["status"] == "complete"]
                if reflected:
                    last = reflected[-1]
                    projected["reflection"] = {"executionId": last["executionId"], "artifacts": last["evidence"]["artifacts"]}
                modes[mode] = projected
            tasks.append({"taskId": task_id, "domain": domain["domain"],
                          "status": "ok" if summary["status"] == "skipped" else summary["status"],
                          "summary": summary, "executionIds": [record["executionId"] for record in records], "modes": modes})
    all_files = read_snapshot(library_root)
    context.assert_tree_has_no_grader_verdicts({entry["path"]: entry["content"] for entry in all_files})
    libraries = [{"domain": domain["domain"], "mode": mode,
                  "entries": library.Library(library_root / mode, domain["domain"], earthnano.TEXT_SURFACE).entries(),
                  "files": [entry for entry in all_files if entry["path"].startswith(mode + "/" + domain["domain"] + "/")]}
                 for domain in config["expectedDomains"] for mode in binding["modes"]]
    success = bool(sweep["domains"]) and all(not row.get("error") and row.get("failed") == 0 for row in sweep["domains"])
    return {"resultVersion": 2, "bindingDigest": binding["digest"], "planDigest": config["planDigest"],
            "status": "ok" if success else "partial", "sweep": sweep, "tasks": tasks, "libraries": libraries}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preview", action="store_true")
    group.add_argument("--config", type=Path)
    args = parser.parse_args(argv)
    client = None
    try:
        if args.config:
            from .core.earthnano_binding import JsonLineClient
            config = validate_config(json.loads(args.config.read_text(encoding="utf-8")))
            client = JsonLineClient(sys.stdin, sys.stdout, timeout_ms=config["rpcTimeoutMs"])
            with contextlib.redirect_stdout(sys.stderr):
                result = execution_run(config, client)
            client.exchange("done", result=result)
            return 0 if result["status"] == "ok" else 1
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized preview")
        result = preview(json.loads(raw.decode("utf-8", errors="strict")))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception:
        # No provider text, arbitrary exception body or secret crosses stderr diagnostics.
        print("Original sweep stopped or rejected its frozen plan; platform retains execution ownership.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
