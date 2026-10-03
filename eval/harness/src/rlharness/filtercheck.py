"""Guards for experiments that use the learned filter.

Before any review runs, the harness asks the filter service which model it serves and which
repositories that model was trained on, then refuses to continue if the experiment would
review one of them, or if earlier results of this experiment came from another model.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

from .spec import ReviewInput


class FilterCheckError(RuntimeError):
    pass


def fetch_health(url: str, timeout: float = 10) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=timeout) as response:
            health: dict[str, Any] = json.load(response)
    except OSError as error:
        raise FilterCheckError(
            f"filter service not reachable at {url} ({error}). Start it with "
            "`python -m rlfilter.cli serve` and set FILTER_URL."
        ) from error
    return health


def check_filter(
    health: dict[str, Any], inputs: list[ReviewInput], results: Path
) -> dict[str, Any]:
    """Validate the served model for this experiment and pin it in `filter.json`."""
    trained_on = set(health.get("train_repos") or [])
    if not trained_on:
        raise FilterCheckError(
            "the filter model does not say which repositories it was trained on; "
            "evaluating it could leak training data"
        )
    leaked = sorted(trained_on & {i.repo for i in inputs})
    if leaked:
        raise FilterCheckError(
            "the filter was trained on repositories this experiment reviews: " + ", ".join(leaked)
        )
    identity = {
        "model_version": health["model_version"],
        "features_version": health["features_version"],
        "dataset_hash": health.get("dataset_hash"),
        "train_repos": sorted(trained_on),
    }
    record = results / "filter.json"
    if record.exists():
        previous = json.loads(record.read_text(encoding="utf-8"))
        if previous["model_version"] != identity["model_version"]:
            raise FilterCheckError(
                f"earlier results here used filter {previous['model_version']}, but the service "
                f"serves {identity['model_version']}. Serve the earlier model or use a new "
                "results directory."
            )
    results.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
    return identity
