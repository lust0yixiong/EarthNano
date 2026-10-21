#!/bin/bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ -n "${QA_ROOT:-}" && -n "${QA_SOURCE_ROOT:-}" ]]
operation=$(cd "$(dirname "$0")" && pwd)
executable=$(node -e 'process.stdout.write(require(process.argv[1]).executable)' "$QA_ROOT/evidence/launch.json")
app_bundle=$(node -e 'process.stdout.write(require(process.argv[1]).app)' "$QA_ROOT/evidence/launch.json")
[[ -x "$executable" ]]
cd "$QA_SOURCE_ROOT"
# The original wrapper's real hosted-runner guards and strict cleanup are unchanged.
# The test process receives no GitHub/model credentials or operator configuration.
set +e
OPEN_SCIENCE_E2E_EXECUTABLE="$executable" \
  bash scripts/ci/run-macos-packaged-e2e.sh \
  env -i PATH="$PATH" HOME="$QA_ROOT/runner-home" TMPDIR="$QA_ROOT/tmp" \
  QA_SOURCE_ROOT="$QA_SOURCE_ROOT" QA_ROOT="$QA_ROOT" QA_APP_BUNDLE="$app_bundle" \
  QA_KEYCHAIN_HOME="$HOME" GITHUB_ACTIONS="$GITHUB_ACTIONS" \
  RUNNER_OS="$RUNNER_OS" RUNNER_TEMP="$RUNNER_TEMP" \
  OPEN_SCIENCE_E2E_ISOLATE_HOME=1 OPEN_SCIENCE_E2E_EXECUTABLE="$executable" \
  EARTHNANO_LIVE_DEEPSEEK=0 EARTHNANO_NOTEBOOK_LANGUAGE=python \
  EARTHNANO_E2E_BINARY=0 EARTHNANO_E2E_RESUME=1 EARTHNANO_E2E_SWEEP=0 \
  node node_modules/@playwright/test/cli.js test \
  --config "$QA_ROOT/packaged.playwright.config.ts" \
  --workers=1 --retries=0 --trace=on 2>&1 | tee "$QA_ROOT/evidence/original-acceptance.log"
pipeline_status=("${PIPESTATUS[@]}")
set -e
status=${pipeline_status[0]}
[[ "${pipeline_status[1]}" == 0 ]] || status=1
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({originalWrapperAndTestExit:Number(process.argv[2]),teeExit:Number(process.argv[3])},null,2)+"\n")' \
  "$QA_ROOT/evidence/process-exit.json" "${pipeline_status[0]}" "${pipeline_status[1]}"
set +e
node "$operation/prepare.mjs" finalize > "$QA_ROOT/evidence/final-verification.log" 2>&1
verification_status=$?
set -e
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({finalVerificationExit:Number(process.argv[2])},null,2)+"\n")' \
  "$QA_ROOT/evidence/final-verification-exit.json" "$verification_status"
cat "$QA_ROOT/evidence/final-verification.log"
if [[ "$verification_status" != 0 && "$status" == 0 ]]; then status=$verification_status; fi
exit "$status"
