"""Original LEGACY vs platform-method parity, using deterministic immutable outputs only."""
import copy
import os
import re
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness2.core import recursion, schedule, selection, tree
from harness2.core.earthnano_binding import read_snapshot
from harness2.core.execution_contract import ExecutionStopped
from harness2.core.method_execution import LEGACY
from harness2.core.proposer import Proposer, Reply
from harness2.earthnano import EarthNanoAdapter, TEXT_SURFACE, run, validate_config
from test_earthnano_binding import Peer, config, deliverable_for, harness_for, selector_reply


TRAJECTORY = "[ACTION] Read source.txt\n[OBSERVATION] Synthetic input\n"
NOTES = "<notes>Verified the supplied trajectory.</notes>"


class FixtureReader:
    def __init__(self):
        self.views = {}

    def view(self, path):
        return self.views[Path(path)]

    def intact(self, path):
        return all((Path(path) / entry["path"]).read_text() == entry["content"]
                   for entry in self.view(path)["files"])


class LegacyAdapter(EarthNanoAdapter):
    """Same text adapter and fixtures through the untouched original LEGACY execution path."""
    def execute(self, task_id, harness_dir, run_id):
        path = self.root / "legacy-results" / run_id
        path.mkdir(parents=True)
        content = deliverable_for(run_id.rsplit("/", 1)[-1])
        (path / "answer.txt").write_text(content)
        self.reader.views[path] = {"files": [{"path": "answer.txt", "content": content}],
                                   "trajectoryText": TRAJECTORY}
        return path


class LegacyProposer(Proposer):
    def __init__(self, spec, malformed=False):
        super().__init__(spec, attempts=1)
        self.contexts = {}
        self.malformed = malformed

    def call(self, mission, context_dir, label, **kwargs):
        label = re.sub(r"\.a\d+$", "", label)
        files = read_snapshot(Path(context_dir))
        self.contexts[label] = files
        if label.startswith("select."):
            return Reply(label, "malformed choice" if self.malformed else selector_reply(files), True)
        workspace = Path(context_dir) / "harness"
        (workspace / "instructions.md").write_text(harness_for(label))
        return Reply(label, NOTES, True, workspace=workspace)


class OverlappingStopPeer(Peer):
    """Hold running siblings until two candidate admissions exist, then cancel one."""
    def __init__(self):
        super().__init__()
        self.overlapped = False

    def exchange(self, operation, **args):
        result = super().exchange(operation, **args)
        if operation == "get":
            record = self.records[args["executionId"]]
            if record["request"]["role"] == "candidate":
                candidates = [item for item in self.records.values()
                              if item["request"]["role"] == "candidate"]
                result = copy.deepcopy(result)
                if len(candidates) < 2:
                    result["phase"] = "running"
                else:
                    self.overlapped = True
                    result.update(phase="cancelled", error={"code": "cancelled", "message": "Stop"})
        return result


class SelectorBudgetPeer(Peer):
    def exchange(self, operation, **args):
        if operation == "submit" and args["request"]["role"] == "selector":
            self.requests.append(copy.deepcopy(args["request"]))
            raise ExecutionStopped("Shared budget exhausted before selector")
        return super().exchange(operation, **args)


class EarthNanoMethodTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        for parent, _, _ in os.walk(self.root):
            os.chmod(parent, 0o700)
        self.temporary.cleanup()

    def cfg(self, label, mode="sequential", k=2):
        path = self.root / label
        path.mkdir()
        return dict(config(path), method={"mode": mode, "k": k, "concurrency": 2})

    def legacy(self, cfg, malformed=False):
        cfg = validate_config(cfg)
        root = Path(cfg["workRoot"])
        root.mkdir()
        adapter = LegacyAdapter(cfg, root, FixtureReader())
        prop = LegacyProposer(adapter.spec.channels["proposer"], malformed)
        mode = schedule.mode_token(cfg["method"]["mode"])
        result = schedule.run_task(cfg["taskId"], cfg["method"]["k"], adapter=adapter,
                                   prop=prop, modes=(mode,), runs_root=adapter.spec.runs_root,
                                   execution=LEGACY)
        return result.to_dict(), adapter, prop

    def test_strict_method_validation_before_work_allocation(self):
        omitted = config(self.root)
        self.assertEqual(validate_config(omitted)["method"],
                         {"mode": "sequential", "k": 1, "concurrency": 1})
        self.assertNotIn("method", omitted)
        valid = {"mode": "parallel", "k": 8, "concurrency": 4}
        self.assertEqual(validate_config(dict(omitted, method=valid))["method"], valid)
        for method in (None, {}, [], {"mode": "seq", "k": 2, "concurrency": 2},
                       {"mode": "parallel", "k": 0, "concurrency": 1},
                       {"mode": "parallel", "k": 9, "concurrency": 1},
                       {"mode": "parallel", "k": True, "concurrency": 1},
                       {"mode": "parallel", "k": 2.0, "concurrency": 1},
                       {"mode": "parallel", "k": 2, "concurrency": False},
                       {"mode": "parallel", "k": 2, "concurrency": 0},
                       {"mode": "parallel", "k": 2, "concurrency": 5},
                       dict(valid, library=True)):
            with self.subTest(method=method), self.assertRaises(ValueError):
                run(dict(omitted, method=method), Peer())
        self.assertFalse(Path(omitted["workRoot"]).exists())

    def test_both_modes_match_legacy_recursion_evidence_and_real_selector(self):
        for name, token, chosen in (("sequential", "seq", "c2"), ("parallel", "agg", "agg2")):
            with self.subTest(mode=name):
                peer = Peer()
                cfg = self.cfg(f"port-{token}", name)
                runner = recursion.run_sequential if token == "seq" else recursion.run_parallel
                with patch.object(recursion, runner.__name__, wraps=runner) as recursive, \
                     patch.object(selection, "run_selection", wraps=selection.run_selection) as selector:
                    actual = run(cfg, peer)
                recursive.assert_called_once()
                selector.assert_called_once()
                legacy, adapter, prop = self.legacy(self.cfg(f"legacy-{token}", name))
                self.assertEqual(actual["status"], "ok")
                self.assertEqual(len(peer.requests), 15)
                self.assertEqual(set(actual["summary"]["modes"]), {token})
                self.assertEqual(actual["summary"]["modes"][token], legacy["modes"][token])
                for key in ("id_map", "chosen_id", "chosen_label", "n_candidates", "trivial", "fallback", "why"):
                    self.assertEqual(actual["summary"]["selections"][token][key], legacy["selections"][token][key])
                self.assertEqual(actual["selection"], {"chosenLabel": chosen, "candidateCount": 2,
                                 "trivial": False, "fallback": False, "reason": "Complete reconciled evidence."})
                self.assertTrue(actual["configurationChanged"])
                selected = next(record for record in peer.records.values()
                                if record["request"]["role"] == "candidate"
                                and record["request"]["origin"]["stageId"] == chosen)
                self.assertEqual(actual["chosenArtifacts"], selected["evidence"]["artifacts"])
                # Exact evidence-tree parity includes sequential history and parallel shared pools.
                for offered in peer.invocations.values():
                    invocation = offered["invocation"]
                    if invocation["role"] in ("proposer", "composer", "selector"):
                        self.assertEqual(offered["contextFiles"], prop.contexts[invocation["stageLabel"]])
                        self.assertNotIn("synthetic", invocation["mission"].lower().split("# YOUR EVIDENCE")[0])
                        self.assertNotIn("pass_rate", json.dumps(offered["contextFiles"]))
                        self.assertFalse(any(file["path"].endswith("reference_answer.txt")
                                             for file in offered["contextFiles"]))
                selector_input = next(data for data in peer.invocations.values()
                                      if data["invocation"]["role"] == "selector")
                self.assertEqual({file["path"] for file in selector_input["contextFiles"]},
                                 {"task.md", "source/source.txt", "candidates/A.md", "candidates/B.md"})
                for file in selector_input["contextFiles"]:
                    if file["path"].startswith("candidates/"):
                        self.assertNotRegex(file["content"], r"base[12]|inv[12]|dom[12]|agg[12]|\bc[12]\b|pass_rate|verdict")
                self.assertEqual((legacy["modes"][token]["ledger"]["R"],
                                  legacy["modes"][token]["ledger"]["P"]), (8, 6))
                namespace = schedule.Namespace("earthnano", "claude-text", token, 2)
                selected_tree = tree.read_tree(TEXT_SURFACE, namespace.task_dir(adapter.spec.runs_root,
                                               cfg["taskId"]) / "harnesses" / chosen)
                self.assertEqual(selected_tree, {"instructions.md": harness_for(chosen)})

    def test_k1_both_modes_retain_trivial_selection_without_extra_admission(self):
        for name, chosen in (("sequential", "c1"), ("parallel", "agg1")):
            with self.subTest(mode=name), patch.object(selection, "run_selection",
                                                       side_effect=AssertionError("selector called")):
                peer = Peer()
                result = run(self.cfg(name, name, 1), peer)
                self.assertEqual(len(peer.requests), 7)
                self.assertEqual(result["selection"]["chosenLabel"], chosen)
                self.assertTrue(result["selection"]["trivial"])
                self.assertTrue(result["configurationChanged"])

    def test_malformed_choice_keeps_original_finals_fallback_and_status(self):
        for name, token in (("sequential", "seq"), ("parallel", "agg")):
            with self.subTest(mode=name):
                peer = Peer()
                peer.selector_text = "malformed choice"
                actual = run(self.cfg(f"invalid-{token}", name), peer)
                legacy, _, _ = self.legacy(self.cfg(f"legacy-invalid-{token}", name), malformed=True)
                expected = legacy["selections"][token]
                self.assertEqual(actual["status"], legacy["status"])
                self.assertEqual(actual["selection"]["chosenLabel"], expected["chosen_label"])
                self.assertTrue(actual["selection"]["fallback"])
                self.assertEqual(actual["selection"]["reason"], expected["error"])
                self.assertEqual(len(peer.requests), 15)

    def test_overlapping_stop_and_budget_rejection_never_become_selector_fallback(self):
        for name in ("sequential", "parallel"):
            with self.subTest(mode=name):
                peer = OverlappingStopPeer()
                with self.assertRaises(ExecutionStopped):
                    run(self.cfg(f"stop-{name}", name), peer)
                self.assertTrue(peer.overlapped)
                self.assertFalse(any(request["role"] in ("composer", "selector") for request in peer.requests))
                budget = Peer()
                budget.fault = "budget"
                with self.assertRaises(ExecutionStopped):
                    run(self.cfg(f"budget-{name}", name), budget)
                self.assertFalse(any(request["role"] == "selector" for request in budget.requests))
                selector_budget = SelectorBudgetPeer()
                with self.assertRaises(ExecutionStopped):
                    run(self.cfg(f"selector-budget-{name}", name), selector_budget)
                self.assertEqual(len(selector_budget.requests), 15)

    def test_grader_verdict_in_source_never_reaches_proposer_or_selector(self):
        for name in ("sequential", "parallel"):
            with self.subTest(mode=name):
                cfg = self.cfg(f"verdict-{name}", name)
                cfg["task"]["files"].append({"path": "reference_answer.txt", "content": '"pass_rate": 1'})
                peer = Peer()
                result = run(cfg, peer)
                self.assertEqual(result["status"], "partial")
                self.assertFalse(any(request["role"] in ("proposer", "composer", "selector")
                                     for request in peer.requests))
                self.assertFalse(any(data["contextFiles"] for data in peer.invocations.values()))

    def test_both_k2_modes_through_real_stdio_process(self):
        for name, chosen in (("sequential", "c2"), ("parallel", "agg2")):
            with self.subTest(mode=name):
                cfg = self.cfg(f"stdio-{name}", name)
                path = self.root / f"{name}.json"
                path.write_text(json.dumps(cfg))
                peer = Peer()
                child = subprocess.Popen([sys.executable, "-B", "-m", "harness2.earthnano", "--config", str(path)],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         text=True)
                final = None
                try:
                    for line in child.stdout:
                        message = json.loads(line)
                        operation = message.pop("operation")
                        request_id = message.pop("id")
                        result = peer.exchange(operation, **message)
                        if operation == "done":
                            final = message["result"]
                        child.stdin.write(json.dumps({"id": request_id, "result": result}) + "\n")
                        child.stdin.flush()
                    self.assertEqual(child.wait(timeout=10), 0, child.stderr.read())
                    self.assertEqual(len(peer.requests), 15)
                    self.assertEqual(final["selection"]["chosenLabel"], chosen)
                    self.assertEqual(final["method"], cfg["method"])
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
