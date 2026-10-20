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
from .proposer import Reply

MAX_MESSAGE_BYTES = 32 * 1024 * 1024
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
        if total > MAX_MESSAGE_BYTES // 2:
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


def read_snapshot(root: Path | None) -> list[dict]:
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
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise ValueError("Snapshot file changed while opening")
                raw = stream.read(MAX_MESSAGE_BYTES // 2 + 1)
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
                if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
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
    def __init__(self, client: JsonLineClient, *, timeout_ms: int = 100_000):
        self.client, self.timeout_ms = client, timeout_ms

    def __call__(self, invocation: Invocation):
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
            contextFiles=read_snapshot(invocation.context_dir),
        ))


class PlatformResultReader:
    """Validate the fixed-version projection and build a private, readonly adapter view."""

    def __init__(self, client: JsonLineClient, root: Path):
        self.client = client
        self.root = Path(root)
        self.root.mkdir(mode=0o700)
        self.views: dict[Path, dict] = {}
        self.lock = threading.Lock()

    def _read(self, record):
        try:
            result = self.client.exchange("readResult", executionId=record["executionId"])
            if not isinstance(result, dict) or set(result) != {
                "executionId", "artifacts", "replyText", "trajectoryText", "files"
            }:
                raise ValueError("Invalid versioned result projection")
            if (result["executionId"] != record["executionId"]
                    or result["artifacts"] != record["evidence"]["artifacts"]):
                raise ValueError("Result artifact identity mismatch")
            if not all(isinstance(result[key], str) for key in ("replyText", "trajectoryText")):
                raise ValueError("Expected readable versioned text")
            files = text_files(result["files"], with_digest=True)
            for entry in files:
                if set(entry) != {"path", "content", "digest", "artifactRef"}:
                    raise ValueError("Unknown versioned file fields")
                if entry["artifactRef"] not in result["artifacts"]:
                    raise ValueError("File refers to an uncommitted artifact")
            result["files"] = files
            return result
        except ExecutionStopped:
            raise
        except Exception:
            raise ExecutionStopped("Invalid immutable result projection") from None

    def _materialize(self, result, *, harvest=False):
        folder = self.root / uuid.uuid4().hex
        folder.mkdir(mode=0o700)
        files = result["files"]
        if harvest:
            files = [dict(entry, path=entry["path"][len("context/harness/"):])
                     for entry in files if entry["path"].startswith("context/harness/")]
        for entry in files:
            target = folder / safe_path(entry["path"])
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("x", encoding="utf-8", newline="") as stream:
                stream.write(entry["content"])
            target.chmod(0o400)
        for parent, directories, _ in os.walk(folder, topdown=False):
            for name in directories:
                (Path(parent) / name).chmod(0o500)
        folder.chmod(0o500)
        with self.lock:
            self.views[folder] = dict(result, files=files)
        return folder

    def rollout(self, record, invocation):
        return self._materialize(self._read(record))

    def reply(self, record, invocation):
        result = self._read(record)
        harvested = any(entry["path"].startswith("context/harness/") for entry in result["files"])
        workspace = self._materialize(result, harvest=True) if harvested else None
        return Reply(label=invocation.label, text=result["replyText"], ok=True, workspace=workspace,
                     execution_id=record["executionId"])

    def view(self, path):
        with self.lock:
            return self.views[Path(path)]

    def intact(self, path):
        try:
            for entry in self.view(path)["files"]:
                target = Path(path) / entry["path"]
                info = target.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    return False
                if digest(target.read_text(encoding="utf-8")) != entry["digest"]:
                    return False
            return True
        except (OSError, KeyError, UnicodeError):
            return False
