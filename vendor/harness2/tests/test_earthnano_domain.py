"""Explicit domain stream, original reflection/Library and task routing; no model/network."""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness2 import earthnano, earthnano_domain
from harness2.core import schedule, selection
from harness2.core.earthnano_binding import digest, read_snapshot
from harness2.core.execution_contract import ExecutionStopped
from harness2.core.method_execution import LEGACY
from harness2.core.proposer import Proposer, Reply
from test_earthnano_binding import BASE, Peer, config as single_config
from test_earthnano_method import FixtureReader


LESSON = "Reconcile every source row before delivery"
TRANSFERRED = BASE + LESSON + "; apply the earlier task experience.\n"
REFLECTION = ("<edits>Verified each row before delivery.</edits>\n"
              "<experience>\ncue: Source row reconciliation\n"
              f"lesson: {LESSON}\n"
              "evidence: The chosen output reconciles all supplied rows.\n"
              "confidence: provisional\n</experience>")


def config(root, mode="sequential", domain="row-checking"):
    return {
        "configVersion": 1, "domain": domain,
        "tasks": [
            {"taskId": "experiment-0001", "task": {
                "prompt": "First task: summarize first.txt into answer.txt.",
                "files": [{"path": "first.txt", "content": "FIRST SOURCE ROWS"}]}},
            {"taskId": "experiment-0002", "task": {
                "prompt": "Second task: reconcile second.txt into answer.txt.",
                "files": [{"path": "second.txt", "content": "SECOND SOURCE ROWS"}]}},
        ],
        "baseHarnessFiles": [{"path": "instructions.md", "content": BASE}],
        "workRoot": str(root / "work"), "model": "fixture-model",
        "method": {"mode": mode, "k": 1, "concurrency": 2},
        "executionTimeoutMs": 10_000, "rpcTimeoutMs": 12_000,
    }


class DomainPeer(Peer):
    def __init__(self, cfg):
        super().__init__()
        self.tasks = {item["taskId"]: item["task"] for item in cfg["tasks"]}
        self.reflection_text = None
        self.reflection_failed = False
        self.stop_role = None
        self.admissions_limit = None

    def exchange(self, operation, **args):
        if operation == "freezeInvocation":
            invocation = args["invocation"]
            task = self.tasks[invocation["taskId"]]
            if invocation["role"] in ("baseline", "candidate"):
                assert invocation["mission"] == task["prompt"]
            else:
                files = {entry["path"]: entry["content"] for entry in args["contextFiles"]}
                assert files["task.md"] == task["prompt"]
                assert {path: body for path, body in files.items() if path.startswith("source/")} == {
                    "source/" + entry["path"]: entry["content"] for entry in task["files"]}
        if operation == "submit":
            if (args["request"]["role"] == self.stop_role
                    or self.admissions_limit is not None and len(self.requests) >= self.admissions_limit):
                raise ExecutionStopped("Domain shared budget or stop")
        result = super().exchange(operation, **args)
        if operation == "submit":
            request = args["request"]
            offered = self.invocations[request["requestKey"]]
            invocation = offered["invocation"]
            exported = self.results[result["executionId"]]
            artifact = exported["artifacts"][0]
            role = invocation["role"]
            if role in ("proposer", "composer"):
                learned = any(entry["path"].startswith("library/") and LESSON in entry["content"]
                              for entry in offered["contextFiles"])
                if learned:
                    content = TRANSFERRED
                    exported["files"][0].update(content=content, digest=digest(content))
            elif role == "reflection":
                if self.reflection_failed:
                    self.records[result["executionId"]].update(
                        phase="failed", error={"code": "provider-failed", "message": "Ordinary reflection failure"})
                    result["phase"] = "failed"
                reply = self.reflection_text
                if reply is None:
                    reply = REFLECTION
                exported["replyText"] = reply
                exported["files"] = [{"path": "experience.md", "content": reply,
                                       "digest": digest(reply), "artifactRef": artifact}]
            elif role in ("baseline", "candidate"):
                task = self.tasks[invocation["taskId"]]
                harness = {entry["path"]: entry["content"] for entry in offered["harnessFiles"]}
                learned = LESSON in harness["instructions.md"]
                content = task["files"][0]["content"] + ("; reconciled using prior experience" if learned else "")
                if invocation["stageLabel"] in ("c2", "agg2"):
                    content += "; verified twice"
                exported["files"][0].update(content=content, digest=digest(content))
                exported["trajectoryText"] = "Read the current task source and verified its rows."
        return result


