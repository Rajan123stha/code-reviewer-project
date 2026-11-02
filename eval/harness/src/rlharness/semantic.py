"""Semantic matching: did a posted comment describe the bug, not just land near it?

Location matching (matching.py) counts a comment within a few lines of the fixed lines as a
hit, whatever it says. Here each posted comment in a ground-truth file (within the first
max-k) is paired with its case, an LLM judge that sees the later fix decides whether the
comment describes that bug, and recall is recomputed counting only `same_bug` verdicts.

Files, under an experiment's results directory:

- `matches/items.jsonl`   one pair per distinct (case, comment); what the judge and labelers see
- `matches/judge.jsonl`   judge verdicts (written by `reviewlens match`)
- `matches/human.jsonl`   human verdicts from the labeling pages (the last per id wins)

Pairs are keyed by content (case, file, line, claim), so arms that share a cached model
response share their judgments, and judging is resumable.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

from rlbench import git

from . import stats
from .comments import latest, read_jsonl, write_jsonl
from .matching import normalize_path
from .metrics import ArmResults

VERDICTS = ("same_bug", "different_issue", "unclear")
DIFF_CONTEXT_LINES = 3


def matches_dir(results: Path) -> Path:
    return results / "matches"


def pair_id(case_id: str, comment: dict[str, Any]) -> str:
    key = f"{case_id}|{normalize_path(str(comment['file']))}|{comment['line']}|{comment['claim']}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def _truth(case: dict[str, Any]) -> dict[str, list[int]]:
    return {normalize_path(r["path"]): list(r["lines"]) for r in case["ground_truth"]}


def pairs(
    loaded: dict[str, ArmResults], cases: list[dict[str, Any]], k_max: int
) -> list[dict[str, Any]]:
    """Every (case, posted comment in one of its ground-truth files) within the first k_max."""
    by_input: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        by_input.setdefault(case["input_key"], []).append(case)
    out: list[dict[str, Any]] = []
    for arm_id, arm in sorted(loaded.items()):
        for run_index, by_key in sorted(arm.runs.items()):
            for key, run in sorted(by_key.items()):
                for case in by_input.get(key, []):
                    truth = _truth(case)
                    for rank, comment in enumerate(run.get("selected", [])[:k_max], start=1):
                        if normalize_path(str(comment["file"])) not in truth:
                            continue
                        out.append(
                            {
                                "id": pair_id(case["id"], comment),
                                "case_id": case["id"],
                                "arm": arm_id,
                                "run": run_index,
                                "rank": rank,
                                "comment": comment,
                            }
                        )
    return out


def build_items(
    found: list[dict[str, Any]],
    cases: list[dict[str, Any]],
    repo_dir_of: Callable[[str], Path],
) -> list[dict[str, Any]]:
    """One judge item per distinct pair: the comment plus the fix it is compared with."""
    by_id = {c["id"]: c for c in cases}
    diffs: dict[str, str] = {}
    items: dict[str, dict[str, Any]] = {}
    for p in found:
        if p["id"] in items:
            continue
        case = by_id[p["case_id"]]
        if case["id"] not in diffs:
            paths = sorted(r["path"] for r in case["ground_truth"])
            diffs[case["id"]] = git.run(
                repo_dir_of(case["repo"]),
                "show",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--format=",
                f"--unified={DIFF_CONTEXT_LINES}",
                case["fix"]["sha"],
                "--",
                *paths,
            ).strip()
        comment = p["comment"]
        path = normalize_path(str(comment["file"]))
        items[p["id"]] = {
            "id": p["id"],
            "case_id": case["id"],
            "path": path,
            "line": comment["line"],
            "category": comment["category"],
            "claim": comment["claim"],
            "evidence": comment["evidence"],
            "fix_subject": case["fix"]["subject"],
            "fix_diff": diffs[case["id"]],
            "truth_lines": _truth(case).get(path, []),
        }
    return sorted(items.values(), key=lambda i: str(i["id"]))


def write_items(results: Path, items: list[dict[str, Any]]) -> Path:
    path = matches_dir(results) / "items.jsonl"
    write_jsonl(path, items)
    return path


def summary(
    loaded: dict[str, ArmResults],
    cases: list[dict[str, Any]],
    case_ids: list[str],
    ks: tuple[int, ...],
    results: Path,
    seed: int = 0,
) -> dict[str, Any] | None:
    """Semantic recall per arm, with judge coverage and calibration; None without a judge."""
    directory = matches_dir(results)
    judge = latest(read_jsonl(directory / "judge.jsonl"))
    if not judge:
        return None
    human = latest(read_jsonl(directory / "human.jsonl"))
    found = pairs(loaded, cases, max(ks))
    distinct = {p["id"] for p in found}
    judged = distinct & judge.keys()

    # case -> arm -> run -> rank of the first comment judged to describe the bug
    first: dict[str, dict[str, dict[int, int]]] = {}
    for p in found:
        if judge.get(p["id"]) != "same_bug":
            continue
        runs = first.setdefault(p["case_id"], {}).setdefault(p["arm"], {})
        runs[p["run"]] = min(runs.get(p["run"], p["rank"]), p["rank"])

    arms: dict[str, Any] = {}
    for arm_id, arm in loaded.items():
        recall: dict[str, Any] = {}
        for k in ks:
            per_case = []
            for case_id in case_ids:
                run_ranks = first.get(case_id, {}).get(arm_id, {})
                run_ids = [r for r, by_case in arm.outcomes.items() if case_id in by_case]
                hits = [run_ranks.get(r, math.inf) <= k for r in run_ids]
                per_case.append(sum(hits) / len(hits) if hits else float("nan"))
            low, high = stats.bootstrap_ci(per_case, seed=seed)
            recall[str(k)] = {"mean": stats.mean(per_case), "ci95": [low, high]}
        arms[arm_id] = {"recall_at": recall}

    out: dict[str, Any] = {
        "pairs": len(distinct),
        "judged": len(judged),
        # Below 1, unjudged pairs count as misses and recall is a lower bound.
        "coverage": (len(judged) / len(distinct)) if distinct else None,
        "verdicts": {v: sum(1 for i in judged if judge[i] == v) for v in VERDICTS},
        "arms": arms,
    }
    shared = sorted(judged & human.keys())
    if shared:
        pairs_hj = [(human[i], judge[i]) for i in shared]
        binary = [(h == "same_bug", j == "same_bug") for h, j in pairs_hj]
        out["calibration"] = {
            "shared": len(shared),
            "agreement": sum(h == j for h, j in pairs_hj) / len(pairs_hj),
            "kappa": stats.cohen_kappa(pairs_hj),
            "same_bug_agreement": sum(h == j for h, j in binary) / len(binary),
        }
    return out
