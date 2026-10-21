# Original sweep method integration

The host `previewOptimizationSweep` API uses the shared sweep contract and calls original
`schedule.task_stream` with a complete identity-only catalog. It freezes normalized options,
ordered selected IDs, complete catalog digest, actual Python method digest, original Namespace
descriptor and a canonical digest. Preview creates no Core/Session/admission and passes no
source bytes, source credentials, criteria, runtime descriptor or provider environment.

`harness2.earthnano_sweep --config FILE` accepts configVersion2 and the exact private fields:
bindingIdentity, catalog, selected tasks, stream, expectedDomains, catalogDigest, planDigest,
baseHarnessFiles, model, workRoot, executionTimeoutMs, rpcTimeoutMs, coreConcurrency and optional
explicit resume=true. k/modes/seed come from the validated v2 descriptor; stream.seed must agree.
coreConcurrency is only a fact in mode result metadata. Original domain workers remain stream.workers;
the host Core controls global admission/concurrency/budget.

The entry validates selected payload identity and complete original planning output before
creating its private workspace. It invokes original `run_sweep` once through one
PortMethodExecution, retaining original run_domain/run_task, shared k bases, per-mode recursion,
anonymous finals selection, reflection, Library retention/restoration and summary.port.json.
Original scheduler/recursion/selector/Library files are unchanged. Full catalog rows expose
only IDs/domains; only selected IDs have source payloads. Scientific payloads use existing exact
managed-input metadata validation, never a replacement source reader or runtime policy.

ResultVersion2 returns plan/binding digests, original sweep report, task summaries, per-mode
projections, and per-domain/mode Library files/entries. Outer task executionIds are all owned
method records for that task. Each mode includes the shared baselines plus its exact scope's
records; reflection therefore cannot be borrowed from the other mode. The host must still
validate every returned ID, ArtifactVersion, selected harness and Library against original owners.

## Optional binding v2

Existing HarnessOptimizationBinding accepts optional bindingIdentity, resumeScope(requestKey),
and onFreeze(request,slot,scope?). V1 keeps its previous slot and mission bytes and two-argument
callback. V2 uses the existing descriptor/slot helper, rejects v1/missing/foreign routing and
cross-mode retry provenance, and implements taskRecords(taskId,scope?) as an owned subset with
shared baselines. The domain multiplexer requires no alternative execution owner.

V2's immutable invocation mission also pins the registered logical taskId, original scope and
descriptor digest. This is necessary because task snapshot bytes can coincide, Namespace alone
does not include taskId, and a readable routing index is not immutable execution authority.
Tests rewrite both the task/scope index and slot while retaining byte-identical evidence; exact
completed request comparison refuses reuse. A v2 dispatch barrier validates every resumed
immutable invocation header before any result read or freeze, including original summary/Library
reopening that does not call freezeInvocation. Existing origin.stageId remains unchanged, including
base1 for independent assessment. The root runner must compare/persist its full v2 manifest
before constructing bindings; there is no v1 migration or automatic paid replay.

## Offline evidence and limits

The real original-sweep fixture covers two domains × two tasks × both modes × k2 with one
shared port: baseline8/candidate48/proposer32/composer16/selector8/reflection8 =120 method
admissions. Its chosen outputs are original agg2/c2 with no fallback. A k1 sweep compares
original domain/task results and exact Library bytes against the byte-pinned original
run_sweep fixture (Harness commit1cfe254e8d25b15f37048c3730134686abe60335). That fixture imports
the integrated core's existing default LEGACY dependencies; it is a scheduler comparison,
not a separate full upstream installation. Existing original k2 shared-base controls also run.

Other controls exercise seed0/negative seeds, task/domain filters, per-domain max, workers,
explicit partial resume and fully completed reopening with unchanged admissions, malformed
metadata/plan refusal before work, task-local scientific metadata, NO_ENTRY with no fabricated
Library, exact scope routing, provider-route mismatch refusal and shared-Core cancellation.
The real scheduler controls explicitly skip Windows for the pinned original fcntl requirement;
no fake lock adapter is introduced. Scientific metadata fixtures do not execute Notebook tools
or claim source-access/native persistence proof. Root-owned actual Core/desktop/owner tests and
independent per-task/mode assessment remain the integration acceptance authority.

For the full four-task k2/two-mode case, the method's120 admissions plus one base1 assessment
and two chosen candidate assessments per task require132 admissions on the complete first-attempt
path. Retries/stopped history can require more. The existing semantic/research verifiers remain
unchanged in this method lane; the root runner owns fresh confirmed reviewer reuse and original
budget enforcement. No paid provider call or shared dependency build is used in these controls.
