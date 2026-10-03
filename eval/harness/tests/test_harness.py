from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from rlharness import comments, report, spec, stats
from rlharness.matching import score_case
from rlharness.metrics import compare_arms, load_arm, summarize_arm
from rlharness.runner import (
    CliReviewer,
    QuotaExhausted,
    ReviewFailed,
    result_path,
    run_experiment,
)

# ---------------------------------------------------------------------------- fixtures


def case(
    case_id: str, repo: str = "o/r", path: str = "src/a.js", lines: tuple[int, ...] = (10,)
) -> dict[str, Any]:
    return {
        "id": case_id,
        "repo": repo,
        "base_sha": "b" * 40,
        "head_sha": case_id.ljust(40, "0"),
        "input_key": f"{repo}@{case_id}",
        "introduced": {"subject": f"Change {case_id}", "committed_at": "2026-01-01T00:00:00+00:00"},
        "fix": {"committed_at": "2026-02-01T00:00:00+00:00"},
        "ground_truth": [{"path": path, "lines": list(lines)}],
    }


def comment(file: str, line: int, index: int = 0) -> dict[str, Any]:
    return {
        "index": index,
        "file": file,
        "line": line,
        "category": "bug",
        "severity": "high",
        "claim": "c",
        "evidence": "e",
        "suggested_fix": None,
        "status": "selected",
    }


def run_json(
    selected: list[dict[str, Any]], tokens: int = 1000, latency_ms: float = 2000
) -> dict[str, Any]:
    return {
        "configHash": "cfg",
        "selected": selected,
        "candidates": [*selected, {"status": "invalid"}],
        "context": {"estimatedTokens": 500},
        "llm": {
            "usage": {
                "inputTokens": tokens - 400,
                "cacheReadInputTokens": 400,
                "outputTokens": 100,
            },
            "costUsd": 0.01,
            "latencyMs": latency_ms,
            "cached": False,
            "fallbackUsed": False,
            "servedModel": "m",
        },
    }


def write_spec(tmp_path: Path, body: str) -> spec.Experiment:
    (tmp_path / "manifest.json").write_text("{}", encoding="utf-8")
    path = tmp_path / "exp.yaml"
    path.write_text("name: t\nmanifest: manifest.json\n" + body, encoding="utf-8")
    return spec.load(path)


TWO_ARMS = "runs: 2\nk: [1, 3]\nmatching: {line_tolerance: 2}\narms:\n  - {id: A, strategy: S0}\n  - {id: B, strategy: S4, config: {graphDepth: 3}}\n"

# ---------------------------------------------------------------------------- matching


@pytest.mark.parametrize(
    ("selected", "tolerance", "line_rank", "file_rank", "distance"),
    [
        ([comment("src/a.js", 10)], 0, 1, 1, 0),
        ([comment("src/a.js", 12)], 2, 1, 1, 2),
        ([comment("src/a.js", 13)], 2, None, 1, 3),
        ([comment("src/other.js", 10)], 2, None, None, None),
        (
            [comment("src/other.js", 10), comment("src/a.js", 40), comment("./src/a.js", 9)],
            2,
            3,
            2,
            1,
        ),
        ([], 2, None, None, None),
    ],
)
def test_score_case(
    selected: list[dict[str, Any]],
    tolerance: int,
    line_rank: int | None,
    file_rank: int | None,
    distance: int | None,
) -> None:
    outcome = score_case(case("c1"), {"selected": selected}, tolerance)
    assert (
        outcome.first_line_hit_rank,
        outcome.first_file_hit_rank,
        outcome.min_line_distance,
    ) == (
        line_rank,
        file_rank,
        distance,
    )


def test_hit_at_k_uses_only_the_first_k_comments() -> None:
    selected = [comment("src/x.js", 1), comment("src/x.js", 2), comment("src/a.js", 10)]
    outcome = score_case(case("c1"), {"selected": selected}, 0)
    assert [outcome.line_hit_at(k) for k in (1, 2, 3, 10)] == [False, False, True, True]


def test_multiple_ground_truth_lines_use_the_nearest() -> None:
    outcome = score_case(case("c1", lines=(10, 50)), {"selected": [comment("src/a.js", 48)]}, 2)
    assert outcome.first_line_hit_rank == 1 and outcome.min_line_distance == 2


# ---------------------------------------------------------------------------- statistics


