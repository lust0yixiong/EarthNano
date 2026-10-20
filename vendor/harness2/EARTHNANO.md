# EarthNano local execution binding

This opt-in entry point runs the existing `schedule.run_task` and `recursion.run_sequential`
method with one task, `k=1`, no Library and the shared `PortMethodExecution`. It does not
replace the default Harness² CLI or launch a provider directly.

The platform starts it from this directory:

```sh
python3 -B -m harness2.earthnano --config /absolute/private/run-config.json
```

The private configuration contains no credential or endpoint:

```json
{
  "configVersion": 1,
  "taskId": "synthetic-1",
  "task": {"prompt": "Complete the supplied task.", "files": []},
  "baseHarnessFiles": [{"path": "instructions.md", "content": "Read and verify the source."}],
  "workRoot": "/absolute/private/new-method-directory",
  "model": "explicit-platform-model",
  "executionTimeoutMs": 100000,
  "rpcTimeoutMs": 120000
}
```

`workRoot` must not exist. The platform owns that scratch directory's cleanup. The
configuration is a local bootstrap payload, not an immutable reference. The TS factory freezes
the authoritative task/harness/invocation/agent/environment snapshots; offered filesystem paths
are never relabeled as references. The platform must bind the offered task/model to its own
configured run. Python does not load provider credentials.

Stdio is private JSONL. Requests have a positive integer `id`, `operation`, and operation
arguments; responses are exactly `{id,result}` or `{id,error:{code,message}}`. Method diagnostics
go to stderr. A whole exchange is locked across method threads. EOF, malformed/partial replies,
response identity loss, timeout and explicit errors stop without automatic replay. The TS owner
also bounds the process lifetime and cancels admitted executions after process/transport failure.

Operations are `freezeInvocation`, `submit`, `get`, `cancel`, `events`, `readResult`, and `done`.
The freeze operation sends the local invocation descriptor plus UTF-8 `harnessFiles` and
`contextFiles`. The TS factory owns request keys, immutable references, project/budget membership
and retry linkage. No local binding operation adds fields to the shared ExecutionRequest.

`readResult({executionId})` must return:

```text
{executionId, artifacts, replyText, trajectoryText,
 files: [{path,content,digest,artifactRef}]}
```

`artifacts` equals the terminal record's `evidence.artifacts`; each file's `artifactRef` is one of
those exact `{artifactId,versionId,checksum}` references and its digest is SHA-256 of UTF-8 content.
The platform exports only the committed ArtifactVersion, never a current workspace fallback.
Python checks identities, file checksums, duplicate paths and path escapes, and materializes a
private readonly adapter view. Rollout files are deliverables. Proposer/composer files beneath
`context/harness/` become the harvested tree after stripping that prefix. The projection contains
no Review verdicts; final assessment remains with the independent platform Review owner after
selection has committed.

The profile accepts only nonempty `instructions.md` and optional
`skills/<name>/SKILL.md`, with names matching `[a-z0-9][a-z0-9-]*`. Skill frontmatter has exactly
`name` and a plain `description`, matching the native preparation profile. Scripts, hooks,
plugins, subagents, settings, file mentions and dynamic shell are rejected. The new `claude-text`
prompt surface describes this restricted profile; original OpenCode/Codex surfaces are unchanged.
The local file permissions and directory layout are not an OS sandbox.

A successful first attempt has seven common-core admissions: one baseline, two independent
INV/DOM proposers, their two candidate runs, one composer and its final candidate run. The
upstream method ledger remains R=4/P=3. The single final uses the existing trivial selection;
there is no extra LLM selector or reflection at k=1 without a Library. Ordinary proposal failure
and its original retry/fallback behavior remain visible; budget/timeout/unknown cleanup and
invalid immutable results propagate as control stops before fallback. The platform must bound
all admissions, including retries. `configurationChanged` reports a changed chosen text tree;
it does not prove a quality improvement. `fallbackStages` reports any inherited stages.

Deterministic verification uses synthetic in-process owners and a real Python stdio subprocess,
without a model, network, credential or paid request:

```sh
python3 -B -m unittest discover -s tests -p test_earthnano_binding.py -v
python3 -B -m unittest discover -s tests -p test_workflow.py -v
python3 -B -m unittest discover -s tests -p test_execution_seam.py -v
```

These checks cover the canonical seven-admission method, changed harvested configuration,
strict surface, no legacy launcher/judge, budget/timeout stops, tampered artifacts, snapshot links,
transport response loss and partial-line timeout. Real provider behavior, TS persistence owners,
desktop startup and OS sandboxing are outside these Python tests.
