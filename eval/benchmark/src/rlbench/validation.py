"""Manual validation of benchmark cases: sampling, recording verdicts, label-noise rate."""

from __future__ import annotations

import json
import math
import random
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import git

VERDICTS = ("valid", "invalid", "unsure")

GUIDE = """\
Judge whether this case is a real bug that a reviewer of the introducing change could
have caught.

  valid    The marked lines of the introducing change contain (or directly cause) the
           defect that the fix corrects.
  invalid  The marked lines were not wrong when written: the fix is a feature, refactor,
           behavior change or API change; or the bug lives elsewhere; or blame landed on
           a commit that only moved or reformatted the code.
  unsure   Cannot tell from the two diffs.
"""


def sample(cases: list[dict[str, Any]], size: int, seed: int) -> list[str]:
    """Seeded sample of case ids, spread across repositories.

    Round-robin over repositories (each shuffled with the seed), so small repositories are
    represented and one large repository cannot dominate the sample.
    """
    rng = random.Random(seed)
    by_repo: dict[str, list[str]] = {}
    for case in sorted(cases, key=lambda c: c["id"]):
        by_repo.setdefault(case["repo"], []).append(case["id"])
    for ids in by_repo.values():
        rng.shuffle(ids)
    repos = sorted(by_repo)
    rng.shuffle(repos)
    picked: list[str] = []
    while len(picked) < size and any(by_repo.values()):
        for repo in repos:
            if by_repo[repo] and len(picked) < size:
                picked.append(by_repo[repo].pop())
    return picked


@dataclass(frozen=True)
class Verdict:
    case_id: str
    verdict: str
    note: str
    labeler: str
    at: str


def load_verdicts(path: Path) -> list[Verdict]:
    if not path.exists():
        return []
    out: list[Verdict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.append(Verdict(**json.loads(line)))
    return out


def append_verdict(path: Path, case_id: str, verdict: str, note: str, labeler: str) -> Verdict:
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}")
    record = Verdict(case_id, verdict, note, labeler, datetime.now(timezone.utc).isoformat())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record.__dict__) + "\n")
    return record


def latest_by_case(verdicts: list[Verdict], labeler: str | None = None) -> dict[str, Verdict]:
    """Last verdict per case (a labeler can correct themselves by labeling again)."""
    latest: dict[str, Verdict] = {}
    for v in verdicts:
        if labeler is None or v.labeler == labeler:
            latest[v.case_id] = v
    return latest


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a proportion; well-behaved for small samples."""
    if total == 0:
        return (0.0, 1.0)
    p = successes / total
    denom = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def noise_report(verdicts: list[Verdict], labeler: str | None = None) -> dict[str, Any]:
    """Label-noise rate = invalid / (valid + invalid); `unsure` is reported separately."""
    latest = latest_by_case(verdicts, labeler)
    counts = Counter(v.verdict for v in latest.values())
    decided = counts["valid"] + counts["invalid"]
    low, high = wilson_interval(counts["invalid"], decided)
    return {
        "labeled": len(latest),
        "valid": counts["valid"],
        "invalid": counts["invalid"],
        "unsure": counts["unsure"],
        "noise_rate": (counts["invalid"] / decided) if decided else None,
        "noise_rate_ci95": [round(low, 4), round(high, 4)] if decided else None,
    }


def cohen_kappa(a: dict[str, Verdict], b: dict[str, Verdict]) -> dict[str, Any]:
    """Agreement between two labelers on the cases both labeled."""
    shared = sorted(a.keys() & b.keys())
    if not shared:
        return {"shared": 0, "agreement": None, "kappa": None}
    pairs = [(a[c].verdict, b[c].verdict) for c in shared]
    observed = sum(x == y for x, y in pairs) / len(pairs)
    left = Counter(x for x, _ in pairs)
    right = Counter(y for _, y in pairs)
    expected = sum(left[v] * right[v] for v in VERDICTS) / (len(pairs) ** 2)
    kappa = 1.0 if expected == 1 else (observed - expected) / (1 - expected)
    return {"shared": len(shared), "agreement": round(observed, 4), "kappa": round(kappa, 4)}


def render_case(case: dict[str, Any], repo_dir: Path, context: int = 3) -> str:
    """Text shown to a labeler: the fix, then the introducing change with truth marked."""
    truth = {r["path"]: set(r["lines"]) for r in case["ground_truth"]}
    out = [
        "=" * 100,
        f"CASE {case['id']}",
        f"repo {case['repo']}   fixed {case['stats']['days_to_fix']} days after introduction"
        f"   blame share {case['provenance']['blame_share']}",
        "",
        f"FIX {case['fix']['sha'][:10]}  {case['fix']['committed_at'][:10]}",
        f"  {case['fix']['subject']}",
        "",
        git.run(
            repo_dir,
            "show",
            "--no-color",
            "--no-ext-diff",
            "--format=%b",
            f"--unified={context}",
            case["fix"]["sha"],
            "--",
            *case["fix"]["files"],
        ).rstrip(),
        "",
        "-" * 100,
        f"INTRODUCING CHANGE {case['head_sha'][:10]}  {case['introduced']['committed_at'][:10]}",
        f"  {case['introduced']['subject']}",
        "  Lines marked >> are the ground truth (later removed or rewritten by the fix).",
        "",
    ]
    for path, lines in sorted(truth.items()):
        content = git.file_at(repo_dir, case["head_sha"], path)
        if content is None:
            out.append(f"  (cannot read {path} at head)")
            continue
        file_lines = content.split("\n")
        shown: set[int] = set()
        for n in lines:
            shown.update(range(max(1, n - context), min(len(file_lines), n + context) + 1))
        out.append(f"  {path}")
        previous = 0
        for n in sorted(shown):
            if previous and n != previous + 1:
                out.append("      ...")
            marker = ">>" if n in lines else "  "
            out.append(f"  {marker} {n:5d} | {file_lines[n - 1]}")
            previous = n
        out.append("")
    return "\n".join(out)
