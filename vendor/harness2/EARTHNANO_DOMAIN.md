# Explicit experiment-local domain stream

The single-task `harness2.earthnano` entry remains unchanged. Domain experiments opt into a
separate entry using the same private JSONL execution binding:

```sh
python3 -B -m harness2.earthnano_domain --config /absolute/private/domain-config.json
```

Configuration version 1 has exactly these fields, with no credentials or assessment criteria:

```json
{
  "configVersion": 1,
  "domain": "source-reconciliation",
  "tasks": [
    {"taskId": "experiment-0001", "task": {"prompt": "Complete the first task.", "files": []}},
    {"taskId": "experiment-0002", "task": {"prompt": "Complete the second task.", "files": []}}
  ],
  "baseHarnessFiles": [{"path": "instructions.md", "content": "Read and verify the source."}],
  "workRoot": "/absolute/private/new-domain-directory",
  "model": "explicit-platform-model",
  "method": {"mode": "sequential", "k": 1, "concurrency": 2},
  "executionTimeoutMs": 100000,
  "rpcTimeoutMs": 120000
}
```

There are one to four tasks. Task IDs have one shared portable root and consecutive suffixes
`-0001` through `-0004`; this preserves displayed order through the original reference-order
sort. The domain is a portable ASCII name of at most 80 characters. Method options, task text,
file snapshots and the restricted harness use the single-task validators. Each task has its own
source directory and starts with the same base harness. The new workRoot must not exist.

The entry calls original `schedule.task_stream(seed=None)` and one `schedule.run_domain` for
one selected mode, sharing one `PortMethodExecution`. Original recursion, finals selection,
`selection.reflect_adoption`, experience parsing and `library.Library` retention/adoption remain
unchanged. The original per-task Library context may inform later proposals in this experiment.
The Library starts empty, is private to this invocation, domain and mode, and is never published
or loaded into another experiment automatically. These are raw model experiences, not a shared
verified knowledge base. Independent criteria, answers, scores and Review verdicts stay outside
the method and Library. The existing grader-marker checks also guard the exported Library.

Reflection keeps the original `<experience>` and optional `<edits>` reply syntax; the original platform
Session/Artifact owners also persist the same committed review-safe reply as the reserved
`reflection-reply.md` artifact. This projection is created by the owner, not a second model
transcription, and does not overwrite model-written files. Reserved-name collisions are rejected;
pre/post-publication reply bytes must agree, and the existing output size/count limits include
this transport artifact.
`NO_ENTRY` or malformed experience yields no fabricated Library entry. Such a task can remain
method-successful under upstream rules. Cancellation, refused budget, transport/contract loss
or unknown cleanup stops the whole stream before the next task. Ordinary method failures and
retry behavior remain upstream behavior; the platform's completed-output integrity gate still
applies independently.

At k=1 each task has seven original recursion admissions plus one reflection admission. At
k>1 the task has `7*k+2` method admissions including selection and reflection. Two independent
assessments per task occur after the stream under the same platform budget; they are not Python
method admissions. Retries are additional and remain charged.

The final result has `status`, `domain`, ordered task IDs, per-task original results, all execution
records and `library: {files,entries}`. Each task includes exact `executionIds`, the original
summary, chosen immutable artifact refs, configuration-change/fallback/method/selection metadata,
`libraryEntriesBefore` and optional completed-reflection execution/artifact refs. Execution IDs
are associated with local Invocation.task_id through the existing trusted request factory;
identical task bytes sharing opaque snapshot refs cannot mix their records. The wire schema is
unchanged. Per-task summaries use upstream `Namespace` and `summary.port.json`; selected harnesses
use the selected-mode Namespace. Exported Library paths are relative, bounded ordinary UTF-8
snapshots, not host paths or platform artifact references. Platform persistence owns provenance.

Deterministic checks use no provider or network:

```sh
python3 -B -m unittest discover -s tests -p test_earthnano_domain.py -v
python3 -B -m unittest discover -s tests -p 'test_earthnano*.py' -v
python3 -B -m unittest discover -s tests -p test_workflow.py -v
python3 -B -m unittest discover -s tests -p test_execution_seam.py -v
```

The domain checks compare complete evidence trees, Library snapshots and selections against the
original LEGACY mechanism, exercise both modes over real stdio, distinguish task inputs, show
task-two output using task-one experience, and verify task/domain/mode/root isolation, no-entry,
grader-marker rejection, shared stop/budget and the unchanged single-task path.
