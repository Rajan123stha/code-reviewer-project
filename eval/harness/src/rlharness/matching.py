"""Decide whether a review caught a benchmark bug.

Matching rules (every assumption, in one place):

1. **Only posted comments count.** The comments scored are the run's `selected` list: the
   ones that passed validation and dedupe and are within `maxComments`, in rank order.
   Rejected, duplicate and over-cap candidates never produce a hit.
2. **Ground truth** is the set of (path, line) pairs in the reviewed change that the later fix
   removed or rewrote. Paths and lines are in the head commit, the same coordinates the
   reviewer comments in.
3. **File-level hit**: a comment's `file` equals a ground-truth path exactly.
4. **Line-level hit**: a file-level hit whose `line` is within `line_tolerance` lines of any
   ground-truth line in that file. Tolerance 0 demands the exact line. The default of 3
   allows a comment on the statement's first line when the fix touched its continuation, or
   on the `if` above the faulty body.
5. **The claim's text is not checked.** A comment near the buggy line that complains about
   something else still counts. This over-credits; the LLM judge and human labels measure
   that separately. Location-only matching is deliberately the first, model-free measure.
6. **hit@k** uses only the first k selected comments. `recall@k` is the share of cases with a
   line-level hit@k; `file_recall@k` is the same at file level.
7. **Cases that share an input** (one change that introduced several bugs) are scored
   separately against the same review.
8. **A review that failed or was never run** yields no outcome for its cases. Aggregates are
   computed over cases with an outcome, and comparisons between arms use only the cases
   that every compared arm completed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CaseOutcome:
    case_id: str
    input_key: str
    repo: str
    # 1-based rank of the first selected comment that matches, or None.
    first_line_hit_rank: int | None
    first_file_hit_rank: int | None
    # Smallest distance in lines from any comment in a ground-truth file to a ground-truth
    # line, or None if no comment landed in a ground-truth file.
    min_line_distance: int | None
    comments: int

    def line_hit_at(self, k: int) -> bool:
        return self.first_line_hit_rank is not None and self.first_line_hit_rank <= k

    def file_hit_at(self, k: int) -> bool:
        return self.first_file_hit_rank is not None and self.first_file_hit_rank <= k


def normalize_path(path: str) -> str:
    path = path.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def comment_distance(comment: dict[str, Any], truth: dict[str, list[int]]) -> int | None:
    """Lines between a comment and the nearest ground-truth line in its file."""
    lines = truth.get(normalize_path(str(comment["file"])))
    if not lines:
        return None
    return min(abs(int(comment["line"]) - line) for line in lines)


def score_case(case: dict[str, Any], run: dict[str, Any], line_tolerance: int) -> CaseOutcome:
    truth = {normalize_path(r["path"]): list(r["lines"]) for r in case["ground_truth"]}
    selected: list[dict[str, Any]] = run.get("selected", [])
    first_line: int | None = None
    first_file: int | None = None
    best: int | None = None
    for rank, comment in enumerate(selected, start=1):
        distance = comment_distance(comment, truth)
        if distance is None:
            continue
        if first_file is None:
            first_file = rank
        if best is None or distance < best:
            best = distance
        if first_line is None and distance <= line_tolerance:
            first_line = rank
    return CaseOutcome(
        case_id=case["id"],
        input_key=case["input_key"],
        repo=case["repo"],
        first_line_hit_rank=first_line,
        first_file_hit_rank=first_file,
        min_line_distance=best,
        comments=len(selected),
    )


def comment_matches_any(
    comment: dict[str, Any], cases: list[dict[str, Any]], line_tolerance: int
) -> bool:
    """Whether a comment lands on the ground truth of any case of its input."""
    for case in cases:
        truth = {normalize_path(r["path"]): list(r["lines"]) for r in case["ground_truth"]}
        distance = comment_distance(comment, truth)
        if distance is not None and distance <= line_tolerance:
            return True
    return False
