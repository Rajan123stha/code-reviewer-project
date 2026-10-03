"""Train and evaluate the filter: leave-one-repo-out CV for both models, then a final fit."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import evaluate
from .features import COLUMNS, FEATURES_VERSION, vectorize
from .model import FITTERS, Matrix, Model, ModelError, Vector
from .split import Split, assert_disjoint

SWEEP_THRESHOLDS = tuple(round(0.05 * i, 2) for i in range(0, 19))
KEEP_SHARES = (0.75, 0.5, 0.25)
# Fewer rows than this and the metrics are noise; training proceeds but the report says so.
MIN_ROWS_FOR_CLAIMS = 300
MIN_POSITIVES_FOR_CLAIMS = 30


def matrices(rows: list[dict[str, Any]]) -> tuple[Matrix, Vector]:
    x = np.asarray([vectorize(r["features"]) for r in rows], dtype=np.float64)
    y = np.asarray([float(r["label"]) for r in rows], dtype=np.float64)
    return x.reshape(len(rows), len(COLUMNS)), y


def run(
    rows: list[dict[str, Any]], split: Split, dataset_hash: str, seed: int = 0
) -> tuple[Model, dict[str, Any]]:
    """Cross-validate both models on the training repositories and fit the chosen one on all.

    The choice rule is fixed in advance: gradient boosting replaces logistic regression only
    if its out-of-fold AUROC is higher. Test repositories play no part.
    """
    repos = [str(r["repo"]) for r in rows]
    assert_disjoint(set(repos), set(split.test_repos))
    if not rows:
        raise ModelError("the dataset is empty")
    x, y = matrices(rows)
    labels = [float(v) for v in y]
    groups = [str(r["review"]) for r in rows]

    report: dict[str, Any] = {
        "features_version": FEATURES_VERSION,
        "dataset_hash": dataset_hash,
        "seed": seed,
        "rows": len(rows),
        "positives": int(y.sum()),
        "base_rate": float(y.mean()),
        "repos": sorted(set(repos)),
        "reviews": len(set(groups)),
        "enough_data_for_claims": bool(
            len(rows) >= MIN_ROWS_FOR_CLAIMS and y.sum() >= MIN_POSITIVES_FOR_CLAIMS
        ),
        "models": {},
    }

    # Reference point: rank by the reviewing model's own confidence, no learning.
    confidence = [float(r["features"]["confidence"]) for r in rows]
    report["baseline_llm_confidence"] = evaluate.summarize(
        labels, confidence, groups, repos, seed=seed
    )

    for kind, fit in FITTERS.items():
        scores, skipped = evaluate.loro_scores(x, y, repos, fit, seed)
        known = [i for i, s in enumerate(scores) if not math.isnan(s)]
        kept_scores = [float(scores[i]) for i in known]
        kept_labels = [labels[i] for i in known]
        kept_groups = [groups[i] for i in known]
        kept_repos = [repos[i] for i in known]
        summary = evaluate.summarize(kept_labels, kept_scores, kept_groups, kept_repos, seed=seed)
        summary["folds_skipped"] = skipped
        summary["sweep"] = evaluate.threshold_sweep(
            kept_labels, kept_scores, kept_groups, SWEEP_THRESHOLDS
        )
        summary["thresholds_for_keep_share"] = evaluate.thresholds_for_keep_shares(
            kept_scores, KEEP_SHARES
        )
        per_repo: dict[str, Any] = {}
        for repo in sorted(set(repos)):
            members = [i for i in known if repos[i] == repo]
            repo_labels = [labels[i] for i in members]
            per_repo[repo] = {
                "rows": len(members),
                "positives": int(sum(repo_labels)),
                "auroc": evaluate.auroc(repo_labels, [float(scores[i]) for i in members]),
            }
        summary["per_repo"] = per_repo
        report["models"][kind] = summary

    lr_auc = report["models"]["lr"]["auroc"]
    gbm_auc = report["models"]["gbm"]["auroc"]
    chosen = "gbm" if not math.isnan(gbm_auc) and gbm_auc > lr_auc else "lr"
    report["chosen"] = chosen
    report["choice_rule"] = "gbm only if its leave-one-repo-out AUROC exceeds lr's"

    model = FITTERS[chosen](x, y, seed)
    model.meta = {
        "dataset_hash": dataset_hash,
        "train_repos": sorted(set(repos)),
        "rows": len(rows),
        "positives": int(y.sum()),
        "seed": seed,
        "split_seed": split.seed,
        "manifest_hash": split.manifest_hash,
        "loro_auroc": report["models"][chosen]["auroc"],
        "thresholds_for_keep_share": report["models"][chosen]["thresholds_for_keep_share"],
    }
    report["model_version"] = model.version
    return model, report


def _pct(value: float | None) -> str:
    return "n/a" if value is None or math.isnan(value) else f"{100 * value:.1f}%"


def _num(value: float | None) -> str:
    return "n/a" if value is None or math.isnan(value) else f"{value:.3f}"


def to_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# Filter training report ({report['model_version']})",
        "",
        f"- Dataset `{report['dataset_hash']}`, {report['features_version']}, "
        f"seed {report['seed']}",
        f"- {report['rows']} comments from {report['reviews']} reviews of "
        f"{len(report['repos'])} repositories; {report['positives']} useful "
        f"({_pct(report['base_rate'])})",
        f"- Chosen model: **{report['chosen']}** ({report['choice_rule']})",
    ]
    if not report["enough_data_for_claims"]:
        lines += [
            "",
            f"> **Too little data for conclusions.** Fewer than {MIN_ROWS_FOR_CLAIMS} comments or "
            f"{MIN_POSITIVES_FOR_CLAIMS} useful ones. The numbers below show that the pipeline "
            "runs; they do not show that the filter works.",
        ]
    lines += [
        "",
        "## Leave-one-repo-out results",
        "",
        "Each comment is scored by a model that saw no comment from its repository.",
        "",
        "| Scorer | AUROC | 95% CI | Avg precision | P@1 | P@3 | P@5 | Brier | ECE |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    named = [
        ("LLM confidence (no learning)", report["baseline_llm_confidence"]),
        ("Logistic regression", report["models"]["lr"]),
        ("LightGBM", report["models"]["gbm"]),
    ]
    for name, m in named:
        low, high = m["auroc_ci95"]
        lines.append(
            f"| {name} | {_num(m['auroc'])} | {_num(low)} to {_num(high)} | "
            f"{_num(m['average_precision'])} | {_pct(m['precision_at']['1'])} | "
            f"{_pct(m['precision_at']['3'])} | {_pct(m['precision_at']['5'])} | "
            f"{_num(m['brier'])} | {_num(m['ece'])} |"
        )
    chosen = report["models"][report["chosen"]]
    lines += [
        "",
        "P@k: share of useful comments among each review's k best-scored. The interval resamples "
        "whole repositories. LLM confidence is not a calibrated probability, so its Brier and "
        "ECE are shown only for scale.",
        "",
        f"## Threshold sweep ({report['chosen']}, out-of-fold scores)",
        "",
        "| Threshold | Comments kept | Useful comments kept | Precision | Comments / review |",
        "| ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in chosen["sweep"]:
        lines.append(
            f"| {row['threshold']:.2f} | {_pct(row['comments_kept_share'])} | "
            f"{_pct(row['positives_kept_share'])} | {_pct(row['precision'])} | "
            f"{row['comments_per_review']:.2f} |"
        )
    lines += ["", "Thresholds that keep a given share of comments:", ""]
    for share, threshold in chosen["thresholds_for_keep_share"].items():
        lines.append(f"- keep {_pct(float(share))}: threshold {threshold:.3f}")
    if chosen["folds_skipped"]:
        lines += [
            "",
            "Folds skipped (one class left to train on): " + ", ".join(chosen["folds_skipped"]),
        ]
    lines += [
        "",
        "## Per repository (held out)",
        "",
        "| Repository | Comments | Useful | AUROC |",
        "| --- | ---: | ---: | ---: |",
    ]
    for repo, m in chosen["per_repo"].items():
        lines.append(f"| {repo} | {m['rows']} | {m['positives']} | {_num(m['auroc'])} |")
    lines += [
        "",
        "## Calibration (chosen model)",
        "",
        "| Score bin | Comments | Mean score | Useful |",
        "| --- | ---: | ---: | ---: |",
    ]
    for b in chosen["reliability"]:
        lines.append(
            f"| {b['low']:.1f} to {b['high']:.1f} | {int(b['count'])} | {_num(b['mean_score'])} | "
            f"{_pct(b['positive_rate'])} |"
        )
    return "\n".join(lines) + "\n"
