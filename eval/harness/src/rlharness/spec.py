"""Experiment specifications (YAML) and case selection."""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# Capabilities the pipeline has today. A spec that `requires` anything else is refused, so an
# ablation cannot silently run without the thing it is supposed to measure.
AVAILABLE_FEATURES: frozenset[str] = frozenset()


class SpecError(ValueError):
    pass


@dataclass(frozen=True)
class Arm:
    """One configuration under test: a strategy preset plus config overrides."""

    id: str
    strategy: str
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Experiment:
    name: str
    description: str
    manifest: Path
    arms: tuple[Arm, ...]
    runs: int
    k: tuple[int, ...]
    line_tolerance: int
    sample: int | None
    seed: int
    repos: tuple[str, ...]
    exclude_invalid: bool
    requires: tuple[str, ...]
    baseline: str
    source: Path

    def unavailable(self) -> list[str]:
        return [r for r in self.requires if r not in AVAILABLE_FEATURES]

    def identity(self) -> dict[str, Any]:
        """Everything that defines the experiment's results, for hashing."""
        return {
            "name": self.name,
            "arms": [{"id": a.id, "strategy": a.strategy, "config": a.config} for a in self.arms],
            "runs": self.runs,
            "k": list(self.k),
            "line_tolerance": self.line_tolerance,
            "sample": self.sample,
            "seed": self.seed,
            "repos": list(self.repos),
            "exclude_invalid": self.exclude_invalid,
        }

    def spec_hash(self) -> str:
        canonical = json.dumps(self.identity(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def load(path: Path) -> Experiment:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SpecError(f"{path}: expected a mapping")
    base: dict[str, Any] = raw.get("base") or {}
    arms: list[Arm] = []
    for entry in raw.get("arms") or []:
        if "id" not in entry or "strategy" not in entry:
            raise SpecError(f"{path}: every arm needs an id and a strategy")
        # Arm settings override the experiment-wide base settings.
        arms.append(
            Arm(str(entry["id"]), str(entry["strategy"]), {**base, **(entry.get("config") or {})})
        )
    if not arms:
        raise SpecError(f"{path}: no arms")
    ids = [a.id for a in arms]
    if len(set(ids)) != len(ids):
        raise SpecError(f"{path}: duplicate arm ids")
    cases: dict[str, Any] = raw.get("cases") or {}
    matching: dict[str, Any] = raw.get("matching") or {}
    baseline = str(raw.get("baseline") or ids[0])
    if baseline not in ids:
        raise SpecError(f"{path}: baseline {baseline} is not an arm")
    runs = int(raw.get("runs", 1))
    if runs < 1:
        raise SpecError(f"{path}: runs must be at least 1")
    return Experiment(
        name=str(raw["name"]),
        description=str(raw.get("description", "")),
        manifest=(path.parent / str(raw["manifest"])).resolve(),
        arms=tuple(arms),
        runs=runs,
        k=tuple(sorted(int(k) for k in raw.get("k", [1, 3, 5, 10]))),
        line_tolerance=int(matching.get("line_tolerance", 3)),
        sample=None if cases.get("sample") is None else int(cases["sample"]),
        seed=int(cases.get("seed", 1)),
        repos=tuple(cases.get("repos") or ()),
        exclude_invalid=bool(cases.get("exclude_invalid", True)),
        requires=tuple(raw.get("requires") or ()),
        baseline=baseline,
        source=path,
    )


@dataclass(frozen=True)
class ReviewInput:
    """One change to review. Several benchmark cases (bugs) can share an input."""

    key: str
    repo: str
    base_sha: str
    head_sha: str
    title: str

    @property
    def file_key(self) -> str:
        return hashlib.sha1(self.key.encode()).hexdigest()[:16]


def select_cases(
    cases: list[dict[str, Any]],
    experiment: Experiment,
    invalid_case_ids: frozenset[str] = frozenset(),
) -> tuple[list[ReviewInput], list[dict[str, Any]]]:
    """Choose the inputs to review and the cases they are scored against.

    Sampling is over distinct inputs, seeded, round-robin across repositories so that a
    large repository cannot dominate. Every case of a chosen input is kept.
    """
    pool = [
        c
        for c in cases
        if (not experiment.repos or c["repo"] in experiment.repos)
        and not (experiment.exclude_invalid and c["id"] in invalid_case_ids)
    ]
    by_input: dict[str, list[dict[str, Any]]] = {}
    for case in sorted(pool, key=lambda c: c["id"]):
        by_input.setdefault(case["input_key"], []).append(case)

    keys = sorted(by_input)
    if experiment.sample is not None and experiment.sample < len(keys):
        rng = random.Random(experiment.seed)
        by_repo: dict[str, list[str]] = {}
        for key in keys:
            by_repo.setdefault(by_input[key][0]["repo"], []).append(key)
        for group in by_repo.values():
            rng.shuffle(group)
        repos = sorted(by_repo)
        rng.shuffle(repos)
        picked: list[str] = []
        while len(picked) < experiment.sample:
            for repo in repos:
                if by_repo[repo] and len(picked) < experiment.sample:
                    picked.append(by_repo[repo].pop())
        keys = sorted(picked)

    inputs = [
        ReviewInput(
            key=key,
            repo=by_input[key][0]["repo"],
            base_sha=by_input[key][0]["base_sha"],
            head_sha=by_input[key][0]["head_sha"],
            title=by_input[key][0]["introduced"]["subject"],
        )
        for key in keys
    ]
    chosen = [case for key in keys for case in by_input[key]]
    return inputs, chosen
