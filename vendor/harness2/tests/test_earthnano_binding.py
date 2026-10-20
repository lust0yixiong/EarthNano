"""Deterministic production-binding tests. No model, provider, credential or network access."""
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from harness2.core.earthnano_binding import (
    JsonLineClient, PlatformResultReader, digest, read_snapshot,
)
from harness2.core.execution_contract import ExecutionStopped, request_digest
from harness2.core.method_execution import Invocation
from harness2.earthnano import run, validate_text_harness

BASE = "Read the source and produce the requested deliverable.\n"
INV = BASE + "Verify every line before final delivery.\n"
DOM = BASE + "Reconcile the source entries before final delivery.\n"
COMPOSED = INV + "Reconcile the source entries before final delivery.\n"


def config(root):
    return {
        "configVersion": 1, "taskId": "synthetic-1",
        "task": {"prompt": "Summarize the synthetic input in answer.txt.",
                 "files": [{"path": "source.txt", "content": "SYNTHETIC INPUT ONLY"}]},
        "baseHarnessFiles": [{"path": "instructions.md", "content": BASE}],
        "workRoot": str(root / "work"), "model": "synthetic-model",
    }


class Peer:
    """In-memory platform owner fixture; production Python binding calls every operation."""
    def __init__(self):
        self.invocations = {}
        self.requests = []
        self.records = {}
        self.results = {}
        self.operations = []
        self.fault = None
        self.stopped = False

    def exchange(self, operation, **args):
        self.operations.append(operation)
        if operation == "freezeInvocation":
            invocation = args["invocation"]
            index = len(self.invocations) + 1
            key = f"request-{index}"
            ref = {"id": "frozen", "version": "1", "digest": digest("frozen")}
            request = {
                "contractVersion": 1, "requestKey": key, "projectId": "synthetic-project",
                "taskSnapshotRef": ref, "invocationRef": dict(ref, id=f"invocation-{index}"),
                "agentSpecRef": ref, "harnessRevisionRef": ref, "environmentSpecRef": ref,
                "role": invocation["role"], "interactionPolicy": "deny-unresolved",
                "origin": {"kind": "optimization", "optimizationId": "synthetic-loop",
                           "stageId": invocation["stageLabel"]},
                "budgetRef": "shared", "timeoutMs": 10_000,
            }
            if invocation["retryOfExecutionId"]:
                request["origin"]["retryOfExecutionId"] = invocation["retryOfExecutionId"]
            self.invocations[key] = copy.deepcopy(args)
            return request
        if operation == "submit":
            request = args["request"]
            self.requests.append(copy.deepcopy(request))
            slot = len(self.requests)
            invocation = self.invocations[request["requestKey"]]["invocation"]
            if self.fault == "budget" and slot == 2:
                raise ExecutionStopped("Budget rejected")
            execution_id = f"execution-{slot}"
            artifact = {"artifactId": f"artifact-{slot}", "versionId": "immutable-v1",
                        "checksum": digest(f"version-{slot}")}
            proposed = invocation["role"] in ("proposer", "composer")
            content = ({"inv1": INV, "dom1": DOM, "c1": COMPOSED}[invocation["stageLabel"]]
                       if proposed else "Synthetic completed deliverable\n")
            path = "context/harness/instructions.md" if proposed else "answer.txt"
            files = [{"path": path, "content": content, "digest": digest(content),
                      "artifactRef": artifact}]
            result = {"executionId": execution_id, "artifacts": [artifact],
                      "replyText": "<notes>Verified the supplied trajectory.</notes>",
                      "trajectoryText": "[ACTION] Read source.txt\n[OBSERVATION] Synthetic input\n",
                      "files": files}
            record = {
                "executionId": execution_id, "requestKey": request["requestKey"],
                "phase": "completed", "identity": {"sessionId": f"session-{slot}"},
                "request": copy.deepcopy(request), "requestDigest": request_digest(request),
                "createdAt": "2026-10-20T00:00:00Z", "updatedAt": "2026-10-20T00:00:00Z",
                "cleanup": "confirmed", "cancellationRequested": False,
                "evidence": {"status": "complete", "scope": "synthetic fixture", "text": "",
                             "artifacts": [artifact], "references": [], "limitations": []},
                "usage": {"status": "unknown"},
                "configuration": {"status": "unknown", "requestedDigest": request["harnessRevisionRef"]["digest"], "instructions": [], "skills": [],
                                  "tools": [], "confirmation": "Fixture only"},
            }
            if self.fault == "timeout" and slot == 2:
                record.update(phase="interrupted", cleanup="unknown",
                              error={"code": "timeout", "message": "Fixture timeout"})
            self.records[execution_id], self.results[execution_id] = record, result
            return {key: record[key] for key in ("executionId", "requestKey", "phase", "identity")}
        if operation == "get":
            return copy.deepcopy(self.records[args["executionId"]])
        if operation == "readResult":
            result = copy.deepcopy(self.results[args["executionId"]])
            if self.fault == "tamper" and args["executionId"] == "execution-2":
                result["files"][0]["content"] += "tampered"
            if self.fault == "artifact" and args["executionId"] == "execution-2":
                result["artifacts"][0]["versionId"] = "latest-not-fixed"
            return result
        if operation == "cancel":
            return {"executionId": args["executionId"], "status": "requested", "cleanup": "unknown"}
        if operation == "done":
            return {"acknowledged": True}
        raise AssertionError(operation)


class EarthNanoBindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        for parent, directories, _ in os.walk(self.root):
            os.chmod(parent, 0o700)
        self.temporary.cleanup()

    def test_original_seq_k1_has_seven_admissions_and_real_changed_tree(self):
        peer = Peer()
        result = run(config(self.root), peer)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(peer.requests), 7)
        self.assertEqual(Counter(request["role"] for request in peer.requests),
                         {"baseline": 1, "candidate": 3, "proposer": 2, "composer": 1})
        ledger = result["summary"]["modes"]["seq"]["ledger"]
        self.assertEqual((ledger["R"], ledger["P"]), (4, 3))
        self.assertTrue(result["summary"]["selections"]["seq"]["trivial"])
        self.assertTrue(result["configurationChanged"])
        self.assertEqual(result["fallbackStages"], [])
        self.assertEqual(result["chosenArtifacts"], peer.records["execution-7"]["evidence"]["artifacts"])
        for data in peer.invocations.values():
            invocation = data["invocation"]
            self.assertNotIn("@", invocation["mission"])
            self.assertNotRegex(invocation["mission"], r"!\s*`|`{3,}\s*!")
            self.assertNotIn("score", json.dumps(data["contextFiles"]).lower())
            if invocation["role"] in ("proposer", "composer"):
                self.assertTrue(any(file["path"] == "harness/instructions.md"
                                    for file in data["contextFiles"]))
        with self.assertRaises(FileExistsError):
            run(config(self.root), Peer())

    def test_budget_and_timeout_stop_before_fallback_or_next_candidate(self):
        for fault in ("budget", "timeout", "tamper", "artifact"):
            with self.subTest(fault=fault):
                case = self.root / fault
                case.mkdir()
                peer = Peer()
                peer.fault = fault
                with self.assertRaises(ExecutionStopped):
                    run(config(case), peer)
                # INV/DOM may already be queued concurrently; a stop never starts their rollouts.
                self.assertGreaterEqual(len(peer.requests), 2)
                self.assertLessEqual(len(peer.requests), 3)
                self.assertFalse(any(request["role"] == "candidate" for request in peer.requests))
                self.assertFalse(any(data["invocation"]["role"] == "composer"
                                     for data in peer.invocations.values()))

    def test_result_projection_rejects_checksum_paths_and_uncommitted_refs(self):
        peer = Peer()
        ref = {"artifactId": "artifact", "versionId": "v1", "checksum": digest("artifact")}
        record = {"executionId": "fixed", "evidence": {"artifacts": [ref]}}
        base = {"executionId": "fixed", "artifacts": [ref], "replyText": "notes",
                "trajectoryText": "trajectory", "files": [{"path": "answer.txt", "content": "ok",
                    "digest": digest("ok"), "artifactRef": ref}]}
        reader = PlatformResultReader(peer, self.root / "views")
        invocation = Invocation(task_id="t", scope="s", role="candidate", label="l",
                                stage_label="l", mission="m")
        for fault in ("digest", "path", "ref", "duplicate", "identity"):
            with self.subTest(fault=fault):
                data = copy.deepcopy(base)
                if fault == "digest": data["files"][0]["content"] = "changed"
                if fault == "path": data["files"][0]["path"] = "../host.txt"
                if fault == "ref": data["files"][0]["artifactRef"] = dict(ref, versionId="other")
                if fault == "duplicate": data["files"].append(copy.deepcopy(data["files"][0]))
                if fault == "identity": data["executionId"] = "other"
                peer.results["fixed"] = data
                with self.assertRaises(ExecutionStopped): reader.rollout(record, invocation)
        peer.results["fixed"] = base
        view = reader.rollout(record, invocation)
        self.assertEqual((view / "answer.txt").read_text(), "ok")
        self.assertEqual((view / "answer.txt").stat().st_mode & 0o222, 0)
        self.assertTrue(reader.intact(view))

    def test_no_legacy_launcher_or_independent_judge_is_used(self):
        with patch("harness2.core.proposer.Proposer.call", side_effect=AssertionError("legacy")), \
             patch("harness2.core.judge.judge_one", side_effect=AssertionError("judge")):
            self.assertEqual(run(config(self.root), Peer())["status"], "ok")

    def test_strict_text_profile_rejects_executable_and_native_unsupported_policy(self):
        for files in (
            {"instructions.md": BASE, "scripts/helper.py": "print(1)"},
            {"instructions.md": "Read @host-file"},
            {"instructions.md": BASE, "skills/invalid_name/SKILL.md": "content"},
            {"instructions.md": BASE, "skills/probe/SKILL.md":
             "---\nname: probe\ndescription: Test\nallowed-tools: Bash\n---\nBody"},
        ):
            with self.subTest(files=list(files)):
                with self.assertRaises(ValueError): validate_text_harness(files)
        validate_text_harness({"instructions.md": "Use Skill earthnano-candidate:probe.",
                              "skills/probe/SKILL.md": "---\nname: probe\ndescription: Test\n---\nBody\n"})

    def test_snapshot_rejects_links_and_does_not_emit_path_refs(self):
        folder = self.root / "snapshot"
        folder.mkdir()
        (folder / "file.txt").write_text("frozen")
        self.assertEqual(read_snapshot(folder), [{"path": "file.txt", "content": "frozen"}])
        (folder / "alias.txt").symlink_to(folder / "file.txt")
        with self.assertRaises(ValueError): read_snapshot(folder)
        (folder / "alias.txt").unlink()
        os.link(folder / "file.txt", folder / "alias.txt")
        with self.assertRaises(ValueError): read_snapshot(folder)

    def test_transport_stops_on_eof_wrong_id_error_and_malformed_response(self):
        for wire in ("", "not json\n", '{"id":"other","result":{}}\n',
                     '{"id":1,"error":{"code":"budget-exhausted","message":"secret"}}\n'):
            with self.subTest(wire=wire):
                writer = io.StringIO()
                client = JsonLineClient(io.StringIO(wire), writer)
                with self.assertRaises(ExecutionStopped) as error:
                    client.exchange("submit", request={})
                self.assertNotIn("secret", str(error.exception))
                sent = writer.getvalue()
                with self.assertRaises(ExecutionStopped): client.exchange("submit", request={})
                self.assertEqual(writer.getvalue(), sent)

    def test_partial_pipe_response_obeys_timeout(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b'{"id":"1","result":')
        with os.fdopen(read_fd, "r") as reader:
            client = JsonLineClient(reader, io.StringIO(), timeout_ms=20)
            started = time.monotonic()
            try:
                with self.assertRaises(ExecutionStopped): client.exchange("get", executionId="e")
                self.assertLess(time.monotonic() - started, 1)
            finally:
                os.close(write_fd)

    def test_real_stdio_entrypoint_uses_original_method_and_protocol_only_stdout(self):
        cfg = config(self.root)
        path = self.root / "config.json"
        path.write_text(json.dumps(cfg))
        peer = Peer()
        child = subprocess.Popen([sys.executable, "-B", "-m", "harness2.earthnano", "--config", str(path)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True)
        final = None
        try:
            for line in child.stdout:
                message = json.loads(line)  # Any ordinary method stdout would fail this assertion.
                operation = message.pop("operation")
                request_id = message.pop("id")
                result = peer.exchange(operation, **message)
                if operation == "done": final = message["result"]
                child.stdin.write(json.dumps({"id": request_id, "result": result}) + "\n")
                child.stdin.flush()
            self.assertEqual(child.wait(timeout=10), 0, child.stderr.read())
            self.assertEqual(len(peer.requests), 7)
            self.assertTrue(final["configurationChanged"])
        finally:
            if child.poll() is None: child.kill()
            child.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
