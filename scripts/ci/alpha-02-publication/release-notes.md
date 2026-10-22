## Highlights

EarthNano 0.2-Alpha carries the published 0.1.1 capabilities forward and repairs the Windows installation path by reusing the upstream installer modules. This preview includes native packages for macOS ARM64/x64, Linux ARM64/x64 and Windows x64.

## Bug fixes

- Reuse the upstream Windows installer transaction, helper, signing-hook and Unicode handling fixes.
- Preserve the original Windows installation, resource/RPC, Notebook environment and database fresh/legacy/reopen smoke checks.
- Correct Windows test fixtures and release metadata verification while retaining the original source comparison rules and exact complete FileVersion check.

## Alpha limitations

Packages are unsigned Alpha previews. Windows optimization remains unsupported; 13 POSIX-only integration tests are explicitly not applicable on Windows and are not counted as passed. Original Mac source comparisons retain inherited failures/skips and establish no new compared Mac regressions, not universal passing tests. A previous intermittent Windows shutdown-observer timeout remains in the historical evidence; later successful runs do not establish a diagnosed fix for that occurrence.

For this publication the user explicitly waived the two remaining Linux full source batches (runs39734082630 and39744881823) and their dependent full Unix comparison. They are not accepted or counted as passed; original runs, reports and product CI rules are retained. Only the eight original Mac reports per run and Harness are required/replayed for source acceptance. The frozen `SOURCE-CI-ACCEPTANCE.json` records both actual run states and this limited exception. All five original native build/install/smoke gates, including both Linux targets, still must pass.

This release does not certify upgrading a previously published Windows installer, Authenticode, paid model task quality or WSL authorization. It adds no new research/optimization features and keeps the existing upstream pins and compatibility identities. This versioned prerelease does not advance or replace the rolling alpha channel or prior releases.

All nine installers, update feeds and blockmaps are checked against the original clean-source native manifests before staging. The five-platform aggregate uses the unchanged certification tools. The Windows platform certificate is derived by the publication runner from the same-source successful original installer smoke and original database certificate; its derivation receipt is included separately.