def test_percentile_and_sd() -> None:
    assert stats.percentile([1, 2, 3, 4], 50) == 2.5
    assert stats.percentile([5], 95) == 5
    assert stats.sample_sd([2, 4, 4, 4, 5, 5, 7, 9]) == pytest.approx(2.138, abs=1e-3)
    assert stats.sample_sd([3]) == 0.0


def test_bootstrap_ci_is_seeded_and_brackets_the_mean() -> None:
    values = [1.0] * 30 + [0.0] * 70
    low, high = stats.bootstrap_ci(values, seed=1)
    assert (low, high) == stats.bootstrap_ci(values, seed=1)
    assert low < 0.30 < high
    assert 0.20 < low < 0.25 and 0.35 < high < 0.41
    assert stats.bootstrap_ci([1.0] * 10) == (1.0, 1.0)


def test_paired_bootstrap_detects_a_consistent_gain() -> None:
    b = [0.0] * 40 + [1.0] * 20
    a = [1.0] * 12 + [0.0] * 28 + [1.0] * 20  # a catches 12 cases that b misses
    diff, low, high = stats.paired_bootstrap_diff(a, b, seed=3)
    assert diff == pytest.approx(0.2)
    assert low > 0
    same = stats.paired_bootstrap_diff(b, b)
    assert same == (0.0, 0.0, 0.0)
    with pytest.raises(ValueError):
        stats.paired_bootstrap_diff([1.0], [1.0, 0.0])


def test_mcnemar_exact_known_values() -> None:
    assert stats.mcnemar_exact(0, 0) == 1.0
    assert stats.mcnemar_exact(5, 5) == 1.0
    # 10 discordant pairs, all one way: 2 * (1/2)^10
    assert stats.mcnemar_exact(10, 0) == pytest.approx(2 / 1024)
    assert stats.mcnemar_exact(8, 2) == pytest.approx(0.109375)


def test_cohen_kappa() -> None:
    assert stats.cohen_kappa([("a", "a"), ("b", "b")]) == 1.0
    assert stats.cohen_kappa([("a", "a"), ("a", "b"), ("b", "a"), ("b", "b")]) == 0.0


# ---------------------------------------------------------------------------- spec and selection


def test_spec_merges_base_into_arms_and_hashes_identity(tmp_path: Path) -> None:
    experiment = write_spec(
        tmp_path,
        "base: {effort: low, graphDepth: 1}\nruns: 3\narms:\n  - {id: A, strategy: S0}\n  - {id: B, strategy: S4, config: {graphDepth: 3}}\n",
    )
    assert experiment.arms[0].config == {"effort": "low", "graphDepth": 1}
    assert experiment.arms[1].config == {"effort": "low", "graphDepth": 3}
    assert experiment.baseline == "A" and experiment.runs == 3
    other = write_spec(
        tmp_path, "base: {effort: low, graphDepth: 1}\nruns: 2\narms:\n  - {id: A, strategy: S0}\n"
    )
    assert other.spec_hash() != experiment.spec_hash()


def test_spec_rejects_bad_definitions(tmp_path: Path) -> None:
    with pytest.raises(spec.SpecError, match="no arms"):
        write_spec(tmp_path, "arms: []\n")
    with pytest.raises(spec.SpecError, match="duplicate"):
        write_spec(tmp_path, "arms:\n  - {id: A, strategy: S0}\n  - {id: A, strategy: S1}\n")
    with pytest.raises(spec.SpecError, match="baseline"):
        write_spec(tmp_path, "baseline: Z\narms:\n  - {id: A, strategy: S0}\n")
    pending = write_spec(tmp_path, "requires: [verifier]\narms:\n  - {id: A, strategy: S0}\n")
    assert pending.unavailable() == ["verifier"]


def test_select_cases_samples_inputs_round_robin_and_keeps_all_their_cases(tmp_path: Path) -> None:
    cases = [case(f"big{i:02d}", "o/big") for i in range(20)] + [
        case(f"sm{i}", "o/small") for i in range(2)
    ]
    shared = case("extra", "o/small")
    shared["input_key"] = cases[-1]["input_key"]  # two bugs introduced by one change
    cases.append(shared)
    experiment = write_spec(
        tmp_path, "cases: {sample: 6, seed: 5}\narms:\n  - {id: A, strategy: S0}\n"
    )

    inputs, chosen = spec.select_cases(cases, experiment)
    assert len(inputs) == 6
    assert sum(i.repo == "o/small" for i in inputs) == 2
    assert {c["id"] for c in chosen} >= {"extra", "sm1"}
    again, _ = spec.select_cases(list(reversed(cases)), experiment)
    assert [i.key for i in again] == [i.key for i in inputs]

    _, without = spec.select_cases(cases, experiment, frozenset({"extra"}))
    assert "extra" not in {c["id"] for c in without}


