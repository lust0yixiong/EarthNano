# Round 7 minimal contract

Base: PR #8 d9db3c785, still open; this round is a stacked PR, never an automatic merge.
Reuse original task_stream/run_domain/Library/reflect_adoption. No replacement recursion/search.

Desktop request optionally adds `checks: OutputCheckSpec[]` and
`domain: {name, nextTasks:[{prompt,files,criteria,checks?}]}`. Current task is first;
0–3 next tasks (1–4 total), one domain, one selected mode. Domain enables one original
reflection per task. Omission keeps old single-task method and request digest unchanged.
Private task IDs are `<rootTaskId>-0001`, etc., preserving displayed order through upstream
task_stream's sorted reference order. All executions share one core, budget, stop and deadline.
First-attempt domain admissions = (7*k + (k>1?1:0) + 3) * task count, including reflection
and two independent assessments per task. Retried calls remain charged; platform cap128 remains.

The domain Python entry uses a per-task source adapter with the same base harness/agent,
returns order, per-task original method results and exact executionIds, plus raw original
Library file projection. Reflection must preserve original <experience>/<edits> reply syntax
and also emit OUTPUT/experience.md for existing ArtifactVersion/Review owners.

Library is explicitly scoped to this experiment. Original reflection/Library.add may precede
independent assessment and inform the next task within the experiment. This does not publish
a configuration or create a shared verified knowledge base. Platform records provenance and
admission privately; model-visible Library never receives independent criteria, scores or answers.
NO_ENTRY/invalid reflection remains an original no-entry outcome, not fabricated experience.
Failed lessons remain in durable Session/Artifact evidence even without an index entry.

Lifecycle completed, artifact acceptance and configuration eligibility are distinct.
Output checks v1 are bounded JSON-pointer equality/numeric tolerance checks on exact persisted
artifact versions. Expectations stay in the private assessment plan, outside method context.
Model pass alone yields unverified. Flagged semantic or failing deterministic check blocks;
passing supplied checks + semantic pass permits only further configuration validation. A lower
candidate model score than baseline conservatively blocks eligibility. No automatic promotion.
Outcomes keep fixed-version evidence, selected harness reference and original Review references.

Persistent progress/result add optional `outcome` and `domain` using research-outcome.ts.
Domain summaries may be projected incrementally so a stopped assessment retains prior results.
Partial/failed/interrupted execution cannot publish an eligible whole experiment.
Root owns shared types, checker/provenance persistence and runner; platform owns manager,
composition, IPC, UI/locales; method agent owns vendor entry and parity/isolation tests.
