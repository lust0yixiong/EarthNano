EarthNano 0.1.1-Alpha adds two upstream cases to the existing trial Project/Session workflow.

## Highlights

- **OpenScience Case16:** original frozen registry input and analysis script, with two CSV outputs checked against the original reference bytes.
- **Harness² signed ledgers:** both original demo inputs, ordinary Notebook execution and explicit baseline/candidate comparison through the same execution core, with independent Review.
- Selecting a case prepares an editable draft and managed attachments. It does not automatically send, execute, approve permissions or start optimization.
- The requested `© 2026 AIPOCH` line is removed from Settings/About. Upstream source and license notices are retained.

## Install and try

Choose your macOS or Linux architecture below and verify the installer against `SHA256SUMS.txt`.
Open your existing trial project (or create one), click **New**, expand **Try upstream examples**,
and choose a case. Enable a Python Notebook runtime and configure your model before sending.
The Harness² example can then use **Optimize task → Repeat this task with Notebook** with the
same prompt and both source inputs.

See the [trial instructions](https://github.com/lust0yixiong/EarthNano/blob/v0.1.1-alpha.1/docs/earthnano/UPSTREAM_TRIALS.md)
for reference outputs, sources and exact scope. Model API calls may incur provider charges.

## Scope

Validation completed for both actual-package examples, the real DeepSeek trial,
all four macOS/Linux native install/launch checks, and the full macOS comparison
against pinned original source (no new regressions; two inherited PDF worker-resource
test failures retained). The full Linux source comparison is still running in
[CI](https://github.com/lust0yixiong/EarthNano/actions/runs/39722806098) and is not claimed passed.

Unsigned/ad-hoc macOS and Linux Alpha preview; no Developer ID notarization or SLSA claim.
Windows remains deferred to 0.2-Alpha. Reproducing a frozen calculation or obtaining a passing
Review does not establish general scientific correctness or broadly better model performance.

This is a separate fixed version. The existing `v0.1.0-alpha.1` and `alpha` releases, tags and
download files remain unchanged. Do not run the old and new apps concurrently against the same data.
