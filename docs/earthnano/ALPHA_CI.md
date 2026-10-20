# EarthNano Alpha CI and pinned upstream evidence

`.github/workflows/earthnano-ci.yml` is a dedicated, read-only workflow. It has no schedule,
signing credentials, publishing step, model credentials, or privileged PR-target trigger. Existing
upstream workflows are retained as source history; the repository administrator must disable them
before enabling this workflow. This change does not perform Actions API writes.

## What the gates actually establish

The source matrix independently installs the exact OpenScience commit
`9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5` and the candidate source in fresh runner directories.
It uses the original `scripts/ci/npm-ci.mjs`, `npm run pretest`, package builds, compiled type checks,
and original Vitest configuration. macOS and Linux run four full-source shards each. Windows uses
its original full-test sequencer's eight shards. Both sides receive the same runner OS/image,
architecture, Node major selection, exact Python 3.12.13, worker limits, timeouts and flags. The
comparison rejects mismatched actual Node/Electron/image identities and incomplete reports.
Each source retains its own original lockfile; the report records its hash rather than silently
replacing upstream dependencies with candidate dependencies. Native runtime URLs and integrity
manifests remain those of the original owners.
All platforms must report one candidate HEAD and one lockfile digest per source kind; internally
consistent platform shards from different revisions cannot be combined as one comparison.

Tests are compared after merging every shard, so adding tests cannot move a baseline assertion
out of the compared shard. A baseline pass becoming a failure/skip, a removed baseline assertion,
or a new failure is a regression. Existing baseline failures, baseline skips, candidate failures,
and candidate skips are separate inventories. New platform/explicit-model skips remain visible
and are not called executed coverage. Equal failing statuses do not prove identical causes.
`no-new-regressions` is a comparison result, not a claim that all upstream tests passed.
Installation, collection, timeout, missing-artifact and runtime failures block comparison rather
than being treated as passing baseline failures. Raw logs are opened before each child command;
interrupted stages retain a running marker and fail the complete-inventory gate.

The pinned Vitest JSON reporter does not include global unhandled errors and can report
`success: true` for passing assertions even when the process exits 1. Both source versions now
use the same reviewed, read-only companion reporter to retain the original run-end reason and
unhandled errors in `runtime.json`. Comparison requires that raw sidecar and the unmodified raw
`vitest.json`, checks the projected inventory against those bytes, and rejects global/collection/
hook errors, dishonest success/counters, missing stages, process signals/errors, nonterminal
stages, and missing/out-of-range shard coverage. Only exit 1 fully represented by ordinary failed
assertions, with no global errors, is available for the original failure classification. Older
artifacts without the required sidecar are unavailable evidence and must be rerun. No raw
original report is rewritten to make it pass.

Five exact branding assertion names have reviewed one-to-one mappings: the product display name,
the packaged default icon, and the 16/20/24px frame test for each of the three app ICO files.
These names changed with the requested EarthNano artwork/product replacement. Raw inventories
retain original names; `reviewedTestRenames` lists every applied mapping. Their actual passing
results remain mandatory: missing, failed or skipped corresponding candidate assertions still
fail the gate. No other test-name matching, fuzzy identity or removed-test waiver is used.

The Harness job fetches exact original commit `1cfe254e8d25b15f37048c3730134686abe60335`, checks
its tree `edc756a4d03a2826a248115482084a176e60e751`, checks the retained original license, and runs
original unittest discovery against original and integrated source with the same interpreter.
The report records actual Git commit/tree, source/test byte digest, exact interpreter executable,
architecture, license digest and reviewed upstream pins. Baseline collection must start from the
clean original pinned checkout; candidate collection must use the clean retained vendor path.
Import/discovery `_FailedTest` and class/module setup/teardown holder errors retain their original
raw failure records but make the report unavailable. Matching loader errors, empty discovery,
missing provenance and mismatched environments cannot become comparable assertion failures.
No model packages or API credentials are installed. Its comparison includes the existing
EarthNano execution/method/domain equivalence tests; it is offline algorithm evidence, not a
model-quality assessment.

The original Windows runtime action builds/restores the immutable AppContainer-compatible
runtime recipe. A baseline checkout may reuse that payload only if the complete tracked runtime
recipe is unchanged against the original pin. A recipe difference fails closed until an
independent original runtime build is supplied. No replacement download URL is introduced.

## Native Alpha gate

A reviewer must explicitly dispatch this workflow at the reviewed Alpha ref with `native=true`.
For the first CI bootstrap before the workflow exists on `main`, the same native lane can also be
started by explicitly pushing the reviewed commit to `ci/earthnano-native`. This exact repository
branch is a validation ref, never a release trigger. It skips the duplicate source/Harness matrices;
ordinary pull requests continue to run their complete source comparisons.
The source definition alone does not complete Alpha acceptance. The native matrix must actually
finish on macOS ARM64, macOS Intel, Linux x64, and Windows x64 for that same source version:

