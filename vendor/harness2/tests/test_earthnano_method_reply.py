"""Original textual method contracts with committed reply artifacts, no model dispatch."""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from harness2.core import recursion, selection, tree
from harness2.core.earthnano_binding import PlatformResultReader
from harness2.core.method_execution import Invocation
from harness2.core.proposer import Reply
from harness2.core.spec import RunView
from harness2.demo import DemoAdapter


class MethodReplyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.adapter = DemoAdapter(self.root)

    def tearDown(self):
        for parent, _, _ in os.walk(self.root):
            os.chmod(parent, 0o700)
        self.temporary.cleanup()

    def reply(self, role, text, files=None):
        values = files if files is not None else [(f"{role}-reply.md", text)]
        artifacts, exported = [], []
        for index, (path, content) in enumerate(values):
            checksum = hashlib.sha256(content.encode()).hexdigest()
            ref = {"artifactId": f"reply-{index}", "versionId": "fixed-1", "checksum": checksum}
            artifacts.append(ref)
            exported.append({"path": path, "content": content, "digest": "sha256:" + checksum,
                             "artifactRef": ref})
        result = {"executionId": role, "artifacts": artifacts, "replyText": text,
                  "trajectoryText": "original turn", "files": exported}

        class Peer:
            def exchange(self, operation, **args):
                assert operation == "readResult" and args["executionId"] == role
                return result

        reader = PlatformResultReader(Peer(), self.root / f"results-{role}")
        invocation = Invocation(task_id="ledger-1", scope="original", role=role, label=role,
                                stage_label=role, mission="original", harness_dir=self.adapter.base_harness())
        return reader.reply({"executionId": role, "evidence": {"artifacts": artifacts}}, invocation)

    def test_original_selector_accepts_committed_reply_without_model_file_transcription(self):
        text = "<why>Both candidates deliver; prefer B.</why>\n```choice\nB\n```"
        reply = self.reply("selector", text)
        self.assertIsNone(reply.workspace)
        calls = []

        class ReplyOnly:
            def call(self, mission, context_dir, label, **kwargs):
                calls.append(label)
                return reply

        candidates = {}
        for label in ("agg1", "agg2"):
            path = self.root / label
            path.mkdir()
            (path / "answer.txt").write_text("Total: 12.00\n")
            candidates[label] = RunView(label=label, run_id=label, run_dir=path, ok=True, delivered=True)
        selected = selection.run_selection("ledger-1", 2, "agg", candidates, adapter=self.adapter,
                                            prop=ReplyOnly(), work_dir=self.root / "method", pool_kind="finals")
        self.assertTrue(selected.ok)
        self.assertFalse(selected.fallback)
        self.assertEqual(selected.chosen_id, "B")
        self.assertEqual(len(calls), 1)

    def test_reply_artifact_does_not_become_harvest_and_original_retry_or_fallback_is_preserved(self):
        reply = self.reply("proposer", "The attempted proposal emitted no harness files.")
        self.assertIsNone(reply.workspace)
        surface = self.adapter.substrate.surface()
        fallback = tree.read_tree(surface, self.adapter.base_harness())
        for valid_second in (False, True):
            calls = []
            adapter = self.adapter

            class MissingHarvest:
                def call(self, mission, context_dir, label, **kwargs):
                    calls.append(mission)
                    if valid_second and len(calls) == 2:
                        return Reply(label, "Exact original file harvest", True, workspace=adapter.base_harness())
                    return reply

            stage = recursion._run_stage(label=f"inv{int(valid_second) + 1}", dim="INV", job="improve",
                fallback=fallback, adapter=self.adapter, prop=MissingHarvest(), ctx_dir=self.root / "context",
                task_id="ledger-1", rollouts=[], harness_dir=self.adapter.base_harness(), library_dir=None)
            self.assertEqual(len(calls), 2)
            self.assertIn("YOUR PREVIOUS ATTEMPT WAS REJECTED", calls[1])
            self.assertEqual(stage.fell_back, not valid_second)
            self.assertEqual(stage.tree, fallback)

    def test_file_only_harvest_preserves_empty_narrative_without_filler(self):
        reply = self.reply("composer", "", [("context/harness/instructions.md", "Frozen file-only guidance")])
        self.assertEqual(reply.text, "")
        self.assertIsNotNone(reply.workspace)
        self.assertEqual((reply.workspace / "instructions.md").read_text(), "Frozen file-only guidance")
        self.assertFalse((reply.workspace / "composer-reply.md").exists())

    def test_exact_empty_reply_remains_empty_and_does_not_become_a_harness(self):
        reply = self.reply("proposer", "")
        self.assertEqual(reply.text, "")
        self.assertIsNone(reply.workspace)