# ---------------------------------------------------------------------------- runner


class ScriptedReviewer:
    def __init__(self, behavior: dict[str, Any]) -> None:
        self.behavior = behavior
        self.calls: list[str] = []

    def review(self, item: spec.ReviewInput, arm: spec.Arm, run_index: int, out: Path) -> None:
        label = f"{arm.id}/run{run_index}/{item.key}"
        self.calls.append(label)
        action = self.behavior.get(label) or self.behavior.get(arm.id) or "ok"
        if isinstance(action, Exception):
            raise action
        out.write_text(json.dumps(run_json([])), encoding="utf-8")


def test_runner_is_resumable_and_records_failures(tmp_path: Path) -> None:
    experiment = write_spec(tmp_path, TWO_ARMS)
    inputs, _ = spec.select_cases([case("c1"), case("c2")], experiment)
    results = tmp_path / "results"
    bad = f"B/run1/{inputs[0].key}"
    reviewer = ScriptedReviewer({bad: ReviewFailed("boom")})

    first = run_experiment(experiment, inputs, results, reviewer, log=lambda _l: None)
    assert (first.planned, first.completed, first.failed) == (8, 7, 1)
    error_file = result_path(results, experiment.arms[1], 1, inputs[0]).with_suffix(".error.json")
    assert json.loads(error_file.read_text())["error"] == "boom"

    reviewer.behavior = {}
    second = run_experiment(experiment, inputs, results, reviewer, log=lambda _l: None)
    assert (second.already_done, second.completed, second.failed) == (7, 1, 0)
    assert not error_file.exists()
    third = run_experiment(experiment, inputs, results, reviewer, log=lambda _l: None)
    assert (third.already_done, third.completed) == (8, 0)


def test_runner_stops_on_quota_and_orders_work_by_input(tmp_path: Path) -> None:
    experiment = write_spec(tmp_path, TWO_ARMS)
    inputs, _ = spec.select_cases([case("c1"), case("c2")], experiment)
    reviewer = ScriptedReviewer({f"A/run1/{inputs[1].key}": QuotaExhausted("daily quota")})
    summary = run_experiment(experiment, inputs, tmp_path / "r", reviewer, log=lambda _l: None)
    assert summary.stopped_for_quota is True
    # The first input was finished in both arms before the second was started.
    assert reviewer.calls[:3] == [
        f"A/run1/{inputs[0].key}",
        f"B/run1/{inputs[0].key}",
        f"A/run1/{inputs[1].key}",
    ]
    assert summary.completed == 2 and summary.failed == 0
    assert len(reviewer.calls) == 3


def test_runner_respects_limit(tmp_path: Path) -> None:
    experiment = write_spec(tmp_path, TWO_ARMS)
    inputs, _ = spec.select_cases([case("c1"), case("c2")], experiment)
    reviewer = ScriptedReviewer({})
    summary = run_experiment(
        experiment, inputs, tmp_path / "r", reviewer, limit=3, log=lambda _l: None
    )
    assert summary.completed == 3 and summary.remaining == 5


def test_cli_reviewer_command_carries_config_and_salt(tmp_path: Path) -> None:
    experiment = write_spec(tmp_path, TWO_ARMS)
    inputs, _ = spec.select_cases([case("c1")], experiment)
    reviewer = CliReviewer(cli=Path("cli.js"), fake_llm=Path("fake.json"))
    cmd = reviewer.command(inputs[0], experiment.arms[1], 2, Path("out.json"))
    assert cmd[:3] == ["node", "cli.js", "review"]
    assert cmd[cmd.index("--strategy") + 1] == "S4"
    assert json.loads(cmd[cmd.index("--config-json") + 1]) == {"graphDepth": 3}
    assert cmd[cmd.index("--salt") + 1] == "run-2"
    assert cmd[cmd.index("--title") + 1] == "Change c1"
    assert cmd[-2:] == ["--fake-llm", "fake.json"]


