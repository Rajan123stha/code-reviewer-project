"""Command line for the learned filter.

rlfilter split     make the fixed train/test repository split (once)
rlfilter dataset   build the training set from eval result files
rlfilter train     cross-validate, write the report, save the model
rlfilter check     verify that training and evaluation data cannot overlap
rlfilter serve     run the scoring service
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from rlbench import manifest as manifest_io

from . import dataset, split, train
from . import model as model_io
from .app import resolve_model_path

SERVICE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = split.REPO_ROOT
DEFAULT_MANIFEST = REPO_ROOT / "eval" / "benchmark" / "manifests" / "benchmark-a.v1.json"
DEFAULT_RESULTS = REPO_ROOT / "eval" / "results"
DEFAULT_DATASET = SERVICE_ROOT / "data" / "dataset.v1.jsonl"
DEFAULT_MODELS = SERVICE_ROOT / "models"
DEFAULT_REPORTS = SERVICE_ROOT / "reports"
EXPERIMENTS = REPO_ROOT / "eval" / "harness" / "experiments"


def cmd_split(args: argparse.Namespace) -> int:
    if args.out.exists() and not args.force:
        print(f"{args.out} exists. The split is fixed; pass --force only to start over.")
        return 1
    made = split.make(manifest_io.load(args.manifest), args.seed, args.test_share)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(made, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(made['train_repos'])} train / {len(made['test_repos'])} test repos -> {args.out}")
    return 0


def cmd_dataset(args: argparse.Namespace) -> int:
    rows, stats = dataset.build(
        args.results, manifest_io.load(args.manifest), split.load(args.split)
    )
    if args.feedback:
        rows = dataset.merge_feedback(
            rows, dataset.load(args.feedback), split.load(args.split), stats
        )
    meta = dataset.save(rows, stats, split.load(args.split), args.out)
    print(json.dumps(meta, indent=2))
    print(f"wrote {len(rows)} rows -> {args.out}")
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    rows = dataset.load(args.dataset)
    dataset_hash = dataset.content_hash(rows)
    model, report = train.run(rows, split.load(args.split), dataset_hash, seed=args.seed)
    report_dir = args.reports / dataset_hash
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "metrics.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    markdown = train.to_markdown(report)
    (report_dir / "report.md").write_text(markdown, encoding="utf-8", newline="\n")
    model_path = args.models / f"{model.version}.json"
    model.save(model_path)
    (args.models / "current.json").write_text(
        json.dumps({"model": model_path.name}) + "\n", encoding="utf-8", newline="\n"
    )
    print(markdown)
    print(f"model {model.version} -> {model_path}; report -> {report_dir}")
    return 0


def _spec_repos(path: Path) -> set[str]:
    import yaml

    raw: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return set((raw.get("cases") or {}).get("repos") or [])


def check(split_path: Path, dataset_path: Path, models_dir: Path, experiments: Path) -> list[str]:
    """Every way training data could meet evaluation data; returns the problems found."""
    problems: list[str] = []
    fixed = split.load(split_path)  # raises if the two sides overlap

    e5 = _spec_repos(experiments / "E5-filter.yaml")
    if e5 != set(fixed.test_repos):
        problems.append("E5-filter.yaml must review exactly the split's test repositories")
    f1 = _spec_repos(experiments / "F1-filter-data.yaml")
    if f1 != set(fixed.train_repos):
        problems.append("F1-filter-data.yaml must review exactly the split's train repositories")

    if dataset_path.exists():
        leaked = {r["repo"] for r in dataset.load(dataset_path)} & set(fixed.test_repos)
        if leaked:
            problems.append(f"dataset holds rows from test repositories: {sorted(leaked)}")
    for path in sorted(models_dir.glob("*.json")) if models_dir.exists() else []:
        if path.name == "current.json":
            continue
        trained_on = set(model_io.load(path).meta.get("train_repos", []))
        if not trained_on:
            problems.append(f"{path.name} does not record its training repositories")
        if trained_on & set(fixed.test_repos):
            problems.append(f"{path.name} was trained on test repositories")
    return problems


def cmd_check(args: argparse.Namespace) -> int:
    problems = check(args.split, args.dataset, args.models, EXPERIMENTS)
    for problem in problems:
        print(f"FAIL {problem}")
    if not problems:
        print("split hygiene ok: training and evaluation repositories are disjoint")
    return 1 if problems else 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .app import create_app

    model = model_io.load(resolve_model_path(args.model))
    print(f"serving {model.version} on http://{args.host}:{args.port}")
    uvicorn.run(create_app(model), host=args.host, port=args.port, log_level="warning")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rlfilter", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def paths(p: argparse.ArgumentParser) -> None:
        p.add_argument("--split", type=Path, default=split.DEFAULT_SPLIT)
        p.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)

    p = sub.add_parser("split", help="make the fixed repository split")
    p.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    p.add_argument("--out", type=Path, default=split.DEFAULT_SPLIT)
    p.add_argument("--seed", type=int, default=20261004)
    p.add_argument("--test-share", type=float, default=1 / 3)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_split)

    p = sub.add_parser("dataset", help="build the training set from eval results")
    paths(p)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--out", type=Path, default=DEFAULT_DATASET)
    p.add_argument(
        "--feedback", type=Path, help="labeled production comments (pnpm export:feedback)"
    )
    p.set_defaults(func=cmd_dataset)

    p = sub.add_parser("train", help="cross-validate and save the model")
    paths(p)
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    p.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    p.add_argument("--reports", type=Path, default=DEFAULT_REPORTS)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_train)

    p = sub.add_parser("check", help="verify train/test separation")
    paths(p)
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    p.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("serve", help="run the scoring service")
    p.add_argument("--model", type=Path, default=DEFAULT_MODELS, help="model file or directory")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    try:
        result: int = args.func(args)
    except (model_io.ModelError, split.SplitError, FileNotFoundError) as error:
        print(f"error: {error}")
        return 1
    return result


if __name__ == "__main__":
    sys.exit(main())
