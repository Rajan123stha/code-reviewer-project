"""How many model calls an experiment still needs, and how long that takes on your keys.

Arms that differ only after the model has answered (verifier, filter, comment cap) send the
same review request, so the LLM cache serves all but the first of them. The plan counts
distinct review requests, plus each arm's verifier passes, which are separate calls.
Embedding calls (strategy S2) use a separate quota and are listed apart.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .runner import result_path
from .spec import Arm, Experiment, ReviewInput

# Config keys that change what happens after generation but not the review request itself.
POST_GENERATION_KEYS = frozenset(
    {
        "verifierPasses",
        "verifierThreshold",
        "verifierPromptVersion",
        "filterThreshold",
        "filterModel",
        "maxComments",
    }
)

# Requests per key per day on the free tier, as observed for gemini-3.5-flash in October 2026.
# Override with --daily-per-key; quotas differ by model and change without notice.
DEFAULT_DAILY_PER_KEY = 15


@dataclass
class Plan:
    reviews_total: int
    reviews_done: int
    review_calls: int
    verifier_calls: int
    s2_reviews: int
    keys: int
    daily_per_key: int

    @property
    def reviews_remaining(self) -> int:
        return self.reviews_total - self.reviews_done

    @property
    def calls(self) -> int:
        return self.review_calls + self.verifier_calls

    @property
    def days(self) -> float:
        per_day = self.keys * self.daily_per_key
        return math.inf if per_day == 0 else self.calls / per_day

    def to_text(self, name: str) -> str:
        days = "never (no keys)" if math.isinf(self.days) else f"{math.ceil(self.days)} day(s)"
        lines = [
            f"{name}: {self.reviews_done} of {self.reviews_total} reviews done, "
            f"{self.reviews_remaining} remaining",
            f"model calls needed: {self.calls} "
            f"({self.review_calls} reviews after cache sharing, {self.verifier_calls} verifier)",
            f"at {self.daily_per_key} calls per key per day with {self.keys} key(s): {days}",
        ]
        if self.s2_reviews:
            lines.append(
                f"plus embeddings for {self.s2_reviews} S2 review(s), on the embedding quota"
            )
        if self.keys and self.calls:
            needed = math.ceil(self.calls / self.daily_per_key)
            lines.append(f"keys needed to finish in one day: {needed}")
        return "\n".join(lines)


def _request_key(arm: Arm) -> str:
    """What decides the review request: strategy and every pre-generation config key."""
    config = {k: v for k, v in arm.config.items() if k not in POST_GENERATION_KEYS}
    return json.dumps({"strategy": arm.strategy, "config": config}, sort_keys=True)


def make_plan(
    experiment: Experiment,
    inputs: Iterable[ReviewInput],
    results: Path,
    keys: int,
    daily_per_key: int = DEFAULT_DAILY_PER_KEY,
) -> Plan:
    inputs = list(inputs)
    total = done = verifier = s2 = 0
    requests: set[tuple[str, int, str]] = set()
    for run_index in range(1, experiment.runs + 1):
        for item in inputs:
            for arm in experiment.arms:
                total += 1
                if result_path(results, arm, run_index, item).exists():
                    done += 1
                    continue
                requests.add((_request_key(arm), run_index, item.key))
                verifier += int(arm.config.get("verifierPasses", 0) or 0)
                s2 += arm.strategy == "S2"
    return Plan(
        reviews_total=total,
        reviews_done=done,
        review_calls=len(requests),
        verifier_calls=verifier,
        s2_reviews=s2,
        keys=keys,
        daily_per_key=daily_per_key,
    )


def count_keys(env_file: Path, environ: dict[str, Any]) -> int:
    """Number of Gemini keys configured, from the environment or .env. Never reads values out."""
    raw = environ.get("GEMINI_API_KEYS") or environ.get("GEMINI_API_KEY")
    if raw is None and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() in ("GEMINI_API_KEYS", "GEMINI_API_KEY") and value.strip():
                raw = value
                break
    if not raw:
        return 0
    return len([k for k in raw.replace(",", " ").split() if k.strip()])
