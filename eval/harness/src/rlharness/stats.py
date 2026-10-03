"""Small, dependency-free statistics for comparing review strategies."""

from __future__ import annotations

import math
import random
from collections.abc import Sequence

DEFAULT_RESAMPLES = 2_000


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def sample_sd(values: Sequence[float]) -> float:
    """Sample standard deviation (n - 1); 0 for fewer than two values."""
    if len(values) < 2:
        return 0.0
    m = mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / (len(values) - 1))


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile, q in [0, 100]."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    position = (len(ordered) - 1) * q / 100
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def bootstrap_ci(
    values: Sequence[float],
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    confidence: float = 0.95,
) -> tuple[float, float]:
    """Percentile bootstrap interval for the mean of per-case values.

    The unit resampled is the case. When a config was run several times, pass each case's
    mean over runs, so the interval reflects case-to-case variation and is not narrowed by
    repeats of the same cases.
    """
    if not values:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    n = len(values)
    means = sorted(mean([values[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples))
    alpha = (1 - confidence) / 2
    return (percentile(means, 100 * alpha), percentile(means, 100 * (1 - alpha)))


def paired_bootstrap_diff(
    a: Sequence[float],
    b: Sequence[float],
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    confidence: float = 0.95,
) -> tuple[float, float, float]:
    """Mean of (a - b) over the same cases, with a percentile bootstrap interval.

    `a[i]` and `b[i]` must be the same case under two configs. Resampling whole pairs keeps
    the correlation between configs, which is what makes paired comparisons sensitive.
    """
    if len(a) != len(b):
        raise ValueError("paired samples must have the same length")
    diffs = [x - y for x, y in zip(a, b, strict=True)]
    if not diffs:
        return (float("nan"), float("nan"), float("nan"))
    low, high = bootstrap_ci(diffs, resamples, seed, confidence)
    return (mean(diffs), low, high)


def mcnemar_exact(only_a: int, only_b: int) -> float:
    """Two-sided exact McNemar p-value for paired binary outcomes.

    `only_a` is the number of cases config A caught and B missed, `only_b` the reverse.
    Cases both caught or both missed carry no information about the difference.
    """
    n = only_a + only_b
    if n == 0:
        return 1.0
    k = min(only_a, only_b)
    tail: float = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a proportion."""
    if total == 0:
        return (0.0, 1.0)
    p = successes / total
    denom = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def cohen_kappa(pairs: Sequence[tuple[str, str]]) -> float:
    """Agreement between two raters beyond chance, over (rater1, rater2) label pairs."""
    if not pairs:
        return float("nan")
    n = len(pairs)
    observed = sum(x == y for x, y in pairs) / n
    labels = {label for pair in pairs for label in pair}
    expected = sum(
        (sum(x == label for x, _ in pairs) / n) * (sum(y == label for _, y in pairs) / n)
        for label in labels
    )
    return 1.0 if expected == 1 else (observed - expected) / (1 - expected)
