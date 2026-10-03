"""Run reviews for an experiment: one result file per (arm, run, input), resumable."""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .spec import Arm, Experiment, ReviewInput

REPO_ROOT = Path(__file__).resolve().parents[4]
# The built CLI: the same review-core pipeline that the production worker runs.
DEFAULT_CLI = REPO_ROOT / "apps" / "cli" / "dist" / "main.js"

# Exit code the CLI uses when the model was rate-limited or unavailable.
EXIT_TRANSIENT = 3


class QuotaExhausted(RuntimeError):
    """The model cannot serve more requests now; stop and resume later."""


class ReviewFailed(RuntimeError):
    pass


class Reviewer(Protocol):
    def review(self, item: ReviewInput, arm: Arm, run_index: int, out: Path) -> None:
        """Write the pipeline's run JSON to `out`, or raise."""


def cache_root() -> Path:
    root = os.environ.get("REVIEWLENS_CACHE") or str(Path.home() / ".cache" / "reviewlens")
    return Path(root)


def repo_dir(full_name: str) -> Path:
    return cache_root() / "repos" / f"{full_name.replace('/', '__')}.git"


@dataclass
class CliReviewer:
    """Runs the TypeScript CLI in a subprocess, once per review."""

    cli: Path = DEFAULT_CLI
    # Path to a JSON file of scripted comments: no model is called (tests, smoke runs).
    fake_llm: Path | None = None
    timeout_seconds: float = 20 * 60
    repo_dir_of: Callable[[str], Path] = repo_dir
    extra_args: tuple[str, ...] = ()

    def command(self, item: ReviewInput, arm: Arm, run_index: int, out: Path) -> list[str]:
        caches = cache_root() / "eval"
        cmd = [
            "node",
            str(self.cli),
            "review",
            "--git",
            str(self.repo_dir_of(item.repo)),
            "--base",
            item.base_sha,
            "--head",
            item.head_sha,
            "--strategy",
            arm.strategy,
            "--config-json",
            json.dumps(arm.config, sort_keys=True),
            # Each repeat of a config is a separate sample: the salt keeps the LLM cache
            # from returning run 1's answer for run 2, while a re-run of the same repeat
            # is served from the cache for free.
            "--salt",
            f"run-{run_index}",
            "--title",
            item.title,
            "--cache-dir",
            str(caches / "llm"),
            "--parse-cache",
            str(caches / "parse"),
            "--embed-cache",
            str(caches / "embed"),
            "--out",
            str(out),
            *self.extra_args,
        ]
        if self.fake_llm is not None:
            cmd += ["--fake-llm", str(self.fake_llm)]
        return cmd

    def review(self, item: ReviewInput, arm: Arm, run_index: int, out: Path) -> None:
        proc = subprocess.run(
            self.command(item, arm, run_index, out),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=self.timeout_seconds,
            cwd=REPO_ROOT,
        )
        if proc.returncode == 0:
            return
        last = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else ""
        detail = last[len("[error] ") :] if last.startswith("[error] ") else last[:300]
        if proc.returncode == EXIT_TRANSIENT:
            raise QuotaExhausted(detail)
        raise ReviewFailed(detail or f"exit code {proc.returncode}")


def result_path(results: Path, arm: Arm, run_index: int, item: ReviewInput) -> Path:
    return results / "runs" / arm.id / f"run{run_index}" / f"{item.file_key}.json"


@dataclass
class RunSummary:
    planned: int = 0
    already_done: int = 0
    completed: int = 0
    failed: int = 0
    stopped_for_quota: bool = False
    errors: list[str] = field(default_factory=list)

    @property
    def remaining(self) -> int:
        return self.planned - self.already_done - self.completed - self.failed


def run_experiment(
    experiment: Experiment,
    inputs: list[ReviewInput],
    results: Path,
    reviewer: Reviewer,
    workers: int = 1,
    retry_failed: bool = True,
    limit: int | None = None,
    log: Callable[[str], None] = print,
) -> RunSummary:
    """Run every (arm, run, input) that has no result yet.

    A finished review is a JSON file; a failed one leaves `<name>.error.json` beside it.
    Re-running skips finished reviews (and failed ones unless `retry_failed`), so an
    interrupted or quota-limited experiment continues where it stopped.

    Work is ordered run by run, input by input, arm by arm: if the experiment stops early,
    the inputs done so far are complete across all arms, which is what paired comparisons
    need.
    """
    summary = RunSummary()
    jobs: list[tuple[Arm, int, ReviewInput, Path]] = []
    for run_index in range(1, experiment.runs + 1):
        for item in inputs:
            for arm in experiment.arms:
                out = result_path(results, arm, run_index, item)
                summary.planned += 1
                if out.exists():
                    summary.already_done += 1
                    continue
                if not retry_failed and out.with_suffix(".error.json").exists():
                    summary.failed += 1
                    continue
                jobs.append((arm, run_index, item, out))
    if limit is not None:
        jobs = jobs[:limit]

    def work(job: tuple[Arm, int, ReviewInput, Path]) -> None:
        arm, run_index, item, out = job
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        reviewer.review(item, arm, run_index, tmp)
        json.loads(tmp.read_text(encoding="utf-8"))  # refuse to keep a truncated result
        out.with_suffix(".error.json").unlink(missing_ok=True)
        tmp.replace(out)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {}
        for job in jobs:
            if summary.stopped_for_quota:
                break
            futures[pool.submit(work, job)] = job
            if len(futures) >= workers:
                _drain(futures, summary, log, wait_all=False)
        _drain(futures, summary, log, wait_all=True)
    return summary


def _drain(
    futures: dict[Any, tuple[Arm, int, ReviewInput, Path]],
    summary: RunSummary,
    log: Callable[[str], None],
    wait_all: bool,
) -> None:
    for future in as_completed(list(futures)):
        arm, run_index, item, out = futures.pop(future)
        label = f"{arm.id} run{run_index} {item.repo}@{item.head_sha[:10]}"
        try:
            future.result()
            summary.completed += 1
            log(f"ok     {label}")
        except QuotaExhausted as error:
            summary.stopped_for_quota = True
            summary.errors.append(f"{label}: {error}")
            log(f"quota  {label}: {error}")
        except Exception as error:  # noqa: BLE001 - one bad case must not stop the run
            summary.failed += 1
            summary.errors.append(f"{label}: {error}")
            out.parent.mkdir(parents=True, exist_ok=True)
            out.with_suffix(".error.json").write_text(
                json.dumps({"error": str(error)}), encoding="utf-8"
            )
            log(f"failed {label}: {error}")
        if not wait_all:
            return
