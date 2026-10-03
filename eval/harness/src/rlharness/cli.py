"""Command line for the eval harness.

rlharness run <experiment.yaml>       run the reviews that have no result yet
rlharness score <experiment.yaml>     compute metrics; write summary.json, report.md, pareto.png
rlharness comments <experiment.yaml>  sample posted comments for precision labeling
rlharness label <experiment.yaml>     label sampled comments (valid / nitpick / invalid)
rlharness judge <experiment.yaml>     run the LLM judge over the sampled comments
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from rlbench import manifest as manifest_io
from rlbench import validation

from . import comments as comments_mod
from . import report, spec
from .metrics import load_arm
from .runner import DEFAULT_CLI, REPO_ROOT, CliReviewer, repo_dir, run_experiment

RESULTS_ROOT = REPO_ROOT / "eval" / "results"
BENCH_VERDICTS = REPO_ROOT / "eval" / "benchmark" / "validation" / "verdicts.jsonl"


def results_dir(experiment: spec.Experiment, root: Path = RESULTS_ROOT) -> Path:
    """Results are keyed by the spec hash: changing the spec never mixes old and new runs."""
    return root / experiment.name / experiment.spec_hash()


def prepare(
    path: Path,
) -> tuple[spec.Experiment, dict[str, Any], list[spec.ReviewInput], list[dict[str, Any]]]:
    experiment = spec.load(path)
    missing = experiment.unavailable()
    if missing:
        raise SystemExit(
            f"{experiment.name} needs {', '.join(missing)}, which the pipeline does not have yet"
        )
    manifest = manifest_io.load(experiment.manifest)
    # Cases a human labeled invalid are not bugs; scoring against them would be noise.
    invalid = frozenset(
        case_id
        for case_id, verdict in validation.latest_by_case(
            validation.load_verdicts(BENCH_VERDICTS)
        ).items()
        if verdict.verdict == "invalid"
    )
    inputs, cases = spec.select_cases(manifest["cases"], experiment, invalid)
    return experiment, manifest, inputs, cases


def cmd_run(args: argparse.Namespace) -> int:
    experiment, _manifest, inputs, cases = prepare(args.experiment)
    results = results_dir(experiment, args.results)
    results.mkdir(parents=True, exist_ok=True)
    (results / "spec.json").write_text(
        __import__("json").dumps(experiment.identity(), indent=2) + "\n", encoding="utf-8"
    )
    total = len(inputs) * len(experiment.arms) * experiment.runs
    print(
        f"{experiment.name} [{experiment.spec_hash()}]: {len(inputs)} inputs ({len(cases)} cases) "
        f"x {len(experiment.arms)} arms x {experiment.runs} runs = {total} reviews"
    )
    if not args.cli.exists():
        raise SystemExit(f"CLI not built: {args.cli} (run `pnpm build`)")
    reviewer = CliReviewer(cli=args.cli, fake_llm=args.fake_llm)
    summary = run_experiment(
        experiment,
        inputs,
        results,
        reviewer,
        workers=args.workers,
        retry_failed=not args.no_retry_failed,
        limit=args.limit,
    )
    print(
        f"done: {summary.completed} new, {summary.already_done} already done, "
        f"{summary.failed} failed, {summary.remaining} remaining -> {results}"
    )
    if summary.stopped_for_quota:
        print("stopped: the model is rate-limited or unavailable. Run the same command to resume.")
        return 3
    return 1 if summary.failed else 0


def cmd_score(args: argparse.Namespace) -> int:
    experiment, manifest, inputs, cases = prepare(args.experiment)
    results = results_dir(experiment, args.results)
    summary = report.score(experiment, inputs, cases, results, manifest, cutoff=args.cutoff)
    paths = report.write(summary, results)
    print(report.to_markdown(summary))
    print("wrote " + ", ".join(str(p) for p in paths.values()))
    return 0


def cmd_comments(args: argparse.Namespace) -> int:
    experiment, _manifest, inputs, cases = prepare(args.experiment)
    results = results_dir(experiment, args.results)
    loaded = {a.id: load_arm(experiment, a, inputs, cases, results) for a in experiment.arms}
    all_comments = comments_mod.collect(loaded)
    items = comments_mod.sample_items(
        all_comments, {i.key: i for i in inputs}, repo_dir, args.size, args.seed
    )
    out = comments_mod.comments_dir(results) / "items.jsonl"
    comments_mod.write_jsonl(out, items)
    print(f"sampled {len(items)} of {len(all_comments)} posted comments -> {out}")
    return 0


def cmd_label(args: argparse.Namespace) -> int:
    experiment = spec.load(args.experiment)
    directory = comments_mod.comments_dir(results_dir(experiment, args.results))
    items = comments_mod.read_jsonl(directory / "items.jsonl")
    human_path = directory / "human.jsonl"
    done = comments_mod.latest(comments_mod.read_jsonl(human_path))
    todo = [i for i in items if i["id"] not in done]
    print(
        "valid: a real problem in the changed code that the author should act on.\n"
        "nitpick: true, but style, naming, formatting or negligible impact.\n"
        "invalid: wrong, unsupported by the code shown, or too vague to act on.\n"
    )
    for index, item in enumerate(todo, 1):
        # The arm is deliberately not shown, so labels cannot favor a strategy.
        print("=" * 100)
        print(item["diff"])
        print("-" * 100)
        print(f"{item['path']}:{item['line']}  [{item['severity']} {item['category']}]")
        print(f"claim:    {item['claim']}")
        print(f"evidence: {item['evidence']}")
        if item.get("suggested_fix"):
            print(f"fix:      {item['suggested_fix']}")
        while True:
            answer = input(f"[{index}/{len(todo)}] (v)alid (n)itpick (i)nvalid (s)kip (q)uit > ")
            choice = answer.strip().lower()[:1]
            if choice in ("v", "n", "i", "s", "q"):
                break
        if choice == "q":
            break
        if choice == "s":
            continue
        verdict = {"v": "valid", "n": "nitpick", "i": "invalid"}[choice]
        note = input("note (optional) > ").strip()
        comments_mod.append_human(human_path, item["id"], verdict, note, args.labeler)
    return 0


def cmd_judge(args: argparse.Namespace) -> int:
    experiment = spec.load(args.experiment)
    directory = comments_mod.comments_dir(results_dir(experiment, args.results))
    items = directory / "items.jsonl"
    if not items.exists():
        raise SystemExit("no sampled comments; run `rlharness comments` first")
    cmd = [
        "node",
        str(args.cli),
        "judge",
        "--in",
        str(items),
        "--out",
        str(directory / "judge.jsonl"),
    ]
    if args.fake_llm:
        cmd += ["--fake-llm", "scripted"]
    if args.model:
        cmd += ["--model", args.model]
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rlharness", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("experiment", type=Path)
        p.add_argument("--results", type=Path, default=RESULTS_ROOT)

    p = sub.add_parser("run", help="run reviews that have no result yet")
    common(p)
    p.add_argument("--workers", type=int, default=1, help="reviews in parallel (default 1)")
    p.add_argument("--limit", type=int, help="run at most this many reviews, then stop")
    p.add_argument("--no-retry-failed", action="store_true")
    p.add_argument("--cli", type=Path, default=DEFAULT_CLI)
    p.add_argument("--fake-llm", type=Path, help="scripted comments; no model is called")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("score", help="compute metrics and write the report")
    common(p)
    p.add_argument("--cutoff", help="ISO date; also report recall for cases before/after it")
    p.set_defaults(func=cmd_score)

    p = sub.add_parser("comments", help="sample posted comments for precision labeling")
    common(p)
    p.add_argument("--size", type=int, default=200)
    p.add_argument("--seed", type=int, default=1)
    p.set_defaults(func=cmd_comments)

    p = sub.add_parser("label", help="label sampled comments")
    common(p)
    p.add_argument(
        "--labeler", default=os.environ.get("USERNAME") or os.environ.get("USER") or "me"
    )
    p.set_defaults(func=cmd_label)

    p = sub.add_parser("judge", help="run the LLM judge over sampled comments")
    common(p)
    p.add_argument("--cli", type=Path, default=DEFAULT_CLI)
    p.add_argument("--model")
    p.add_argument("--fake-llm", action="store_true")
    p.set_defaults(func=cmd_judge)

    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
