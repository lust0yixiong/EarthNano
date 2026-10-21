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
architecture, Node major selection, exact Python 3.12.10 from `.github/earthnano-python-version`,
worker limits, timeouts and flags. The
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

## Windows cold build and independent platform work

The first Alpha bootstrap's Windows runtime job `39438006915` exhausted its 90-minute job
budget. The retained log `/tmp/earthnano-alpha-runtime-timeout.log` shows Node compilation
consumed approximately 85 minutes; PowerShell's crossgen2 was then cancelled with the job.
This establishes a cold-build deadline bottleneck, not a demonstrated compiler error or a
successful runtime build.

Only the Alpha `windows_runtime` cold-build job now has a 150-minute budget. Its original
action, source recipe, cache key, pins, verification and runtime artifact remain unchanged.
Source and native test jobs retain their 90-minute deadlines. A longer deadline alone is not
build-success evidence; Windows still must complete its original verification before consumers.

The root workflow partitions the original source inventory into `source_unix` (16 Linux/macOS
shards) and `source_windows` (16 Windows shards). Both invoke the single reusable
`.github/workflows/earthnano-source.yml` recipe. Unix source shards depend only on the plan;
Windows source shards also require the runtime. The four original native targets are similarly
partitioned into three Unix targets and one Windows target, invoking the same
`.github/workflows/earthnano-native.yml` recipe. Unix native targets can start independently;
the Windows target still requires the verified runtime. There are no duplicated test recipes
or alternate source/native commands.

The stable comparison job depends on both source matrices and runs after failure/skip as well
as success for ordinary source CI. It explicitly requires both matrix statuses to be `success`
before downloading reports; missing, skipped, failed or cancelled matrix results cannot become
a green partial comparison. The unchanged comparator then requires every one of the original
32 shard reports, exact source/environment identities, raw inventories and runtime sidecars.
The intentionally native-only `ci/earthnano-native` validation ref continues to skip source and
Harness comparison. PR base matching also accepts `feat/alpha-*` for stacked Alpha PRs; push
triggers, explicit native opt-in, read-only permissions and no-publication policy are unchanged.

Focused local topology tests execute the actual plan and status guard, verify all 32 unique
shards/four native targets, check dependency isolation, and compare shared step inventories
against the parsed recipes at `d4b20667d` (normalizing the matrix-to-input variable context and
the single common Python input change documented below).
This covers original commands, immutable action pins, conditions, environments and artifact
names; it does not constitute a hosted source or native build result. Local YAML/guard tests
do not replace GitHub's workflow validation or an actual Windows cold build.

## Common hosted Python version

Hosted run `39454904669`, job `118739140883`, failed in setup-python before source tests:
3.12.13 was unavailable for macOS 15.7.9 arm64. The original raw log remains
`/tmp/earthnano-usage-pr14-mac-failed.log` (SHA-256
`70ff6e10235ef9819e7007221092e65f2afc77e4a7aedf21cdd37e389573a0ff`). This is an unavailable
CI interpreter, not an original/candidate assertion failure.

The reviewed official [Python versions manifest](https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json)
snapshot has SHA-256 `3bffef7a0fddc945a17a5bb7b924462746844f4a39f7fdd57a318add7df13b21`.
Its latest 3.12 release with all four required asset families is 3.12.10: Darwin arm64/x64,
Linux 24.04 x64 and Windows x64. The 3.12.11–3.12.13 entries provide no Darwin/Windows assets.
The compact projection in `validation/alpha/ci-python-availability-projection.json` records
the release/asset URLs, snapshot identity and projection time; the complete raw manifest remains
outside Git. `validation/alpha/ci-python-macos-unavailable-job.json` and
`validation/alpha/ci-python-macos-unavailable.log.gz` preserve the original job metadata and
compressed log. These three artifacts are centrally archived with the integration evidence.
Manifest availability does not certify installation or a successful hosted rerun.

