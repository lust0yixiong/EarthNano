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

Run the contract gate from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --project=default --maxWorkers=1 src/main/earthnano/execution-core.test.ts
```

The two extraction tasks start only after this gate passes. Their production defaults must preserve
existing public behavior; new internal opt-in paths must use these exact requests/results and reuse
existing Session, ArtifactVersion and Review ownership. Unsupported configuration/policy must fail
explicitly. Harness² control stops must propagate before ordinary proposal/selection fallback.