class LegacyDomainAdapter(earthnano_domain.DomainAdapter):
    def execute(self, task_id, harness_dir, run_id):
        path = self.root / "legacy-results" / run_id
        path.mkdir(parents=True)
        harness = Path(harness_dir or self.base_harness()) / "instructions.md"
        learned = LESSON in harness.read_text()
        content = self.task_map[task_id]["files"][0]["content"] + (
            "; reconciled using prior experience" if learned else "")
        (path / "answer.txt").write_text(content)
        self.reader.views[path] = {"files": [{"path": "answer.txt", "content": content}],
                                   "trajectoryText": "Read the current task source and verified its rows."}
        return path


class LegacyDomainProposer(Proposer):
    def __init__(self, spec):
        super().__init__(spec, attempts=1)
        self.contexts = []

    def call(self, mission, context_dir, label, **kwargs):
        files = read_snapshot(Path(context_dir))
        self.contexts.append((label, files))
        if label.startswith("experience."):
            return Reply(label, REFLECTION, True)
        from test_earthnano_binding import harness_for
        learned = any(file["path"].startswith("library/") and LESSON in file["content"] for file in files)
        workspace = Path(context_dir) / "harness"
        (workspace / "instructions.md").write_text(
            TRANSFERRED if learned else harness_for(re.sub(r"\.a\d+$", "", label)))
        return Reply(label, "<notes>Verified the supplied trajectory.</notes>", True, workspace=workspace)


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        for parent, _, _ in os.walk(self.root):
            os.chmod(parent, 0o700)
        self.temporary.cleanup()

    def cfg(self, name, **kwargs):
        root = self.root / name
        root.mkdir()
        return config(root, **kwargs)

    def assert_stream(self, cfg, peer, result):
        ids = [item["taskId"] for item in cfg["tasks"]]
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["order"], ids)
        self.assertEqual(len(peer.requests), 16)
        self.assertEqual([task["libraryEntriesBefore"] for task in result["tasks"]], [0, 1])
        self.assertEqual(result["library"]["entries"], ids)
        self.assertEqual(len(result["records"]), 16)
        own_id_sets = []
        token = schedule.mode_token(cfg["method"]["mode"])
        for task in result["tasks"]:
            own_ids = set(task["executionIds"])
            own_id_sets.append(own_ids)
            self.assertEqual(len(own_ids), 8)
            own = [record for record in result["records"] if record["executionId"] in own_ids]
            for record in own:
                offered = peer.invocations[record["requestKey"]]
                self.assertEqual(offered["invocation"]["taskId"], task["taskId"])
            self.assertEqual(sum(record["request"]["role"] == "reflection" for record in own), 1)
            self.assertEqual(task["reflection"]["artifacts"],
                             peer.records[task["reflection"]["executionId"]]["evidence"]["artifacts"])
            self.assertTrue(task["selection"]["trivial"])
            self.assertEqual(task["selection"]["candidateCount"], 1)
            self.assertTrue(task["configurationChanged"])
            self.assertTrue(task["summary"]["selections"][token]["experience"]["lesson"])
            self.assertEqual((task["summary"]["modes"][token]["ledger"]["R"],
                              task["summary"]["modes"][token]["ledger"]["P"]), (4, 3))
            chosen = next(record for record in own if record["evidence"]["artifacts"] == task["chosenArtifacts"])
            self.assertEqual(chosen["request"]["role"], "candidate")
        self.assertTrue(own_id_sets[0].isdisjoint(own_id_sets[1]))
        self.assertEqual(set.union(*own_id_sets), set(peer.records))
        for offered in peer.invocations.values():
            invocation = offered["invocation"]
            files = {file["path"]: file["content"] for file in offered["contextFiles"]}
            if invocation["role"] in ("proposer", "composer"):
                if invocation["taskId"] == ids[0]:
                    self.assertFalse(any(path.startswith("library/") for path in files))
                else:
                    self.assertTrue(any(path.startswith("library/") and LESSON in body
                                        for path, body in files.items()))
                    self.assertNotIn("FIRST SOURCE ROWS", "\n".join(files.values()))
            self.assertNotIn("pass_rate", json.dumps(files))
            self.assertNotIn("private-grade", json.dumps(files))
        second_final = next(record for record in result["records"]
                            if record["evidence"]["artifacts"] == result["tasks"][1]["chosenArtifacts"])
        self.assertIn("prior experience", peer.results[second_final["executionId"]]["files"][0]["content"])
        exported = json.dumps(result["library"])
        self.assertIn(LESSON, exported)
        self.assertNotIn(str(self.root), exported)
        self.assertTrue(all(file["path"].startswith(token + "/" + cfg["domain"] + "/")
                            for file in result["library"]["files"]))

    def test_original_two_task_domain_transfers_reflection_in_both_modes(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                cfg = self.cfg(mode, mode=mode)
                peer = DomainPeer(cfg)
                with patch.object(schedule, "task_stream", wraps=schedule.task_stream) as order, \
                     patch.object(schedule, "run_domain", wraps=schedule.run_domain) as domain, \
                     patch.object(selection, "reflect_adoption", wraps=selection.reflect_adoption) as reflect, \
                     patch("harness2.core.proposer.Proposer.call", side_effect=AssertionError("provider")):
                    result = earthnano_domain.run(cfg, peer)
                order.assert_called_once()
                domain.assert_called_once()
                self.assertEqual(reflect.call_count, 2)
                self.assert_stream(cfg, peer, result)

    def test_four_task_reference_order_retains_only_preceding_original_library_entries(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                cfg = self.cfg("four-task-" + mode, mode=mode)
                for index in (3, 4):
                    cfg["tasks"].append({"taskId": f"experiment-{index:04d}", "task": {
                        "prompt": f"Task {index}: reconcile its supplied source.",
                        "files": [{"path": f"source-{index}.txt", "content": f"SOURCE ROWS {index}"}]}})
                peer = DomainPeer(cfg)
                result = earthnano_domain.run(cfg, peer)
                ids = [item["taskId"] for item in cfg["tasks"]]
                self.assertEqual(result["order"], ids)
                self.assertEqual(result["library"]["entries"], ids)
                self.assertEqual([task["libraryEntriesBefore"] for task in result["tasks"]], [0, 1, 2, 3])
                self.assertEqual(len(peer.requests), 32)
                for offered in peer.invocations.values():
                    invocation = offered["invocation"]
                    if invocation["role"] not in ("proposer", "composer"):
                        continue
                    current = ids.index(invocation["taskId"])
                    paths = [file["path"] for file in offered["contextFiles"]]
                    for index, task_id in enumerate(ids):
                        found = any(path.startswith(f"library/harnesses/{task_id}/") for path in paths)
                        self.assertEqual(found, index < current)
                    body = json.dumps(offered["contextFiles"])
                    self.assertNotIn("private-grade", body)
                    self.assertNotIn("pass_rate", body)

    def test_real_stdio_both_modes_preserve_task_routing_and_library_transfer(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                cfg = self.cfg("stdio-" + mode, mode=mode)
                path = self.root / (mode + ".json")
                path.write_text(json.dumps(cfg))
                peer = DomainPeer(cfg)
                child = subprocess.Popen([sys.executable, "-B", "-m", "harness2.earthnano_domain", "--config", str(path)],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                final = None
                try:
                    for line in child.stdout:
                        message = json.loads(line)
                        operation = message.pop("operation")
                        request_id = message.pop("id")
                        reply = peer.exchange(operation, **message)
                        if operation == "done":
                            final = message["result"]
                        child.stdin.write(json.dumps({"id": request_id, "result": reply}) + "\n")
                        child.stdin.flush()
                    self.assertEqual(child.wait(timeout=10), 0, child.stderr.read())
                    self.assert_stream(cfg, peer, final)
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=10)

    def test_domain_library_and_complete_contexts_match_original_legacy_mechanism(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                cfg = self.cfg("port-parity-" + mode, mode=mode)
                peer = DomainPeer(cfg)
                result = earthnano_domain.run(cfg, peer)
                legacy_cfg = self.cfg("legacy-parity-" + mode, mode=mode)
                root = Path(legacy_cfg["workRoot"])
                root.mkdir()
                adapter = LegacyDomainAdapter(legacy_cfg, root, FixtureReader())
                prop = LegacyDomainProposer(adapter.spec.channels["proposer"])
                token = schedule.mode_token(mode)
                order = schedule.task_stream(adapter, seed=None)[cfg["domain"]]
                stream = schedule.run_domain(cfg["domain"], order, 1, adapter=adapter, prop=prop,
                                              runs_root=adapter.spec.runs_root, library_root=root / "library",
                                              modes=(token,), seed=None, execution=LEGACY)
                self.assertEqual(stream["failed"], 0)
                self.assertEqual(result["library"]["files"], read_snapshot(root / "library"))
                actual_contexts = [(data["invocation"]["label"], data["contextFiles"])
                                   for data in peer.invocations.values()
                                   if data["invocation"]["role"] in ("proposer", "composer", "reflection")]
                self.assertEqual(sorted(actual_contexts, key=lambda item: (item[0], str(item[1]))),
                                 sorted(prop.contexts, key=lambda item: (item[0], str(item[1]))))
                namespace = schedule.Namespace("earthnano", "claude-text", "agg", 1)
                for task in result["tasks"]:
                    summary = json.loads((namespace.task_dir(adapter.spec.runs_root, task["taskId"])
                                          / "summary.json").read_text())
                    self.assertEqual(task["summary"]["modes"], summary["modes"])
                    actual = task["summary"]["selections"][token]
                    expected = summary["selections"][token]
                    for key in ("chosen_label", "trivial", "fallback", "experience", "id_map", "why"):
                        self.assertEqual(actual[key], expected[key])

    def test_no_entry_or_malformed_reflection_does_not_fabricate_library(self):
        for index, reply in enumerate(("NO_ENTRY", "<experience>lesson: Incomplete</experience>")):
            cfg = self.cfg(f"no-entry-{index}")
            peer = DomainPeer(cfg)
            peer.reflection_text = reply
            result = earthnano_domain.run(cfg, peer)
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["library"], {"files": [], "entries": []})
            self.assertEqual([task["libraryEntriesBefore"] for task in result["tasks"]], [0, 0])
            self.assertTrue(all("reflection" in task for task in result["tasks"]))
            self.assertFalse(any(file["path"].startswith("library/") for offered in peer.invocations.values()
                                 for file in offered["contextFiles"]))

    def test_k2_domain_keeps_original_anonymous_selector_before_each_reflection(self):
        for mode, chosen in (("sequential", "c2"), ("parallel", "agg2")):
            with self.subTest(mode=mode):
                cfg = self.cfg("k2-" + mode, mode=mode)
                cfg["method"]["k"] = 2
                peer = DomainPeer(cfg)
                with patch.object(selection, "run_selection", wraps=selection.run_selection) as select:
                    result = earthnano_domain.run(cfg, peer)
                self.assertEqual(result["status"], "ok")
                self.assertEqual(select.call_count, 2)
                self.assertEqual(len(peer.requests), 32)
                self.assertEqual([task["libraryEntriesBefore"] for task in result["tasks"]], [0, 1])
                for task in result["tasks"]:
                    self.assertEqual(len(task["executionIds"]), 16)
                    self.assertEqual(task["selection"]["chosenLabel"], chosen)
                    self.assertEqual(task["selection"]["candidateCount"], 2)
                    self.assertFalse(task["selection"]["trivial"])
                    own = [record for record in result["records"]
                           if record["executionId"] in task["executionIds"]]
                    self.assertEqual([record["request"]["role"] for record in own[-2:]],
                                     ["selector", "reflection"])

    def test_ordinary_failed_reflection_is_recorded_without_claiming_complete_reflection(self):
        cfg = self.cfg("failed-reflection")
        peer = DomainPeer(cfg)
        peer.reflection_failed = True
        result = earthnano_domain.run(cfg, peer)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["library"], {"files": [], "entries": []})
        self.assertFalse(any("reflection" in task for task in result["tasks"]))
        self.assertEqual(sum(record["phase"] == "failed" for record in result["records"]), 2)
        self.assertEqual(len(peer.requests), 16)

    def test_domain_and_mode_and_experiment_roots_never_share_library(self):
        for index, (domain, mode) in enumerate((("first", "sequential"), ("second", "sequential"),
                                                ("first", "parallel"), ("first", "sequential"))):
            cfg = self.cfg(f"isolated-{index}", domain=domain, mode=mode)
            peer = DomainPeer(cfg)
            result = earthnano_domain.run(cfg, peer)
            self.assert_stream(cfg, peer, result)
            with self.assertRaises(FileExistsError):
                earthnano_domain.run(cfg, DomainPeer(cfg))

    def test_shared_budget_and_reflection_stop_prevent_next_task(self):
        for name in ("budget", "stop"):
            cfg = self.cfg(name)
            peer = DomainPeer(cfg)
            if name == "budget":
                peer.admissions_limit = 7
            else:
                peer.stop_role = "reflection"
            with self.assertRaises(ExecutionStopped):
                earthnano_domain.run(cfg, peer)
            self.assertEqual(len(peer.requests), 7)
            self.assertTrue(all(offered["invocation"]["taskId"] == "experiment-0001"
                                for offered in peer.invocations.values()))

    def test_grader_text_in_reflection_cannot_enter_next_task_or_exported_library(self):
        cfg = self.cfg("grader")
        peer = DomainPeer(cfg)
        peer.reflection_text = '<experience>\ncue: rows\nlesson: "pass_rate": 1\nevidence: private-grade\n</experience>'
        result = earthnano_domain.run(cfg, peer)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["library"], {"files": [], "entries": []})
        self.assertFalse(any("private-grade" in file["content"] for offered in peer.invocations.values()
                             for file in offered["contextFiles"]))

    def test_validation_rejects_invalid_domain_order_and_fields_before_work_allocation(self):
        cfg = self.cfg("validation")
        invalid = [dict(cfg, domain="../host"), dict(cfg, domain="x" * 81), dict(cfg, domain="中文"),
                   dict(cfg, tasks=[]), dict(cfg, tasks=cfg["tasks"] * 3),
                   dict(cfg, tasks=list(reversed(cfg["tasks"]))), dict(cfg, criteria="private-grade"),
                   dict(cfg, configVersion=True), dict(cfg, method={"mode": "seq", "k": 1, "concurrency": 1})]
        wrong_root = copy.deepcopy(cfg)
        wrong_root["tasks"][1]["taskId"] = "other-0002"
        invalid.append(wrong_root)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                earthnano_domain.run(value, DomainPeer(cfg))
        self.assertFalse(Path(cfg["workRoot"]).exists())

    def test_single_task_entry_keeps_no_library_or_reflection(self):
        cfg = single_config(self.root)
        peer = Peer()
        result = earthnano.run(cfg, peer)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(peer.requests), 7)
        self.assertFalse(any(request["role"] == "reflection" for request in peer.requests))
        self.assertNotIn("library", result)


if __name__ == "__main__":
    unittest.main()
