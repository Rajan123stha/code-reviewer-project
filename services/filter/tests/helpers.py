"""Synthetic candidates for tests. Not real review data."""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Any

from rlfilter.features import CATEGORIES, FEATURES_VERSION
from rlfilter.split import Split

TRAIN = ("o/a", "o/b", "o/c", "o/d")
TEST = ("o/x", "o/y")
SPLIT = Split(frozenset(TRAIN), frozenset(TEST), seed=1, manifest_hash="test")


def features(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "category": "bug",
        "severity": "high",
        "confidence": 0.8,
        "claimChars": 120,
        "evidenceLines": 1,
        "hasFix": True,
        "evidenceInAddedLines": True,
        "fileExt": "ts",
        "isTest": False,
        "lineIsAdded": True,
        "fileChangedLines": 12,
        "prChangedLines": 40,
        "prFiles": 3,
        "symbolCallers": 2,
        "strategy": "S4",
        "duplicateClusterSize": 1,
        "candidatesInReview": 3,
        "verifierAgreement": None,
        "repoCategoryAcceptRate": None,
    }
    return {**base, **overrides}


def synthetic_rows(n: int, seed: int, repos: tuple[str, ...] = TRAIN) -> list[dict[str, Any]]:
    """Rows whose label depends on confidence, evidence location and test files, plus noise."""
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []
    for i in range(n):
        confidence = rng.random()
        in_added = rng.random() < 0.6
        is_test = rng.random() < 0.3
        signal = 2.5 * confidence + 1.5 * in_added - 1.5 * is_test - 2.2
        label = int(rng.random() < 1 / (1 + pow(2.718281828, -2.5 * signal)))
        repo = repos[i % len(repos)]
        rows.append(
            {
                "id": f"row{i}",
                "repo": repo,
                "input_key": f"{repo}@{i // 3}",
                "review": f"exp/S4/run1/{repo}@{i // 3}",
                "status": "selected",
                "label": label,
                "label_source": "benchmark",
                "features": features(
                    confidence=round(confidence, 3),
                    evidenceInAddedLines=in_added,
                    isTest=is_test,
                    category=rng.choice(CATEGORIES),
                    severity=rng.choice(["low", "medium", "high", "critical"]),
                    symbolCallers=rng.choice([None, 0, 1, 5]),
                    claimChars=rng.randint(40, 300),
                ),
            }
        )
    return rows


def file_key(input_key: str) -> str:
    return hashlib.sha1(input_key.encode()).hexdigest()[:16]


def case(repo: str, sha: str, path: str, lines: list[int]) -> dict[str, Any]:
    return {
        "id": f"{repo}-{sha}",
        "repo": repo,
        "input_key": f"{repo}@{sha}",
        "ground_truth": [{"path": path, "lines": lines}],
    }


def candidate(
    index: int, line: int, status: str = "selected", **feature_overrides: Any
) -> dict[str, Any]:
    return {
        "index": index,
        "file": "src/a.ts",
        "line": line,
        "claim": f"problem at line {line}",
        "status": status,
        "features": None if status == "invalid" else features(**feature_overrides),
    }


def write_run(
    root: Path,
    experiment: str,
    arm: str,
    run_index: int,
    input_key: str,
    candidates: list[dict[str, Any]],
    features_version: str = FEATURES_VERSION,
) -> Path:
    directory = root / experiment / "abc123"
    (directory / "runs" / arm / f"run{run_index}").mkdir(parents=True, exist_ok=True)
    (directory / "spec.json").write_text(json.dumps({"line_tolerance": 3}), encoding="utf-8")
    path = directory / "runs" / arm / f"run{run_index}" / f"{file_key(input_key)}.json"
    path.write_text(
        json.dumps({"featuresVersion": features_version, "candidates": candidates}),
        encoding="utf-8",
    )
    return directory