All three Alpha workflows now use the same plain `.github/earthnano-python-version` file via
`python-version-file`; none supplies a competing literal/range. The unchanged pinned
[setup-python action interface](https://github.com/actions/setup-python/blob/e797f83bcb11b83ae66e0230d6156d7c80228e7c/action.yml)
accepts that input, and its [file parser](https://github.com/actions/setup-python/blob/e797f83bcb11b83ae66e0230d6156d7c80228e7c/src/utils.ts#L343-L352)
routes this filename to the plain-text parser. Both source kinds and both Harness checkouts
still receive the same resolved interpreter. Full shared recipe hashes change only for this
explicit setup input; a reverse check restoring that one input still matches the old complete
recipe hashes. Action pins, resource recipes, timeout budgets, original gates and report
comparison rules are unchanged. Earlier local and paid 3.12.13 observations below and in historical
validation records retain their actual version and are not relabeled 3.12.10 evidence.

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

## Native producer fingerprint correction

PR14 run39454904669's Linux candidate shard1 job118739141566 failed in npm postinstall, before typecheck/tests. Two previously updated Action SHAs in the inherited `.github/workflows/native-components.yml` changed `sourceFingerprint`: the complete producer workflow is a signed-release input even when native C++ sources are unchanged. The current catalog remains byte-identical to the fixed upstream, so accepting the new hash would falsely describe the existing release.

Restoring that file byte-for-byte from OpenScience9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5 restores `24cd5bc90f7f2c68bc0c4df4a17f91854801073feb5f5fe197260d4a21d0bdf0`, matching every target in the original catalog. The actual change is exactly the two Action pins. Original native source/spec, node-gyp lock input, catalog, fingerprint function, digest and signature checks are unchanged. The inherited producer workflow remains `disabled_manually`; EarthNano CI is the active workflow.

A new guard validates the actual checked-in release catalog against the complete actual source fingerprint, in addition to the original fixture cases. Combined native-component/CI gates pass61 tests locally. Independent reconstruction, actual failed source report and raw npm log are retained under validation/alpha/ci-native-* and ci-linux-fingerprint-*.

Linux shard2 job118739140680 separately failed with npm ECONNRESET before postinstall. Its log identifies no package or endpoint; no source-code cause is inferred and no network retry rule is changed. The original Linux baseline was still running at the saved observation; no baseline test result is claimed. New CI must still demonstrate installation and all original source/native checks on the corrected head.

## 完整 sweep 轮的实际环境发现与精确 Host Node

PR14 corrected run `39456512139` 的 candidate Ubuntu3/4 job `118745034481` 在 npm-ci 的原 onnxruntime-node1.24.3 install 下载中 ETIMEDOUT/ENETUNREACH，未到测试。其锁定依赖与固定 OpenScience9e18 相同。baseline3/4 job `118745034231` 实际完成：18,953 passed、295 pending/skipped、0 failed。两者分别为 Host Node24.22.0 / 24.21.0、runner image ubuntu24:20261018.339.1 / ubuntu24:20261012.334.1；相同 shard 标签不等于匹配执行环境，也没有候选测试结果可作比较。完整原记录见 validation/alpha/README.md。

本轮将专用 EarthNano CI 的 Host Node 固定到 `.github/earthnano-node-version` 的 `24.22.0`：source/native/comparison/Harness 共同读取，Windows runtime job 在原 composite 前设置同一 Host Node。版本及所用目标的官方发布链接/校验值已核验（[官方发布页](https://nodejs.org/en/blog/release/v24.22.0)），本机直连探针超时，没有把它写成已下载/运行的证据。

`.nvmrc`、lockfile、原 patched Notebook Node24.21.0 sources/URL、原 native producer workflow 字节和 disabled 状态均保留。recipe 对照只明确允许 setup-node 的精确版本输入和前轮 Python 输入，逆变换后仍要求原完整配方哈希相同。Node/image 不匹配仍被 comparator 拒绝；pin 只解决 Host Node 漂移，不能宣称 runner image 已一致、Hosted 全部通过或原生包已验收。新的 Hosted 结果须重新取得并对照，不盲目重跑/删失败原件/跳过 ONNX。

## PR15：账户限制发生在执行前

新 sweep PR15 的 run [39464594843](https://github.com/lust0yixiong/EarthNano/actions/runs/39464594843) 在 runner 分配前被阻止。GitHub annotation 原文为 “The job was not started because recent account payments have failed or your spending limit needs to be increased.” plan 和 Windows runtime 都没有步骤或 runner，因而没有运行依赖安装、版本设置或源码测试。原始 API 返回及 SHA 见 validation/alpha/README.md。需要仓库所属账户在 Billing & plans 恢复付款或可用支出额度后，才能执行托管验证；保留当前严格原版对照和 draft 状态。

## 2026-10-21 原生分项结果

固定干净源码 `4df93008e499941738d91dd75dc653fb033316b0` 的 [原生 run39550528030](https://github.com/lust0yixiong/EarthNano/actions/runs/39550528030) 已取得 Linux x64 分项结果：[job119058437315](https://github.com/lust0yixiong/EarthNano/actions/runs/39550528030/job/119058437315) 成功执行原完整构建、打包、DEB 生命周期及安装、AppImage 资源和安装后启动检查。产生 `EarthNano-0.1.0-alpha.1-linux-x86_64.AppImage`（344,201,268 字节）与 `EarthNano_0.1.0-alpha.1_amd64.deb`（272,735,696 字节），原摘要与源码身份已留存。这是 CI 的 unsigned 分发资产，未发布为正式 Release，不能移用于后续不同源码提交。

同一 run 的两个 Mac 目标在完整应用构建时遇到约 2GB Node heap OOM，尚未进入打包/图标编译及包启动验收。原固定 OpenScience `build.yml` 对打包构建显式设置 `NODE_OPTIONS=--max-old-space-size=8192`；EarthNano native lane 漏继承该设置，修复仅恢复原预算，原命令、矩阵与检查不降低。修复后的 Mac 实际结果仍需取得，不能把失败自动追认为通过。记录时 Windows runtime 仍运行中，不代表 Windows 包结果。

原发布认证覆盖五种 target（macOS arm64/x64、Linux x64/arm64、Windows x64）和七种 installer key；当前 unsigned CI 只有四个 target，缺 Linux arm64。四目标 launch/resource smoke 不等于原完整签名/安装/聚合发布认证，后者门槛保持不变。

原 job/日志、Linux source/artifact manifest 和数据库迁移认证原始字节见 [分项证据清单](validation/alpha/native-39550528030/manifest.json)。这些结果也不替代完整上游源码比较、候选优化的跨平台可达性或 DeepSeek 科研验收。
