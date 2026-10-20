# Alpha Artifact publication recovery

The comparison baseline is pinned OpenScience commit
`9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5`. The six-case regression fixture
runs unchanged against its original source and the EarthNano candidate. The baseline
was extracted from Git into an isolated temporary directory; both use the same prepared
dependency installation, Node v26.0.0, Vitest 4.1.11, macOS arm64. No dependency builds,
model requests, or paid calls were made.

## Confirmed publication window

Original `ArtifactTurnOwner.finalize` prepares a recovery marker without a Message ID
before `RuntimeSessionOwner.publish` flushes the queued final provider Message and stages
its exact durable Artifact claim. Application Session hydration can occur in that window.
The original unclaimed recovery heuristic then treats the only durable agent Message
(a commentary prefix) as the owner and permanently finalizes the Version to it. Subsequent
original runtime publication correctly refuses to reassign that Version to the final Message.

The deterministic upstream failure is:

```text
ArtifactFinalizationProofError: Artifact Version <fixture-version-id> is already finalized to a different message.
validateArtifactFinalizationProof (.../provenance-message-finalization.ts:215)
code: version-message-conflict
```

The production change only defers the unclaimed single-Message heuristic while the
same prompt owns the Session's original `activeRun`. Complete durable claims and bound
markers retain their existing recovery paths. Original Session authority remains responsible
for normalizing stale runtime state after restart. The proof validator, immutable Version
ownership, Artifact finalizer, and runtime publication owner are unchanged.

## Deterministic checks

`src/main/acp/artifact-publication-recovery.integration.test.ts` uses the original
Session repository/coordinator, runtime owner, Artifact turn owner, storage and provenance
repositories, and real finalization handlers. It queues a final runtime event, creates the
original prepared marker, and forces application hydration at the relevant boundary.
Its producer is an original completed NotebookRun **record**; this boundary test does
not start a Notebook kernel or claim that a model performed a calculation.

| Case                                                   | Pinned upstream               | Candidate |
| ------------------------------------------------------ | ----------------------------- | --------- |
| Same live prompt, hydration before final runtime flush | Fails with the conflict above | Pass      |
| Hydration after original exact durable claim           | Pass                          | Pass      |
| Cold process, original normalization clears activeRun  | Pass                          | Pass      |
| A different active prompt                              | Pass                          | Pass      |
| Partial durable claim refuses recovery                 | Pass                          | Pass      |
| Competing durable claims refuse recovery               | Pass                          | Pass      |

The successful publication case also checks final Message ownership, absence of a
commentary Artifact attachment, original terminal completion, and rejection of a later
attempt to retarget the immutable Version.

Run the same six cases in either checkout:

```sh
node node_modules/vitest/vitest.mjs run src/main/acp/artifact-publication-recovery.integration.test.ts --maxWorkers=1
```

Final upstream result: **1 failed / 5 passed**. Candidate result: **6 passed**.
The original five suites below pass **237 tests** on pinned upstream; the candidate
passes the same suites plus the new fixture: **243 tests / 6 files**.

```sh
node node_modules/vitest/vitest.mjs run \
  src/main/acp/artifact-publication-recovery.integration.test.ts \
  src/main/session-persistence/artifact-finalization-recovery.integration.test.ts \
  src/main/artifacts/provenance-repository.test.ts \
  src/main/artifacts/provenance-lifecycle-contract.test.ts \
  src/main/acp/artifact-turn-owner.test.ts \
  src/main/session-persistence/runtime-session-owner.test.ts --maxWorkers=1
```

For the upstream existing-suite comparison, omit the first (new fixture) path.
Local raw reports are `/tmp/earthnano-alpha-artifact-publication-upstream-red.log`,
`/tmp/earthnano-alpha-artifact-publication-upstream-legacy.log`, and
`/tmp/earthnano-alpha-artifact-publication-green.log`. Native TypeScript checking and
scoped ESLint are recorded separately in the corresponding `-tsc.log` and `-eslint.log`.

## Evidence limits

The live failure report had the same proof error and showed the generated Artifact on
both a commentary Message and the final response. Its isolated Session database had
already been removed, so those diagnostics alone cannot identify the historical first
writer. This deterministic original-owner reproduction establishes the unsafe recovery
window without reconstructing every historical failure. It does not replace subsequent
desktop, real Notebook, packaging, or paid-provider acceptance.

Delegated frames share the application Session but carry their own child prompt identity
(`delegation/delegated-artifact-evidence.ts`). The same-prompt guard does not treat the
root activeRun as authority for every child. Their original normal path has a different
ordering: `delegated-turn-lifecycle.ts` awaits `stageAttemptRuntimeTranscript` and obtains
the durable terminal Message before preparing the Artifact marker; then
`delegated-artifact-publication.ts` finalizes with that exact terminal Message ID. This
regression tests the confirmed root publication window, and establishes no additional
delegated-frame concurrency guarantee.
