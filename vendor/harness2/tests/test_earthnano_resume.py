"""Explicit port resume: original algorithms, markers and Library, with no model launcher."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path

from harness2 import earthnano, earthnano_domain
from harness2.core.execution_contract import ExecutionStopped
from test_earthnano_binding import Peer, config
from test_earthnano_domain import DomainPeer, config as domain_config


class ResumePeer:
    def __init__(self, owner, stop_after=None):
        self.owner = owner
        self.stop_after = stop_after
        self.resuming = False
        self.reused = set()
        self.stopped = False

    def exchange(self, operation, **args):
        if operation == "freezeInvocation" and self.resuming:
            for key, prior in self.owner.invocations.items():
                if prior != args:
                    continue
                record = next((record for record in self.owner.records.values()
                               if record["requestKey"] == key and record["phase"] == "completed"), None)
                if record:
                    self.reused.add(record["executionId"])
                    return copy.deepcopy(record["request"])
        if operation == "submit":
            if self.resuming:
                record = next((record for record in self.owner.records.values()
                               if record["requestKey"] == args["request"]["requestKey"]), None)
                if record:
                    return {key: record[key] for key in ("executionId", "requestKey", "phase", "identity")}
            if not self.resuming and self.stop_after is not None and len(self.owner.requests) >= self.stop_after:
                raise ExecutionStopped("Explicit user stop before next admission")
        if operation == "taskRecords":
            return [record for record in self.owner.records.values()
                    if self.owner.invocations[record["requestKey"]]["invocation"]["taskId"] == args["taskId"]]
        result = self.owner.exchange(operation, **args)
        if operation == "readResult" and args["executionId"] in self.reused:
            result = dict(result, reused=True)
        return result


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        for parent, _, files in os.walk(self.root):
            os.chmod(parent, 0o700)
            for name in files:
                os.chmod(Path(parent) / name, 0o600)
        self.temp.cleanup()

    def cfg(self, mode):
        root = self.root / mode
        root.mkdir()
        return dict(config(root), method={"mode": mode, "k": 2, "concurrency": 2})

    def test_partial_completed_stages_are_reused_in_both_original_modes(self):
        for mode in ("sequential", "parallel"):
            cfg = self.cfg(mode)
            peer = ResumePeer(Peer(), stop_after=4)
            with self.assertRaises(ExecutionStopped):
                earthnano.run(cfg, peer)
            original_ids = set(peer.owner.records)
            self.assertEqual(len(original_ids), 4)
            peer.resuming = True
            result = earthnano.run(dict(cfg, resume=True), peer)
            self.assertEqual(result["status"], "ok")
            self.assertFalse(result["selection"]["fallback"])
            self.assertEqual(len(peer.owner.requests), 15)
            self.assertTrue(original_ids <= peer.reused)
            self.assertEqual(result["fallbackStages"], [])
            admitted = len(peer.owner.requests)
            again = earthnano.run(dict(cfg, resume=True), peer)
            self.assertEqual(again["summary"]["status"], "skipped")
            self.assertEqual(again["chosenArtifacts"], result["chosenArtifacts"])
            self.assertEqual(len(peer.owner.requests), admitted)

    def test_notebook_parallel_resume_preserves_metadata_evidence_across_canonical_config_keys(self):
        cfg = self.cfg("parallel")
        cfg["task"]["files"] = []
        cfg["task"]["managedInputs"] = [{
            "sourceKind": "upload-version", "sourceProjectId": "project",
            "sourceSessionId": "source-session", "sourceFileId": "upload",
            "inputFileVersionId": "version", "filename": "values.csv",
            "sizeBytes": 12, "checksum": "a" * 64,
        }]
        peer = ResumePeer(Peer(), stop_after=4)
        with self.assertRaises(ExecutionStopped):
            earthnano.run(cfg, peer)
        source = Path(cfg["workRoot"]) / "source" / "managed-inputs.json"
        original_bytes = source.read_bytes()
        original_ids = set(peer.owner.records)
        original_requests = {key: copy.deepcopy(value["request"])
                             for key, value in peer.owner.records.items()}
        peer.resuming = True
        # The host's durable writer canonically sorts private JSON on resume. Object key order
        # is not a new source tuple, but must not mutate the method's frozen evidence bytes.
        resumed_config = json.loads(json.dumps(dict(cfg, resume=True), sort_keys=True))
        result = earthnano.run(resumed_config, peer)
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(peer.owner.requests), 15)
        self.assertTrue(original_ids <= peer.reused)
        for key, original in original_requests.items():
            self.assertEqual(peer.owner.records[key]["request"]["invocationRef"], original["invocationRef"])
            self.assertEqual(peer.owner.records[key]["request"], original)
        self.assertFalse(result["selection"]["fallback"])
        self.assertEqual(result["fallbackStages"], [])

    def test_original_domain_resume_restores_library_and_order_without_new_admission(self):
        cfg = domain_config(self.root)
        peer = ResumePeer(DomainPeer(cfg))
        first = earthnano_domain.run(cfg, peer)
        original_admissions = len(peer.owner.requests)
        peer.resuming = True
        resumed = earthnano_domain.run(dict(cfg, resume=True), peer)
        self.assertEqual(resumed["order"], first["order"])
        self.assertEqual(resumed["library"], first["library"])
        self.assertEqual(len(peer.owner.requests), original_admissions)
        self.assertEqual(resumed["status"], "ok")
        self.assertEqual([row["executionIds"] for row in resumed["tasks"]],
                         [row["executionIds"] for row in first["tasks"]])

    def test_changed_original_result_bytes_stop_before_any_paid_replay(self):
        cfg = self.cfg("sequential")
        peer = ResumePeer(Peer())
        first = earthnano.run(cfg, peer)
        chosen = Path(first["summary"]["selections"]["seq"]["chosen_run_dir"]) / "answer.txt"
        chosen.chmod(0o600)
        chosen.write_text("changed committed projection")
        peer.resuming = True
        before = len(peer.owner.requests)
        with self.assertRaises(ExecutionStopped):
            earthnano.run(dict(cfg, resume=True), peer)
        self.assertEqual(len(peer.owner.requests), before)
