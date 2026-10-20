"""Method-local execution seam; the wire contract remains execution_contract's authority.

Invocation is a LOCAL descriptor, never a wire message or an immutable reference. The trusted
request factory must freeze its inputs before returning an ExecutionRequest. ResultReader resolves
existing committed outputs explicitly; this module never guesses a path from wire evidence.
"""
from __future__ import annotations

import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .execution_contract import (
    ExecutionPort,
    ExecutionStopped,
    request_digest,
    validate_handle,
    validate_record,
    validate_request,
)
from .execution_types import ExecutionRecord, ExecutionRequest, ExecutionRole
from .proposer import Proposer, ProposerError, Reply
from .spec import ChannelSpec


@dataclass(frozen=True)
class Invocation:
    """Inputs offered to a trusted platform binding, including the method's logical identity."""

    task_id: str
    scope: str
    role: ExecutionRole
    label: str
    stage_label: str
    mission: str
    system: str = ""
    context_dir: Path | None = None
    harness_dir: Path | None = None
    run_id: str = ""
    channel: ChannelSpec | None = None
    timeout: int | None = None
    harvest: str | None = None
    attempt: int = 1
    retry_of_execution_id: str = ""


class RequestFactory(Protocol):
    def __call__(self, invocation: Invocation) -> ExecutionRequest:
        """Freeze all role inputs and return authoritative refs, policy, budget and a new key.

        Thread-safe. Retrying an invocation must use a new key and retryOfExecutionId. Local
        descriptor paths MUST be copied/snapshotted, not relabeled as immutable references.
        """
        ...


class ResultReader(Protocol):
    def rollout(self, record: ExecutionRecord, invocation: Invocation) -> Path:
        """Resolve a committed rollout into this adapter's existing readable artifact view."""
        ...

    def reply(self, record: ExecutionRecord, invocation: Invocation) -> Reply:
        """Resolve final text and, for edits, the committed harvested configuration workspace."""
        ...


class MethodExecution:
    """Legacy implementation. All method callers use this seam, including native batches."""

    legacy = True

    def rollout(self, adapter, task_id, harness_dir, run_id, *, label, scope) -> Path:
        return adapter.execute(task_id, harness_dir, run_id)

    def rollouts(self, adapter, task_id, pending, *, scope) -> list[Path]:
        return list(adapter.execute_many(task_id, None, [rid for _label, rid in pending]))

    def call(
        self, prop, mission, context_dir, label, *, role, task_id, scope,
        stage_label=None, retry_of_execution_id="", **kwargs,
    ) -> Reply:
        return prop.call(mission, context_dir, label, **kwargs)


LEGACY = MethodExecution()