- Exact lockfile Electron package **and actual executable** identity; a cached 43.4 executable
  cannot satisfy a 43.7.5 lockfile. The probe uses `ELECTRON_RUN_AS_NODE=1` and
  `-p process.versions.electron`, not Node's `--version` output.
- Original full app build, target-native components, pinned micromamba resources and original
  target Prisma engine pruning. No cross-architecture package is presented as a native test.
- `xcrun actool --version` on the original macOS 26 runners; Icon Composer `build/icon.icon`
  packaging and both `Assets.car` and the legacy ICNS fallback. Missing actool is an unavailable
  build prerequisite; the gate never switches to ICNS-only packaging to create a green result.
- Original DMG/ZIP, NSIS and AppImage/DEB resource, actual installed-launch, RPC, database migration,
  reopen, shutdown and profile-preservation assertions. The helpers now derive display names,
  compatibility executable names and exact artifact templates from package/builder metadata.
  macOS validates Info.plist and uses its verified CFBundleExecutable; Windows validates actual
  PE FileDescription/ProductName/ProductVersion. Compatibility appId, data and CLI identities
  remain unchanged. Both OpenScience and EarthNano identities are covered by helper tests.
- Byte-identical declared packaged licenses and streamed SHA-256 package/icon/source manifests.
  Validated unsigned packages are retained as short-lived CI artifacts, not published releases.

Signed/notarized distribution, updater feed availability, ARM Linux/Windows packages, visual
regression screenshots, and paid provider quality are not established by these native x64/Apple
build lanes. Original optional tests report their own skips. Cross-product historical installer
upgrade certification requires matching previous-package identity metadata and is not claimed
by a fresh/current Alpha smoke.

## Commands and retained reports

On an **isolated checkout with its own dependencies** (never a shared node_modules worktree), a
source shard is reproducible with:

```sh
node scripts/ci/earthnano-source.mjs source --kind baseline --shard 1 --total 4 --out /tmp/baseline-1
node scripts/ci/earthnano-source.mjs source --kind candidate --shard 1 --total 4 --out /tmp/candidate-1
```

Use all four shards on Linux/macOS and all eight on Windows. Windows also requires the original
runtime action's verified payload. Git history must contain the original OpenScience commit.
The baseline command creates a detached sibling worktree and performs a real original npm-ci;
it is intentionally not a dry-run or a shared-install shortcut. Source commands remove live-model
toggles and API-key variables from child environments. The workflow supplies a verified Python
interpreter for optional real local Notebook coverage, without enabling paid model tests.

```sh
node scripts/ci/earthnano-source.mjs compare --reports downloaded-source-artifacts --out comparison
node scripts/ci/earthnano-source.mjs pins
node scripts/ci/earthnano-source.mjs electron
node scripts/ci/earthnano-source.mjs manifest --out test-results/native-evidence
python scripts/ci/earthnano-harness.py /path/to/exact/original/checkout /tmp/harness-report.json --kind baseline
python scripts/ci/earthnano-harness.py vendor/harness2 /tmp/harness-candidate.json --kind candidate
```

Artifacts retain full Vitest JSON assertion inventories, per-stage logs/source manifests,
`comparison.json` and `comparison.md`, original/integrated Harness reports, native migration
certification, and package/source/license/icon hashes. Missing or interrupted reports are fatal;
`validation-unavailable.json` records an unavailable CLI prerequisite when possible. The native
job must succeed in addition to its evidence upload; an always-uploaded manifest is not a launch
success claim.

The checkout/setup-node/upload/download Action SHAs match retained original workflow pins.
New Python setup is pinned to the official
[setup-python v6.0.0 commit](https://github.com/actions/setup-python/commit/e797f83bcb11b83ae66e0230d6156d7c80228e7c),
with the interpreter version declared explicitly.

## Local preparation evidence (not a hosted CI run)

On this development host, the new script/smoke unit tests passed, and exact original Harness tree
archive discovery passed **5 original / 55 integrated tests**, zero failures/skips, using the same
Python 3.12.13. The actual shared Electron executable reports **43.7.5** through the exact probe;
this lane did not install or mutate shared dependencies. Local Command Line Tools do not provide
actool. No macOS/Linux/Windows hosted native packaging result, signing result, or full source
comparison is claimed by these preparation checks. Those remain required external execution.

Current matched local inventory after the reply-persistence and diagnostic fixes: exact Git-pinned original Harness **5 passed**, integrated source at `5812df666` **63 passed**, no failures or skips, with the same Python3.12.13 executable, source/tree provenance and license digest checked by the new runner. Raw reports and comparison are under `validation/alpha/`. These replace the earlier5/55 preparation count for the current source; they do not replace hosted source/native package checks.
