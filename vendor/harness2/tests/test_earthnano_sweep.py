"""Real original run_sweep through offline platform port; no model or runtime launch."""
import copy
import json
import os
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from harness2 import earthnano_sweep as S
from harness2.core import schedule
from harness2.core.earthnano_binding import read_snapshot
from harness2.core.execution_contract import ExecutionStopped
from test_earthnano_binding import BASE, Peer
from test_earthnano_domain import DomainPeer, LegacyDomainAdapter, LegacyDomainProposer
from test_earthnano_method import FixtureReader
from test_earthnano_resume import ResumePeer
from test_earthnano_sweep_binding_v2 import original_schedule


def config(root, k=2, seed=None, workers=2):
    catalog = [{"taskId": task, "domain": domain} for domain in ("z", "a") for task in (domain + "2", domain + "1")]
    options = {"modes": ["parallel", "sequential"], "k": k, "concurrency": 2,
               "stream": {"seed": seed, "onlyDomains": [], "onlyTasks": [], "maxTasks": None, "workers": workers}}
    scope = lambda mode: str(schedule.Namespace("earthnano", "claude-text", mode, k, seed))
    binding = {"schemaVersion": 2, "bindingProfile": "earthnano-harness-binding-v2", "k": k,
               "seed": seed, "modes": ["agg", "seq"], "baseScope": scope("agg"),
               "modeScopes": {mode: scope(mode) for mode in ("agg", "seq")}}
    binding["digest"] = S.canonical_digest(binding)
    return {"configVersion": 2, "bindingIdentity": binding, "catalog": catalog,
            "tasks": [{"taskId": row["taskId"], "task": {"prompt": "Reconcile " + row["taskId"],
                        "files": [{"path": "source.txt", "content": row["taskId"] + " SOURCE"}]}} for row in catalog],
            "stream": options["stream"], "expectedDomains": S.planned_domains(catalog, options),
            "catalogDigest": S.canonical_digest(catalog), "planDigest": "sha256:" + "a" * 64,
            "baseHarnessFiles": [{"path": "instructions.md", "content": BASE}], "model": "offline-only",
            "workRoot": str(root / "work"), "executionTimeoutMs": 10_000, "rpcTimeoutMs": 12_000, "coreConcurrency": 2}


def scoped_records(owner, args):
    records = [record for record in owner.records.values()
               if owner.invocations[record["requestKey"]]["invocation"]["taskId"] == args["taskId"]]
    if "scope" in args:
        records = [record for record in records if record["request"]["role"] == "baseline"
                   or owner.invocations[record["requestKey"]]["invocation"]["scope"] == args["scope"]]
    return copy.deepcopy(records)


class SweepPeer(DomainPeer):
    def exchange(self, operation, **args):
        if operation == "taskRecords":
            return scoped_records(self, args)
        return super().exchange(operation, **args)


class SweepResumePeer(ResumePeer):
    def exchange(self, operation, **args):
        if operation == "taskRecords":
            return scoped_records(self.owner, args)
        return super().exchange(operation, **args)


class ManagedPeer(Peer):
    """Metadata transport fixture only; does not claim actual Notebook input/tool execution."""
    def __init__(self, cfg):
        super().__init__()
        self.tasks = {row["taskId"]: row["task"] for row in cfg["tasks"]}

    def exchange(self, operation, **args):
        if operation == "taskRecords":
            return scoped_records(self, args)
        if operation == "freezeInvocation":
            invocation = args["invocation"]
            task = self.tasks[invocation["taskId"]]
            if invocation["role"] in ("baseline", "candidate"):
                assert invocation["mission"] == task["prompt"]
            else:
                files = {entry["path"]: entry["content"] for entry in args["contextFiles"]}
                assert json.loads(files["source/managed-inputs.json"]) == task["managedInputs"]
                assert "criteria" not in files and "runtimeId" not in files
        result = super().exchange(operation, **args)
        if operation == "submit" and args["request"]["role"] == "reflection":
            self.results[result["executionId"]]["replyText"] = "NO_ENTRY"
        return result


