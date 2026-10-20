# Round 6: original Harness² recursion in the desktop execution path

Scope: one task and one selected original recursion mode per optimization. Library, domain
streams, automatic triggers, richer tool profiles and restart replay remain later work.

## Shared options

`method?: { mode: 'sequential' | 'parallel'; k: number; concurrency: number }`

- Omission preserves `{mode:'sequential', k:1, concurrency:1}`.
- The platform bounds k to 1–8, concurrent executions to 1–4 and admissions to 128.
- Python receives this same `method` object in its private bootstrap configuration.
  It maps names through upstream `schedule.mode_token`, then calls original `run_task`
  and its existing recursion/selection implementation. No duplicate search algorithm.
- One-mode first-attempt admissions are `7*k + (k>1 ? 1 : 0)`, plus two independent
  assessments when enabled. This follows upstream R=4k/P=3k; retries are extra and share
  the existing user-selected execution budget. A count cap is not a token/currency cap.
- Desktop validation rejects an insufficient first-attempt budget before allocating work.
  Trusted internal execution tests may deliberately supply smaller budgets to exercise stops.
- Method parameters participate in desktop request identity and are persisted in progress
  and method configuration. Existing omitted-option requests retain their previous digest.

## Execution and results

The original method chooses phase ordering and candidates. Platform execution caps concurrent
drivers, reserves budget on durable admission, and keeps queued work cancellable. An unknown
cleanup outcome fences further execution instead of releasing capacity to another candidate.
Neither cancellation nor budget exhaustion may become an ordinary method fallback.

Stage identifiers are projected from the existing ExecutionRequest origin. The Python result
keeps existing status/summary/records/chosenArtifacts/configurationChanged/fallbackStages and
adds `method` and `selection: {chosenLabel,candidateCount,trivial,fallback,reason}`. The selected
artifact references are read from platform-persisted versions. Upstream finals-only anonymous
selection and retry/fallback semantics remain unchanged; k=1 retains trivial selection.

Independent assessments run after selection. For k>1 the comparison baseline is predeclared
as the original `base1` execution, not the fastest, highest-scoring or last-completing baseline.
The report compares that fixed baseline with the selected final; it is not an aggregate
estimate over all k baselines. Evaluation criteria and verdicts remain outside method context.

## Implementation ownership and verification

- Platform agent: desktop manager/UI/locales, method options forwarding in persistent runner,
  shared-core bounded concurrency and their targeted tests.
- Method agent: EarthNano Python entry/binding tests and upstream method parity checks.
  Retain original core algorithm files unless a demonstrated seam defect requires a narrow fix.
- Main agent: shared options/contract, semantic assessment baseline handling, selector role
  context/output integration, process/live integration checks, upstream delta record and PR.

Required checks: both k=2 modes call the original selector; unchanged k=1 path; meaningful
candidate selection from immutable outputs; budget/stop under overlapping executions; no
grader leakage; candidate isolation; fixed base1 assessment; desktop option/selection display;
original Harness² workflow tests. DeepSeek verification stays opt-in and bounded.
