"""Score an experiment and render its tables and plot."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rlbench import manifest as manifest_io

from . import stats
from .comments import precision_summary
from .metrics import ArmResults, compare_arms, load_arm, summarize_arm
from .spec import Experiment, ReviewInput


def score(
    experiment: Experiment,
    inputs: list[ReviewInput],
    cases: list[dict[str, Any]],
    results: Path,
    manifest: dict[str, Any],
    seed: int = 0,
    cutoff: str | None = None,
) -> dict[str, Any]:
    """Compute every metric for an experiment from the result files on disk.

    `cutoff` (an ISO date, such as a model's training cutoff) adds recall for cases fixed
    before it, introduced after it, and straddling it.
    """
    loaded: dict[str, ArmResults] = {
        arm.id: load_arm(experiment, arm, inputs, cases, results) for arm in experiment.arms
    }
    # Compare arms only on cases that every arm finished, in every run.
    complete = set.intersection(*(r.completed_cases() for r in loaded.values()))
    case_ids = sorted(complete)
    k_max = max(experiment.k)
    baseline = loaded[experiment.baseline]
    summary: dict[str, Any] = {
        "experiment": experiment.name,
        "description": experiment.description,
        "spec_hash": experiment.spec_hash(),
        "manifest_cases_hash": manifest.get("cases_hash"),
        "scored_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "line_tolerance": experiment.line_tolerance,
        "k": list(experiment.k),
        "runs": experiment.runs,
        "inputs_selected": len(inputs),
        "cases_selected": len(cases),
        "cases_complete_in_all_arms": len(case_ids),
        "baseline": experiment.baseline,
        "arms": [
            summarize_arm(experiment, loaded[a.id], cases, case_ids, seed) for a in experiment.arms
        ],
        "comparisons": [
            compare_arms(experiment, loaded[a.id], baseline, case_ids, k_max, seed)
            for a in experiment.arms
            if a.id != experiment.baseline
        ],
        "config_hashes": {
            arm_id: sorted({run["configHash"] for by in r.runs.values() for run in by.values()})
            for arm_id, r in loaded.items()
        },
        "date_split": _date_split(experiment, loaded, cases, case_ids, cutoff),
    }
    precision = precision_summary(results)
    if precision:
        summary["precision"] = precision
    return summary


def _date_split(
    experiment: Experiment,
    loaded: dict[str, ArmResults],
    cases: list[dict[str, Any]],
    case_ids: list[str],
    cutoff: str | None,
) -> dict[str, Any] | None:
    """Recall@max-k per arm for cases before and after a cutoff date, if one is given."""
    if cutoff is None:
        return None
    wanted = set(case_ids)
    groups = manifest_io.split_by_date([c for c in cases if c["id"] in wanted], cutoff)
    k = max(experiment.k)
    return {
        "cutoff": cutoff,
        "groups": {
            name: {
                "cases": len(group),
                "recall": {
                    arm_id: stats.mean([r.hit_rate(c["id"], k) for c in group]) if group else None
                    for arm_id, r in loaded.items()
                },
            }
            for name, group in groups.items()
        },
    }


def _pct(value: float | None, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{100 * value:.{digits}f}%"


def _num(value: float | None, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:,.{digits}f}"


def to_markdown(summary: dict[str, Any]) -> str:
    """The ablation table, the paired comparison table and the caveats, as Markdown."""
    k_max = str(max(summary["k"]))
    lines = [
        f"# {summary['experiment']}",
        "",
        summary["description"],
        "",
        f"- Cases scored: **{summary['cases_complete_in_all_arms']}** "
        f"(of {summary['cases_selected']} selected, {summary['inputs_selected']} review inputs), "
        f"complete in every arm and run",
        f"- Runs per arm: {summary['runs']}; a hit is a posted comment within "
        f"{summary['line_tolerance']} lines of a line the fix changed",
        f"- Spec `{summary['spec_hash']}`, manifest cases `{summary['manifest_cases_hash']}`, "
        f"scored {summary['scored_at']}",
        "",
        "## Results",
        "",
    ]
    header = ["Arm"]
    header += [f"Recall@{k}" for k in summary["k"]]
    header += [
        f"95% CI (@{k_max})",
        "Run SD",
        "File recall",
        "Localization",
        "Comments / review",
        "GT precision",
        "Context tokens",
        "Tokens in",
        "Tokens out",
        "Cost / review",
        "p50 s",
        "p95 s",
    ]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] + ["---:"] * (len(header) - 1)) + "|")
    for arm in summary["arms"]:
        top = arm["recall_at"][k_max]
        row = [arm["arm"]]
        row += [_pct(arm["recall_at"][str(k)]["mean"]) for k in summary["k"]]
        row += [
            f"{_pct(top['ci95'][0])} to {_pct(top['ci95'][1])}",
            _pct(top["run_sd"]),
            _pct(arm["file_recall_at_max_k"]),
            _pct(arm["localization_accuracy"]),
            _num(arm["comments_per_review"], 2),
            _pct(arm["ground_truth_precision"]),
            _num(arm["context_tokens_estimated"], 0),
            _num(arm["tokens_in"], 0),
            _num(arm["tokens_out"], 0),
            "n/a" if arm["cost_usd_per_review"] is None else f"${arm['cost_usd_per_review']:.4f}",
            _num(arm["latency_s_p50"]),
            _num(arm["latency_s_p95"]),
        ]
        lines.append("| " + " | ".join(row) + " |")

    if summary["comparisons"]:
        lines += [
            "",
            f"## Paired comparison with `{summary['baseline']}` (recall@{k_max}, same cases)",
            "",
            "| Arm | Recall difference | 95% CI | Caught only by arm "
            "| Caught only by baseline | McNemar p |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        for c in summary["comparisons"]:
            sign = "+" if c["recall_diff"] >= 0 else ""
            lines.append(
                f"| {c['arm']} | {sign}{100 * c['recall_diff']:.1f} pts | "
                f"{100 * c['ci95'][0]:+.1f} to {100 * c['ci95'][1]:+.1f} pts | "
                f"{c['only_arm']} | {c['only_baseline']} | {c['mcnemar_p']:.3f} |"
            )

    precision = summary.get("precision")
    if precision:
        lines += ["", "## Comment precision", ""]
        for source, block in precision.items():
            if not isinstance(block, dict) or "labeled" not in block:
                continue
            lines.append(
                f"- **{source}**: {block['labeled']} comments; valid {_pct(block['valid_rate'])} "
                f"(95% CI {_pct(block['valid_ci95'][0])} to {_pct(block['valid_ci95'][1])}), "
                f"nitpick {_pct(block['nitpick_rate'])}, invalid {_pct(block['invalid_rate'])}"
            )
        calibration = precision.get("calibration")
        if calibration:
            lines.append(
                f"- **Judge vs human** on {calibration['shared']} comments: agreement "
                f"{_pct(calibration['agreement'])}, Cohen's kappa {calibration['kappa']:.2f}"
            )

    failed = sum(a["reviews_failed"] for a in summary["arms"])
    missing = sum(a["reviews_missing"] for a in summary["arms"])
    fallbacks = {a["arm"]: a["fallback_rate"] for a in summary["arms"] if a["fallback_rate"]}
    lines += [
        "",
        "## Notes",
        "",
        "- Recall@k is the share of benchmark bugs with a posted comment on or near the lines "
        "the fix later changed, using the first k comments. The claim's text is not checked.",
        "- Localization is line-level recall divided by file-level recall: of the bugs whose "
        "file was flagged, how many were flagged on the right lines.",
        "- GT precision is a lower bound: a comment on a real problem that is not a benchmark "
        "bug counts as a miss.",
        "- Run SD is the spread of recall between repeats of the same config.",
        f"- Reviews failed: {failed}; not yet run: {missing}.",
    ]
    if fallbacks:
        shown = ", ".join(f"{arm} {_pct(rate)}" for arm, rate in fallbacks.items())
        lines.append(f"- Share of reviews answered by a fallback model: {shown}.")
    return "\n".join(lines) + "\n"


def pareto_plot(summary: dict[str, Any], out: Path) -> bool:
    """Recall against comments per review, with tokens as marker size. False without matplotlib."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    k_max = str(max(summary["k"]))
    arms = [a for a in summary["arms"] if not math.isnan(a["recall_at"][k_max]["mean"])]
    if not arms:
        return False
    fig, ax = plt.subplots(figsize=(7, 4.5))
    biggest = max(a["tokens_in"] for a in arms) or 1
    for arm in arms:
        recall = 100 * arm["recall_at"][k_max]["mean"]
        low, high = (100 * v for v in arm["recall_at"][k_max]["ci95"])
        x = arm["comments_per_review"]
        ax.errorbar(
            x, recall, yerr=[[recall - low], [high - recall]], color="#888", capsize=3, lw=1
        )
        ax.scatter(x, recall, s=60 + 340 * arm["tokens_in"] / biggest, alpha=0.75, edgecolor="#333")
        ax.annotate(arm["arm"], (x, recall), textcoords="offset points", xytext=(8, 6))
    ax.set_xlabel("Comments posted per review (noise proxy; lower is better)")
    ax.set_ylabel(f"Bug-catch recall@{k_max} (%)")
    ax.set_title(f"{summary['experiment']}: recall vs. comments (marker size = input tokens)")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return True


def write(summary: dict[str, Any], results: Path) -> dict[str, Path]:
    results.mkdir(parents=True, exist_ok=True)
    paths = {"summary": results / "summary.json", "report": results / "report.md"}
    paths["summary"].write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    paths["report"].write_text(to_markdown(summary), encoding="utf-8")
    if pareto_plot(summary, results / "pareto.png"):
        paths["plot"] = results / "pareto.png"
    return paths
