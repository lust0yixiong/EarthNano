"""Both languages read the exact same provider-usage schema fixtures; no model calls."""
import json
from pathlib import Path
import unittest

from harness2.core.execution_contract import SCHEMA, _check


class UsageContractTests(unittest.TestCase):
    def test_shared_usage_fixtures(self):
        root = Path(__file__).resolve().parents[3]
        fixtures = json.loads((root / "contracts/execution/usage-fixtures.json").read_text())
        rule = SCHEMA["definitions"]["ExecutionUsage"]
        for usage in fixtures["valid"]:
            with self.subTest(usage=usage):
                _check(usage, rule)
        for usage in fixtures["invalid"]:
            with self.subTest(usage=usage), self.assertRaises(ValueError):
                _check(usage, rule)


if __name__ == "__main__":
    unittest.main()
