# EarthNano internal execution contract v1

`schema.json` is the authoritative wire definition. Generate/check both language types with:

```sh
python3 scripts/earthnano/generate-contract.py
python3 scripts/earthnano/generate-contract.py --check
```

TypeScript imports `src/shared/earthnano/execution-port.ts`; Python imports
`harness2.core.execution_contract` and generated `execution_types`. No agent may add local wire fields.
The copied Python schema is generated so installed packages do not depend on the repository layout.
`fixtures.json` fixes a Unicode request and its digest across both languages. JSON wire property names
are fixed ASCII, numbers are bounded integers, and strings must be Unicode scalar strings.
The request digest uses sorted-key compact UTF-8 JSON and SHA-256; it includes every request field.
This digest is for idempotent admission, **not** a cache key that permits cross-request result reuse.
`origin.sessionId` / `origin.promptMessageId` describe the source interaction. The record's `identity`
describes the actual executing turn. An isolated candidate may have a different target Session;
trusted bindings must validate target Project/Session/provenance rather than overwrite the origin.

The TypeScript `ExecutionCore` implements the owner behind `ExecutionPort`. A driver receives frozen
request references and an `ExecutionContext`; it resolves inputs through its trusted platform bindings,
reports running/admission/identity facts, and returns only after original result owners have committed.
`ExecutionOutcome` is an internal driver result, not an additional wire message. Cancellation requests
abort the context signal, but only a driver outcome confirms cancelled/cleanup. Timeout is interrupted
with unknown cleanup. The core never assumes that an aborted signal killed a provider process.

The initial core has a project-scoped **admission count** budget (configureBudget), not a monetary cap.
Reservations persist, including failures/cancellations; it does not estimate provider charges. Unknown
cleanup fences subsequent submissions sharing that project's environment reference ID. Reconciliation
and more granular runtime-slot ownership are later work; there is no automatic release operation.
Events are a finite, bounded replay, with explicit gaps; they are not an unlimited audit store.

The file store uses atomic replacement and fsync on POSIX, with an exclusive lock. The caller must
retire the old runtime/core before closing the store. A stale lock after a process crash is deliberately
not stolen automatically: an operator must confirm the old runtime is gone before removing it and
recovering. Recovery marks unconfirmed executions interrupted and does not dispatch them again.
No desktop bootstrap, server transport, automatic optimization trigger, configuration compiler,
real-provider isolation or result cache is installed by this contract layer.

`ExecutionUsage` stores observed provider facts. `status: known` means that some usage is known;
each absent optional field is independently **unknown**, never zero. `inputTokens` excludes cache;
`cacheTokens` is the provider-neutral cache total. Optional cache read/write values are a pair whose
sum equals that total. `modelTurns` counts inference turns, not HTTP requests. `apiRequests` and
`costMicrousd` require direct facts and are not estimated from turns, tokens or current prices.

New original-owner usage has `source.scope: logical-prompt` and the exact executing Session,
prompt and persisted usage-owner message identities. This is a snapshot of the original logical
prompt total: upstream accumulates detached ask-user continuations into the same prompt. It is
**not a per-Core-execution delta**. Aggregation must exclude repeated Session/prompt scopes when
more than one distinct execution refers to them; it must not add cumulative snapshots. Retries
with distinct fresh Sessions remain distinct. Legacy usage without this attribution remains readable
but cannot establish additive totals. Root usage does not claim delegated child-frame or ordinary
Reviewer coverage. Missing, ambiguous, unavailable, cancelled or interrupted usage stays unknown
unless an exact original completed usage owner supplies actual counters.

Desktop summaries report covered executions and known subtotals per metric, plus total unique
Core admissions. A partial subtotal is not a complete charge total. Shared baseline references and
repeated progress snapshots do not create extra executions. Time is kept separate: these provider
counters do not establish elapsed, active-compute or billed time.

Run the contract gate from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 src/main/earthnano/execution-core.test.ts
```

`stdio-roundtrip.py` and `harness-roundtrip.test.ts` are test-only transport fixtures: a real Python
method client calls the TypeScript core over test pipes, sharing an admission budget with a TS task.
They are not registered application endpoints and do not implement the production transport.

The two extraction tasks start only after this gate passes. Their production defaults must preserve
existing public behavior; new internal opt-in paths must use these exact requests/results and reuse
existing Session, ArtifactVersion and Review ownership. Unsupported configuration/policy must fail
explicitly. Harness² control stops must propagate before ordinary proposal/selection fallback.
