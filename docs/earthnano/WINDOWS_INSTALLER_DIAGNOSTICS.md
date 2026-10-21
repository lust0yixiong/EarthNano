# Windows installer invocation and diagnostics

**2026-10-21: deferred by the user to 0.2-Alpha.** Windows builds, publication and
installation acceptance are excluded from 0.1-Alpha. This branch preserves attempted
fixes and diagnostic work; it is not a passing Windows release. No further Windows
installer debugging, build or CI dispatch is planned in the current release.

## Source and current status

The fixed OpenScience pin `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` already calls
`spawn` with `/S` followed by `/D=<target>` using default Windows argument serialization.
EarthNano runs `39555053834` and `39573702221` both built the actual setup executable,
then failed the original installed-resource/RPC/launch smoke with installer exit 2 and an
empty requested target. Neither run passed Windows native acceptance.

Run `39573702221` retained a raw `GetCommandLineW` receipt showing Node put quotes around
the complete `/D=<path with spaces and Unicode>` argument. The lockfile-selected
`app-builder-lib` 26.15.3 `multiUser.nsh` requires the final `/D` suffix without quotes and
its original `GetDParameter` macro copies that suffix without removing quotes. This is
source-supported invocation causality, not a diagnosis of every possible installer exit 2.
The old probe itself exited 2 after its first case; `continue-on-error` made the Actions
step look successful, and its second case never ran. Preserve that failed control.

The current smoke keeps the original executable, `/S`, final `/D`, isolated profile,
spaces/Unicode target, timeout and installed application checks. Only this install call
uses `windowsVerbatimArguments: true` and a quoted `argv0`; `/D` remains unquoted.
No product NSIS template, compiler or application behavior changes. Actual Windows
run `39577934563` still failed with installer exit 2 and an empty requested target.
The optional macro probe failed compilation because it resolved the stock NSIS
`MultiUser.nsh`, which lacks the dependency macro; no probe case ran. Local commit
`28d87337f8a68d2c765d6441cc33ae57063df4ba` binds the include to the locked
app-builder headers, but has not been verified on Windows. The installation root
cause remains unresolved; argument serialization alone did not fix installation.

## Original-macro diagnostic

After original packaging has populated the cache, run:

```powershell
node scripts/windows-nsis-arguments-probe.mjs --out test-results/native-evidence/nsis-arguments
```

The probe verifies the original cached NSIS 3.0.4.1 archive/compiler and original
nsis-resources 3.4.1 StdUtils plugin bytes, using the already cached original 7zip reader.
Missing, ambiguous, overridden or changed inputs produce unavailable evidence. There is
no download, compiler substitution or custom command-line parser. The observation program
directly includes the locked dependency's `multiUser.nsh` and invokes `GetDParameter`;
the report retains the actual macro source and include hashes.

Default and verbatim calls run independently, including when the first process fails or
its receipt is absent. Bounded receipts retain raw command line, `$CMDLINE`, builtin and
macro-selected `$INSTDIR`, process status and whether the target was created. Success
requires both receipts, exact target selection and zero exit for the verbatim case, and
no installation target created by the observation program. A failed default execution
remains explicitly failed. All compiler/process calls have finite time/output bounds;
the program writes only its owned evidence/profile files and does not install the app.

The preserved diagnostic workflow retained evidence even on failure and required the
complete original application smoke. Its optional diagnostic step's green conclusion
was never an installation verdict. The historical `nativeTargets=windows` input was
for diagnosis only. It is not the 0.1-Alpha release workflow; that release now targets
macOS and Linux only. No five-target acceptance claim is made.

## Evidence limits

The cached compiler's `/HDRINFO` lacks `NSIS_CONFIG_LOG`; adding `/LOG` is not a supported
logging solution. A logging-enabled custom compiler would change the tested baseline.
The smoke records bounded failure phase, invocation, profile and exit/output facts and
rethrows the error; it does not suppress installer failures.

Local orchestration tests and a real Node child verify argument forwarding, independent
cases, original cache checks, tamper rejection and failed receipts. They do not execute
Windows/NSIS or prove application installation. Require the actual Windows macro receipts
and the original installed app resources, R/runtime, RPC, health and launch checks before
claiming Windows native acceptance.

References: [NSIS command-line rules](https://nsis.sourceforge.io/Docs/Chapter3.html),
[NSIS exit levels](https://nsis.sourceforge.io/Docs/AppendixD.html#D.1),
[Node 24.22 Windows argument implementation](https://raw.githubusercontent.com/nodejs/node/v24.22.0/deps/uv/src/win/process.c).
