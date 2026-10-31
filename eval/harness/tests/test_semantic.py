from __future__ import annotations

import json
from pathlib import Path

from rlharness import semantic
from rlharness.matching import CaseOutcome
from rlharness.metrics import ArmResults
from rlharness.spec import Arm


def comment(file: str, line: int, claim: str) -> dict[str, object]:
    return {"file": file, "line": line, "claim": claim, "category": "bug", "evidence": "x"}


def outcome(case_id: str) -> CaseOutcome:
    return CaseOutcome(case_id, "k", "o/r", None, None, None, 0)


CASE = {
    "id": "c1",
    "repo": "o/r",
    "input_key": "k",
    "fix": {"sha": "f" * 40, "subject": "fix: off by one"},
    "ground_truth": [{"path": "src/a.js", "lines": [10]}],
}
ON_BUG = comment("src/a.js", 10, "Loop reads past the end.")
NEARBY_OTHER = comment("src/a.js", 11, "Rename this variable.")
ELSEWHERE = comment("src/b.js", 10, "Unrelated file.")


def arm(arm_id: str, runs: dict[int, list[dict[str, object]]]) -> ArmResults:
    loaded = ArmResults(Arm(arm_id, "S0"))
    for run_index, selected in runs.items():
        loaded.runs[run_index] = {"k": {"selected": selected}}
        loaded.outcomes[run_index] = {"c1": outcome("c1")}
    return loaded


def write(results: Path, name: str, rows: list[dict[str, str]]) -> None:
    directory = semantic.matches_dir(results)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def test_pairs_cover_comments_in_ground_truth_files_only() -> None:
    loaded = {"A": arm("A", {1: [NEARBY_OTHER, ELSEWHERE, ON_BUG]})}
    found = semantic.pairs(loaded, [CASE], k_max=10)
    assert [(p["rank"], p["comment"]["claim"]) for p in found] == [
        (1, "Rename this variable."),
        (3, "Loop reads past the end."),
    ]
    # The same comment from another arm or run is the same pair: judged once.
    again = semantic.pairs({"B": arm("B", {2: [ON_BUG]})}, [CASE], k_max=10)
    assert again[0]["id"] == found[1]["id"]
    assert semantic.pairs(loaded, [CASE], k_max=2)[-1]["rank"] == 1


def test_semantic_recall_counts_only_comments_judged_to_describe_the_bug(tmp_path: Path) -> None:
    loaded = {
        # Run 1: the bug is found at rank 3, behind an off-topic comment on the same lines.
        # Run 2: only the off-topic comment.
        "A": arm("A", {1: [NEARBY_OTHER, ELSEWHERE, ON_BUG], 2: [NEARBY_OTHER]}),
    }
    on_bug = semantic.pair_id("c1", ON_BUG)
    other = semantic.pair_id("c1", NEARBY_OTHER)
    assert semantic.summary(loaded, [CASE], ["c1"], (1, 3), tmp_path) is None  # no judge yet

    write(
        tmp_path,
        "judge.jsonl",
        [{"id": on_bug, "verdict": "same_bug"}, {"id": other, "verdict": "different_issue"}],
    )
    write(
        tmp_path,
        "human.jsonl",
        [{"id": on_bug, "verdict": "same_bug"}, {"id": other, "verdict": "same_bug"}],
    )
    result = semantic.summary(loaded, [CASE], ["c1"], (1, 3), tmp_path)
    assert result is not None
    assert result["pairs"] == 2 and result["coverage"] == 1.0
    assert result["verdicts"] == {"same_bug": 1, "different_issue": 1, "unclear": 0}
    recall = result["arms"]["A"]["recall_at"]
    assert recall["1"]["mean"] == 0.0  # the rank-1 comment is near the bug but about something else
    assert recall["3"]["mean"] == 0.5  # found in one run of two
    assert result["calibration"]["shared"] == 2
    assert result["calibration"]["agreement"] == 0.5


def test_unjudged_pairs_are_misses_and_lower_coverage(tmp_path: Path) -> None:
    loaded = {"A": arm("A", {1: [ON_BUG]})}
    write(tmp_path, "judge.jsonl", [{"id": "someone-else", "verdict": "same_bug"}])
    result = semantic.summary(loaded, [CASE], ["c1"], (1,), tmp_path)
    assert result is not None
    assert result["coverage"] == 0.0
    assert result["arms"]["A"]["recall_at"]["1"]["mean"] == 0.0
    assert "calibration" not in result
