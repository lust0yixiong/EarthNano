"""Opt-in platform-owned Harness² loop: python -m harness2.earthnano --config FILE.

The platform starts/owns the stdio peer, snapshots, model credentials, processes and durable
ArtifactVersion/Review owners. This entry point runs one existing sequential or parallel mode.
It never grades during optimization and never falls back to a legacy model launcher.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import re
import sys
from pathlib import Path

from .core import schedule, tree
from .core.earthnano_binding import (
    binary_alias, JsonLineClient, PlatformRequestFactory, PlatformResultReader, StdioExecutionPort,
    safe_path, text_files,
)
from .core.execution_contract import ExecutionStopped
from .core.method_execution import PortMethodExecution
from .core.proposer import Proposer
from .core.spec import BenchPrompts, BenchSpec, ChannelSpec

TEXT_SURFACE = tree.SurfaceSpec(
    name="claude-text", always_on=("instructions.md",), always_on_max=32_000,
    always_on_cap_reason="The directory-process profile admits only bounded plain text.",
    skill_dir="skills", skill_name_rule="must_match",
    trigger_hint="Name the native Skill earthnano-candidate:{name} in instructions.md.",
    autotrigger_file="instructions.md",
    trigger_line="Use Skill earthnano-candidate:{name} when {desc}.",
    subagent_requires_mode=False, plugin_dir=None, hooks_file=None,
    reject_empty_always_on=True,
)
_SKILL = re.compile(r"skills/([a-z0-9][a-z0-9-]*)/SKILL\.md")


def validate_text_harness(files: dict[str, str]) -> None:
    """Strict intersection of the method surface and the supported native Claude profile."""
    if not files.get("instructions.md", "").strip():
        raise ValueError("instructions.md must be nonempty")
    for path, content in files.items():
        match = _SKILL.fullmatch(path)
        if path != "instructions.md" and not match:
            raise ValueError("Only instructions.md and skills/name/SKILL.md are supported")
        if "@" in content or re.search(r"!\s*`|`{3,}\s*!", content):
            raise ValueError("File mention and dynamic shell syntax are unsupported")
        if match:
            frontmatter = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", content)
            if not frontmatter:
                raise ValueError("Skill requires name/description frontmatter")
            fields = re.split(r"\r?\n", frontmatter.group(1))
            if (len(fields) != 2 or f"name: {match.group(1)}" not in fields
                    or not any(line.startswith("description: ") for line in fields)
                    or any(not re.fullmatch(r"(?:name|description): [a-zA-Z0-9][a-zA-Z0-9 .,()_-]*", line)
                           for line in fields)
                    or re.search(r"^(?:hooks|allowed-tools|context|agent|disable-model-invocation)\s*:",
                                 content, re.M)):
                raise ValueError("Unsupported Skill frontmatter or policy")
    tree.validate(TEXT_SURFACE, files, allow_subagents=False)


class TextSubstrate:
    name = "claude-text"

    def surface(self):
        return TEXT_SURFACE


class EarthNanoAdapter:
    def __init__(self, config, root: Path, reader: PlatformResultReader):
        self.config, self.root, self.reader = config, root, reader
        self.substrate = TextSubstrate()
        self.base = root / "base-harness"
        self.base.mkdir(exist_ok=config.get("resume", False))
        base = {item["path"]: item["content"] for item in text_files(config["baseHarnessFiles"])}
        validate_text_harness(base)
        tree.write_tree(TEXT_SURFACE, base, self.base, stubs=False)
        self.source = root / "source"
        self.source.mkdir(exist_ok=config.get("resume", False))
        for entry in text_files(config["task"]["files"]):
            path = self.source / safe_path(entry["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(entry["content"], encoding="utf-8", newline="")
        if "managedInputs" in config["task"]:
            # Source identity only. The host's original Notebook owner stages these exact Versions.
            # This view cannot grant tools, resolve a host path, or choose a newer source Version.
            (self.source / "managed-inputs.json").write_text(
                json.dumps(config["task"]["managedInputs"], ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        channel = ChannelSpec("claude_cli", config["model"],
                              timeout=math.ceil(config["executionTimeoutMs"] / 1000))
        self.spec = BenchSpec(
            name="earthnano", runs_root=root / "runs", install_mode="workspace_agents_md",
            prompts=BenchPrompts(
                work="Complete the supplied research task using its source material.",
                inv_levers="Improve reliable reading, checking, and delivery of the requested work.",
                dom_levers="Improve the task-specific working guidance and plain text Skills.",
                domain_guidance="Only instructions.md and skills/name/SKILL.md may change. "
                                "Names use lowercase letters, digits and hyphens. Keep Skill "
                                "frontmatter exactly name and description. No scripts, hooks, "
                                "agents, plugins, configuration, file mentions or dynamic shell.",
            ),
            channels={"proposer": channel, "selector": channel},
        )

    def tasks(self, split="all"):
        return [self.config["taskId"]]

    def domain_of(self, task_id):
        return "local-task"

    def task_prompt(self, task_id):
        if task_id != self.config["taskId"]:
            raise ValueError("Unknown task")
        return self.config["task"]["prompt"]

    def task_files(self, task_id):
        self.task_prompt(task_id)
        return self.source

    def base_harness(self):
        return self.base

    def validate_tree(self, proposed):
        validate_text_harness(proposed)

    def execute(self, *args, **kwargs):
        raise ExecutionStopped("EarthNano execution requires the common platform port")

    def delivered(self, run_dir):
        return bool(self.reader.view(run_dir)["files"])

    def _binary_metadata(self, run_dir):
        return [{"logicalPath": entry["path"], "asset": binary_alias(entry),
                 "sizeBytes": entry["sizeBytes"], **({"contentType": entry["contentType"]}
                 if "contentType" in entry else {})}
                for entry in self.reader.view(run_dir)["files"]
                if entry.get("representation") == "binary"]

    def deliverable_files(self, run_dir):
        files = {entry["path"]: entry["content"] for entry in self.reader.view(run_dir)["files"]
                 if entry.get("representation") != "binary"}
        binary = self._binary_metadata(run_dir)
        if binary:
            name = "binary-artifacts.metadata.json"
            while name in files:
                name = "_" + name
            files[name] = json.dumps({"representation": "metadata-only",
                "notice": "This is metadata, not a text conversion, rendering, verification or Review of the binary bytes. The actual original bytes are in raw/<asset>. Any generic context index claim that this metadata is a canonical rendering does not apply to these binary assets.",
                "assets": binary}, ensure_ascii=False, sort_keys=True)
        return files

    def deliverable_text(self, run_dir):
        return "\n\n".join(f"# {path}\n\n{content}" for path, content
                           in self.deliverable_files(run_dir).items())

    deliverable_assets_reference_only = True

    @staticmethod
    def deliverable_assets_note(names):
        return "Original binary assets for this candidate are in `{anon}/`: " + ", ".join(names) + ". Metadata is not their content or an assessment. Open the actual files using supported tools.\n"

    @staticmethod
    def deliverable_assets_line(shown):
        return "    context/candidates/<id>/     original binary assets (" + shown + "), not rendered or verified evidence.\n"

    def deliverable_assets(self, run_dir):
        if not self._binary_metadata(run_dir):
            return []
        return self.reader.asset_paths(run_dir)

    def trajectory(self, run_dir, *, obs_trunc):
        # The platform projection is the complete readable turn; never inject Review verdicts.
        return self.reader.view(run_dir)["trajectoryText"]

    def artifacts_intact(self, run_dir):
        return self.reader.intact(run_dir)

    def score(self, *args, **kwargs):
        raise RuntimeError("Final assessment belongs to the independent platform Review owner")


def validate_managed_inputs(value):
    """Check the private identity projection; host owners remain the source/version authority."""
    fields = {"sourceKind", "sourceProjectId", "sourceSessionId", "sourceFileId",
              "inputFileVersionId", "filename", "sizeBytes", "checksum"}
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        raise ValueError("Expected one to ten original immutable inputs")
    seen = set()
    projects = set()
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != fields:
            raise ValueError("Invalid managed input identity fields")
        if entry["sourceKind"] not in ("upload-version", "artifact-version"):
            raise ValueError("Invalid managed input source kind")
        for key in fields - {"sizeBytes"}:
            text = entry[key]
            if (not isinstance(text, str) or not text.strip() or len(text) > 4096
                    or re.search(r"[\x00-\x1f\x7f]", text)):
                raise ValueError("Invalid managed input identity text")
            text.encode("utf-8")
        safe_path(entry["filename"])
        if (type(entry["sizeBytes"]) is not int or not 0 <= entry["sizeBytes"] <= 2**53 - 1
                or not re.fullmatch(r"[a-f0-9]{64}", entry["checksum"])):
            raise ValueError("Invalid managed input byte identity")
        key = (entry["sourceKind"], entry["inputFileVersionId"])
        if key in seen:
            raise ValueError("Duplicate managed input Version")
        seen.add(key)
        projects.add(entry["sourceProjectId"])
    if len(projects) != 1:
        raise ValueError("Managed inputs must belong to one Project")


def validate_config(value):
    required = {"configVersion", "taskId", "task", "baseHarnessFiles", "workRoot", "model"}
    optional = {"executionTimeoutMs", "rpcTimeoutMs", "method", "resume"}
    if not isinstance(value, dict) or required - value.keys() or value.keys() - required - optional:
        raise ValueError("Invalid EarthNano configuration fields")
    if "resume" in value and value["resume"] is not True:
        raise ValueError("Resume requires explicit true")
    if value["configVersion"] != 1:
        raise ValueError("Unsupported EarthNano configuration version")
    if not isinstance(value["taskId"], str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", value["taskId"]):
        raise ValueError("Task ID must be a portable single path segment")
    if not isinstance(value["model"], str) or not value["model"].strip():
        raise ValueError("Expected an explicit model identifier")
    if not isinstance(value["workRoot"], str) or not Path(value["workRoot"]).is_absolute():
        raise ValueError("workRoot must be an absolute new directory")
    task = value["task"]
    if (not isinstance(task, dict) or {"prompt", "files"} - set(task)
            or set(task) - {"prompt", "files", "managedInputs"}
            or not isinstance(task["prompt"], str) or not task["prompt"].strip()):
        raise ValueError("Expected the explicit research task and files")
    task["prompt"].encode("utf-8")
    text_files(task["files"])
    if "managedInputs" in task:
        validate_managed_inputs(task["managedInputs"])
        if task["files"]:
            raise ValueError("Managed scientific inputs cannot mix with inline files")
    base = text_files(value["baseHarnessFiles"])
    validate_text_harness({entry["path"]: entry["content"] for entry in base})
    value = dict(value, executionTimeoutMs=value.get("executionTimeoutMs", 100_000),
                 rpcTimeoutMs=value.get("rpcTimeoutMs", 120_000))
    for key in ("executionTimeoutMs", "rpcTimeoutMs"):
        if type(value[key]) is not int or not 1 <= value[key] <= 3_600_000:
            raise ValueError("Expected a positive bounded timeout in milliseconds")
    method = value.get("method", {"mode": "sequential", "k": 1, "concurrency": 1})
    if (not isinstance(method, dict) or set(method) != {"mode", "k", "concurrency"}
            or method["mode"] not in ("sequential", "parallel")
            or type(method["k"]) is not int or not 1 <= method["k"] <= 8
            or type(method["concurrency"]) is not int or not 1 <= method["concurrency"] <= 4):
        raise ValueError("Expected method mode, k (1–8), and concurrency (1–4)")
    value["method"] = dict(method)
    return value


def run(config, client):
    config = validate_config(config)
    root = Path(config["workRoot"])
    root.mkdir(mode=0o700, exist_ok=config.get("resume", False))
    reader = PlatformResultReader(client, root / "results", resume=config.get("resume", False))
    adapter = EarthNanoAdapter(config, root, reader)
    execution = PortMethodExecution(StdioExecutionPort(client),
                                    PlatformRequestFactory(client, timeout_ms=config["executionTimeoutMs"], reader=reader),
                                    reader, poll_interval=0.02)
    execution.resume = config.get("resume", False)
    prop = Proposer(adapter.spec.channels["proposer"], attempts=1)
    method = config["method"]
    mode = schedule.mode_token(method["mode"])
    result = schedule.run_task(config["taskId"], method["k"], adapter=adapter, prop=prop,
                               runs_root=adapter.spec.runs_root, modes=(mode,), execution=execution)
    selection = result.selections.get(mode, {})
    chosen_path = selection.get("chosen_run_dir")
    chosen = reader.view(chosen_path) if chosen_path else None
    base_tree = tree.read_tree(TEXT_SURFACE, adapter.base_harness())
    namespace = schedule.Namespace(adapter.spec.name, adapter.substrate.name, mode, method["k"])
    chosen_tree = tree.read_tree(TEXT_SURFACE,
                                namespace.task_dir(adapter.spec.runs_root, config["taskId"])
                                / "harnesses" / selection.get("chosen_label", "missing"))
    changed = bool(chosen_tree and chosen_tree != base_tree)
    stages = result.modes.get(mode, {}).get("stages", [])
    return {
        "status": "ok" if result.status == "skipped" else result.status,
        "summary": result.to_dict(),
        "records": (client.exchange("taskRecords", taskId=config["taskId"])
                    if config.get("resume") else list(execution.records)),
        "chosenArtifacts": chosen["artifacts"] if chosen else [],
        "configurationChanged": changed,
        "fallbackStages": [stage["label"] for stage in stages if stage["fell_back"]],
        "method": method,
        "selection": {
            "chosenLabel": selection.get("chosen_label", ""),
            "candidateCount": selection.get("n_candidates", 0),
            "trivial": selection.get("trivial", False),
            "fallback": selection.get("fallback", False),
            "reason": selection.get("why") or selection.get("error", ""),
        },
    }


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
        # The transport may already be unusable: notification is best effort, never readmit work.
        if client is not None and not client.stopped:
            try:
                client.exchange("done", result={"status": "stopped"})
            except ExecutionStopped:
                pass
        print("EarthNano method stopped; platform retains execution/cleanup ownership.", file=sys.stderr)
        return 2
    except Exception:
        print("EarthNano method failed; inspect platform-owned records for details.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
