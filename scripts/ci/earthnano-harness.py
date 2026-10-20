"""Run the original unittest discovery without model dependencies; preserve every test outcome."""
import json
import os
from pathlib import Path
import sys
import unittest

HARNESS_PIN = "1cfe254e8d25b15f37048c3730134686abe60335"
HARNESS_TREE = "edc756a4d03a2826a248115482084a176e60e751"


def main():
    root, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    if not ((3, 12) <= sys.version_info[:2] < (3, 14)):
        raise RuntimeError("Harness requires the pinned upstream supported Python >=3.12,<3.14")
    os.chdir(root)
    sys.path.insert(0, str(root))
    tests = []

    class Result(unittest.TextTestResult):
        def addSuccess(self, test):
            tests.append({"id": test.id(), "status": "passed"})
            super().addSuccess(test)

        def addFailure(self, test, error):
            tests.append({"id": test.id(), "status": "failed", "failureMessages": [self._exc_info_to_string(error, test)]})
            super().addFailure(test, error)

        def addError(self, test, error):
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
    output.write_text(json.dumps({"schemaVersion": 1, "python": sys.version, "platform": sys.platform, "testsRun": result.testsRun, "tests": tests}, indent=2) + "\n")
    # Failed tests are compared rather than hidden by shell continuation; malformed discovery
    # and missing outcomes remain fatal to the comparison gate.
    if result.testsRun != len(tests) or not tests:
        raise RuntimeError("Incomplete original unittest inventory")


if __name__ == "__main__":
    main()