class PortMethodExecution(MethodExecution):
    """Opt-in synchronous client of the shared port; no legacy cache or launcher is consulted.

    One instance represents one optimization scope. Once a control stop is observed, the latch
    rejects further admissions, including queued concurrent siblings. Already admitted work is
    still owned by the port: cancellation requests do not assert process exit or release slots.
    """

    legacy = False
    _CONTROL_CODES = frozenset({
        "budget-exhausted", "budget-rejected", "cleanup-unconfirmed", "timeout",
        "cancelled", "interrupted", "process_restarted",
        "invalid-request", "request-conflict", "not-found",
    })

    def __init__(
        self, port: ExecutionPort, request_factory: RequestFactory, result_reader: ResultReader,
        *, poll_interval: float = 0.01,
    ):
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self.port = port
        self.request_factory = request_factory
        self.result_reader = result_reader
        self.poll_interval = poll_interval
        self._stopped = threading.Event()
        self._admission = threading.Lock()
        self._records: list[ExecutionRecord] = []
        self._request_keys: dict[str, str] = {}

    @property
    def records(self) -> tuple[ExecutionRecord, ...]:
        """Shared contract records, including failures and stops, for the integration owner."""
        with self._admission:
            return tuple(deepcopy(self._records))

    def _check_stop(self) -> None:
        if self._stopped.is_set():
            raise ExecutionStopped("Optimization stopped; no further method admissions")

    def _stop(self, message: str) -> None:
        self._stopped.set()
        raise ExecutionStopped(message)

    def _record(self, invocation: Invocation) -> ExecutionRecord:
        handle = None
        record = None
        try:
            with self._admission:
                self._check_stop()
                request = validate_request(self.request_factory(invocation))
                if request["role"] != invocation.role:
                    self._stop("Request factory changed the invocation role")
                if request["origin"]["kind"] != "optimization":
                    self._stop("Method invocations require an optimization origin")
                if invocation.retry_of_execution_id and (
                    request["origin"].get("retryOfExecutionId") != invocation.retry_of_execution_id
                ):
                    self._stop("Request factory omitted retryOfExecutionId")
                if request["requestKey"] == self._request_keys.get(invocation.retry_of_execution_id):
                    self._stop("Retry must use a new requestKey")
                digest = request_digest(request)
                handle = validate_handle(self.port.submit(request))
                if handle["requestKey"] != request["requestKey"]:
                    self._stop("Execution handle does not match the submitted request")
                if handle["executionId"] == invocation.retry_of_execution_id:
                    self._stop("Retry reused its previous execution identity")
                self._request_keys[handle["executionId"]] = request["requestKey"]
            deadline = time.monotonic() + request["timeoutMs"] / 1000
            while True:
                record = validate_record(self.port.get(handle["executionId"]))
                if (
                    record["executionId"] != handle["executionId"]
                    or record["requestKey"] != request["requestKey"]
                    or record["requestDigest"] != digest
                    or request_digest(record["request"]) != digest
                ):
                    self._stop("Execution record does not match the frozen request")
                phase = record["phase"]
                if phase in ("completed", "failed", "cancelled", "interrupted"):
                    with self._admission:
                        self._records.append(deepcopy(record))
                    code = record.get("error", {}).get("code", "")
                    if phase in ("cancelled", "interrupted") or code in self._CONTROL_CODES:
                        self._stop(f"Execution {record['executionId']} stopped: {code or phase}")
                    if record["cleanup"] != "confirmed":
                        self._stop(f"Execution {record['executionId']}: cleanup unconfirmed")
                    self._check_stop()
                    return record
                if self._stopped.is_set() or time.monotonic() >= deadline:
                    # This is only a request; the port remains responsible for cleanup confirmation.
                    self._stopped.set()
                    try:
                        self.port.cancel(handle["executionId"])
                    finally:
                        self._stop(f"Execution {handle['executionId']} wait stopped or timed out")
                self._stopped.wait(self.poll_interval)
        except ExecutionStopped:
            self._stopped.set()
            raise
        except Exception as exc:
            # Even an unstructured transport error may follow successful admission. Neither
            # response loss nor a malformed journal response permits retry/fallback/replay.
            self._stopped.set()
            if handle is not None:
                try:
                    self.port.cancel(handle["executionId"])
                except Exception:
                    pass  # Outcome/cleanup remains unknown; the core owns reconciliation.
            raise ExecutionStopped(f"Execution binding/transport failure: {exc}") from exc

    def rollout(self, adapter, task_id, harness_dir, run_id, *, label, scope) -> Path:
        invocation = Invocation(
            task_id=task_id, scope=scope, role="baseline" if harness_dir is None else "candidate",
            label=label, stage_label=label, run_id=run_id, mission=adapter.task_prompt(task_id),
            harness_dir=harness_dir if harness_dir is not None else adapter.base_harness(),
        )
        record = self._record(invocation)
        if record["phase"] != "completed":
            raise RuntimeError(record.get("error", {}).get("message", "Rollout failed"))
        try:
            return self.result_reader.rollout(record, invocation)
        except ExecutionStopped:
            self._stopped.set()
            raise

    def rollouts(self, adapter, task_id, pending, *, scope) -> list[Path]:
        # Native batching has no shared wire message. Each baseline must be independently admitted.
        return [self.rollout(adapter, task_id, None, rid, label=label, scope=scope)
                for label, rid in pending]

    def call(self, *args, **kwargs) -> Reply:
        try:
            return self._call(*args, **kwargs)
        except ExecutionStopped:
            self._stopped.set()
            raise

    def _call(
        self, prop: Proposer, mission, context_dir, label, *, role: ExecutionRole, task_id, scope,
        stage_label=None, retry_of_execution_id="", system="", timeout=None,
        max_attempts=None, harvest=None,
    ) -> Reply:
        tries = max(1, int(prop.attempts if max_attempts is None else max_attempts))
        spent = 0.0
        last = ""
        previous = retry_of_execution_id
        usage_status = "known"
        for attempt in range(1, tries + 1):
            invocation = Invocation(
                task_id=task_id, scope=scope, role=role, label=label,
                stage_label=stage_label or label, mission=mission, system=system,
                context_dir=Path(context_dir) if context_dir is not None else None,
                channel=prop.spec, timeout=timeout or prop.spec.timeout, harvest=harvest,
                attempt=attempt, retry_of_execution_id=previous,
            )
            record = self._record(invocation)
            previous = record["executionId"]
            usage = record["usage"]
            if usage["status"] == "unknown" or "costMicrousd" not in usage:
                usage_status = "unknown"
            spent += usage.get("costMicrousd", 0) / 1_000_000
            if record["phase"] == "failed":
                last = record.get("error", {}).get("message", "Improver execution failed")
                continue
            reply = self.result_reader.reply(record, invocation)
            if not reply.ok or not reply.text.strip():
                last = reply.error or "empty reply"
                continue
            reply.execution_id = previous
            reply.cost_usd = spent
            reply.usage_status = usage_status
            reply.attempts = attempt
            reply.cached = False
            return reply
        raise ProposerError(
            f"[{label}] {last}", attempts=tries, cost_usd=spent, execution_id=previous,
        )
