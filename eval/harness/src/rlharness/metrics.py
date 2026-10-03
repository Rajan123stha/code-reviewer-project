"""Aggregate run results into the metrics reported for each arm."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import stats
from .matching import CaseOutcome, comment_matches_any, score_case
from .runner import result_path
from .spec import Arm, Experiment, ReviewInput


@dataclass
class ArmResults:
    """Everything loaded for one arm: per run, the outcomes and the raw runs."""

    arm: Arm
    # run index -> case id -> outcome
    outcomes: dict[int, dict[str, CaseOutcome]] = field(default_factory=dict)
    # run index -> input key -> run JSON
    runs: dict[int, dict[str, dict[str, Any]]] = field(default_factory=dict)
    failed: int = 0
    missing: int = 0

    def completed_cases(self) -> set[str]:
        """Cases with an outcome in every run of this arm."""
        sets = [set(by_case) for by_case in self.outcomes.values()]
        return set.intersection(*sets) if sets else set()

    def hit_rate(self, case_id: str, k: int, level: str = "line") -> float:
        """Share of this arm's runs that caught the case within k comments."""
        hits = [
            (o.line_hit_at(k) if level == "line" else o.file_hit_at(k))
            for by_case in self.outcomes.values()
            if (o := by_case.get(case_id)) is not None
        ]
        return sum(hits) / len(hits) if hits else float("nan")


def load_arm(
    experiment: Experiment,
    arm: Arm,
    inputs: list[ReviewInput],
    cases: list[dict[str, Any]],
    results: Path,
) -> ArmResults:
    by_input: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        by_input.setdefault(case["input_key"], []).append(case)
    loaded = ArmResults(arm)
    for run_index in range(1, experiment.runs + 1):
        outcomes: dict[str, CaseOutcome] = {}
        runs: dict[str, dict[str, Any]] = {}
        for item in inputs:
            path = result_path(results, arm, run_index, item)
            if not path.exists():
                if path.with_suffix(".error.json").exists():
                    loaded.failed += 1
                else:
                    loaded.missing += 1
                continue
            run: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
            runs[item.key] = run
            for case in by_input.get(item.key, []):
                outcomes[case["id"]] = score_case(case, run, experiment.line_tolerance)
        loaded.outcomes[run_index] = outcomes
        loaded.runs[run_index] = runs
    return loaded


