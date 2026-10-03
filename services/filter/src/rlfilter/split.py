"""The fixed repository split between filter training and filter evaluation.

The filter is trained only on comments from `train_repos`. Experiment E5, which measures the
filter, reviews only changes from `test_repos`. Splitting by repository (not by case) keeps a
repository's style, reviewers and recurring bugs entirely on one side.

The split is made once, before any model is trained, and stored next to the benchmark. Nothing
in this package chooses it by looking at results.
"""

from __future__ import annotations

import json
import random
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_SPLIT = REPO_ROOT / "eval" / "benchmark" / "splits" / "filter-split.v1.json"


class SplitError(ValueError):
    pass


@dataclass(frozen=True)
class Split:
    train_repos: frozenset[str]
    test_repos: frozenset[str]
    seed: int
    manifest_hash: str

    def side(self, repo: str) -> str:
        if repo in self.train_repos:
            return "train"
        if repo in self.test_repos:
            return "test"
        raise SplitError(f"{repo} is in neither side of the split")


def make(manifest: dict[str, Any], seed: int, test_share: float) -> dict[str, Any]:
    """Assign whole repositories to train or test with a seeded shuffle."""
    if not 0 < test_share < 1:
        raise SplitError("test_share must be between 0 and 1")
    cases = Counter(str(c["repo"]) for c in manifest["cases"])
    repos = sorted(cases)
    random.Random(seed).shuffle(repos)
    n_test = max(1, round(len(repos) * test_share))
    test, train = sorted(repos[:n_test]), sorted(repos[n_test:])
    if not train:
        raise SplitError("no repositories left for training")
    return {
        "schema_version": 1,
        "purpose": "learned filter: train on train_repos, evaluate (E5) on test_repos",
        "manifest_hash": manifest["cases_hash"],
        "seed": seed,
        "test_share": test_share,
        "train_repos": train,
        "test_repos": test,
        "cases": {
            "train": sum(cases[r] for r in train),
            "test": sum(cases[r] for r in test),
        },
    }


def load(path: Path = DEFAULT_SPLIT) -> Split:
    raw = json.loads(path.read_text(encoding="utf-8"))
    split = Split(
        train_repos=frozenset(raw["train_repos"]),
        test_repos=frozenset(raw["test_repos"]),
        seed=int(raw["seed"]),
        manifest_hash=str(raw["manifest_hash"]),
    )
    check(split)
    return split


def check(split: Split) -> None:
    both = split.train_repos & split.test_repos
    if both:
        raise SplitError(f"repositories on both sides of the split: {sorted(both)}")
    if not split.train_repos or not split.test_repos:
        raise SplitError("a side of the split is empty")


def assert_disjoint(train_repos: frozenset[str] | set[str], eval_repos: set[str]) -> None:
    """Refuse to evaluate a filter on repositories it was trained on."""
    leaked = set(train_repos) & eval_repos
    if leaked:
        raise SplitError(
            "the filter was trained on repositories it is being evaluated on: "
            + ", ".join(sorted(leaked))
        )
