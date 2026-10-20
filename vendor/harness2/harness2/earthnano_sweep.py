"""Private original-scheduler sweep entry. Preview never constructs execution owners."""
from __future__ import annotations

import argparse
import json
import re
import sys

from .core import schedule
from .cli._common import parse_modes

MAX_BYTES = 32 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1


def fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Invalid fixed sweep fields")
    return value


def catalog_id(value):
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value)
            or value.endswith(".") or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", value, re.I)):
        raise ValueError("Invalid fixed catalog identity")
    return value


def normalize_catalog(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError("Expected bounded fixed catalog")
    result, tasks, domains = [], set(), {}
    for item in value:
        fields(item, ("taskId", "domain"))
        task, domain = catalog_id(item["taskId"]), catalog_id(item["domain"])
        if task.lower() in tasks or domain.lower() in domains and domains[domain.lower()] != domain:
            raise ValueError("Ambiguous catalog identity")
        tasks.add(task.lower())
        domains[domain.lower()] = domain
        result.append({"taskId": task, "domain": domain})
    return result


def normalize_options(value):
    fields(value, ("modes", "k", "concurrency", "stream"))
    modes = value["modes"]
    if (not isinstance(modes, list) or not modes or len(set(modes)) != len(modes)
            or any(mode not in ("parallel", "sequential") for mode in modes)):
        raise ValueError("Invalid original mode selection")
    for key, maximum in (("k", 8), ("concurrency", 4)):
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise ValueError("Invalid bounded method control")
    stream = fields(value["stream"], ("seed", "onlyDomains", "onlyTasks", "maxTasks", "workers"))
    seed, cap = stream["seed"], stream["maxTasks"]
    if seed is not None and (type(seed) is not int or abs(seed) > MAX_SAFE_INTEGER):
        raise ValueError("Invalid original seed")
    if cap is not None and (type(cap) is not int or not 1 <= cap <= MAX_SAFE_INTEGER):
        raise ValueError("Invalid per-domain cap")
    if type(stream["workers"]) is not int or not 1 <= stream["workers"] <= 4:
        raise ValueError("Invalid domain worker count")
    for key in ("onlyDomains", "onlyTasks"):
        names = stream[key]
        if not isinstance(names, list) or len(names) > 32:
            raise ValueError("Invalid stream filter")
        for name in names:
            catalog_id(name)
        if len(set(names)) != len(names):
            raise ValueError("Duplicate stream filter")
    tokens = parse_modes(",".join(modes))
    return dict(value, modes=[schedule.MODE_NAMES[token] for token in tokens], stream=dict(stream))


class IdentityCatalog:
    def __init__(self, catalog):
        self.catalog = catalog
        self.domain_map = {entry["taskId"]: entry["domain"] for entry in catalog}

    def tasks(self, split="all"):
        if split != "all":
            raise ValueError("Fixed catalog has no declared partition")
        return list(self.domain_map)

    def domain_of(self, task_id):
        return self.domain_map[task_id]


def planned_domains(catalog, options):
    stream = options["stream"]
    ordered = schedule.task_stream(IdentityCatalog(catalog), split="all", seed=stream["seed"],
                                   only_domains=stream["onlyDomains"], only_tasks=stream["onlyTasks"],
                                   max_tasks=stream["maxTasks"])
    return [{"domain": domain, "taskIds": ids} for domain, ids in ordered.items()]


def preview(value):
    fields(value, ("configVersion", "catalog", "options"))
    if type(value["configVersion"]) is not int or value["configVersion"] != 2:
        raise ValueError("Invalid sweep preview version")
    catalog, options = normalize_catalog(value["catalog"]), normalize_options(value["options"])
    return {"resultVersion": 2, "domains": planned_domains(catalog, options)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true", required=True)
    parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized preview")
        result = preview(json.loads(raw.decode("utf-8", errors="strict")))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception:
        print("Original sweep preview rejected its fixed catalog or controls.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
