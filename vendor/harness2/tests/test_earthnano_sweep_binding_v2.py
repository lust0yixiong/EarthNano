"""Offline shared-base/multi-mode controls; no production sweep entry is enabled."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from harness2 import earthnano
from harness2.core import schedule
from harness2.core.earthnano_binding import PlatformRequestFactory, PlatformResultReader, StdioExecutionPort
from harness2.core.method_execution import PortMethodExecution
from harness2.core.proposer import Proposer
from harness2.cli._common import parse_modes
from test_earthnano_binding import Peer, config
from test_earthnano_method import FixtureReader, LegacyAdapter, LegacyProposer

ORIGINAL_COMMIT = "1cfe254e8d25b15f37048c3730134686abe60335"
ORIGINAL_SCHEDULE_SHA256 = "6e46c5ab1e4ac111818ff3acd6b636e39d650898189ac0c21802a8233ad4cd38"


def original_schedule():
    path = Path(__file__).parent / "fixtures" / "original_schedule_1cfe254e8d25.py"
    upstreams = json.loads((Path(__file__).resolve().parents[3] / "UPSTREAMS.json").read_text())
    pins = [entry["commit"] for entry in upstreams["upstreams"] if entry["name"] == "Harness²"]
    if pins != [ORIGINAL_COMMIT]:
        raise AssertionError("Control does not match the declared Harness upstream pin")
    if hashlib.sha256(path.read_bytes()).hexdigest() != ORIGINAL_SCHEDULE_SHA256:
        raise AssertionError("Pinned original scheduler fixture changed")
    name = "harness2.core._earthnano_original_schedule_control"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class RecordingLegacyAdapter(LegacyAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.rollouts = []

    def execute(self, task_id, harness_dir, run_id):
        scope, actual_task, label = run_id.split("/")
        assert actual_task == task_id
        self.rollouts.append({"taskId": task_id, "scope": scope,
                              "role": "candidate" if harness_dir else "baseline",
                              "stageLabel": label, "label": label, "attempt": 1})
        return super().execute(task_id, harness_dir, run_id)


def cleanup(root):
    for parent, _, files in os.walk(root):
        os.chmod(parent, 0o700)
        for filename in files:
            os.chmod(Path(parent) / filename, 0o600)


def transcript(seed):
    original = original_schedule()
    modes = parse_modes("sequential,agg,parallel,seq")
    if modes != ("agg", "seq"):
        raise AssertionError("Original CLI canonical modes changed")
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        try:
            port_root, legacy_root = root / "port", root / "original"
            port_root.mkdir()
            legacy_root.mkdir()
            cfg = earthnano.validate_config(config(port_root))
            work = Path(cfg["workRoot"])
            work.mkdir()
            peer = Peer()
            reader = PlatformResultReader(peer, work / "results")
            adapter = earthnano.EarthNanoAdapter(cfg, work, reader)
            execution = PortMethodExecution(StdioExecutionPort(peer), PlatformRequestFactory(peer), reader)
            prop = Proposer(adapter.spec.channels["proposer"], attempts=1)
            with contextlib.redirect_stdout(io.StringIO()):
                result = schedule.run_task(cfg["taskId"], 2, adapter=adapter, prop=prop,
                                           runs_root=adapter.spec.runs_root, modes=modes,
                                           seed=seed, execution=execution)
            old_cfg = earthnano.validate_config(config(legacy_root))
            old_work = Path(old_cfg["workRoot"])
            old_work.mkdir()
            old_adapter = RecordingLegacyAdapter(old_cfg, old_work, FixtureReader())
            old_prop = LegacyProposer(old_adapter.spec.channels["proposer"])
            with contextlib.redirect_stdout(io.StringIO()):
                old_result = original.run_task(old_cfg["taskId"], 2, adapter=old_adapter, prop=old_prop,
                                               runs_root=old_adapter.spec.runs_root,
                                               modes=modes, seed=seed)
            offered = [entry["invocation"] for entry in peer.invocations.values()]
            fields = ("taskId", "scope", "role", "stageLabel", "label", "attempt")
            offered = [{key: entry[key] for key in fields} for entry in offered]
            port_rollouts = [row for row in offered if row["role"] in ("baseline", "candidate")]
            stable = lambda rows: sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
            if stable(port_rollouts) != stable(old_adapter.rollouts):
                raise AssertionError("Original and platform rollout namespaces differ")
            if result.status != "ok" or old_result.status != "ok":
                raise AssertionError("Controlled original method failed")
            projections = {}
            for mode in modes:
                # Keep measured wall time, random private directories and cached usage outside
                # the equivalence claim. Compare the actual decisions and original ledger.
                selected, old_selected = result.selections[mode], old_result.selections[mode]
                keys = ("chosen_label", "trivial", "fallback", "why", "id_map")
                if {key: selected[key] for key in keys} != {key: old_selected[key] for key in keys}:
                    raise AssertionError("Original and platform anonymous decisions differ")
                ledger, old_ledger = result.modes[mode]["ledger"], old_result.modes[mode]["ledger"]
                if (ledger["R"], ledger["P"]) != (old_ledger["R"], old_ledger["P"]):
                    raise AssertionError("Original and platform ledger differ")
                projections[mode] = {"chosenLabel": selected["chosen_label"],
                                     "fallback": selected["fallback"], "R": ledger["R"], "P": ledger["P"]}
            namespace = lambda mode: str(original.Namespace("earthnano", "claude-text", mode, 2, seed))
            return {"originalCommit": ORIGINAL_COMMIT, "originalScheduleSha256": ORIGINAL_SCHEDULE_SHA256,
                    "seed": seed, "k": 2, "modes": list(modes),
                    "baseScope": namespace("agg"), "modeScopes": {mode: namespace(mode) for mode in modes},
                    "roleCounts": dict(Counter(row["role"] for row in offered)),
                    "originalRolloutCount": len(old_adapter.rollouts),
                    "invocations": offered, "selections": projections}
        finally:
            cleanup(root)


class SweepBindingV2OriginalControls(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "Pinned original run_task summary requires POSIX fcntl")
    def test_actual_original_both_modes_share_only_one_set_of_baselines(self):
        for seed in (None, 0, -7):
            with self.subTest(seed=seed):
                result = transcript(seed)
                self.assertEqual(result["roleCounts"], {"baseline": 2, "candidate": 12,
                                                       "proposer": 8, "composer": 4, "selector": 2})
                self.assertEqual(result["originalRolloutCount"], 14)
                bases = [row for row in result["invocations"] if row["role"] == "baseline"]
                self.assertEqual(sorted(row["label"] for row in bases), ["base1", "base2"])
                self.assertTrue(all(row["scope"] == result["baseScope"] for row in bases))
                for mode, chosen in (("agg", "agg2"), ("seq", "c2")):
                    self.assertEqual(result["selections"][mode], {"chosenLabel": chosen, "fallback": False, "R": 8, "P": 6})
                pairs = [(row["role"], row["stageLabel"], row["label"], row["attempt"])
                         for row in result["invocations"]]
                self.assertLess(len(set(pairs)), len(pairs), "Actual modes must exercise v1 slot collisions")

    def test_pinned_original_namespace_rejects_foreign_mode(self):
        with self.assertRaises(ValueError):
            original_schedule().ns("earthnano", "claude-text", "foreign", 2, seed=None)


if __name__ == "__main__":
    if sys.argv[1:] == ["--transcript"]:
        print(json.dumps([transcript(seed) for seed in (None, 0, -7)], sort_keys=True))
    else:
        unittest.main()