class LegacyCatalog(LegacyDomainAdapter):
    def __init__(self, cfg, root):
        super().__init__(dict(cfg, domain="unused"), root, FixtureReader())
        self.domains = {row["taskId"]: row["domain"] for row in cfg["catalog"]}

    def domain_of(self, task_id):
        return self.domains[task_id]


@unittest.skipIf(os.name == "nt", "Pinned original run_sweep summary requires POSIX fcntl")
class SweepTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        for parent, _, files in os.walk(self.root):
            os.chmod(parent, 0o700)
            for name in files:
                os.chmod(Path(parent) / name, 0o600)
        self.temp.cleanup()

    def cfg(self, name, **kwargs):
        root = self.root / name
        root.mkdir()
        return config(root, **kwargs)

    def test_two_domains_two_modes_k2_use_one_original_sweep_with_shared_bases_and_scoped_reflections(self):
        cfg = self.cfg("full")
        peer = SweepPeer(cfg)
        with patch.object(schedule, "run_sweep", wraps=schedule.run_sweep) as sweep:
            result = S.execution_run(cfg, peer)
        self.assertEqual(sweep.call_count, 1)
        self.assertEqual(sweep.call_args.kwargs["domain_parallel"], 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["bindingDigest"], cfg["bindingIdentity"]["digest"])
        self.assertEqual(Counter(request["role"] for request in peer.requests),
                         {"baseline": 8, "candidate": 48, "proposer": 32, "composer": 16, "selector": 8, "reflection": 8})
        self.assertEqual(len(peer.requests), 120)
        for task in result["tasks"]:
            self.assertEqual(len(task["executionIds"]), 30)
            for mode, chosen in (("agg", "agg2"), ("seq", "c2")):
                row = task["modes"][mode]
                self.assertEqual(row["method"], {"mode": schedule.MODE_NAMES[mode], "k": 2, "concurrency": 2})
                self.assertEqual(row["selection"]["chosenLabel"], chosen)
                self.assertFalse(row["selection"]["fallback"])
                self.assertTrue(row["configurationChanged"])
                self.assertEqual(len(row["executionIds"]), 16)
                reflection = peer.records[row["reflection"]["executionId"]]
                self.assertEqual(peer.invocations[reflection["requestKey"]]["invocation"]["scope"], cfg["bindingIdentity"]["modeScopes"][mode])
                bases = [id for id in row["executionIds"] if peer.records[id]["request"]["role"] == "baseline"]
                self.assertEqual(len(bases), 2)
                for other in task["modes"].values():
                    self.assertTrue(set(bases) <= set(other["executionIds"]))
        for cell in result["libraries"]:
            self.assertEqual(set(cell["entries"]), {cell["domain"] + "1", cell["domain"] + "2"})
            self.assertTrue(all(file["path"].startswith(cell["mode"] + "/" + cell["domain"] + "/") for file in cell["files"]))

    def test_library_and_original_stream_match_pinned_original_run_sweep(self):
        cfg = self.cfg("port", k=1)
        peer = SweepPeer(cfg)
        result = S.execution_run(cfg, peer)
        old_cfg = self.cfg("original", k=1)
        work = Path(old_cfg["workRoot"])
        work.mkdir()
        adapter = LegacyCatalog(old_cfg, work)
        prop = LegacyDomainProposer(adapter.spec.channels["proposer"])
        expected = original_schedule().run_sweep(1, adapter=adapter, prop=prop, runs_root=adapter.spec.runs_root,
                                                library_root=work / "library", modes=("agg", "seq"), domain_parallel=2)
        self.assertEqual(result["sweep"]["domain_order"], expected["domain_order"])
        self.assertEqual({row["domain"]: (row["done"], row["failed"], row["tasks"]) for row in result["sweep"]["domains"]},
                         {row["domain"]: (row["done"], row["failed"], row["tasks"]) for row in expected["domains"]})
        actual_files = sorted([file for cell in result["libraries"] for file in cell["files"]], key=lambda f: f["path"])
        self.assertEqual(actual_files, read_snapshot(work / "library"))

    def test_seed_filters_caps_and_workers_use_original_stream_without_unselected_payloads(self):
        for seed in (0, -7):
            cfg = self.cfg("seed" + str(seed), k=1, seed=seed, workers=1)
            cfg["stream"].update(onlyDomains=["z"], onlyTasks=["z1", "z2"], maxTasks=1)
            options = {"modes": ["parallel", "sequential"], "k": 1, "concurrency": 2, "stream": cfg["stream"]}
            cfg["expectedDomains"] = S.planned_domains(cfg["catalog"], options)
            ids = {t for row in cfg["expectedDomains"] for t in row["taskIds"]}
            cfg["tasks"] = [row for row in cfg["tasks"] if row["taskId"] in ids]
            peer = SweepPeer(cfg)
            result = S.execution_run(cfg, peer)
            self.assertEqual([row["taskId"] for row in result["tasks"]], list(ids))
            self.assertEqual(result["sweep"]["seed"], seed)
            self.assertEqual(len(peer.requests), 15)
            self.assertTrue(all(peer.invocations[r["requestKey"]]["invocation"]["taskId"] in ids for r in peer.requests))

    def test_explicit_resume_reuses_completed_original_stages_and_libraries_without_new_admissions(self):
        cfg = self.cfg("resume", k=1, workers=1)
        peer = SweepResumePeer(SweepPeer(cfg), stop_after=5)
        with self.assertRaises(ExecutionStopped):
            S.execution_run(cfg, peer)
        initial = set(peer.owner.records)
        peer.resuming = True
        result = S.execution_run(dict(cfg, resume=True), peer)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(initial <= peer.reused)
        self.assertEqual(len(peer.owner.requests), 60)
        again = S.execution_run(dict(cfg, resume=True), peer)
        self.assertEqual(again["status"], "ok")
        self.assertEqual(len(peer.owner.requests), 60)

    def test_managed_metadata_stays_task_local_and_no_entry_does_not_fabricate_library(self):
        cfg = self.cfg("managed", k=1)
        for row in cfg["tasks"]:
            task_id = row["taskId"]
            row["task"] = {"prompt": "Original scientific task " + task_id, "files": [], "managedInputs": [{
                "sourceKind": "upload-version", "sourceProjectId": "project", "sourceSessionId": "source-" + task_id,
                "sourceFileId": "upload-" + task_id, "inputFileVersionId": "version-" + task_id,
                "filename": "rows.csv", "sizeBytes": 12, "checksum": "a" * 64}]}
        result = S.execution_run(cfg, ManagedPeer(cfg))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(all(not cell["entries"] for cell in result["libraries"]))
        self.assertTrue(all("reflection" in row for task in result["tasks"] for row in task["modes"].values()))

    def test_bad_descriptor_plan_payload_and_metadata_are_rejected_before_workspace_or_port(self):
        cfg = self.cfg("invalid")
        mutations = []
        for key, value in (("configVersion", 1), ("coreConcurrency", 5), ("catalogDigest", "sha256:" + "0" * 64), ("expectedDomains", [])):
            mutations.append(dict(cfg, **{key: value}))
        changed = copy.deepcopy(cfg); changed["bindingIdentity"]["modeScopes"]["seq"] = "foreign"; mutations.append(changed)
        changed = copy.deepcopy(cfg); changed["tasks"][0]["task"]["criteria"] = "LEAK"; mutations.append(changed)
        changed = copy.deepcopy(cfg); changed["tasks"][0]["task"]["managedInputs"] = [{}]; mutations.append(changed)
        for bad in mutations:
            with self.assertRaises((ValueError, TypeError)):
                S.execution_run(bad, SweepPeer(cfg))
            self.assertFalse(Path(cfg["workRoot"]).exists())


if __name__ == "__main__":
    unittest.main()
