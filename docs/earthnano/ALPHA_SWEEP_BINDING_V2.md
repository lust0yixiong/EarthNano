# Isolated namespace/slot preparation for original sweeps

This change does not activate catalog execution or alter the current single-mode runner,
v1 slot lookup, resume manifest, budget or Core admission. `harness-binding-v2.ts` has no
production caller. It reserves an explicit `earthnano-harness-binding-v2` identity and slot
namespace for the later root-owned shared stream/usage contract.

## Identity boundary

The immutable v2 descriptor pins schema/profile, k, seed (null differs from zero), canonical
original mode tokens, original shared-base namespace, mode namespaces and descriptor digest.
The current EarthNano profile permits its existing k=1..8 bound and empty tag only. Namespace
spelling is an exact projection of original `Namespace('earthnano','claude-text',mode,k,seed,'')`.
Mode aliases/order must first pass original CLI `parse_modes`; this helper does not introduce
another mode parser or silently reorder a caller's modes.

Slots include the descriptor digest, registered logical task ID, exact original scope, role,
stage label, invocation label and attempt. Baselines must use the original agg namespace,
including for a seq-only experiment. Other method roles must use an enabled mode's namespace.
Reviewer is not a method role. A namespace never grants task/source/runtime access.

`assertHarnessBindingV2Identity(expected,persisted)` rejects missing/v1/foreign descriptors and
any changed field before a future caller may look up slots or submit to Core. **Future wiring
must persist and enforce this descriptor first.** Changing only the current TypeScript slot
digest would be unsafe: `optimizationMethodDigest` hashes Python sources, and old completed
slots could otherwise disappear from a new lookup. This change never reads or migrates v1.
The existing full task/agent/harness/environment/source/input and original budget equality,
confirmed settlement, original ArtifactVersion verification and exact request matching remain
necessary; the v2 descriptor alone is not a resumability or admission proof.

## Source control and offline fixtures

`vendor/harness2/tests/fixtures/original_schedule_1cfe254e8d25.py` is a byte-exact licensed copy of
`harness2/core/schedule.py` from the `UPSTREAMS.json` Harness² pin:

- Commit: `1cfe254e8d25b15f37048c3730134686abe60335`.
- SHA-256: `6e46c5ab1e4ac111818ff3acd6b636e39d650898189ac0c21802a8233ad4cd38`.
- Confirmed against both the preserved original source archive and Git import `0a9d62c17`.

The control rejects changed fixture bytes before import and directly executes that original
`run_task` with both modes, alongside the integrated `run_task` through the existing
PortMethodExecution/PlatformRequestFactory/PlatformResultReader. Both use existing deterministic
offline text adapter/proposer fixtures. The original scheduler imports the integrated core's
existing default LEGACY dependencies; this is a scheduler/namespace/shared-baseline comparison,
not a claim of a separate full upstream environment or native runtime validation.

For k=2 and each seed null, zero and -7, the control checks:

- Original CLI alias/dedup/order result is `(agg,seq)`.
- One actual shared baseline set: base1/base2, both in original agg namespace.
- Exact original-versus-port rollout task/role/label/namespace inventory: 14 rollouts total.
- Actual port method roles: baseline=2, candidate=12, proposer=8, composer=4, selector=2.
- Both original anonymous choices match: agg2 and c2, no fallback; each mode ledger R=8/P=6.
- The 28 real invocations collide under the old unscoped slot tuple, and are all distinct under v2.
- Changed descriptor/version/scope/role/task/retry is refused or isolated as appropriate.

Tests exclude timing, random private paths and usage amounts from the equivalence claim. These
are local in-memory execution-owner fixtures, not evidence of paid/native execution, original
Session/Artifact persistence, sweep/Library integration or independent per-task grading.
The real-run transcript control explicitly skips Windows because pinned original
`schedule._write_summary` requires POSIX `fcntl`; no fake locking shim is added. Pure v2
identity tests and the original namespace rejection control remain platform-neutral. Local
validation was macOS; Linux and Windows executions are not claimed here.

Reproduce without package builds:

```sh
PYTHONPATH=vendor/harness2 PYTHONDONTWRITEBYTECODE=1 python3 -B vendor/harness2/tests/test_earthnano_sweep_binding_v2.py
node node_modules/vitest/vitest.mjs run src/main/earthnano/harness-binding-v2.test.ts src/main/earthnano/harness-optimization.test.ts --maxWorkers=1
```

The fixture is under `tests/`, outside production `harness2/`; it does not change the current
method source digest. No renderer/IPC/shared DTO or production runner is changed.

Local validation: 43 host tests in three suites (new helper, existing binding and resume),
15 Python tests (new original control plus existing method/resume), node TypeScript check and
focused ESLint passed. Raw source/port control projection:
`/tmp/earthnano-alpha-sweep-binding-v2-control.json`.

## Next wiring, pending the root-owned contract

Freeze an ordered host catalog using existing CandidateSnapshotInput/CandidateSnapshotRefs,
per-task original source Session/message/version provenance, and private evaluation criteria/checks.
Keep prompt-source Session separate from each referenced Version's actual owning Session. Reuse
original authorization on start/resume; neither equal bytes nor another catalog task grants access.
The Python config receives task prompts/files or exact managed-input metadata, never grading
criteria/source-evidence manifests. Common initial harness/agent is the minimal supported catalog
because original adapter `base_harness()` has no task parameter.

Call original `schedule.run_sweep(...,execution=onePort)` once, with original task_stream controls,
shared Core/budget and original run_domain/Library. Project each task/mode's selection/reflection
by the persisted routing scope, not a last-record heuristic. Reuse existing taskRecords operation
with a host-validated optional scope filter (shared baselines plus selected mode). Validate each
Library mode/domain separately and assess each task/mode against that task's fixed base1. All
reviewer admissions remain in the same Core and budget; reuse only exact existing reviewer requests.
No implementation of this broader wiring is included here.