# ---------------------------------------------------------------------------- metrics and report


def build_results(
    tmp_path: Path,
) -> tuple[spec.Experiment, list[spec.ReviewInput], list[dict[str, Any]], Path]:
    """Arm A catches c1 and c2; arm B catches c1, c2, c3 and (in one of two runs) c4."""
    experiment = write_spec(tmp_path, TWO_ARMS)
    cases = [case(f"c{i}") for i in range(1, 6)]
    inputs, chosen = spec.select_cases(cases, experiment)
    results = tmp_path / "results"
    caught = {
        "A": {1: {"c1", "c2"}, 2: {"c1", "c2"}},
        "B": {1: {"c1", "c2", "c3", "c4"}, 2: {"c1", "c2", "c3"}},
    }
    for arm in experiment.arms:
        for run_index in (1, 2):
            for item in inputs:
                case_id = item.key.split("@")[1]
                hit = case_id in caught[arm.id][run_index]
                selected = [
                    comment("src/a.js", 11 if hit else 300),
                    comment("src/zzz.js", 1, index=1),
                ]
                path = result_path(results, arm, run_index, item)
                path.parent.mkdir(parents=True, exist_ok=True)
                tokens = 1000 if arm.id == "A" else 3000
                path.write_text(
                    json.dumps(run_json(selected, tokens, 1000 * run_index)), encoding="utf-8"
                )
    return experiment, inputs, chosen, results


def test_summarize_arm_metrics(tmp_path: Path) -> None:
    experiment, inputs, cases, results = build_results(tmp_path)
    arm_b = load_arm(experiment, experiment.arms[1], inputs, cases, results)
    ids = sorted(arm_b.completed_cases())
    summary = summarize_arm(experiment, arm_b, cases, ids)

    assert summary["cases"] == 5 and summary["runs"] == 2
    assert summary["recall_at"]["1"]["per_run"] == [0.8, 0.6]
    assert summary["recall_at"]["1"]["mean"] == pytest.approx(0.7)
    assert summary["recall_at"]["1"]["run_sd"] == pytest.approx(0.1414, abs=1e-4)
    # Every review commented in the ground-truth file, so file recall is 1.
    assert summary["file_recall_at_max_k"] == 1.0
    assert summary["localization_accuracy"] == pytest.approx(0.7)
    assert summary["comments_per_review"] == 2.0
    # 7 of the 20 posted comments are on a known bug.
    assert summary["ground_truth_precision"] == pytest.approx(7 / 20)
    assert summary["candidates_rejected_rate"] == pytest.approx(1 / 3)
    # Prompt size counts cached tokens too: 2600 uncached + 400 from the provider cache.
    assert summary["tokens_in_cached_share"] == pytest.approx(400 / 3000)
    assert summary["tokens_in"] == 3000 and summary["cost_usd_per_review"] == pytest.approx(0.01)
    assert summary["latency_s_p50"] == 1.5
    assert summary["served_models"] == {"m": 10}


def test_compare_arms_is_paired(tmp_path: Path) -> None:
    experiment, inputs, cases, results = build_results(tmp_path)
    a = load_arm(experiment, experiment.arms[0], inputs, cases, results)
    b = load_arm(experiment, experiment.arms[1], inputs, cases, results)
    comparison = compare_arms(experiment, b, a, sorted(a.completed_cases()), k=3)
    assert comparison["recall_diff"] == pytest.approx(0.3)  # 0.7 - 0.4
    # c3 is caught by B in both runs; c4 in only one, which is not a majority.
    assert (comparison["only_arm"], comparison["only_baseline"]) == (1, 0)
    assert comparison["mcnemar_p"] == 1.0


def test_score_uses_only_cases_complete_in_every_arm_and_writes_report(tmp_path: Path) -> None:
    experiment, inputs, cases, results = build_results(tmp_path)
    result_path(results, experiment.arms[0], 2, inputs[4]).unlink()  # A never finished c5, run 2

    summary = report.score(
        experiment, inputs, cases, results, {"cases_hash": "h"}, cutoff="2026-01-15"
    )
    assert summary["cases_complete_in_all_arms"] == 4
    assert [a["recall_at"]["1"]["mean"] for a in summary["arms"]] == [0.5, pytest.approx(0.875)]
    assert summary["arms"][0]["reviews_missing"] == 1
    assert summary["date_split"]["groups"]["straddles_cutoff"]["cases"] == 4
    assert summary["config_hashes"] == {"A": ["cfg"], "B": ["cfg"]}

    paths = report.write(summary, results)
    text = paths["report"].read_text(encoding="utf-8")
    assert "| A | 50.0% |" in text and "| B | 87.5% |" in text
    assert "Paired comparison with `A`" in text
    assert json.loads(paths["summary"].read_text())["spec_hash"] == experiment.spec_hash()
    assert "plot" in paths and paths["plot"].stat().st_size > 1000


