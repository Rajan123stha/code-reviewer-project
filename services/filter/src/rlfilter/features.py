"""Turn the pipeline's candidate features into the numeric vector the models use.

The feature values themselves are computed in TypeScript (`packages/review-core/src/features.ts`)
and stored with every candidate. This module only encodes them, the same way at training time
and at scoring time. `FEATURES_VERSION` must equal the pipeline's.
"""

from __future__ import annotations

import math
from typing import Any

FEATURES_VERSION = "features/v1"

CATEGORIES = (
    "bug",
    "security",
    "performance",
    "error-handling",
    "concurrency",
    "api-misuse",
    "maintainability",
    "testing",
)
SEVERITY_LEVEL = {"low": 0.0, "medium": 1.0, "high": 2.0, "critical": 3.0}
# Extensions with their own column; everything else is `ext_other`.
EXTENSIONS = ("ts", "tsx", "js", "jsx")
STRATEGIES = ("S0", "S1", "S2", "S3", "S4", "S5")

# `verifierAgreement` and `repoCategoryAcceptRate` are part of features/v1 but always null
# until the verifier and the feedback loop exist, so they have no column yet. Giving them
# one is a new model, not a new features version.
COLUMNS: tuple[str, ...] = (
    "confidence",
    "severity",
    "claim_chars_log",
    "evidence_lines",
    "has_fix",
    "evidence_in_added_lines",
    "is_test",
    "line_is_added",
    "file_changed_lines_log",
    "pr_changed_lines_log",
    "pr_files_log",
    "symbol_callers_log",
    "symbol_callers_known",
    "duplicate_cluster_size",
    "candidates_in_review",
    *(f"category_{c}" for c in CATEGORIES),
    *(f"ext_{e}" for e in EXTENSIONS),
    "ext_other",
    *(f"strategy_{s}" for s in STRATEGIES),
)


class FeatureError(ValueError):
    """The features are missing a field or hold a value this version does not define."""


def _number(features: dict[str, Any], key: str) -> float:
    value = features.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise FeatureError(f"{key} must be a finite number, got {value!r}")
    return float(value)


def _flag(features: dict[str, Any], key: str) -> float:
    value = features.get(key)
    if not isinstance(value, bool):
        raise FeatureError(f"{key} must be true or false, got {value!r}")
    return 1.0 if value else 0.0


def _choice(features: dict[str, Any], key: str, allowed: tuple[str, ...]) -> str:
    value = features.get(key)
    if value not in allowed:
        raise FeatureError(f"{key} must be one of {', '.join(allowed)}; got {value!r}")
    return str(value)


def vectorize(features: dict[str, Any]) -> list[float]:
    """One row, in `COLUMNS` order. Counts are log-scaled; categories are one-hot."""
    category = _choice(features, "category", CATEGORIES)
    severity = _choice(features, "severity", tuple(SEVERITY_LEVEL))
    strategy = _choice(features, "strategy", STRATEGIES)
    ext = features.get("fileExt")
    if not isinstance(ext, str):
        raise FeatureError(f"fileExt must be a string, got {ext!r}")
    callers = features.get("symbolCallers")
    if callers is not None:
        callers = _number(features, "symbolCallers")

    row = [
        _number(features, "confidence"),
        SEVERITY_LEVEL[severity],
        math.log1p(_number(features, "claimChars")),
        _number(features, "evidenceLines"),
        _flag(features, "hasFix"),
        _flag(features, "evidenceInAddedLines"),
        _flag(features, "isTest"),
        _flag(features, "lineIsAdded"),
        math.log1p(_number(features, "fileChangedLines")),
        math.log1p(_number(features, "prChangedLines")),
        math.log1p(_number(features, "prFiles")),
        0.0 if callers is None else math.log1p(callers),
        0.0 if callers is None else 1.0,
        _number(features, "duplicateClusterSize"),
        _number(features, "candidatesInReview"),
        *(1.0 if category == c else 0.0 for c in CATEGORIES),
        *(1.0 if ext == e else 0.0 for e in EXTENSIONS),
        0.0 if ext in EXTENSIONS else 1.0,
        *(1.0 if strategy == s else 0.0 for s in STRATEGIES),
    ]
    assert len(row) == len(COLUMNS)
    return row
