# Round 10 — one scientific task through the shared execution core

EarthNano uses the pinned upstream Notebook runtime, RPC capability owner, input registry,
permission broker, ArtifactVersion and Review owners. Harness² retains its original schedule,
recursion, anonymous selection, reflection and Library. No parallel scientific engine is added.

## Frozen task and capabilities

- Desktop opt-in: `notebook: { promptMessageId }` refers to an original user message in the
  authorized source Session. Main loads its exact prompt and finalized upload/artifact references;
  the requested prompt must match. Raw text files, derived report inputs and domain successors
  cannot be mixed into this mode. Existing text optimization remains supported.
- `CandidateTask.managedInputs?` stores only fixed identity metadata: `sourceKind`
  (`upload-version` or `artifact-version`), `sourceProjectId`, `sourceSessionId`, `sourceFileId`,
  `inputFileVersionId`, `filename`, `sizeBytes`, `checksum`. No storage path, credential or latest
  alias. Main verifies source-message authority and exact ManagedFileVersion identity.
- `CandidateEnvironment.notebook?` contains `runtime`, a host-captured projection of the original
  enabled runnable Python `NotebookRuntimeBinding`: language, runtimeId, source, provenance,
  interpreterPath and optional version. Its network label is `provider-and-notebook-policy`:
  Notebook network/access decisions remain with the original owner, not an invented sandbox.
- `CandidateHarness.tools` gains `notebook-python`. Only baseline/candidate may use it; every
  proposer/composer/selector/reflection/independent Reviewer stays `workspace-only`. Revised
  instructions and Skills preserve the host-fixed profile. No optimizer-written tool grants,
  runtime switches, package installs or changes to source versions.

## Original runtime and persistence

- Baseline/candidate share the same TaskSnapshotRef, input version tuples/checksums and frozen
  environment. Each gets a fresh Session, runtime connection, framework home and Notebook lane.
- Register exact frozen references with the original Notebook input registry and prompt builder.
  Do not pass them through the generic latest-reference resolver; do not republish source files.
- The original application Notebook service/RPC server owns Python execution, capability checks,
  network/environment policy, producer runs, cancellation and physical retirement. Reuse a common
  ACP Notebook binding helper for ordinary and optimization execution where feasible.
- A scientific candidate exports original MCP-published ArtifactVersions and real Notebook producer
  evidence. Do not import its report through the text-file output importer or invent a producer.
  This round supports bounded textual report exports to the method; ordinary binary output remains
  available and expansion of optimizer report exports is explicit follow-up.
- Core remains the sole mission admission/budget/deadline/stop authority. Inherited ACP dispatch
  never creates a second journal or budget charge. Cleanup is confirmed only after original owners
  release agent, Notebook work and capabilities; uncertainty keeps the existing resource fence.
- Independent deterministic and semantic assessments read fixed output versions only after method
  completion. Expected values and criteria never enter optimizer context or Library.

## Acceptance

1. Preserve existing Send, text optimization, method parity, fixed-version and lifecycle tests.
2. Prove exact old source Version is used even if a newer source exists; cross-project, missing,
   deleted or altered references and disabled/changed runtimes reject without provider execution.
3. Run one real CSV/statistics scientific task through ordinary Send and original Harness² baseline
   plus candidates (parallel k2), not a derived JSON-copy task. Every task execution has real
   Notebook runs, the same fixed source version, independent Session lanes and MCP publication.
4. Verify one common Core admission per mission, budget/stop/failure propagation, original producer
   provenance and Review persistence; restart reopens facts with no paid replay.
5. Run offline native desktop acceptance before the bounded DeepSeek/Claude Code live acceptance.
   API calls, execution counts and limitations are reported separately. Tied valid results do not
   prove optimization gain. Submit this round as a new PR; do not merge it automatically.

## Merge baseline

Existing PRs #7, #1, #8, #9, #10 and #11 were reviewed and merged in dependency order.
The reviewed main baseline is `7c08c9b7eb1b3fcc167b23acdab85d4c110df8b2`.
PR #10 includes the physical pre-admission retirement fix `0b904e7e5`; PR #1 includes
updated pinned-action test `dbe43f74d`. GitHub Actions remains disabled. New work uses separate
local worktrees and preserves upstream commit pins and compatibility storage identities.
