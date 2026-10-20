"""Run the original unittest discovery without model dependencies; preserve every test outcome."""
import argparse
import hashlib
import json
import platform
import subprocess
import os
from pathlib import Path
import sys
import unittest

HARNESS_PIN = "1cfe254e8d25b15f37048c3730134686abe60335"
HARNESS_TREE = "edc756a4d03a2826a248115482084a176e60e751"


def source_identity(root, kind):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

    repo = Path(git("rev-parse", "--show-toplevel")).resolve()
    commit, tree = git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}")
    scope = root.relative_to(repo).as_posix()
    if kind == "baseline":
        if root != repo or commit != HARNESS_PIN or tree != HARNESS_TREE:
            raise RuntimeError("Wrong original Harness source pin/tree")
    elif kind == "candidate":
        pins = json.loads((repo / "UPSTREAMS.json").read_text())["upstreams"]
        pin = next(entry for entry in pins if entry["name"] == "Harness²")
        if pin["commit"] != HARNESS_PIN or pin["tree"] != HARNESS_TREE or scope != "vendor/harness2":
            raise RuntimeError("Wrong candidate Harness provenance")
    else:
        raise RuntimeError("Unknown Harness source kind")
    if git("status", "--porcelain", "--untracked-files=all", "--", ":(top)" + scope):
        raise RuntimeError("Harness source changed after checkout")
    files = []
    for directory in ("harness2", "tests"):
        for path in sorted((root / directory).rglob("*.py")):
            if path.is_symlink():
                raise RuntimeError("Harness source must be regular")
            files.append([path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()])
    return {"kind": kind, "commit": commit, "tree": tree, "scope": scope,
            "digest": hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest(),
            "licenseDigest": hashlib.sha256((root / "LICENSE").read_bytes()).hexdigest()}


def run_inventory(root, output, source):
    if not ((3, 12) <= sys.version_info[:2] < (3, 14)):
        raise RuntimeError("Harness requires the pinned upstream supported Python >=3.12,<3.14")
    os.chdir(root)
    sys.path.insert(0, str(root))
    tests, collection_errors = [], []
    sys.dont_write_bytecode = True

    class Result(unittest.TextTestResult):
        def addSuccess(self, test):
            tests.append({"id": test.id(), "status": "passed"})
            super().addSuccess(test)

        def addFailure(self, test, error):
            tests.append({"id": test.id(), "status": "failed", "failureMessages": [self._exc_info_to_string(error, test)]})
            super().addFailure(test, error)

        def addError(self, test, error):
            if (type(test).__module__, type(test).__name__) in {
                    ("unittest.loader", "_FailedTest"), ("unittest.suite", "_ErrorHolder")}:
                collection_errors.append(test.id())
            tests.append({"id": test.id(), "status": "failed", "failureMessages": [self._exc_info_to_string(error, test)]})
            super().addError(test, error)

        def addSkip(self, test, reason):
            tests.append({"id": test.id(), "status": "skipped", "reason": reason})
            super().addSkip(test, reason)

        def addExpectedFailure(self, test, error):
            tests.append({"id": test.id(), "status": "skipped", "reason": "expected-failure"})
            super().addExpectedFailure(test, error)

        def addUnexpectedSuccess(self, test):
            tests.append({"id": test.id(), "status": "failed", "reason": "unexpected-success"})
            super().addUnexpectedSuccess(test)

    result = unittest.TextTestRunner(verbosity=2, resultclass=Result).run(unittest.defaultTestLoader.discover("tests"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"schemaVersion": 1, "pins": {"harness": HARNESS_PIN, "tree": HARNESS_TREE}, "source": source, "python": sys.version, "executable": sys.executable, "arch": platform.machine(), "platform": sys.platform, "collectionErrors": collection_errors, "testsRun": result.testsRun, "tests": tests}, indent=2) + "\n")
    # Failed tests are compared rather than hidden by shell continuation; malformed discovery
    # and missing outcomes remain fatal to the comparison gate.
    if collection_errors or result.testsRun != len(tests) or not tests:
        raise RuntimeError("Incomplete original unittest inventory")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--kind", choices=("baseline", "candidate"), required=True)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    source = source_identity(root, args.kind)
    run_inventory(root, output, source)
    try:
        if source_identity(root, args.kind) != source:
            raise RuntimeError("Harness source changed during discovery")
    except Exception:
        report = json.loads(output.read_text())
        report["unavailable"] = "source-changed"
        output.write_text(json.dumps(report, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
