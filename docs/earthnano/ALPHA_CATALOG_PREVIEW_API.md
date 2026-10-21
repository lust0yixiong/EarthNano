# Desktop catalog preview API

`DesktopOptimizationApi.previewSweep(PreviewDesktopSweep)` is a desktop-only read operation.
Its strict shared DTO accepts project/navigation Session IDs, logical catalog task/domain IDs
and normalized sweep controls. Task bodies, source references, credentials, provider options,
executable paths and execution budgets are rejected at this boundary.

Main calls the existing `previewOptimizationSweep`, which invokes the pinned original
`task_stream` through `harness2.earthnano_sweep --preview`. The response contains the method-pinned
plan digest, selected domain/task order, canonical modes and first-attempt minimum admissions.
The minimum is capacity information, not a promise about retries or successful optimization.
No Core, candidate Session, model/provider capture, selected-task source parsing/freezing,
fixed source file/version reads or separate persisted planning authority is created.

Navigation authorization deliberately retains the original project/archive and Session owner
checks. Those checks can read the navigation Session snapshot internally to reject unavailable,
foreign-project, archived or imported Sessions. This API does not claim zero Session JSON I/O;
it never uses that snapshot as catalog task input or bypasses owner checks with a metadata index.

The manager registers previews before asynchronous authorization and tracks their abort controllers
independently of the start/resume queue. Stop remains callable during preview. Closing or entering
the update gate cancels previews, prevents later Python launch, and waits for physical process
settlement before reporting cleanup. Original Session admission and data-root lifetime leases remain
held through process close. IPC uses the existing top-frame desktop caller gate and fixed error
redaction; both Web surfaces explicitly mark this API unavailable. Legacy start/resume behavior and
persisted experiment identities are unchanged.

Validation includes the production helper running original Python with seed null/0/-7,
filters and per-domain limits; provider/source-reader spies; original navigation rejection;
manager close/update/Stop concurrency; a private fixture copy with an entry-point wait that proves
an already-running Python PID is reaped before leases release; strict IPC fields/redaction;
typed preload forwarding and Web exclusion. The fixture changes no shared method source or build
output. No paid execution is used.
