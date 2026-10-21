"""Local JSONL binding to the platform execution owner; never launches a model.

Local freeze/result messages are not additions to the shared ExecutionRequest schema.
All result bytes come from a committed ArtifactVersion projection, never a runtime cwd.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import select
import stat
import threading
import time
import uuid
import unicodedata
from pathlib import Path, PurePosixPath
from typing import TextIO

from .execution_contract import ExecutionStopped, validate_request
from .method_execution import Invocation
from . import runmark
from .proposer import Reply

MAX_MESSAGE_BYTES = 32 * 1024 * 1024
MAX_EVIDENCE_BYTES = MAX_MESSAGE_BYTES // 2
MAX_FILES = 512


def digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Expected a portable relative file path")
    parts = value.split("/")
    if any(not part or part in (".", "..") or re.search(r"[\x00-\x1f\x7f:]", part)
           or part.endswith((".", " ")) for part in parts) or PurePosixPath(value).is_absolute():
        raise ValueError("Unsafe relative file path")
    return value


def text_files(value: object, *, with_digest: bool = False) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_FILES:
        raise ValueError("Expected a bounded text file list")
    result = []
    seen: set[str] = set()
    total = 0
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("Expected a text file")
        path = safe_path(entry.get("path"))
        content = entry.get("content")
        if not isinstance(content, str):
            raise ValueError("Expected UTF-8 text")
        total += len(content.encode("utf-8"))
        if total > MAX_EVIDENCE_BYTES:
            raise ValueError("Text files exceed binding limit")
        key = unicodedata.normalize("NFC", path).casefold()
        if any(key == old or key.startswith(old + "/") or old.startswith(key + "/")
               for old in seen):
            raise ValueError("Duplicate or overlapping file paths")
        seen.add(key)
        if with_digest and entry.get("digest") != digest(content):
            raise ValueError("Artifact file checksum mismatch")
        result.append(dict(entry, path=path, content=content))
    return result


def binary_file(entry: object) -> dict:
    if not isinstance(entry, dict):
        raise ValueError("Expected a binary descriptor")
    required = {"path", "representation", "sizeBytes", "digest", "artifactRef"}
    if (required - set(entry) or set(entry) - required - {"contentType"}
            or entry.get("representation") != "binary"
            or type(entry.get("sizeBytes")) is not int or not 0 <= entry["sizeBytes"] <= 2**53 - 1):
        raise ValueError("Invalid binary descriptor fields")
    safe_path(entry["path"])
    ref = entry["artifactRef"]
    if (not isinstance(ref, dict) or set(ref) != {"artifactId", "versionId", "checksum"}
            or any(not isinstance(ref[key], str) or not ref[key] for key in ref)
            or not re.fullmatch(r"[a-f0-9]{64}", ref["checksum"])
            or entry["digest"] != "sha256:" + ref["checksum"]
            or ("contentType" in entry and (not isinstance(entry["contentType"], str)
                                           or not entry["contentType"].strip()))):
        raise ValueError("Invalid binary descriptor identity")
    return dict(entry)


def candidate_files(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_FILES:
        raise ValueError("Expected bounded versioned files")
    # Reuse the original portable path, collision and text-byte budget checks.
    text_files([{"path": entry.get("path"), "content": entry.get("content", "")}
                for entry in value if isinstance(entry, dict)])
    result = []
    for entry in value:
        if isinstance(entry, dict) and entry.get("representation") == "binary":
            result.append(binary_file(entry))
        else:
            if not isinstance(entry, dict) or set(entry) != {"path", "content", "digest", "artifactRef"}:
                raise ValueError("Unknown versioned file fields")
            result.extend(text_files([entry], with_digest=True))
    return result


def binary_alias(entry: dict) -> str:
    # No method label, execution id or logical directory leaks into anonymous file names.
    identity = json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "asset-" + hashlib.sha256(identity.encode("utf-8")).hexdigest() + PurePosixPath(entry["path"]).suffix


def checked_binary(source: Path, entry: dict, target: Path | None = None):
    """Read every byte through one unlinked, stable descriptor; optionally copy exclusively."""
    before = source.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != entry["sizeBytes"]:
        raise ValueError("Invalid binary projection file")
    fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("Binary file changed while opening")
        output = target.open("xb") if target is not None else None
        try:
            checksum, size = hashlib.sha256(), 0
            while chunk := stream.read(65536):
                size += len(chunk)
                if size > entry["sizeBytes"]:
                    raise ValueError("Binary file size changed")
                checksum.update(chunk)
                if output is not None:
                    output.write(chunk)
        finally:
            if output is not None:
                output.close()
        after = source.lstat()
        if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) !=
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                or size != entry["sizeBytes"] or "sha256:" + checksum.hexdigest() != entry["digest"]):
            raise ValueError("Binary projection checksum or identity changed")
    if target is not None:
        target.chmod(0o400)


def read_snapshot(root: Path | None, *, _verified_binary_paths: frozenset[str] = frozenset()) -> list[dict]:
    """Snapshot only ordinary, unlinked text files; paths never become immutable refs."""
    if root is None:
        return []
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Expected an ordinary snapshot directory")
    result = []
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            path = Path(parent) / name
            if path.is_symlink():
                raise ValueError("Linked snapshot directory")
        for name in sorted(files):
            path = Path(parent) / name
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError("Linked or non-regular snapshot file")
            # Only context_snapshot supplies this internal set, after checking registered bytes.
            # It is never accepted from JSONL invocation/model arguments.
            if path.relative_to(root).as_posix() in _verified_binary_paths:
                continue
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise ValueError("Snapshot file changed while opening")
                raw = stream.read(MAX_EVIDENCE_BYTES + 1)
            after = path.lstat()
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns
            ):
                raise ValueError("Snapshot file changed while reading")
            result.append({"path": path.relative_to(root).as_posix(),
                           "content": raw.decode("utf-8", errors="strict")})
    return sorted(text_files(result), key=lambda item: item["path"])


class JsonLineClient:
    """One request/response under a lock; transport uncertainty permanently stops admissions."""

    def __init__(self, reader: TextIO, writer: TextIO, *, timeout_ms: int = 120_000):
        self.reader, self.writer = reader, writer
        self.timeout = timeout_ms / 1000
        self.lock = threading.Lock()
        self.counter = 0
        self.stopped = False

    def exchange(self, operation: str, **arguments):
        with self.lock:
            if self.stopped:
                raise ExecutionStopped("Local transport is stopped")
            self.counter += 1
            request_id = self.counter
            try:
                message = json.dumps({"id": request_id, "operation": operation, **arguments},
                                     ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                if len(message.encode("utf-8")) + 1 > MAX_MESSAGE_BYTES:
                    raise ValueError("Oversized local request")
                self.writer.write(message + "\n")
                self.writer.flush()
                # Production stdio is a real POSIX pipe. StringIO is allowed for deterministic tests.
                try:
                    fileno = self.reader.fileno()
                except (AttributeError, OSError):
                    fileno = None
                if fileno is None:
                    line = self.reader.readline(MAX_MESSAGE_BYTES + 1)
                else:
                    # A readable first byte does not imply a complete JSON line. Bound partial
                    # responses as well, so a truncated peer cannot hold this method forever.
                    deadline = time.monotonic() + self.timeout
                    raw = bytearray()
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not select.select([fileno], [], [], remaining)[0]:
                            raise TimeoutError("Local transport response timeout")
                        chunk = os.read(fileno, min(65536, MAX_MESSAGE_BYTES + 1 - len(raw)))
                        if not chunk:
                            raise ValueError("Local transport closed before a complete response")
                        raw.extend(chunk)
                        if len(raw) > MAX_MESSAGE_BYTES:
                            raise ValueError("Oversized local response")
                        if b"\n" in raw:
                            if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
                                raise ValueError("Unsolicited local response")
                            line = raw.decode("utf-8", errors="strict")
                            break
                if not line or not line.endswith("\n") or len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
                    raise ValueError("Incomplete or oversized local response")
                reply = json.loads(line)
                if not isinstance(reply, dict) or reply.get("id") != request_id:
                    raise ValueError("Local response identity mismatch")
                if set(reply) == {"id", "error"}:
                    raise ExecutionStopped("Platform binding refused the local operation")
                if set(reply) != {"id", "result"}:
                    raise ValueError("Malformed local response")
                return reply["result"]
            except Exception as exc:
                self.stopped = True
                # Never include remote error bodies, credentials, or arbitrary provider logs.
                if isinstance(exc, ExecutionStopped):
                    raise
                raise ExecutionStopped("Local execution transport failed closed") from None


class StdioExecutionPort:
    def __init__(self, client: JsonLineClient):
        self.client = client

    def submit(self, request):
        return self.client.exchange("submit", request=request)

    def get(self, execution_id):
        return self.client.exchange("get", executionId=execution_id)

    def cancel(self, execution_id):
        return self.client.exchange("cancel", executionId=execution_id)

    def events(self, execution_id, after_sequence=0):
        return iter(self.client.exchange("events", executionId=execution_id,
                                         afterSequence=after_sequence))


class PlatformRequestFactory:
    def __init__(self, client: JsonLineClient, *, timeout_ms: int = 100_000, reader=None):
        self.client, self.timeout_ms, self.reader = client, timeout_ms, reader

    def __call__(self, invocation: Invocation):
        context, assets = (self.reader.context_snapshot(invocation.context_dir) if self.reader
                           else (read_snapshot(invocation.context_dir), []))
        return validate_request(self.client.exchange(
            "freezeInvocation",
            invocation={
                "taskId": invocation.task_id, "scope": invocation.scope,
                "role": invocation.role, "label": invocation.label,
                "stageLabel": invocation.stage_label, "mission": invocation.mission,
                "system": invocation.system, "attempt": invocation.attempt,
                "retryOfExecutionId": invocation.retry_of_execution_id,
                "timeoutMs": self.timeout_ms if invocation.timeout is None else invocation.timeout * 1000,
                "harvest": invocation.harvest,
            },
            harnessFiles=read_snapshot(invocation.harness_dir),
            contextFiles=context,
            **({"assets": assets} if assets else {}),
        ))


class PlatformResultReader:
    """Validate the fixed-version projection and build a private, readonly adapter view."""

    def __init__(self, client: JsonLineClient, root: Path, *, resume=False):
        self.client = client
        self.root = Path(root)
        self.root.mkdir(mode=0o700, exist_ok=resume)
        self.resume = resume
        self.metadata = self.root / ".projections"
        self.metadata.mkdir(mode=0o700, exist_ok=resume)
        self.views: dict[Path, dict] = {}
        self.lock = threading.Lock()
        self.assets: dict[str, dict] = {}

    def _read(self, record):
        try:
            result = self.client.exchange("readResult", executionId=record["executionId"])
            required = {"executionId", "artifacts", "replyText", "trajectoryText", "files"}
            if (not isinstance(result, dict) or required - set(result)
                    or set(result) - required - {"reused"}
                    or ("reused" in result and type(result["reused"]) is not bool)):
                raise ValueError("Invalid versioned result projection")
            if (result["executionId"] != record["executionId"]
                    or result["artifacts"] != record["evidence"]["artifacts"]):
                raise ValueError("Result artifact identity mismatch")
            if not all(isinstance(result[key], str) for key in ("replyText", "trajectoryText")):
                raise ValueError("Expected readable versioned text")
            files = candidate_files(result["files"])
            for entry in files:
                if entry["artifactRef"] not in result["artifacts"]:
                    raise ValueError("File refers to an uncommitted artifact")
            result["files"] = files
            return result
        except ExecutionStopped:
            raise
        except Exception:
            raise ExecutionStopped("Invalid immutable result projection") from None

    def _materialize(self, result, invocation, *, harvest=False):
        if self.resume:
            for folder in sorted(self.root.iterdir()):
                marker = runmark.read_mark(self.metadata / folder.name)
                if (not marker or marker.get("execution_id") != result["executionId"]
                        or marker.get("harvest") != harvest):
                    continue
                if not runmark.is_complete(self.metadata / folder.name, harness_dir=invocation.harness_dir):
                    raise ExecutionStopped("Completed rollout harness changed; replay refused")
                original = self.view(folder)
                expected = result if not harvest else dict(result, files=[
                    dict(entry, path=entry["path"][len("context/harness/"):])
                    for entry in result["files"] if entry["path"].startswith("context/harness/")])
                if self._stable(original) != self._stable(expected) or not self.intact(folder):
                    raise ExecutionStopped("Committed result projection changed; replay refused")
                return folder
        folder = self.root / uuid.uuid4().hex
        folder.mkdir(mode=0o700)
        files = result["files"]
        if harvest:
            files = [dict(entry, path=entry["path"][len("context/harness/"):])
                     for entry in files if entry["path"].startswith("context/harness/")]
        for entry in files:
            target = folder / safe_path(entry["path"])
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if entry.get("representation") == "binary":
                if harvest:
                    raise ExecutionStopped("Binary artifacts cannot be harvested as text harnesses")
                materialized = self.client.exchange("materializeArtifact",
                    executionId=result["executionId"], artifactRef=entry["artifactRef"])
                if (not isinstance(materialized, dict) or set(materialized) != {"file", "assetPath"}
                        or materialized["file"] != entry or not isinstance(materialized["assetPath"], str)
                        or not Path(materialized["assetPath"]).is_absolute()):
                    raise ExecutionStopped("Invalid binary materialization identity")
                try:
                    checked_binary(Path(materialized["assetPath"]), entry, target)
                except (OSError, ValueError):
                    raise ExecutionStopped("Invalid immutable binary bytes") from None
            else:
                with target.open("x", encoding="utf-8", newline="") as stream:
                    stream.write(entry["content"])
                target.chmod(0o400)
        projection = dict(result, files=files)
        metadata = self.metadata / folder.name
        metadata.mkdir(mode=0o700)
        (metadata / "projection.json").write_text(
            json.dumps(projection, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        runmark.mark_complete(metadata, run_id=invocation.run_id or invocation.label,
                              harness_dir=invocation.harness_dir,
                              extra={"execution_id": result["executionId"], "harvest": harvest})
        for parent, directories, _ in os.walk(folder, topdown=False):
            for name in directories:
                (Path(parent) / name).chmod(0o500)
        folder.chmod(0o500)
        with self.lock:
            self.views[folder] = dict(result, files=files)
        return folder

    def rollout(self, record, invocation):
        return self._materialize(self._read(record), invocation)

    def reply(self, record, invocation):
        result = self._read(record)
        harvested = any(entry["path"].startswith("context/harness/") for entry in result["files"])
        workspace = self._materialize(result, invocation, harvest=True) if harvested else None
        return Reply(label=invocation.label, text=result["replyText"], ok=True, workspace=workspace,
                     execution_id=record["executionId"], cached=result.get("reused", False))

    @staticmethod
    def _stable(result):
        return {key: value for key, value in result.items() if key != "reused"}

    def view(self, path):
        folder = Path(path)
        with self.lock:
            if folder in self.views:
                return self.views[folder]
        if not self.resume or folder.is_symlink() or self.root.resolve() not in folder.resolve().parents:
            raise ExecutionStopped("Unowned method result path")
        metadata = self.metadata / folder.name
        marker = runmark.read_mark(metadata)
        if not marker or marker.get("version") != runmark.VERSION:
            raise ExecutionStopped("Original completed rollout marker is unavailable")
        result = self._read({
            "executionId": marker.get("execution_id"),
            "evidence": {"artifacts": json.loads(
                (metadata / "projection.json").read_text(encoding="utf-8"))["artifacts"]},
        })
        projection = json.loads((metadata / "projection.json").read_text(encoding="utf-8"))
        if marker.get("harvest"):
            result = dict(result, files=[dict(entry, path=entry["path"][len("context/harness/"):])
                for entry in result["files"] if entry["path"].startswith("context/harness/")])
        if self._stable(projection) != self._stable(result):
            raise ExecutionStopped("Original immutable result projection changed")
        with self.lock:
            self.views[folder] = result
        if not self.intact(folder):
            raise ExecutionStopped("Original completed rollout bytes changed")
        return result

    def asset_paths(self, path):
        result = self.view(path)
        assets = []
        for entry in result["files"]:
            if entry.get("representation") != "binary":
                continue
            with self.lock:
                folder = self.metadata / Path(path).name / "assets"
                folder.mkdir(mode=0o700, exist_ok=True)
                alias = binary_alias(entry)
                target = folder / alias
                source = Path(path) / entry["path"]
                try:
                    checked_binary(source, entry)
                    if target.exists():
                        checked_binary(target, entry)
                    else:
                        checked_binary(source, entry, target)
                except (OSError, ValueError):
                    raise ExecutionStopped("Anonymous binary asset changed") from None
                registered = {"sourceExecutionId": result["executionId"], "artifact": entry}
                if alias in self.assets and self.assets[alias] != registered:
                    raise ExecutionStopped("Ambiguous binary asset ownership")
                self.assets[alias] = registered
            assets.append(target)
        return assets

    def context_snapshot(self, root):
        if root is None:
            return [], []
        root = Path(root)
        if not root.is_dir() or root.is_symlink():
            raise ValueError("Expected ordinary context directory")
        text, assets = [], []
        for parent, directories, files in os.walk(root, followlinks=False):
            if any((Path(parent) / name).is_symlink() for name in directories):
                raise ValueError("Linked context directory")
            for name in sorted(files):
                source = Path(parent) / name
                with self.lock:
                    registered = self.assets.get(name)
                if registered is None:
                    # Preserve the original strict text snapshot behavior, including unknown binary rejection.
                    continue
                checked_binary(source, registered["artifact"])
                assets.append(dict(registered, path=source.relative_to(root).as_posix()))
        if not assets:
            return read_snapshot(root), []
        binary_paths = frozenset(asset["path"] for asset in assets)
        text = read_snapshot(root, _verified_binary_paths=binary_paths)
        text_files([{"path": asset["path"], "content": ""} for asset in assets] + text)
        return text, sorted(assets, key=lambda item: item["path"])

    def intact(self, path):
        try:
            for entry in self.view(path)["files"]:
                target = Path(path) / entry["path"]
                info = target.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    return False
                if entry.get("representation") == "binary":
                    checked_binary(target, entry)
                elif digest(target.read_text(encoding="utf-8")) != entry["digest"]:
                    return False
            return True
        except (OSError, KeyError, UnicodeError, ValueError):
            return False