def summarize_arm(
    experiment: Experiment,
    loaded: ArmResults,
    cases: list[dict[str, Any]],
    case_ids: list[str],
    seed: int = 0,
) -> dict[str, Any]:
    """Metrics for one arm over `case_ids` (normally the cases every arm completed)."""
    k_max = max(experiment.k)
    by_input: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        by_input.setdefault(case["input_key"], []).append(case)
    wanted_inputs = {c["input_key"] for c in cases if c["id"] in set(case_ids)}

    recall: dict[str, Any] = {}
    for k in experiment.k:
        per_case = [loaded.hit_rate(c, k) for c in case_ids]
        low, high = stats.bootstrap_ci(per_case, seed=seed)
        per_run = [
            stats.mean([float(by_case[c].line_hit_at(k)) for c in case_ids if c in by_case])
            for by_case in loaded.outcomes.values()
        ]
        recall[str(k)] = {
            "mean": stats.mean(per_case),
            "ci95": [low, high],
            # Spread between repeats of the same config: LLM nondeterminism.
            "run_sd": stats.sample_sd(per_run),
            "per_run": per_run,
        }
    file_recall = stats.mean([loaded.hit_rate(c, k_max, "file") for c in case_ids])
    line_recall = recall[str(k_max)]["mean"]

    comments: list[float] = []
    matched = total_comments = 0
    candidates = invalid = duplicates = filtered = 0
    tokens_in: list[float] = []
    tokens_cached: list[float] = []
    tokens_out: list[float] = []
    costs: list[float] = []
    latencies: list[float] = []
    context_tokens: list[float] = []
    fallbacks = llm_calls = 0
    served: dict[str, int] = {}
    for by_key in loaded.runs.values():
        for key, run in by_key.items():
            if key not in wanted_inputs:
                continue
            selected = run.get("selected", [])
            comments.append(float(len(selected)))
            total_comments += len(selected)
            matched += sum(
                comment_matches_any(c, by_input.get(key, []), experiment.line_tolerance)
                for c in selected
            )
            for candidate in run.get("candidates", []):
                candidates += 1
                invalid += candidate["status"] == "invalid"
                duplicates += candidate["status"] == "duplicate"
                filtered += candidate["status"] == "filtered"
            context_tokens.append(float(run["context"]["estimatedTokens"]))
            llm = run.get("llm")
            if llm:
                llm_calls += 1
                # Providers report cached prompt tokens separately (Gemini caches a shared
                # prefix on its own). The prompt's size is the sum; comparing uncached
                # tokens alone would make whichever arm ran second look smaller.
                usage = llm["usage"]
                cached_tokens = float(usage.get("cacheReadInputTokens", 0))
                tokens_in.append(
                    float(usage["inputTokens"])
                    + cached_tokens
                    + float(usage.get("cacheCreationInputTokens", 0))
                )
                tokens_cached.append(cached_tokens)
                tokens_out.append(float(llm["usage"]["outputTokens"]))
                if llm.get("costUsd") is not None:
                    costs.append(float(llm["costUsd"]))
                # A response served from the cache has no meaningful latency.
                if not llm.get("cached"):
                    latencies.append(float(llm["latencyMs"]) / 1000)
                fallbacks += bool(llm.get("fallbackUsed"))
                served[llm["servedModel"]] = served.get(llm["servedModel"], 0) + 1

    return {
        "arm": loaded.arm.id,
        "strategy": loaded.arm.strategy,
        "config": loaded.arm.config,
        "cases": len(case_ids),
        "inputs": len(wanted_inputs),
        "runs": len(loaded.outcomes),
        "reviews_failed": loaded.failed,
        "reviews_missing": loaded.missing,
        "recall_at": recall,
        "file_recall_at_max_k": file_recall,
        # Given the review flagged the right file, did it point at the right lines?
        "localization_accuracy": (line_recall / file_recall) if file_recall else None,
        "comments_per_review": stats.mean(comments),
        # Lower bound on precision: comments on a known bug. Comments on real problems that
        # are not in the benchmark count against it; the judge and human labels fix that.
        "ground_truth_precision": (matched / total_comments) if total_comments else None,
        "candidates_rejected_rate": (invalid / candidates) if candidates else None,
        "candidates_duplicate_rate": (duplicates / candidates) if candidates else None,
        # Valid, unique comments the learned filter dropped (0 when the filter is off).
        "candidates_filtered_rate": (filtered / candidates) if candidates else None,
        "context_tokens_estimated": stats.mean(context_tokens),
        "tokens_in": stats.mean(tokens_in),
        # Share of prompt tokens the provider served from its cache (billed at a discount).
        "tokens_in_cached_share": (sum(tokens_cached) / sum(tokens_in)) if sum(tokens_in) else None,
        "tokens_out": stats.mean(tokens_out),
        "cost_usd_per_review": stats.mean(costs) if costs else None,
        "latency_s_p50": stats.percentile(latencies, 50),
        "latency_s_p95": stats.percentile(latencies, 95),
        "fallback_rate": (fallbacks / llm_calls) if llm_calls else None,
        "served_models": served,
    }


def compare_arms(
    experiment: Experiment,
    a: ArmResults,
    b: ArmResults,
    case_ids: list[str],
    k: int,
    seed: int = 0,
) -> dict[str, Any]:
    """Paired comparison of recall@k, arm `a` minus arm `b`, on identical cases."""
    rate_a = [a.hit_rate(c, k) for c in case_ids]
    rate_b = [b.hit_rate(c, k) for c in case_ids]
    diff, low, high = stats.paired_bootstrap_diff(rate_a, rate_b, seed=seed)
    # McNemar needs one binary outcome per case: caught in a majority of runs.
    caught_a = [r > 0.5 for r in rate_a]
    caught_b = [r > 0.5 for r in rate_b]
    only_a = sum(x and not y for x, y in zip(caught_a, caught_b, strict=True))
    only_b = sum(y and not x for x, y in zip(caught_a, caught_b, strict=True))
    return {
        "arm": a.arm.id,
        "baseline": b.arm.id,
        "k": k,
        "cases": len(case_ids),
        "recall_diff": diff,
        "ci95": [low, high],
        "only_arm": only_a,
        "only_baseline": only_b,
        "mcnemar_p": stats.mcnemar_exact(only_a, only_b),
    }
