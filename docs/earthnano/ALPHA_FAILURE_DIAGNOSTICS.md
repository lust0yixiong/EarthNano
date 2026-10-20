# Private optimization failure diagnostics

The existing exclusive execution-run owner appends host facts to
`<execution workRoot>/failure-diagnostics.jsonl`. This file is private (created mode
`0600`), rejects linked/nonregular files, and stops appending at 64 KiB. Resume retains
earlier rows. Recording is best effort and never changes admission, budget, cleanup,
method rules, result acceptance, or the exception rethrown by the orchestration layer.
Failures before execution-owner acquisition do not create diagnostic directories.

Each row has only `schemaVersion: 1`, a fixed host `stage`, a fixed `category`, and
optional bounded `exitCode`, allowlisted `protocolStatus`, and allowlisted `bindingCode`.
Stages distinguish resume/input/owner/snapshot validation, method process/result,
execution integrity, domain summary, independent assessment, research verification,
result projection and cleanup. Process categories distinguish spawn, exit, missing result,
protocol, frame/diagnostic limits, binding rejection, timeout, cancellation and I/O.
Allowed protocol statuses are `ok`, `failed`, `partial`, `skipped`. Allowed binding codes
are `budget-exhausted`, `request-conflict`, `cleanup-unconfirmed`, `not-found`.
Other exceptions produce only the current host stage and `stage-failed`, `deadline`,
`cancelled`, or `cleanup-unconfirmed`.

No exception message/stack, stdout/stderr, provider configuration, source content, mission,
request or credentials are serialized. A typed `HarnessProcessFailure` carries only
sanitized facts and the existing fixed generic process error message. This is diagnostic
evidence, not a completion receipt or resource-release authority. It is not added to the
public desktop DTO. Diagnostic-file absence or a full file is not evidence of success.

Acceptance collectors may separately whitelist this exact filename and the existing
`resume.json` and `request-tasks.json`; those private identity files are distinct from
diagnostics and can contain task input. Do not recursively collect candidate directories,
CLI settings, credentials or arbitrary process diagnostics.

## Verification

Base: integrated EarthNano `e934e2732acd3887708e46a227bac05b67388bb9`.
Environment: Node v26.0.0, Vitest 4.1.11, macOS arm64, the unchanged prepared dependencies.
No paid calls, provider processes, package builds or shared dependency writes were used.
Real local Python subprocess tests verify exits, malformed protocol, bounded binding codes,
spawn failure, timeout and cancellation. Fault tests verify secret non-leakage, private
append history, the size cap and linked/unavailable files. Orchestration tests verify the
exact original error object, unchanged configured budget, and awaited original cleanup.

```sh
node node_modules/vitest/vitest.mjs run \
  src/main/earthnano/optimization-failure-diagnostics.test.ts \
  src/main/earthnano/harness-optimization.test.ts \
  src/main/earthnano/run-persistent-optimization.test.ts \
  src/main/earthnano/optimization-resume.test.ts \
  src/main/earthnano/optimization-reconciliation.test.ts --maxWorkers=1
```

Result: **87 passed / 5 files**. Raw report:
`/tmp/earthnano-alpha-private-diagnostics-tests.log`. Native TypeScript and scoped ESLint
reports use the same prefix with `-tsc.log` and `-eslint.log`.

The expanded workload exposed the original real-80-ms deadline test assuming that
assessment starts before expiry. Unchanged `e934e2732` runner and original test source,
copied as temporary baseline modules under the same imports/dependencies, reproduced the
same `TypeError: Cannot read properties of undefined (reading '0')` at its access to
`f.evaluate.mock.calls[0][0]`: **1 failed / 84 passed** in the matched five-file workload.
Raw control: `/tmp/earthnano-alpha-private-diagnostics-original-control.log`.
The test now controls the original `AbortSignal.timeout(80)` factory and uses an
assessment-entry barrier before expiring that signal. A separate test expires the deadline
before assessment and checks zero reviewer/result dispatch. Production timeouts are
unchanged; the tests no longer assume setup finishes within a real 80 ms on a busy host.
