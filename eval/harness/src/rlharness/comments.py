"""Comment-level precision: sample posted comments, label them, judge them, calibrate.

Files, all under an experiment's results directory:

- `comments/items.jsonl`       sampled comments with the diff the judge and labeler see
- `comments/human.jsonl`       human verdicts (appended; the last verdict per item wins)
- `comments/judge.jsonl`       LLM judge verdicts (written by `reviewlens judge`)
"""

from __future__ import annotations

import hashlib
import json
import random
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rlbench import git

from . import stats
from .metrics import ArmResults

VERDICTS = ("valid", "nitpick", "invalid")
DIFF_CONTEXT_LINES = 8


def comments_dir(results: Path) -> Path:
    return results / "comments"


def collect(loaded: dict[str, ArmResults]) -> list[dict[str, Any]]:
    """Every posted comment of an experiment, with where it came from."""
    out: list[dict[str, Any]] = []
    for arm_id, arm in sorted(loaded.items()):
        for run_index, by_key in sorted(arm.runs.items()):
            for key, run in sorted(by_key.items()):
                for comment in run.get("selected", []):
                    identity = f"{arm_id}|{run_index}|{key}|{comment['index']}"
                    out.append(
                        {
                            "id": hashlib.sha1(identity.encode()).hexdigest()[:16],
                            "arm": arm_id,
                            "run": run_index,
                            "input_key": key,
                            "comment": comment,
                        }
                    )
    return out


def sample_items(
    comments: list[dict[str, Any]],
    inputs: dict[str, Any],
    repo_dir_of: Any,
    size: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Seeded sample of comments, as judge items: the comment plus its file's diff.

    The sample is stratified by arm (round-robin), so every arm is represented and the
    labeler is not told which arm a comment came from.
    """
    rng = random.Random(seed)
    by_arm: dict[str, list[dict[str, Any]]] = {}
    for c in comments:
        by_arm.setdefault(c["arm"], []).append(c)
    for group in by_arm.values():
        rng.shuffle(group)
    arms = sorted(by_arm)
    picked: list[dict[str, Any]] = []
    while len(picked) < size and any(by_arm.values()):
        for arm in arms:
            if by_arm[arm] and len(picked) < size:
                picked.append(by_arm[arm].pop())
    rng.shuffle(picked)

    items: list[dict[str, Any]] = []
    for entry in picked:
        item = inputs[entry["input_key"]]
        comment = entry["comment"]
        diff = git.run(
            repo_dir_of(item.repo),
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            f"--unified={DIFF_CONTEXT_LINES}",
            item.base_sha,
            item.head_sha,
            "--",
            comment["file"],
        )
        items.append(
            {
                "id": entry["id"],
                "arm": entry["arm"],
                "run": entry["run"],
                "input_key": entry["input_key"],
                "path": comment["file"],
                "diff": diff,
                "line": comment["line"],
                "category": comment["category"],
                "severity": comment["severity"],
                "claim": comment["claim"],
                "evidence": comment["evidence"],
                "suggested_fix": comment.get("suggested_fix"),
            }
        )
    return items


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


def append_human(path: Path, item_id: str, verdict: str, note: str, labeler: str) -> None:
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}")
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "id": item_id,
        "verdict": verdict,
        "note": note,
        "labeler": labeler,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def latest(rows: list[dict[str, Any]]) -> dict[str, str]:
    """Last verdict per item id."""
    return {row["id"]: row["verdict"] for row in rows}


def rates(verdicts: dict[str, str]) -> dict[str, Any]:
    counts = Counter(verdicts.values())
    total = len(verdicts)
    low, high = stats.wilson_interval(counts["valid"], total)
    return {
        "labeled": total,
        "valid_rate": counts["valid"] / total if total else None,
        "valid_ci95": [low, high],
        "nitpick_rate": counts["nitpick"] / total if total else None,
        "invalid_rate": counts["invalid"] / total if total else None,
        # Noise: posted comments that are wrong or not worth the author's time.
        "noise_rate": (counts["nitpick"] + counts["invalid"]) / total if total else None,
    }


def calibration(human: dict[str, str], judge: dict[str, str]) -> dict[str, Any] | None:
    """How well the LLM judge reproduces human verdicts, on the comments both labeled."""
    shared = sorted(human.keys() & judge.keys())
    if not shared:
        return None
    pairs = [(human[i], judge[i]) for i in shared]
    confusion: dict[str, dict[str, int]] = {h: dict.fromkeys(VERDICTS, 0) for h in VERDICTS}
    for h, j in pairs:
        confusion[h][j] += 1
    # Collapsed to the question precision asks: is the comment valid or not?
    binary = [(h == "valid", j == "valid") for h, j in pairs]
    return {
        "shared": len(shared),
        "agreement": sum(h == j for h, j in pairs) / len(pairs),
        "kappa": stats.cohen_kappa(pairs),
        "valid_agreement": sum(h == j for h, j in binary) / len(binary),
        "confusion_human_rows_judge_columns": confusion,
    }


def precision_summary(results: Path) -> dict[str, Any] | None:
    """Precision from human labels and from the judge, per arm, plus judge calibration."""
    directory = comments_dir(results)
    items = {row["id"]: row for row in read_jsonl(directory / "items.jsonl")}
    if not items:
        return None
    human = latest(read_jsonl(directory / "human.jsonl"))
    judge = latest(read_jsonl(directory / "judge.jsonl"))
    out: dict[str, Any] = {"sampled": len(items)}
    for name, verdicts in (("human", human), ("judge", judge)):
        known = {i: v for i, v in verdicts.items() if i in items}
        if not known:
            continue
        out[name] = rates(known)
        out[f"{name}_by_arm"] = {
            arm: rates({i: v for i, v in known.items() if items[i]["arm"] == arm})
            for arm in sorted({items[i]["arm"] for i in known})
        }
    result = calibration(
        {i: v for i, v in human.items() if i in items},
        {i: v for i, v in judge.items() if i in items},
    )
    if result:
        out["calibration"] = result
    return out if len(out) > 1 else None