def test_empty_experiment_scores_without_crashing(tmp_path: Path) -> None:
    experiment = write_spec(tmp_path, TWO_ARMS)
    inputs, cases = spec.select_cases([case("c1")], experiment)
    summary = report.score(experiment, inputs, cases, tmp_path / "none", {})
    assert summary["cases_complete_in_all_arms"] == 0
    assert math.isnan(summary["arms"][0]["recall_at"]["1"]["mean"])
    assert "n/a" in report.to_markdown(summary)


# ---------------------------------------------------------------------------- comment precision


def test_precision_rates_and_judge_calibration(tmp_path: Path) -> None:
    directory = comments.comments_dir(tmp_path)
    items = [{"id": f"i{n}", "arm": "A" if n < 3 else "B"} for n in range(6)]
    comments.write_jsonl(directory / "items.jsonl", items)
    human = ["valid", "valid", "nitpick", "invalid", "valid", "invalid"]
    judge = ["valid", "nitpick", "nitpick", "invalid", "valid", "valid"]
    for n, verdict in enumerate(human):
        comments.append_human(directory / "human.jsonl", f"i{n}", verdict, "", "me")
    comments.append_human(directory / "human.jsonl", "i5", "valid", "changed my mind", "me")
    comments.write_jsonl(
        directory / "judge.jsonl", [{"id": f"i{n}", "verdict": v} for n, v in enumerate(judge)]
    )

    summary = comments.precision_summary(tmp_path)
    assert summary is not None
    assert summary["human"]["labeled"] == 6
    assert summary["human"]["valid_rate"] == pytest.approx(4 / 6)
    assert summary["human"]["noise_rate"] == pytest.approx(2 / 6)
    assert summary["human_by_arm"]["A"]["valid_rate"] == pytest.approx(2 / 3)
    assert summary["calibration"]["shared"] == 6
    assert summary["calibration"]["agreement"] == pytest.approx(5 / 6)
    assert summary["calibration"]["confusion_human_rows_judge_columns"]["valid"] == {
        "valid": 3,
        "nitpick": 1,
        "invalid": 0,
    }
    with pytest.raises(ValueError):
        comments.append_human(directory / "human.jsonl", "i0", "maybe", "", "me")
    assert comments.precision_summary(tmp_path / "missing") is None


def test_filter_experiments_refuse_training_repositories_and_model_changes(tmp_path: Path) -> None:
    from rlharness import filtercheck
    from rlharness.spec import ReviewInput

    inputs = [ReviewInput("o/x@1", "o/x", "b", "h", "t")]
    health = {
        "model_version": "lr-1",
        "features_version": "features/v1",
        "dataset_hash": "d1",
        "train_repos": ["o/a", "o/b"],
    }
    served = filtercheck.check_filter(health, inputs, tmp_path)
    assert served["model_version"] == "lr-1"
    assert json.loads((tmp_path / "filter.json").read_text())["train_repos"] == ["o/a", "o/b"]
    # Resuming with the same model is fine; with another model it is not.
    filtercheck.check_filter(health, inputs, tmp_path)
    with pytest.raises(filtercheck.FilterCheckError, match="earlier results here used filter lr-1"):
        filtercheck.check_filter({**health, "model_version": "gbm-2"}, inputs, tmp_path)
    # A model trained on a repository under review, or one that does not say, is refused.
    with pytest.raises(filtercheck.FilterCheckError, match="trained on repositories.*o/x"):
        filtercheck.check_filter({**health, "train_repos": ["o/x"]}, inputs, tmp_path / "b")
    with pytest.raises(filtercheck.FilterCheckError, match="does not say"):
        filtercheck.check_filter({**health, "train_repos": []}, inputs, tmp_path / "c")
    assert not (tmp_path / "b").exists()
