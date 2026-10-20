"""EarthNano wire validation; no model, subprocess, transport, or benchmark dependency."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Iterator, Protocol

from .execution_types import (
    CancellationReceipt, ExecutionEvent, ExecutionHandle, ExecutionRecord, ExecutionRequest,
)

SCHEMA = json.loads(Path(__file__).with_name("execution_schema.json").read_text())


class ExecutionStopped(RuntimeError):
    """Control stop: callers must propagate this before ordinary method fallback."""


class ExecutionPort(Protocol):
    def submit(self, request: ExecutionRequest) -> ExecutionHandle: ...
    def get(self, execution_id: str) -> ExecutionRecord: ...
    def cancel(self, execution_id: str) -> CancellationReceipt: ...
    def events(self, execution_id: str, after_sequence: int = 0) -> Iterator[ExecutionEvent]: ...


def _check(item, rule):
    if "$ref" in rule:
        return _check(item, SCHEMA["definitions"][rule["$ref"].rsplit("/", 1)[1]])
    kind = rule["type"]
    if kind == "object":
        if not isinstance(item, dict):
            raise ValueError("Expected object")
        if set(rule["required"]) - item.keys() or item.keys() - rule["properties"].keys():
            raise ValueError("Missing or unknown fields")
        for key, child in item.items():
            _check(child, rule["properties"][key])
    elif kind == "string":
        if not isinstance(item, str) or len(item) < rule.get("minLength", 0):
            raise ValueError("Expected string")
        item.encode("utf-8")  # Reject lone surrogates, as the TypeScript authority does.
        if "pattern" in rule and not re.fullmatch(rule["pattern"], item):
            raise ValueError("Invalid string format")
    elif kind == "integer":
        if type(item) is not int or not rule.get("minimum", -9007199254740991) <= item <= rule.get("maximum", 9007199254740991):
            raise ValueError("Expected bounded integer")
    elif kind == "boolean":
        if type(item) is not bool:
            raise ValueError("Expected boolean")
    elif kind == "array":
        if not isinstance(item, list):
            raise ValueError("Expected array")
        for child in item:
            _check(child, rule["items"])
    else:
        raise ValueError(f"Unsupported schema type: {kind}")
    if "const" in rule and item != rule["const"]:
        raise ValueError("Invalid constant")
    if "enum" in rule and item not in rule["enum"]:
        raise ValueError("Invalid enum")


def validate_request(value: object) -> ExecutionRequest:
    _check(value, SCHEMA)
    origin = value["origin"]
    if origin["kind"] == "optimization" and not (origin.get("optimizationId") and origin.get("stageId")):
        raise ValueError("Optimization requires optimizationId and stageId")
    if origin["kind"] == "optimization" and value["timeoutMs"] == 0:
        raise ValueError("Optimization requires a bounded deadline")
    return value


def validate_record(value: object) -> ExecutionRecord:
    """Validate every returned field against the same schema, before any method decision."""
    _check(value, SCHEMA["definitions"]["ExecutionRecord"])
    validate_request(value["request"])
    return value


def validate_handle(value: object) -> ExecutionHandle:
    _check(value, SCHEMA["definitions"]["ExecutionHandle"])
    return value


def request_digest(request: ExecutionRequest) -> str:
    validate_request(request)
    raw = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
