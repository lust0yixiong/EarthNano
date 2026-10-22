Reconcile the two signed transaction ledgers from the original Harness² deterministic demo.

Use the enabled Python Notebook runtime to read the attached ledger-1.csv and ledger-2.csv at their actual managed paths. Use csv and decimal.Decimal from the Python standard library. Sum EVERY signed amount, retaining credits as well as debits. Do not discard negative values, change the input files, install packages, use Shell, access the network, or delegate.

Save ledger-results.json with this structure: {"ledger-1": {"count": <integer>, "total": "<two decimal places>"}, "ledger-2": {"count": <integer>, "total": "<two decimal places>"}}. Publish that exact file with write_artifact_file and its actual Notebook producerRunId. Explain the calculations and the positive-only filter defect in the upstream demo's initial harness.

This is the ordinary execution of the same task that can subsequently be submitted explicitly to EarthNano's Optimize task entry. Do not start optimization automatically or claim that choosing this example already ran the Harness² recursion. Baselines and candidates must use the same task and both frozen ledger inputs through the existing shared execution core. A correct baseline is a valid outcome; do not invent an improvement.
