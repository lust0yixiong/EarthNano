"""Binary artifacts retain original identity and bytes through anonymous method asset hooks."""
import copy
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from harness2.core.earthnano_binding import PlatformResultReader, binary_alias, candidate_files
from harness2.core.execution_contract import ExecutionStopped
from harness2.core.method_execution import Invocation
from harness2.earthnano import run
from test_earthnano_binding import Peer, config
from test_earthnano_resume import ResumePeer

PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0bIDATx\x9cc\xf8\x0f\x04\x00\x09\xfb\x03\xfd\xfb^k+\x00\x00\x00\x00IEND\xaeB`\x82"


def descriptor(raw, path="figure.png", version="v1"):
    checksum = hashlib.sha256(raw).hexdigest()
    return {"path": path, "representation": "binary", "sizeBytes": len(raw),
            "contentType": "image/png", "digest": "sha256:" + checksum,
            "artifactRef": {"artifactId": "original-" + version, "versionId": version,
                            "checksum": checksum}}


class BinaryPeer(Peer):
    def __init__(self, root):
        super().__init__()
        self.root = root
        self.materializations = []

    def exchange(self, operation, **args):
        if operation == "materializeArtifact":
            self.materializations.append(copy.deepcopy(args))
            result = self.results[args["executionId"]]
            entry = next(entry for entry in result["files"]
                         if entry.get("representation") == "binary"
                         and entry["artifactRef"] == args["artifactRef"])
            return {"file": copy.deepcopy(entry), "assetPath": str(self.root / entry["artifactRef"]["versionId"])}
        result = super().exchange(operation, **args)
        if operation == "submit":
            record = self.records[result["executionId"]]
            if record["request"]["role"] in ("baseline", "candidate"):
                for index in (1, 2):
                    version = result["executionId"] + "-" + str(index)
                    raw = PNG + bytes([index])
                    entry = descriptor(raw, f"plot-{index}/figure.png", version)
                    (self.root / version).write_bytes(raw)
                    self.results[result["executionId"]]["files"].append(entry)
                    self.results[result["executionId"]]["artifacts"].append(entry["artifactRef"])
                    record["evidence"]["artifacts"].append(entry["artifactRef"])
        return result


class BinaryBindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        for parent, directories, files in os.walk(self.root):
            os.chmod(parent, 0o700)
        self.temporary.cleanup()

    def fixture(self):
        entry = descriptor(PNG)
        source = self.root / "owner.png"
        source.write_bytes(PNG)
        record = {"executionId": "original", "evidence": {"artifacts": [entry["artifactRef"]]}}
        result = {"executionId": "original", "artifacts": record["evidence"]["artifacts"],
                  "replyText": "original reply", "trajectoryText": "original trajectory", "files": [entry]}
        class Owner:
            def __init__(self): self.calls = []
            def exchange(owner, operation, **arguments):
                owner.calls.append((operation, arguments))
                if operation == "readResult": return copy.deepcopy(result)
                if operation == "materializeArtifact":
                    self.assertEqual(arguments, {"executionId": "original", "artifactRef": entry["artifactRef"]})
                    return {"file": copy.deepcopy(entry), "assetPath": str(source)}
                raise AssertionError(operation)
        invocation = Invocation(task_id="task", scope="scope", role="candidate", label="candidate",
                                stage_label="candidate", mission="scientific task")
        return entry, source, record, result, Owner(), invocation

    def test_bytes_metadata_alias_and_registered_context_manifest(self):
        entry, source, record, result, owner, invocation = self.fixture()
        reader = PlatformResultReader(owner, self.root / "results")
        folder = reader.rollout(record, invocation)
        self.assertEqual((folder / "figure.png").read_bytes(), PNG)
        self.assertEqual(reader.view(folder), result)
        self.assertNotIn("content", reader.view(folder)["files"][0])
        self.assertTrue(reader.intact(folder))
        paths = reader.asset_paths(folder)
        self.assertEqual([path.name for path in paths], [binary_alias(entry)])
        self.assertNotIn("candidate", paths[0].name)
        context = self.root / "context"
        (context / "candidates" / "A").mkdir(parents=True)
        shutil.copy2(paths[0], context / "candidates" / "A" / paths[0].name)
        (context / "candidates" / "A.md").write_text("Metadata, not binary content.")
        text, assets = reader.context_snapshot(context)
        self.assertEqual(text, [{"path": "candidates/A.md", "content": "Metadata, not binary content."}])
        self.assertEqual(assets, [{"path": "candidates/A/" + paths[0].name,
                                  "sourceExecutionId": "original", "artifact": entry}])
        self.assertEqual((folder / "figure.png").stat().st_mode & 0o222, 0)
        self.assertEqual(json.loads((reader.metadata / folder.name / "projection.json").read_text())["files"], [entry])
        # Only the locally registered, checked manifest may bypass the original UTF-8 reader.
        (context / "unregistered.png").write_bytes(PNG)
        with self.assertRaises(UnicodeError):
            reader.context_snapshot(context)
        (context / "unregistered.png").unlink()
        (context / "linked.txt").symlink_to(source)
        with self.assertRaises(ValueError):
            reader.context_snapshot(context)

    def test_resume_keeps_runmark_and_refuses_changed_bytes_or_descriptor(self):
        entry, source, record, result, owner, invocation = self.fixture()
        folder = PlatformResultReader(owner, self.root / "results").rollout(record, invocation)
        resumed = PlatformResultReader(owner, self.root / "results", resume=True)
        self.assertEqual(resumed.rollout(record, invocation), folder)
        self.assertEqual(sum(operation == "materializeArtifact" for operation, _ in owner.calls), 1)
        target = folder / "figure.png"
        target.chmod(0o600)
        target.write_bytes(PNG[:-1] + b"\x00")
        self.assertFalse(resumed.intact(folder))
        with self.assertRaises(ExecutionStopped):
            PlatformResultReader(owner, self.root / "results", resume=True).rollout(record, invocation)
        target.write_bytes(PNG)
        result["files"][0] = descriptor(PNG, version="changed-reference")
        result["artifacts"] = [result["files"][0]["artifactRef"]]
        record["evidence"]["artifacts"] = result["artifacts"]
        with self.assertRaises(ExecutionStopped):
            PlatformResultReader(owner, self.root / "results", resume=True).rollout(record, invocation)

    def test_binary_partial_resume_reuses_original_admissions_in_both_modes(self):
        for mode, stop_after in ((mode, stop) for mode in ("sequential", "parallel") for stop in (4, 12, 14)):
            with self.subTest(mode=mode, stop_after=stop_after):
                root = self.root / (mode + str(stop_after))
                root.mkdir()
                cfg = dict(config(root), method={"mode": mode, "k": 2, "concurrency": 2})
                peer = ResumePeer(BinaryPeer(root), stop_after=stop_after)
                with self.assertRaises(ExecutionStopped): run(cfg, peer)
                original_ids = set(peer.owner.records)
                original_materializations = list(peer.owner.materializations)
                peer.resuming = True
                result = run(dict(cfg, resume=True), peer)
                self.assertEqual(result["status"], "ok")
                self.assertEqual(len(peer.owner.requests), 15)
                self.assertTrue(original_ids <= peer.reused)
                for original in original_materializations:
                    self.assertEqual(peer.owner.materializations.count(original), 1)
                admitted = len(peer.owner.requests)
                again = run(dict(cfg, resume=True), peer)
                self.assertEqual(again["summary"]["status"], "skipped")
                self.assertEqual(again["chosenArtifacts"], result["chosenArtifacts"])
                self.assertEqual(len(peer.owner.requests), admitted)

    def test_unknown_binary_bad_descriptor_symlink_and_copy_checksum_fail_closed(self):
        entry, source, record, result, owner, invocation = self.fixture()
        reader = PlatformResultReader(owner, self.root / "results")
        unknown = self.root / "unknown"
        unknown.mkdir()
        (unknown / "unregistered.png").write_bytes(PNG)
        with self.assertRaises(UnicodeError): reader.context_snapshot(unknown)
        for changed in (dict(entry, content="metadata"), dict(entry, sizeBytes=-1),
                        dict(entry, sizeBytes=2**53), dict(entry, sizeBytes=True),
                        dict(entry, digest="sha256:" + "0" * 64), dict(entry, assetPath=str(source))):
            with self.assertRaises(ValueError): candidate_files([changed])
        source.write_bytes(PNG[:-1] + b"\x00")
        with self.assertRaises(ExecutionStopped): reader.rollout(record, invocation)
        source.write_bytes(PNG)
        real = self.root / "real.png"
        source.rename(real)
        source.symlink_to(real)
        with self.assertRaises(ExecutionStopped): reader.rollout(record, invocation)

    def test_original_selector_and_proposer_receive_assets_without_basename_collisions(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                root = self.root / mode
                root.mkdir()
                peer = BinaryPeer(root)
                cfg = config(root)
                cfg["method"] = {"mode": mode, "k": 2, "concurrency": 1}
                result = run(cfg, peer)
                self.assertEqual(result["status"], "ok")
                self.assertTrue(peer.materializations)
                selector = next(data for data in peer.invocations.values()
                                if data["invocation"]["role"] == "selector")
                assets = selector["assets"]
                self.assertEqual(len(assets), 4)
                for asset in assets:
                    self.assertRegex(Path(asset["path"]).name, r"^asset-[a-f0-9]{64}\.png$")
                    self.assertNotIn("candidate", Path(asset["path"]).name)
                    self.assertEqual(asset["artifact"]["representation"], "binary")
                    self.assertIn(asset["artifact"], peer.results[asset["sourceExecutionId"]]["files"])
                    copied = [path for path in Path(cfg["workRoot"]).rglob(asset["path"])
                              if "selection" in path.parts]
                    self.assertEqual(len(copied), 1)
                    self.assertEqual(copied[0].read_bytes(),
                                     (root / asset["artifact"]["artifactRef"]["versionId"]).read_bytes())
                self.assertEqual(len({asset["path"] for asset in assets}), 4)
                self.assertTrue(any(data.get("assets") for data in peer.invocations.values()
                                    if data["invocation"]["role"] == "proposer"))
                self.assertTrue(any("metadata-only" in item["content"] for item in selector["contextFiles"]))
                self.assertFalse(any(item["path"].endswith(".png") for item in selector["contextFiles"]))
                shown = json.dumps(selector["contextFiles"])
                self.assertNotIn(str(root), shown)
                self.assertNotIn('"sourceExecutionId"', shown)
                self.assertNotIn('"artifactId"', shown)


if __name__ == "__main__": unittest.main()
