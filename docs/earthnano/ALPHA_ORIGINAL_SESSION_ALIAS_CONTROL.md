# Original first-start alias collision control

This opt-in control reproduces the owner/RPC failure without a model, Core, ACP child process,
Notebook kernel, remote host or source-data read. It is a known-defect characterization of the
original source, not a candidate acceptance test and not evidence that a repair passes.

```bash
node scripts/controls/original-session-alias.mjs \
  --output /tmp/earthnano-original-session-alias-control.json \
  > /tmp/earthnano-original-session-alias-control.log 2>&1
```

The script obtains these exact two files from the local Git object database at original OpenScience
pin `9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5`. Missing objects or changed hashes fail closed;
it never fetches or silently substitutes checkout sources. It copies them to a temporary overlay,
links retained checkout dependencies, then loads them through the existing Jiti dependency.
The real `AcpSessionCapabilityOwner` and `NotebookLocalRpcServer` run over a real loopback TCP server.
The Notebook service's `state` method only records/returns the authenticated routing identity.
No private capability map is inspected, no token is printed, and the overlay/server are cleaned up.

| File                                       | Original and frozen failure-head SHA-256                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `src/main/acp/session-capability-owner.ts` | `572c7b412a56e4842c322ef73f375f41dd0f476234c1bb973f0aa310a7f914ca` |
| `src/main/notebook/local-rpc-server.ts`    | `3fa48425983c7bb6eb866646e4fc7b0d940b5b52a31672ca9772f0561283d424` |

Both hashes match failure source `30e5c784b1efc426896bb2af627a5576a0c1bed6` byte for byte.
Other dependencies come from that checkout; this is not a complete original dependency rebuild.
The retained report records the actual checkout HEAD, both source hashes and Node version.

With `Date.now()` fixed, two independent owners each provision their first artifact+Notebook
capabilities. The original per-instance sequences both start at one, creating identical
`artifact-session-<timestamp>-1` and `notebook-session-<timestamp>-1` identities.

1. The first Notebook token successfully calls the real RPC (`200`).
2. The second `issueSessionConnection` rotates that same provisional owner; the first token now
   returns `401 Invalid notebook RPC token.`
3. `first.commit('canonical-first')` adopts the surviving second token through the shared alias.
4. After `second.commit('canonical-second')`, calls authenticated with the second token still reach
   Notebook `state` as `canonical-first`. Agent-supplied body owner fields are deliberately wrong;
   the observed identity comes from original RPC capability admission.
5. Counterfactuals under the unchanged original source pass: one shared owner at the same clock
   value gets increasing sequences and independent routes; two independent owners with explicit
   distinct stable IDs also retain distinct routes.

The native catalog failure has the corresponding symptoms: candidate `43f8e651-8433-41b6-a3d5-453083972f55`
has invalid Notebook RPC credentials; candidate `e67b30ab-455e-4399-a0e4-6303437222ba` receives a
completed Run whose file-evidence storage Session is the first candidate's Session, then its Artifact
publication fails. The frozen Core records have distinct execution/Session identities and invocations,
the correct task-0001 sequential scope, and the same appropriate task/environment snapshots. The
extra repeated slot is the retained stopped proposer and its explicit replacement. No source evidence
points to an original Harness namespace/cache crossover. Actual provisional MCP environments from
that failed native run were not retained, so their exact alias string cannot be recovered from this
control; the deterministic reproduction establishes the source mechanism and matching effects.

Repair acceptance must separately prove independent first-start owner identities across all capability
namespaces/framework paths; canonical RPC route isolation after both commits; old-owner disposal or
rollback cannot retire a sibling; same stable-ID handover/rotation remains safe; and real concurrent
scientific candidates publish fixed-input Run-owned ArtifactVersions. Keep the failed native evidence.
Do not change original schedule/Library/cache matching, waive producer proof, or serialize all candidates.

Archived control output:

- `validation/alpha/original-session-alias-control.json`
- `validation/alpha/original-session-alias-control.log.gz`

The original files intentionally retain the observed original collision. Default execution imports
the pinned original; candidate mode below tests the repair separately. Both are opt-in controls,
require the local Git objects and a POSIX fixture filesystem, and add no default CI gate.

The same control also ran against platform repair
`c9d4c73df509a1935efeb22d6024606a046f057d` using the same frozen checkout dependencies:

```bash
node scripts/controls/original-session-alias.mjs \
  --candidate-ref c9d4c73df509a1935efeb22d6024606a046f057d \
  --output /tmp/earthnano-candidate-session-alias-control.json \
  > /tmp/earthnano-candidate-session-alias-control.log 2>&1
```

With `--candidate-ref`, both subject files are copied from that exact local Git commit instead;
the original pin hashes are still verified separately. The script requires the positive isolation
outcomes rather than treating the known original collision as success for the candidate.

| Observation under the same forced clock                  | Original 9e18                    | Candidate c9d4                                        |
| -------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| Independent owners' first artifact/Notebook aliases      | Identical                        | Distinct                                              |
| First token after second provision                       | 401                              | 200                                                   |
| Second token after first commit                          | Routes to first Session          | Keeps own provisional Session                         |
| Second token after second commit                         | Still routes to first Session    | Routes to second Session                              |
| First owner disposal                                     | Not asserted as a repair outcome | First token revoked, second canonical route still 200 |
| Single shared owner / distinct stable-ID counterfactuals | Correct routes                   | Correct routes                                        |

The candidate owner source SHA-256 is
`e95348dde6f92edd51d40c1006802eba7207cf69c9aa5063e0a173b2deddceaf`;
the original RPC source is unchanged. Archived before/after JSON and gzipped complete process logs
are stored together. These controls verify the capability ownership boundary, not real kernel,
Artifact publication, full upstream dependencies, native desktop acceptance or provider behavior.
