"""Filter evaluation: leave-one-repo-out predictions, ranking and calibration metrics, sweeps.

Every metric here is computed on out-of-fold scores: the score of a comment comes from a
model that saw no comment from that comment's repository.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

from .model import Matrix, Model, ModelError, Vector

Fitter = Callable[[Matrix, Vector, int], Model]


def auroc(labels: Sequence[float], scores: Sequence[float]) -> float:
    """Probability that a random positive outscores a random negative (ties count half)."""
    pairs = sorted(zip(scores, labels, strict=True))
    n_pos = sum(1 for _, y in pairs if y)
    n_neg = len(pairs) - n_pos
    if n_pos == 0 or n_neg == 0:
        return math.nan
    rank_sum = 0.0
    i = 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        average_rank = (i + 1 + j) / 2  # ranks i+1 .. j share their mean
        rank_sum += average_rank * sum(1 for _, y in pairs[i:j] if y)
        i = j
    return (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def average_precision(labels: Sequence[float], scores: Sequence[float]) -> float:
    """Mean of the precision at each positive, walking down the scores."""
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    hits = 0
    total = 0.0
    for position, i in enumerate(order, start=1):
        if labels[i]:
            hits += 1
            total += hits / position
    return total / hits if hits else math.nan


def brier(labels: Sequence[float], scores: Sequence[float]) -> float:
    return sum((s - y) ** 2 for s, y in zip(scores, labels, strict=True)) / len(labels)


def reliability(
    labels: Sequence[float], scores: Sequence[float], bins: int = 10
) -> list[dict[str, float]]:
    """Equal-width score bins: how often comments scored about p are in fact useful."""
    out: list[dict[str, float]] = []
    for b in range(bins):
        low, high = b / bins, (b + 1) / bins
        members = [
            i for i, s in enumerate(scores) if low <= s < high or (b == bins - 1 and s == 1.0)
        ]
        if not members:
            continue
        out.append(
            {
                "low": low,
                "high": high,
                "count": float(len(members)),
                "mean_score": sum(scores[i] for i in members) / len(members),
                "positive_rate": sum(labels[i] for i in members) / len(members),
            }
        )
    return out


def expected_calibration_error(
    labels: Sequence[float], scores: Sequence[float], bins: int = 10
) -> float:
    table = reliability(labels, scores, bins)
    return sum(r["count"] * abs(r["mean_score"] - r["positive_rate"]) for r in table) / len(labels)


def precision_at_k(
    labels: Sequence[float], scores: Sequence[float], groups: Sequence[str], k: int
) -> float:
    """Share of useful comments among each review's k best-scored, pooled over reviews.

    This is the number that matters in use: the filter picks what to post per review.
    """
    by_group: dict[str, list[int]] = {}
    for i, g in enumerate(groups):
        by_group.setdefault(g, []).append(i)
    kept = hits = 0
    for members in by_group.values():
        # Ties broken by original order, so the result does not depend on dict ordering.
        top = sorted(members, key=lambda i: (-scores[i], i))[:k]
        kept += len(top)
        hits += sum(1 for i in top if labels[i])
    return hits / kept if kept else math.nan


def loro_scores(
    x: Matrix, y: Vector, repos: Sequence[str], fit: Fitter, seed: int = 0
) -> tuple[Vector, list[str]]:
    """Leave-one-repo-out: score each repository with a model trained on all the others.

    Returns the out-of-fold scores (NaN where a fold could not be fitted) and the
    repositories skipped because the remaining data had a single class.
    """
    names = sorted(set(repos))
    if len(names) < 2:
        raise ModelError("leave-one-repo-out needs at least two repositories")
    repo_of = np.asarray(repos)
    scores = np.full(len(y), np.nan, dtype=np.float64)
    skipped: list[str] = []
    for held_out in names:
        test = repo_of == held_out
        train = ~test
        assert not (set(repo_of[train]) & {held_out})
        if len(np.unique(y[train])) < 2:
            skipped.append(held_out)
            continue
        scores[test] = fit(x[train], y[train], seed).predict(x[test])
    return scores, skipped


def bootstrap_ci(
    metric: Callable[[list[float], list[float]], float],
    labels: Sequence[float],
    scores: Sequence[float],
    clusters: Sequence[str],
    resamples: int = 1000,
    seed: int = 0,
) -> tuple[float, float]:
    """95% percentile interval, resampling whole clusters (repositories).

    Comments from one repository are not independent, so rows are not resampled singly.
    """
    by_cluster: dict[str, list[int]] = {}
    for i, c in enumerate(clusters):
        by_cluster.setdefault(c, []).append(i)
    names = sorted(by_cluster)
    rng = random.Random(seed)
    values: list[float] = []
    for _ in range(resamples):
        rows = [i for _ in names for i in by_cluster[rng.choice(names)]]
        value = metric([labels[i] for i in rows], [scores[i] for i in rows])
        if not math.isnan(value):
            values.append(value)
    if not values:
        return (math.nan, math.nan)
    values.sort()
    return (
        values[int(0.025 * (len(values) - 1))],
        values[int(math.ceil(0.975 * (len(values) - 1)))],
    )


def summarize(
    labels: Sequence[float],
    scores: Sequence[float],
    groups: Sequence[str],
    repos: Sequence[str],
    ks: Sequence[int] = (1, 3, 5),
    seed: int = 0,
) -> dict[str, Any]:
    low, high = bootstrap_ci(auroc, labels, scores, repos, seed=seed)
    return {
        "rows": len(labels),
        "positives": int(sum(labels)),
        "auroc": auroc(labels, scores),
        "auroc_ci95": [low, high],
        "average_precision": average_precision(labels, scores),
        "precision_at": {str(k): precision_at_k(labels, scores, groups, k) for k in ks},
        "brier": brier(labels, scores),
        "ece": expected_calibration_error(labels, scores),
        "reliability": reliability(labels, scores),
    }


def threshold_sweep(
    labels: Sequence[float],
    scores: Sequence[float],
    groups: Sequence[str],
    thresholds: Sequence[float],
) -> list[dict[str, float]]:
    """What each threshold keeps: the trade the filter offers, before any review is rerun."""
    reviews = len(set(groups))
    positives = sum(labels)
    out: list[dict[str, float]] = []
    for t in thresholds:
        kept = [i for i, s in enumerate(scores) if s >= t]
        kept_pos = sum(labels[i] for i in kept)
        out.append(
            {
                "threshold": t,
                "comments_kept_share": len(kept) / len(scores),
                "positives_kept_share": kept_pos / positives if positives else math.nan,
                "precision": kept_pos / len(kept) if kept else math.nan,
                "comments_per_review": len(kept) / reviews,
            }
        )
    return out


def thresholds_for_keep_shares(
    scores: Sequence[float], keep_shares: Sequence[float]
) -> dict[str, float]:
    """The score threshold that keeps about each given share of comments."""
    ordered = sorted(scores, reverse=True)
    out: dict[str, float] = {}
    for share in keep_shares:
        n = max(1, min(len(ordered), round(share * len(ordered))))
        out[f"{share:g}"] = ordered[n - 1]
    return out
