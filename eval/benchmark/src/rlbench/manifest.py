"""The case manifest: a versioned JSON file that fully describes the benchmark.

Schema version 1. A manifest holds only metadata (commit ids, paths, line numbers, dates and
commit subjects); source code stays in the upstream repositories under their own licenses.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

_CASE_KEYS = {
    "id",
    "repo",
    "license",
    "base_sha",
    "head_sha",
    "input_key",
    "introduced",
    "fix",
    "ground_truth",
    "stats",
    "provenance",
}


class ManifestError(ValueError):
    pass


def validate(manifest: dict[str, Any]) -> None:
    """Structural checks; raises ManifestError with the first problem found."""
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ManifestError(f"unsupported schema_version: {manifest.get('schema_version')}")
    for key in ("benchmark", "generator", "repos", "cases"):
        if key not in manifest:
            raise ManifestError(f"missing top-level key: {key}")
    seen: set[str] = set()
    for case in manifest["cases"]:
        missing = _CASE_KEYS - case.keys()
        if missing:
            raise ManifestError(f"case {case.get('id')}: missing {sorted(missing)}")
        if case["id"] in seen:
            raise ManifestError(f"duplicate case id: {case['id']}")
        seen.add(case["id"])
        for sha_key in ("base_sha", "head_sha"):
            sha = case[sha_key]
            if not (isinstance(sha, str) and len(sha) == 40):
                raise ManifestError(f"case {case['id']}: bad {sha_key}")
        if not case["ground_truth"]:
            raise ManifestError(f"case {case['id']}: empty ground truth")
        for region in case["ground_truth"]:
            if not region["lines"] or region["lines"] != sorted(set(region["lines"])):
                raise ManifestError(f"case {case['id']}: ground truth lines not sorted/unique")
        if case["stats"]["days_to_fix"] < 0:
            raise ManifestError(f"case {case['id']}: fix is dated before the introducing change")


def content_hash(manifest: dict[str, Any]) -> str:
    """Hash of the cases only, so regenerating identical cases gives the same hash."""
    canonical = json.dumps(manifest["cases"], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def save(manifest: dict[str, Any], path: Path) -> None:
    validate(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def load(path: Path) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    validate(manifest)
    return manifest


def split_by_date(cases: list[dict[str, Any]], cutoff: str) -> dict[str, list[dict[str, Any]]]:
    """Cases whose bug was introduced before or on/after an ISO date (model training cutoff).

    A case introduced after the cutoff cannot have been seen in training; the fix date
    matters too, since a model may have seen the fix, so both are checked.
    """
    pre: list[dict[str, Any]] = []
    post: list[dict[str, Any]] = []
    straddle: list[dict[str, Any]] = []
    for case in cases:
        introduced = case["introduced"]["committed_at"][:10]
        fixed = case["fix"]["committed_at"][:10]
        if fixed < cutoff:
            pre.append(case)
        elif introduced >= cutoff:
            post.append(case)
        else:
            straddle.append(case)
    return {"pre_cutoff": pre, "post_cutoff": post, "straddles_cutoff": straddle}
