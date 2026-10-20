"""Deterministic method integration against the shared Python ExecutionPort contract.

The fixture is not a production transport/core. Its factory snapshots inputs into opaque refs;
only its explicit driver runs the local arithmetic script / DemoProposer. No provider is invoked.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from harness2.core import context, judge, recursion, schedule, selection, tree
from harness2.core.execution_contract import ExecutionStopped, request_digest, validate_request
from harness2.core.library import Library
from harness2.core.method_execution import Invocation, LEGACY, PortMethodExecution
from harness2.core.proposer import Proposer, Reply
from harness2.core.spec import RunView
from harness2.demo import BASE_SCRIPT, DemoAdapter, DemoProposer


def manifest(root):
    if root is None:
        return {}
    return {p.relative_to(root).as_posix(): p.read_bytes().hex()
            for p in sorted(Path(root).rglob("*")) if p.is_file()}


class Rejected(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class FixtureBinding:
    """Trusted test-only request factory + result reader + deferred in-process fake port."""

    def __init__(self, root, adapter):
        self.root = root
        self.adapter = adapter
        self.backend = DemoProposer(adapter.spec.channels["proposer"])
        self.invocations = {}
        self.sources = {}
        self.requests = []
        self.records = {}
        self.outputs = {}
        self.attempted = []
        self.cancelled = []
        self.fault = None
        self.no_entry = False
        self.invalid_first = False
        self.transport_first = False
        self.pending = False
        self.timeout_ms = 10_000

    def ref(self, kind, value):
        digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        return {"id": f"fixture:{kind}:{digest}", "version": "1", "digest": f"sha256:{digest}"}

    def factory(self, invocation: Invocation):
        # PortMethodExecution serializes factory/admission; snapshot contents, not path strings.
        slot = self.root / "frozen" / str(len(self.requests) + 1)
        slot.mkdir(parents=True, exist_ok=True)
        source = slot / "source"
        shutil.copytree(self.adapter.task_files(invocation.task_id), source)
        context = slot / "context" if invocation.context_dir else None
        harness = slot / "harness" if invocation.harness_dir else None
        if context:
            shutil.copytree(invocation.context_dir, context)
        if harness:
            shutil.copytree(invocation.harness_dir, harness)
        frozen = replace(invocation, context_dir=context, harness_dir=harness)
        payload = {
            "mission": frozen.mission, "system": frozen.system, "context": manifest(context),
            "harness": manifest(harness), "harvest": frozen.harvest,
        }
        inv_ref = self.ref("invocation", payload)
        # Identical input bytes may have identical refs; the requestKey identifies the attempt.
        key = f"request-{len(self.requests) + 1}"
        request = {
            "contractVersion": 1, "requestKey": key, "projectId": "fixture-project",
            "taskSnapshotRef": self.ref("task", {
                "prompt": self.adapter.task_prompt(invocation.task_id), "source": manifest(source),
            }),
            "invocationRef": inv_ref,
            "agentSpecRef": self.ref("agent", vars(invocation.channel) if invocation.channel else {}),
            "harnessRevisionRef": self.ref(
                "harness", manifest(harness or (context / "harness" if context else None))
            ),
            "environmentSpecRef": self.ref("environment", {"fixture": "local-arithmetic-only"}),
            "role": invocation.role,
            "origin": {
                "kind": "optimization", "optimizationId": "fixture-optimization",
                "stageId": f"{invocation.scope}/{invocation.task_id}/{invocation.role}/{invocation.stage_label}",
            },
            "interactionPolicy": "deny-unresolved", "budgetRef": "fixture-budget",
            "timeoutMs": self.timeout_ms,
        }
        if invocation.retry_of_execution_id:
            request["origin"]["retryOfExecutionId"] = invocation.retry_of_execution_id
        validate_request(request)
        self.requests.append(deepcopy(request))
        self.invocations[key] = frozen
        self.sources[key] = source
        return request

    def submit(self, request):
        self.attempted.append(deepcopy(request))
        invocation = self.invocations[request["requestKey"]]
        fault = self.fault(invocation) if self.fault else None
        if isinstance(fault, Exception):
            raise fault
        execution_id = f"execution-{len(self.records) + 1}"
        record = {
            "executionId": execution_id, "requestKey": request["requestKey"], "phase": "queued",
            "identity": {}, "request": deepcopy(request), "requestDigest": request_digest(request),
            "createdAt": "2026-10-20T00:00:00Z", "updatedAt": "2026-10-20T00:00:00Z",
            "cleanup": "confirmed", "cancellationRequested": False,
            "evidence": {"status": "complete", "scope": "fixture", "text": "",
                         "artifacts": [], "references": [], "limitations": []},
            "usage": {"status": "known", "costMicrousd": 1_000_000},
            "configuration": {
                "status": "unknown", "requestedDigest": request["harnessRevisionRef"]["digest"],
                "instructions": [], "skills": [], "tools": [],
                "confirmation": "Only local deterministic fixture; no backend loading claim",
            },
        }
        if isinstance(fault, dict):
            record.update(fault)
        self.records[execution_id] = record
        return {key: record[key] for key in ("executionId", "requestKey", "phase", "identity")}

    def get(self, execution_id):
        record = self.records[execution_id]
        if record["phase"] != "queued" or self.pending:
            return record
        key = record["requestKey"]
        inv = self.invocations[key]
        if self.transport_first and inv.role == "proposer" and inv.attempt == 1:
            record.update(phase="failed", error={"code": "driver-failed", "message": "transient"})
            return record
        if inv.role in ("baseline", "candidate"):
            output = self.root / "outputs" / execution_id
            output.mkdir(parents=True)
            result = subprocess.run(
                [sys.executable, str(inv.harness_dir / "scripts/summarize.py"),
                 str(self.sources[key] / "ledger.csv")],
                capture_output=True, text=True, check=True, timeout=10,
            )
            (output / "answer.txt").write_text(result.stdout)
            (output / "trajectory.md").write_text("[ACTION] local script\n[OBSERVATION]\n" + result.stdout)
            self.outputs[execution_id] = output
        else:
            if self.invalid_first and inv.role == "proposer" and inv.label.endswith(".a1"):
                (inv.context_dir / "harness/scripts/summarize.py").write_text("def broken(:\n")
                reply = Reply(inv.label, "invalid edit", True, workspace=inv.context_dir / "harness")
            elif self.no_entry and inv.role == "reflection":
                reply = Reply(inv.label, "NO_ENTRY", True)
            else:
                if self.invalid_first and inv.role == "proposer" and inv.label.endswith(".a2"):
                    (inv.context_dir / "harness/scripts/summarize.py").write_text(BASE_SCRIPT)
                try:
                    reply = self.backend.call(inv.mission, inv.context_dir, inv.label)
                except ExecutionStopped:
                    raise
                except Exception as exc:
                    # A known driver failure is a failed record; it is not transport loss.
                    record.update(phase="failed", error={
                        "code": "driver-failed", "message": str(exc) or type(exc).__name__,
                    })
                    return record
            self.outputs[execution_id] = reply
            record["evidence"]["text"] = reply.text
        record["phase"] = "completed"
        return record

    def cancel(self, execution_id):
        self.cancelled.append(execution_id)
        return {"executionId": execution_id, "status": "requested", "cleanup": "unknown"}

    def events(self, execution_id, after_sequence=0):
        return iter(())

    def rollout(self, record, invocation):
        return self.outputs[record["executionId"]]

    def reply(self, record, invocation):
        return self.outputs[record["executionId"]]

    def seam(self):
        return PortMethodExecution(self, self.factory, self, poll_interval=0.001)


class ExecutionSeamTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.adapter = DemoAdapter(self.root / "demo")
        self.prop = DemoProposer(self.adapter.spec.channels["proposer"])
        self.binding = FixtureBinding(self.root / "binding", self.adapter)

    def forbid_legacy(self):
        self.adapter.execute = Mock(side_effect=AssertionError("solver bypassed port"))
        self.adapter.execute_many = Mock(side_effect=AssertionError("batch bypassed port"))
        self.prop.call = Mock(side_effect=AssertionError("proposer bypassed port"))
        self.prop._cached = Mock(side_effect=AssertionError("legacy proposer cache consulted"))

    def stream(self, k=2, seam=None):
        return schedule.run_domain(
            "accounting", self.adapter.tasks(), k, adapter=self.adapter, prop=self.prop,
            runs_root=self.adapter.spec.runs_root, library_root=self.root / "library" / str(k),
            execution=seam or self.binding.seam(),
        )

    def test_both_paths_all_roles_and_method_semantics(self):
        self.forbid_legacy()
        for k in (1, 2):
            with self.subTest(k=k):
                before = len(self.binding.records)
                seam = self.binding.seam()
                result = self.stream(k, seam)
                self.assertEqual((result["done"], result["failed"]), (2, 0))
                records = seam.records
                counts = Counter(r["request"]["role"] for r in records)
                self.assertEqual(counts["baseline"], 2*k)
                self.assertEqual(counts["candidate"], 12*k)
                self.assertEqual(counts["proposer"], 8*k)
                self.assertEqual(counts["composer"], 4*k)
                self.assertEqual(counts["selector"], 4 if k > 1 else 0)
                self.assertEqual(counts["reflection"], 4)
                self.assertEqual(len(self.binding.records) - before, sum(counts.values()))
                for task in self.adapter.tasks():
                    work = self.adapter.spec.runs_root / f"demo-oc-agg{k}" / task
                    summary = json.loads((work / "summary.port.json").read_text())
                    for mode in ("agg", "seq"):
                        ledger = summary["modes"][mode]["ledger"]
                        self.assertEqual((ledger["R"], ledger["P"]), (4*k, 3*k))
                        chosen = summary["selections"][mode]
                        self.assertFalse(chosen["chosen_label"].startswith("base"))
                        expected = "Total: 85.15\n" if task == "ledger-1" else "Total: 20.25\n"
                        self.assertEqual(self.adapter.deliverable_text(Path(chosen["chosen_run_dir"])), expected)
                frozen_second = [inv.context_dir for inv in self.binding.invocations.values()
                                 if inv.task_id == "ledger-2" and inv.role == "proposer"]
                for context in frozen_second:
                    entries = context / "library/harnesses"
                    self.assertEqual([p.name for p in entries.iterdir()], ["ledger-1"])
        self.adapter.execute.assert_not_called()
        self.adapter.execute_many.assert_not_called()
        self.prop.call.assert_not_called()
        self.prop._cached.assert_not_called()

    def test_port_does_not_resume_legacy_summary_or_use_legacy_calls(self):
        legacy = self.stream(k=1, seam=LEGACY)
        self.assertEqual(legacy["done"], 2)
        self.forbid_legacy()
        with patch("harness2.core.schedule._resume", side_effect=AssertionError("old summary reused")):
            result = self.stream(k=1)
        self.assertEqual([row["status"] for row in result["tasks"]], ["ok", "ok"])
        self.assertEqual(len(self.binding.records), 30)

    def test_transport_and_validation_retries_have_distinct_linked_executions(self):
        self.forbid_legacy()
        self.binding.transport_first = True
        self.binding.invalid_first = True
        seam = self.binding.seam()
        stage = recursion._run_stage(
            label="inv1", dim="INV", job="Repair local arithmetic", adapter=self.adapter,
            prop=self.prop, ctx_dir=self.root / "context", task_id="ledger-1", rollouts=[],
            fallback=tree.read_tree(self.adapter.substrate.surface(), self.adapter.base_harness()),
            harness_dir=self.adapter.base_harness(), library_dir=None,
            execution=seam, scope="test-agg1",
        )
        self.assertFalse(stage.fell_back)
        self.assertEqual((stage.attempts, stage.usd), (4, 4))
        records = seam.records
        self.assertEqual(len(records), 4)
        self.assertEqual(len({r["requestKey"] for r in records}), 4)
        self.assertEqual(len({r["request"]["origin"]["stageId"] for r in records}), 1)
        for previous, current in zip(records, records[1:]):
            self.assertEqual(current["request"]["origin"]["retryOfExecutionId"], previous["executionId"])
        last = self.binding.invocations[records[-1]["requestKey"]]
        self.assertIn("PREVIOUS ATTEMPT WAS REJECTED", last.mission)

    def test_no_entry_stays_out_of_library(self):
        self.forbid_legacy()
        self.binding.no_entry = True
        result = self.stream(k=1)
        self.assertEqual(result["done"], 2)
        for mode in ("agg", "seq"):
            library = Library(self.root / "library/1" / mode, "accounting", self.adapter.substrate.surface())
            self.assertEqual(library.entries(), [])

    def test_failed_selector_is_not_judged_and_does_not_reflect(self):
        self.forbid_legacy()
        self.binding.fault = lambda inv: (
            {"phase": "failed", "error": {"code": "driver-failed", "message": "selection failed"}}
            if inv.role == "selector" else None
        )
        result = self.stream()
        self.assertEqual(result["failed"], 2)
        self.assertFalse(any(r["role"] == "reflection" for r in self.binding.attempted))
        summary = json.loads((self.adapter.spec.runs_root / "demo-oc-agg2/ledger-1/summary.port.json").read_text())
        self.adapter.score = Mock(side_effect=AssertionError("failed selection was judged"))
        rows = judge.judge_selections(self.adapter, list(summary["selections"].values()))
        self.assertTrue(all(not row.graded for row in rows))
        self.adapter.score.assert_not_called()

    def test_batch_baseline_partial_failure_preserves_individual_outcomes(self):
        self.forbid_legacy()
        self.binding.fault = lambda inv: (
            {"phase": "failed", "error": {"code": "driver-failed", "message": "base failed"}}
            if inv.role == "baseline" and inv.label == "base1" else None
        )
        result = schedule.run_task(
            "ledger-1", 2, adapter=self.adapter, prop=self.prop,
            runs_root=self.adapter.spec.runs_root, execution=self.binding.seam(),
        )
        # The existing demo artifact extractor cannot render a failed baseline, so the
        # downstream method may be partial; one baseline failure must not erase the other.
        self.assertEqual(result.status, "partial")
        self.assertNotIn("no base rollout produced anything", result.errors)
        bases = [r for r in self.binding.records.values() if r["request"]["role"] == "baseline"]
        self.assertEqual(Counter(r["phase"] for r in bases), {"failed": 1, "completed": 1})
        self.adapter.execute_many.assert_not_called()

    def test_control_stops_escape_every_role_and_latch_next_admission(self):
        self.forbid_legacy()
        for role in ("baseline", "proposer", "candidate", "composer", "selector", "reflection"):
            for reason in ("budget-exhausted", "timeout"):
                with self.subTest(role=role, reason=reason):
                    seam = self.binding.seam()
                    self.binding.fault = lambda inv: Rejected(reason) if inv.role == role else None
                    with self.assertRaises(ExecutionStopped):
                        self.stream(seam=seam)
                    stopped_at = len(self.binding.attempted)
                    with self.assertRaises(ExecutionStopped):
                        seam.call(self.prop, "again", None, "again", role="proposer",
                                  task_id="ledger-1", scope="test")
                    self.assertEqual(len(self.binding.attempted), stopped_at)
                    self.assertEqual(self.binding.attempted[-1]["role"], role)

    def test_cancelled_interrupted_and_unknown_cleanup_records_stop(self):
        self.forbid_legacy()
        for fault in ({"phase": "cancelled"}, {"phase": "interrupted"},
                      {"phase": "failed", "cleanup": "unknown"},
                      {"phase": "completed", "cleanup": "unknown"}):
            with self.subTest(fault=fault):
                self.binding.fault = lambda inv: fault
                seam = self.binding.seam()
                with self.assertRaises(ExecutionStopped):
                    self.stream(k=1, seam=seam)

    def test_wait_deadline_requests_cancel_without_claiming_cleanup(self):
        self.binding.pending = True
        self.binding.timeout_ms = 1
        seam = self.binding.seam()
        with self.assertRaises(ExecutionStopped):
            seam.call(self.prop, "wait", None, "inv1", role="proposer", task_id="ledger-1", scope="test")
        self.assertEqual(self.binding.cancelled, ["execution-1"])
        self.assertEqual(self.binding.records["execution-1"]["phase"], "queued")

    def test_proposer_legacy_backend_control_stop_is_not_transport_retry(self):
        proposer = Proposer(self.prop.spec)
        proposer._opencode = Mock(side_effect=ExecutionStopped("budget stop"))
        with self.assertRaises(ExecutionStopped):
            proposer.call("mission", None, "inv1")
        self.assertEqual(proposer._opencode.call_count, 1)

    def test_request_and_record_identity_mismatch_are_rejected(self):
        seam = self.binding.seam()
        original_get = self.binding.get

        def mismatched(execution_id):
            record = deepcopy(original_get(execution_id))
            record["requestDigest"] = "different-request"
            return record

        self.binding.get = mismatched
        with self.assertRaises(ExecutionStopped):
            seam.rollout(self.adapter, "ledger-1", None, "base", label="base1", scope="test")

    def test_sweep_propagates_stop_instead_of_aggregating_failure(self):
        self.forbid_legacy()
        self.binding.fault = lambda inv: ExecutionStopped("budget stop")
        with self.assertRaises(ExecutionStopped):
            schedule.run_sweep(
                1, adapter=self.adapter, prop=self.prop, runs_root=self.adapter.spec.runs_root,
                library_root=self.root / "library", execution=self.binding.seam(),
            )

    def test_legacy_native_batch_still_uses_one_batch_call(self):
        original_execute = self.adapter.execute
        self.adapter.execute_many = Mock(side_effect=lambda task, harness, run_ids: [
            original_execute(task, harness, run_id) for run_id in run_ids
        ])
        pending = [("base1", "run/base1"), ("base2", "run/base2")]
        result = schedule._roll_bases("ledger-1", self.adapter, pending, self.root / "missing")
        self.adapter.execute_many.assert_called_once_with("ledger-1", None, [rid for _, rid in pending])
        self.assertTrue(all(view.delivered for view in result.values()))

    def test_unknown_usage_survives_reply_mapping_in_authoritative_record(self):
        self.binding.no_entry = True
        original_get = self.binding.get

        def unknown_usage(execution_id):
            record = original_get(execution_id)
            record["usage"] = {"status": "unknown"}
            return record

        self.binding.get = unknown_usage
        seam = self.binding.seam()
        reply = seam.call(self.prop, "reflect", None, "experience.agg1", role="reflection",
                          task_id="ledger-1", scope="test")
        self.assertEqual(reply.usage_status, "unknown")
        self.assertEqual(seam.records[0]["usage"], {"status": "unknown"})

    def test_context_and_selection_readers_cannot_swallow_control_stop(self):
        self.adapter.trajectory = Mock(side_effect=ExecutionStopped("timeout"))
        run = self.adapter.execute("ledger-1", None, "test")
        view = RunView("base1", "test", run, True, True)
        with self.assertRaises(ExecutionStopped):
            context.build(self.root / "context", self.adapter, "ledger-1", [view])
        self.adapter.deliverable_text = Mock(side_effect=ExecutionStopped("budget-exhausted"))
        with self.assertRaises(ExecutionStopped):
            selection.trivial_selection(
                "ledger-1", 1, "agg", {"agg1": view}, adapter=self.adapter, work_dir=self.root,
            )

    def test_submit_response_loss_does_not_retry_or_fallback(self):
        self.forbid_legacy()
        original_submit = self.binding.submit

        def lose_response(request):
            original_submit(request)  # Admitted, but the caller never learns executionId.
            raise OSError("response lost")

        self.binding.submit = lose_response
        seam = self.binding.seam()
        with self.assertRaises(ExecutionStopped):
            self.stream(k=1, seam=seam)
        self.assertEqual(len(self.binding.records), 1)
        with self.assertRaises(ExecutionStopped):
            self.stream(k=1, seam=seam)
        self.assertEqual(len(self.binding.records), 1)

    def test_get_response_loss_requests_cancel_and_stops_admissions(self):
        self.forbid_legacy()
        self.binding.get = Mock(side_effect=OSError("journal unavailable"))
        seam = self.binding.seam()
        with self.assertRaises(ExecutionStopped):
            self.stream(k=1, seam=seam)
        self.assertEqual(len(self.binding.records), 1)
        self.assertEqual(self.binding.cancelled, ["execution-1"])
        self.assertEqual(self.binding.records["execution-1"]["phase"], "queued")
        with self.assertRaises(ExecutionStopped):
            self.stream(k=1, seam=seam)
        self.assertEqual(len(self.binding.records), 1)

    def test_invalid_factory_request_stops_without_admission(self):
        original_factory = self.binding.factory

        def invalid(invocation):
            request = original_factory(invocation)
            request["pathInsteadOfRef"] = "unsupported"
            return request

        seam = PortMethodExecution(self.binding, invalid, self.binding)
        with self.assertRaises(ExecutionStopped):
            self.stream(k=1, seam=seam)
        self.assertEqual(self.binding.attempted, [])

    def test_incomplete_record_is_not_a_successful_proposal(self):
        original_get = self.binding.get

        def incomplete(execution_id):
            record = deepcopy(original_get(execution_id))
            record.pop("usage")
            return record

        self.binding.get = incomplete
        self.binding.no_entry = True
        seam = self.binding.seam()
        with self.assertRaises(ExecutionStopped):
            seam.call(self.prop, "reflect", None, "experience.agg1", role="reflection",
                      task_id="ledger-1", scope="test")
        self.assertEqual(len(self.binding.records), 1)


if __name__ == "__main__":
    unittest.main()
