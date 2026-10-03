"""Build the filter's training set from eval harness result files.

One row per valid, unique candidate comment the pipeline produced for a change from a
training repository. Features are read as the pipeline stored them; nothing is recomputed.

Labels, in order of precedence:

1. `human`: a person labeled the comment in the harness's precision workflow
   (`comments/human.jsonl`): valid = 1; nitpick or invalid = 0.
2. `benchmark`: the comment lands within the experiment's line tolerance of a line the later
   bug fix changed = 1; otherwise 0. This is the harness's own matching rule. The zeros are
   noisy: a comment on a real problem the benchmark does not know about is labeled 0.

Rows from test repositories are dropped here, so a model cannot be trained on them by mistake.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rlharness.matching import comment_matches_any

from .features import FEATURES_VERSION, FeatureError, vectorize
from .split import Split

# Candidates the filter would be asked about: valid and not a duplicate.
SCORABLE_STATUSES = frozenset({"selected", "over_cap", "filtered"})


@dataclass
class BuildStats:
    result_files: int = 0
    rows: int = 0
    positives: int = 0
    dropped: Counter[str] = field(default_factory=Counter)
    by_repo: Counter[str] = field(default_factory=Counter)
    by_label_source: Counter[str] = field(default_factory=Counter)

    def to_dict(self) -> dict[str, Any]:
        return {
            "result_files": self.result_files,
            "rows": self.rows,
            "positives": self.positives,
            "dropped": dict(sorted(self.dropped.items())),
            "rows_by_repo": dict(sorted(self.by_repo.items())),
            "rows_by_label_source": dict(sorted(self.by_label_source.items())),
        }


def _file_key(input_key: str) -> str:
    # Same naming as the harness's result files (rlharness.spec.ReviewInput.file_key).
    return hashlib.sha1(input_key.encode()).hexdigest()[:16]


def _human_labels(experiment_dir: Path) -> dict[str, str]:
    path = experiment_dir / "comments" / "human.jsonl"
    if not path.exists():
        return {}
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    return {row["id"]: row["verdict"] for row in rows}  # the last verdict per item wins


def build(
    results_root: Path, manifest: dict[str, Any], split: Split
) -> tuple[list[dict[str, Any]], BuildStats]:
    """Collect rows from every `<results_root>/<experiment>/<spec hash>/runs/...` file."""
    cases_by_file: dict[str, list[dict[str, Any]]] = {}
    for case in manifest["cases"]:
        cases_by_file.setdefault(_file_key(case["input_key"]), []).append(case)

    stats = BuildStats()
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, int, str]] = set()
    for spec_path in sorted(results_root.glob("*/*/spec.json")):
        experiment_dir = spec_path.parent
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        tolerance = int(spec["line_tolerance"])
        human = _human_labels(experiment_dir)
        for path in sorted(experiment_dir.glob("runs/*/run*/*.json")):
            if path.name.endswith(".error.json"):
                continue
            cases = cases_by_file.get(path.stem)
            if not cases:
                stats.dropped["input_not_in_manifest"] += 1
                continue
            stats.result_files += 1
            repo = str(cases[0]["repo"])
            input_key = str(cases[0]["input_key"])
            arm = path.parent.parent.name
            run_index = int(path.parent.name.removeprefix("run"))
            run = json.loads(path.read_text(encoding="utf-8"))
            for candidate in run.get("candidates", []):
                if candidate["status"] not in SCORABLE_STATUSES:
                    stats.dropped[f"status_{candidate['status']}"] += 1
                    continue
                if split.side(repo) != "train":
                    stats.dropped["test_repo"] += 1
                    continue
                features = candidate.get("features")
                if run.get("featuresVersion") != FEATURES_VERSION or features is None:
                    stats.dropped["other_features_version"] += 1
                    continue
                try:
                    vectorize(features)
                except FeatureError:
                    stats.dropped["bad_features"] += 1
                    continue
                # Experiments that share a cached model response repeat the same comment.
                claim = hashlib.sha1(str(candidate["claim"]).encode()).hexdigest()[:12]
                identity = (
                    input_key,
                    str(features["strategy"]),
                    str(candidate["file"]),
                    int(candidate["line"]),
                    claim,
                )
                if identity in seen:
                    stats.dropped["repeat_of_cached_response"] += 1
                    continue
                seen.add(identity)

                # The id the harness gives a sampled comment (rlharness.comments.collect).
                item = f"{arm}|{run_index}|{input_key}|{candidate['index']}"
                verdict = human.get(hashlib.sha1(item.encode()).hexdigest()[:16])
                if verdict is not None:
                    label, source = int(verdict == "valid"), "human"
                else:
                    label = int(comment_matches_any(candidate, cases, tolerance))
                    source = "benchmark"
                rows.append(
                    {
                        "id": hashlib.sha1("|".join(map(str, identity)).encode()).hexdigest()[:16],
                        "repo": repo,
                        "input_key": input_key,
                        # One review: the unit the filter ranks within.
                        "review": f"{experiment_dir.parent.name}/{arm}/run{run_index}/{input_key}",
                        "status": candidate["status"],
                        "label": label,
                        "label_source": source,
                        "features": features,
                    }
                )
                stats.by_repo[repo] += 1
                stats.by_label_source[source] += 1
                stats.positives += label
    rows.sort(key=lambda r: (r["repo"], r["review"], r["id"]))
    stats.rows = len(rows)
    return rows, stats


def content_hash(rows: list[dict[str, Any]]) -> str:
    canonical = json.dumps(rows, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def save(rows: list[dict[str, Any]], stats: BuildStats, split: Split, path: Path) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
    path.write_text(lines, encoding="utf-8", newline="\n")
    meta = {
        "features_version": FEATURES_VERSION,
        "dataset_hash": content_hash(rows),
        "manifest_hash": split.manifest_hash,
        "split_seed": split.seed,
        "train_repos": sorted(split.train_repos),
        **stats.to_dict(),
    }
    path.with_suffix(".meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return meta


def load(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
