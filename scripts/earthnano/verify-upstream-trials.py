"""Execute unchanged upstream examples; retain outputs separately from reference files.

This checks fixed calculations and the original deterministic Harness demo, not desktop
tool integration, model quality or full scientific correctness. No network or credentials.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    sources = ROOT / "resources/trials"
    for directory in ("openscience-case16", "harness2-ledger"):
        manifest = json.loads((sources / directory / "SOURCE.json").read_text())
        for entry in manifest["files"]:
            path = sources / directory / entry["path"]
            assert path.stat().st_size == entry["bytes"], path
            assert sha(path) == entry["sha256"], path

    case = sources / "openscience-case16"
    run = subprocess.run(
        [sys.executable, str(case / "analysis.py"), str(case / "registry_source.json"),
         "--out", str(output / "case16")],
        capture_output=True, text=True, check=True, timeout=30,
    )
    (output / "case16-stdout.txt").write_text(run.stdout)
    records = []
    for name in ("trial_calculations.csv", "availability_summary.csv"):
        actual, expected = output / "case16" / name, case / name
        assert actual.read_bytes() == expected.read_bytes(), name
        records.append({"name": name, "bytes": actual.stat().st_size,
                        "sha256": sha(actual), "referenceByteEqual": True})
    with (output / "case16/trial_calculations.csv").open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 93
    assert sum(row["included"] == "True" for row in rows) == 80
    with (output / "case16/availability_summary.csv").open(encoding="utf-8-sig", newline="") as f:
        overall = [r for r in csv.DictReader(f) if r["stratum"] == "Overall"]
    assert len(overall) == 3
    assert all(r["total_trials"] == "80" and r["results_yes"] == "33"
               and r["percent_with_results_all"] == "41.25" for r in overall)

    env = {**os.environ, "PYTHONPATH": str(ROOT / "vendor/harness2")}
    demo = output / "harness2-demo-k2"
    result = subprocess.run(
        [sys.executable, "-m", "harness2.cli.demo", "--output", str(demo), "--k", "2"],
        env=env, cwd=ROOT, capture_output=True, text=True, check=True, timeout=120,
    )
    (output / "harness2-stdout.txt").write_text(result.stdout)
    summary = json.loads((demo / "demo.json").read_text())
    assert summary["done"] == 2 and summary["failed"] == 0, summary
    # Instantiate the original adapter in a separate directory and compare its actual input bytes.
    sys.path.insert(0, str(ROOT / "vendor/harness2"))
    from harness2.demo import DemoAdapter
    adapter = DemoAdapter(output / "source-ledgers")
    for task in adapter.tasks():
        assert (sources / "harness2-ledger" / f"{task}.csv").read_bytes() == (
            adapter.task_files(task) / "ledger.csv").read_bytes()
    answers = [p.read_text().strip() for p in (demo / "executions").rglob("answer.txt")]
    assert "Total: 105.25" in answers and "Total: 35.50" in answers  # original defect
    assert "Total: 85.15" in answers and "Total: 20.25" in answers  # corrected signed sums
    report = {"schemaVersion": 1, "python": sys.version, "case16": {
        "candidates": 93, "included": 80, "excluded": 13,
        "registeredResults": "33/80", "percent": "41.25", "outputs": records},
        "harness2": {"summary": summary, "originalInputBytesEqual": True,
                     "observedAnswers": sorted(set(answers))},
        "scope": "Unchanged upstream fixed calculations and deterministic recursion only; desktop and live-model acceptance are separate."}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.output.resolve()), indent=2))
