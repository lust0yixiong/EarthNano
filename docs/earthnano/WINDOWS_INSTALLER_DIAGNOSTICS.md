# Windows installer argument diagnostics

Native run `39555053834`, Windows job `119099780295`, built the setup executable but the
original smoke's `installApplication` returned exit 2 with an empty requested target. The
unchanged upstream publication hooks can return 2 at several stages; this observation does
not identify the failing stage or establish that quoting caused that exit.

After the original Windows packaging command and before the original smoke, run:

```powershell
node scripts/windows-nsis-arguments-probe.mjs --out test-results/native-evidence/nsis-arguments
```

This is a separate bounded diagnostic command. Retain its failure/output and continue to the
original smoke even if the probe is unavailable; its result must not replace the original smoke
verdict. No workflow, compiler, package, matrix, installer argument, or timeout is changed by
this patch. The existing native evidence upload already includes this output directory.

The probe requires the original `nsis-3.0.4.1.7z` archive in electron-builder's existing cache,
checks its original SHA-256 `9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa`,
and selects exactly one extracted compiler. Missing/ambiguous caches and configured NSIS
overrides fail explicitly and retain an unavailable receipt. The actual job used electron-builder
26.15.3, whose original cache implementation persists this archive before extraction and uses
`nsis-3.0.4.1/nsis-3.0.4.1-<five-character URL suffix>/Bin/makensis.exe` below its cache root.
Archive persistence is best effort; absence makes this diagnostic unavailable and does not
establish an installer defect. The already cached original electron-builder 7zip toolset reads the single
`Bin/makensis.exe` archive member to stdout with a 15-second/8-MiB bound. The selected cached
compiler must match those verified original bytes; a mismatch is unavailable evidence. No
archive files are extracted to disk. It never downloads or installs a compiler. It records compiler
version, `/HDRINFO`, archive/compiler/probe hashes, Node/libuv versions, isolated profile paths,
the original two argument strings, process status, raw Windows command line, NSIS `$CMDLINE`,
and `$INSTDIR`. It compiles a tiny observation executable with that existing compiler. Its only
writes are evidence and isolated temporary profile files below a fresh owned output directory;
it does not install the application, create an installation target, access the registry, or
delete existing paths. Six synchronous commands have a combined 135-second timeout ceiling
(15/15/15/60/15/15 seconds). NSIS command output is bounded to 1 MiB per command.

Both executions use `/S` followed by `/D=<absolute path with spaces and Unicode>` and the same
isolated profile environment layout as the smoke. The first uses Node's default argument
handling. Only the second observation explicitly enables `windowsVerbatimArguments` and quotes
argv[0]; it leaves `/D` unquoted. The production installer invocation retains its default
handling. A selected-directory difference demonstrates a parsing mechanism, not a repaired
application installation. The default target and any missing/failed receipt remain visible.

[NSIS documents](https://nsis.sourceforge.io/Docs/Chapter3.html) that `/D` must be the last argument
and contain no quotes even with spaces. The
[v3.04 parser](https://raw.githubusercontent.com/kichik/nsis/v304/Source/exehead/Main.c)
matches the literal prefix ` /D=` and removes a recognized suffix from `$CMDLINE`, which is why
the probe also reads `GetCommandLineW` directly. The
[Node 24.22.0 libuv implementation](https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/uv/src/win/process.c)
quotes whitespace arguments in its default mode. These sources motivate the control/observation
pair; a real Windows execution is still required.

Correction to the earlier external diagnosis report: `/LOG` is not an available default logging
solution for this original compiler. electron-builder's `customNsisBinary.debugLogging` requires
a logging-enabled compiler; this task does not replace the compiler. `/HDRINFO` is retained as
configuration evidence. The original product smoke now additionally prints a bounded failure
summary (phase, target, profile paths, exit/signal and captured stdout/stderr) and rethrows the
same error. Its original command, timeout, installed-entry/archive summary and failure assertion
remain in force. Silent NSIS internal `DetailPrint` output can still be unavailable.

Local tests cover the original smoke's unchanged invocation/rejection, real Node child failure
capture, strict cache selection, receipt parsing and probe orchestration. Orchestration fixtures
do not execute Windows or NSIS, simulate its quoting semantics, or establish this job's root cause.
