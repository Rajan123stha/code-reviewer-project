"""End-to-end smoke run without a model or network: `make eval-smoke`.

Builds a small git repository with ten known bugs, turns it into a benchmark manifest with
the real builder (fix mining and SZZ), reviews every case through the real TypeScript CLI
with scripted comments in place of a model, then scores the run and checks the numbers.

The scripted comments flag five of the ten bugs on the right line and one in the right file
but too far from the bug, so the expected metrics are known exactly.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from rlbench.cases import BuildConfig, build_repo_cases

from . import report, spec
from .runner import DEFAULT_CLI, CliReviewer, run_experiment

CASES = 10
GOOD = """\
export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price;
  }
  return sum;
}
"""
BUGGY = GOOD.replace("i < items.length", "i <= items.length")
BUG_LINE = 3


def _git(repo: Path, *args: str, date: str | None = None) -> None:
    env = dict(os.environ)
    if date:
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


def build_repo(repo: Path) -> None:
    """Ten modules; each gets a bug in one commit and its fix in a later one."""
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    for key, value in (
        ("user.email", "smoke@example.com"),
        ("user.name", "Smoke"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ):
        _git(repo, "config", key, value)
    day = 0

    def commit(message: str, files: dict[str, str]) -> None:
        nonlocal day
        day += 1
        for name, content in files.items():
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        _git(repo, "add", "-A")
        date = f"2026-{1 + day // 28:02d}-{1 + day % 28:02d}T12:00:00+00:00"
        _git(repo, "commit", "-q", "-m", message, date=date)

    commit("Add modules", {f"src/m{i}.js": GOOD for i in range(CASES)})
    for i in range(CASES):
        commit(f"Rework loop in m{i} (#{100 + i})", {f"src/m{i}.js": BUGGY})
    for i in range(CASES):
        commit(f"Fix off-by-one in m{i} (#{200 + i})", {f"src/m{i}.js": GOOD})


def scripted_comments() -> list[dict[str, Any]]:
    """What the fake model says for every review; comments on other files are rejected."""

    def comment(i: int, line: int, evidence: str) -> dict[str, Any]:
        return {
            "file": f"src/m{i}.js",
            "line": line,
            "category": "bug",
            "severity": "high",
            "claim": f"Problem in m{i}.",
            "evidence": evidence,
            "suggested_fix": None,
            "confidence": 0.9,
        }

    hits = [comment(i, BUG_LINE, "i <= items.length") for i in range(5)]
    # Right file, wrong place: three lines from the bug, outside the smoke tolerance of 1.
    near_miss = [comment(5, BUG_LINE + 3, "return sum;")]
    return hits + near_miss


def run(workdir: Path, cli: Path = DEFAULT_CLI) -> dict[str, Any]:
    # A private, cold cache: the run neither depends on nor pollutes the real eval caches.
    previous = os.environ.get("REVIEWLENS_CACHE")
    os.environ["REVIEWLENS_CACHE"] = str(workdir / "cache")
    try:
        return _run(workdir, cli)
    finally:
        if previous is None:
            del os.environ["REVIEWLENS_CACHE"]
        else:
            os.environ["REVIEWLENS_CACHE"] = previous


def _run(workdir: Path, cli: Path) -> dict[str, Any]:
    repo = workdir / "repo"
    build_repo(repo)
    built = build_repo_cases(repo, "smoke/repo", "MIT", BuildConfig())
    if len(built.cases) != CASES:
        raise AssertionError(f"expected {CASES} cases, built {len(built.cases)}: {built.dropped}")
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "benchmark": "A",
        "generator": {"name": "rlharness.smoke"},
        "repos": [],
        "cases": sorted(built.cases, key=lambda c: c["id"]),
        "cases_hash": "smoke",
    }
    manifest_path = workdir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    fake = workdir / "fake-llm.json"
    fake.write_text(json.dumps(scripted_comments()), encoding="utf-8")
    spec_path = workdir / "smoke.yaml"
    spec_path.write_text(
        "\n".join(
            [
                "name: smoke",
                "description: Synthetic end-to-end check; no model is called.",
                "manifest: manifest.json",
                "runs: 2",
                "k: [1, 10]",
                "matching: { line_tolerance: 1 }",
                "baseline: S0",
                "arms:",
                "  - { id: S0, strategy: S0 }",
                "  - { id: S3, strategy: S3 }",
            ]
        ),
        encoding="utf-8",
    )

    experiment = spec.load(spec_path)
    inputs, cases = spec.select_cases(manifest["cases"], experiment)
    results = workdir / "results"
    reviewer = CliReviewer(cli=cli, fake_llm=fake, repo_dir_of=lambda _name: repo)
    first = run_experiment(experiment, inputs, results, reviewer, log=lambda _line: None)
    # A second pass must find everything already done: the run is resumable.
    second = run_experiment(experiment, inputs, results, reviewer, log=lambda _line: None)
    summary = report.score(experiment, inputs, cases, results, manifest)
    paths = report.write(summary, results)

    expected_reviews = CASES * 2 * 2
    checks: dict[str, tuple[Any, Any]] = {
        "reviews completed": (first.completed, expected_reviews),
        "reviews failed": (first.failed, 0),
        "second pass reran": (second.completed, 0),
        "second pass skipped": (second.already_done, expected_reviews),
        "cases scored": (summary["cases_complete_in_all_arms"], CASES),
    }
    for arm in summary["arms"]:
        name = arm["arm"]
        checks[f"{name} recall@1"] = (round(arm["recall_at"]["1"]["mean"], 4), 0.5)
        checks[f"{name} recall@10"] = (round(arm["recall_at"]["10"]["mean"], 4), 0.5)
        checks[f"{name} file recall"] = (round(arm["file_recall_at_max_k"], 4), 0.6)
        checks[f"{name} localization"] = (round(arm["localization_accuracy"], 4), 0.8333)
        checks[f"{name} run sd"] = (arm["recall_at"]["10"]["run_sd"], 0.0)
        checks[f"{name} gt precision"] = (round(arm["ground_truth_precision"], 4), 0.8333)
    checks["S3 vs S0 recall difference"] = (summary["comparisons"][0]["recall_diff"], 0.0)
    failures = {k: v for k, v in checks.items() if v[0] != v[1]}
    if failures:
        raise AssertionError(f"smoke metrics differ from expected (got, want): {failures}")
    return {
        "summary": summary,
        "paths": {k: str(v) for k, v in paths.items()},
        "checks": len(checks),
    }


def main() -> int:
    if not DEFAULT_CLI.exists():
        print(f"CLI not built: {DEFAULT_CLI} (run `pnpm build`)", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="rl-smoke-") as tmp:
        result = run(Path(tmp))
        print(report.to_markdown(result["summary"]))
    print(f"eval-smoke ok: {result['checks']} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
