# Round 8 — one execution authority for Send and Harness²

Base: PR #9, 372eba63f; stacked PR, no automatic merge. Preserve OpenScience user capabilities and reuse upstream owners/algorithms.

## Authority and scope

One agent turn is one shared Execution. Desktop Send, Task API and every Harness² role must enter the same ExecutionCore rules before provider dispatch. An already admitted execution propagates a trusted in-process scope through ACP: never admit it again. Internal provider/tool continuations stay inside their root scope. Explicit separate review/optimization calls get role/parent declarations; generic completion never triggers optimization.

TaskRun/Session/Experiment are workflow views and original owner facts, not alternative model-execution authorities. Task API preserves its existing acceptance/wait/cancellation and Session/artifact/Review commit ordering, but its agent dispatch/cancel enters this same boundary; a task-owned completion barrier keeps canonical execution settlement behind the original durable owner commit. No mirror log written after an independently launched turn counts as unification.

## Common rules

- Immutable ExecutionRequest/refs describe the original requested task, invocation, selected agent, configuration and resource scope. Rich ACP data remains intact; live workspace/transient images must not be falsely called a reproducible isolated text snapshot. Preserve transient-media nonretention with fingerprints and explicit evidence limitations.
- One durable admission and one budget reservation per real execution; retries use new request keys, authorized rearmed messages are new attempts. Reuse within a scope verifies Project/Session/turn ownership.
- Role/origin/interaction/resource ownership/deadline/budget are declarations consumed by one policy; adapters supply original owner operations, not their own lifecycle policy.
- `timeoutMs=0` means no imposed execution deadline for ordinary user/automation turns. Optimization requires a positive bounded deadline. Interactive approval/permission waits preserve upstream behavior.
- Cancellation is a request, not an outcome. An original owner may reject cancellation; rejection does not abort its execution. Accepted cancellation propagates to the exact owned prompt/lease and later owner/Review commit. Earlier provider, Notebook or persistence failures keep precedence.
- Cleanup is retirement of the execution's owned resources. Shared Session runtime reuse requires exact prompt/lease release and original durable owner completion; isolated candidates also require their owned process retirement. No prompt may cancel another turn.
- Uncertain cleanup fences its resource scope, not unrelated Sessions. No paid automatic replay on restart. Original durable Session/Review witnesses drive trusted reconciliation; do not maintain conflicting terminal histories.
- Evidence/configuration claims come from original Session, ArtifactVersion and Review owners; unknown stays unknown. Original review-safe projection and fixed versions use the same reader for ordinary and candidate paths. Arbitrary binary/rich ordinary artifacts must not be forced through the candidate text profile.

## Preservation and Harness²

Keep full AcpPromptRequest (images, uploads, parts, literature/artifact/session references, skills, history, memory, context reset, plan intent), backend selection/resume/specialists/delegation/compute, notifications, queue/branch control, permissions and cancellation. Explicit ordinary autoReview stays enabled when selected; internal Harness roles never recursively invoke ordinary autoReview. Original sequential/parallel, generation/composition/anonymous selection/reflection/Library/domain ordering/NO_ENTRY/fallback and independent assessment separation remain unchanged.

## Internal boundary API

`AcpExecutionBoundary.execute(input)` receives a full rich request, operation/owner declarations and original `dispatch(observer)` / `cancelOwned()` functions. Observer confirms original durable Session admission and provider acceptance. Host prepares verified refs/store/budget and reads original result after any supplied owner-completion barrier. Existing admitted scopes call the same policy and physical dispatch without a second admission.

`cancel(sessionId, cancelOriginal)` is the canonical Session cancellation path. Trusted physical cancellation runs under a scoped reentry guard so Core → original owner → ACP cannot resubmit cancellation. Public response shapes remain unchanged. Core emits a single admission/provider event per execution.

## Ownership and gates

Root: boundary/authority, execution scope/policy/Core/schema and contract; integration, actual DeepSeek and PR.
Platform agent: actual ACP/coordinator/handler/Task API entry, full request and completion barrier, legacy API projection/controls; original feature regressions.
Method agent: shared original turn evidence reader and host persistence/metadata, reuse by candidate owner; Harness equivalence and ownership regressions.

Required proof: real desktop Send (not TaskRunner alone), headless Task API and Harness stage share Core; single admission, rich field parity, rejected/late cancellation, approval waits, concurrent Sessions, authoritative terminal commits/restart behavior, no recursive review/optimization, seq/par + Library/reflection parity. Real Claude Code/DeepSeek proves ordinary Send plus explicit optimization without fabricating an improvement or requiring nonempty Library.
