# Private candidate Session admission authority

EarthNano's candidate owner originally constructed a second SessionRepository and
SessionPersistenceCoordinator over the application's files. The application repository's original
runtime callbacks only consulted the ordinary ACP coordinator. A renderer hydration between the
candidate's original `admitTaskTurn` and `RuntimeSessionOwner.begin` could therefore normalize its
active run as an interrupted app restart and persist that normalization. The unchanged original
begin assertion then rejected it with `Runtime Session turn is unknown or superseded.` before
provider dispatch.

This ordering is reproduced deterministically with the original file-backed repositories,
coordinators and runtime Session owner. The two controls were also executed against OpenScience
`9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5`: an application-visible live runtime preserves the
admitted run; an application-invisible runtime permits original restart recovery and the original
begin assertion rejects the cleared run. The upstream runtime assertion, prompt admission workflow
and application runtime callback wiring are unchanged. This establishes a fusion ownership defect;
the deleted historical failure journals do not establish the exact writer ordering of every prior
native failure.

The host supplies `PersistentCandidateOwnersOptions.sessionPersistence` with its existing
`repository: SessionRepository` and `coordinator: SessionPersistenceCoordinator`. The candidate uses
those original save, admission and runtime mutation APIs and their common serialization authority.
Standalone factories retain the original construction path.

After original ACP Session creation and before publishing the durable Session, the candidate
registers the exact project/Session scope through the repository's main-only
`registerRuntimeSessionLiveness`. Its probe reads the actual private ACP coordinator's
`hasLiveSession` on every query. The original global callbacks remain effective. The original
recovery decoder, runtime resume checks and graph repair guard use that same liveness query.
Confirmed original ACP plus Notebook shutdown revokes the registration. Detachment immediately
returns false even before explicit revocation; a cold process has no registration. This volatile
probe supplies no admission, completion or physical resource-release evidence. Unconfirmed cleanup
continues to be fenced by the same ExecutionCore.

`private-session-admission.integration.test.ts` retains the two original authority controls and
covers shared authority, exact scope, revocation, detachment, cold-process recovery and independent
registration disposal. The real native ACP scenario `shared-session-hydration` in
`persistent-candidate-owner.integration.test.ts` forces application hydration after original Task
admission and before original runtime begin, then verifies completion, one original admission,
provider evidence, durable original artifacts and one liveness revocation after confirmed shutdown.
It uses the existing local SSE fixture and the original bundled runtime, with no paid provider.

Local validation: 292 tests passed across the original repository, runtime owner, resume recovery,
Session state authority, terminal commit scheduler and operation scheduler suites, plus both
candidate integration suites (eight files, including all fourteen native owner scenarios). Native
node typecheck, scoped ESLint and diff whitespace validation passed. The two controls against the
pinned upstream passed separately; EarthNano-only test cases were deliberately filtered there.
These are scoped regression results, not a substitute for the final desktop resume acceptance or
all-platform CI.

Reproduce the scoped regression from a prepared dependency installation:

```sh
node node_modules/vitest/vitest.mjs run \
  src/main/session-persistence/repository.test.ts \
  src/main/session-persistence/runtime-resume-recovery.test.ts \
  src/main/session-persistence/runtime-session-owner.test.ts \
  src/main/session-persistence/session-state-authority.test.ts \
  src/main/session-persistence/terminal-commit-scheduler.test.ts \
  src/main/session-persistence/operation-scheduler.test.ts \
  src/main/earthnano/private-session-admission.integration.test.ts \
  src/main/earthnano/persistent-candidate-owner.integration.test.ts --maxWorkers=1
node node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.node.json --composite false
```
