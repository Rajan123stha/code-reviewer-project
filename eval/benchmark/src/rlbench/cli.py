"""Command line for building and validating Benchmark A.

rlbench clone    clone the repositories in repos.json (bare, full history)
rlbench build    mine fix commits, run SZZ, apply filters, write the manifest
rlbench enrich   add issue labels and dates from the GitHub API (optional, needs a token)
rlbench stats    summarize a manifest (per repository, drop reasons, date split)
rlbench sample   draw a seeded validation sample
rlbench label    show sampled cases one by one and record verdicts
rlbench report   label-noise rate with a confidence interval; inter-labeler agreement
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__, git, manifest, validation
from .cases import BuildConfig, build_repo_cases, config_dict
from .github_api import GitHubClient, enrich_case
from .szz import METHOD

HERE = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = HERE / "manifests" / "benchmark-a.v1.json"
DEFAULT_VALIDATION = HERE / "validation"


def cache_dir() -> Path:
    """Clones live outside the project (they are large and must not be synced or committed)."""
    root = os.environ.get("REVIEWLENS_CACHE") or str(Path.home() / ".cache" / "reviewlens")
    return Path(root) / "repos"


def repo_dir(full_name: str) -> Path:
    return cache_dir() / f"{full_name.replace('/', '__')}.git"


def load_repos(path: Path) -> list[dict[str, str]]:
    repos: list[dict[str, str]] = json.loads(path.read_text(encoding="utf-8"))["repos"]
    return repos


def cmd_clone(args: argparse.Namespace) -> int:
    for repo in load_repos(args.repos):
        dest = repo_dir(repo["full_name"])
        if dest.exists():
            print(f"have   {repo['full_name']}")
            continue
        free_gb = shutil.disk_usage(dest.parent if dest.parent.exists() else Path.home()).free / 1e9
        if free_gb < args.min_free_gb:
            print(f"stop   {free_gb:.1f} GB free is below --min-free-gb {args.min_free_gb}")
            return 1
        print(f"clone  {repo['full_name']} ({free_gb:.1f} GB free)", flush=True)
        try:
            git.clone_bare(f"https://github.com/{repo['full_name']}.git", dest)
        except git.GitError as error:
            print(f"failed {repo['full_name']}: {error}")
            shutil.rmtree(dest, ignore_errors=True)
    return 0


def detected_license(directory: Path) -> str | None:
    for name in ("LICENSE", "LICENSE.md", "license", "LICENSE.txt", "LICENSE-MIT"):
        text = git.file_at(directory, "HEAD", name)
        if text:
            first = next((line.strip() for line in text.splitlines() if line.strip()), "")
            return first[:80]
    return None


def cmd_build(args: argparse.Namespace) -> int:
    config = BuildConfig(
        max_commits=args.max_commits,
        max_cases_per_repo=args.max_cases_per_repo,
        min_blame_share=args.min_blame_share,
        min_days_to_fix=args.min_days_to_fix,
    )
    repos_out: list[dict[str, Any]] = []
    cases: list[dict[str, Any]] = []
    for repo in load_repos(args.repos):
        directory = repo_dir(repo["full_name"])
        if not directory.exists():
            print(f"skip   {repo['full_name']} (not cloned)")
            continue
        result = build_repo_cases(directory, repo["full_name"], repo["license"], config)
        cases.extend(result.cases)
        repos_out.append(
            {
                "full_name": repo["full_name"],
                "url": f"https://github.com/{repo['full_name']}",
                "license": repo["license"],
                "license_file_first_line": detected_license(directory),
                "language": repo.get("language"),
                "default_branch": git.default_branch(directory),
                "head_sha": git.head_sha(directory),
                "scanned_commits": result.scanned_commits,
                "fix_commits": result.fix_commits,
                "cases": len(result.cases),
                "dropped": dict(sorted(result.dropped.items())),
                "not_fix_commits": dict(sorted(result.rejected_messages.items())),
            }
        )
        print(
            f"built  {repo['full_name']:28s} {len(result.cases):3d} cases from "
            f"{result.fix_commits} fix commits ({result.scanned_commits} scanned)",
            flush=True,
        )

    cases.sort(key=lambda c: c["id"])
    out: dict[str, Any] = {
        "schema_version": manifest.SCHEMA_VERSION,
        "benchmark": "A",
        "description": "Bug-introducing changes located with blame-based SZZ from later fixes.",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": {
            "name": "rlbench",
            "version": __version__,
            "szz_method": METHOD,
            "git": git.version(),
            "config": config_dict(config),
        },
        "repos": repos_out,
        "cases": cases,
    }
    out["cases_hash"] = manifest.content_hash(out)
    manifest.save(out, args.out)
    print(f"\nwrote  {len(cases)} cases from {len(repos_out)} repositories to {args.out}")
    print(f"       cases hash {out['cases_hash']}")
    return 0


def cmd_enrich(args: argparse.Namespace) -> int:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is not set; enrichment needs an authenticated client")
        return 2
    data = manifest.load(args.manifest)
    client = GitHubClient(token, cache_dir().parent / "github")
    for index, case in enumerate(data["cases"], 1):
        enrich_case(case, client)
        if index % 25 == 0:
            print(f"enriched {index}/{len(data['cases'])} ({client.requests} requests)", flush=True)
    data["enriched"] = {"source": "github-issues", "requests": client.requests}
    data["cases_hash"] = manifest.content_hash(data)
    manifest.save(data, args.out or args.manifest)
    labeled = sum(1 for c in data["cases"] if c["fix"].get("bug_labeled"))
    impossible = sum(1 for c in data["cases"] if c["provenance"].get("introduced_after_report"))
    print(f"bug-labeled: {labeled}/{len(data['cases'])}; introduced after report: {impossible}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    data = manifest.load(args.manifest)
    cases = data["cases"]
    print(f"{len(cases)} cases, {len(data['repos'])} repositories, hash {data.get('cases_hash')}")
    print(f"unique review inputs: {len({c['input_key'] for c in cases})}")
    dropped: Counter[str] = Counter()
    for repo in data["repos"]:
        dropped.update(repo["dropped"])
        print(f"  {repo['full_name']:28s} {repo['cases']:3d} cases / {repo['fix_commits']} fixes")
    print("dropped fix commits by reason:")
    for reason, count in dropped.most_common():
        print(f"  {count:5d}  {reason}")
    days = sorted(c["stats"]["days_to_fix"] for c in cases)
    gt = sorted(c["stats"]["ground_truth_lines"] for c in cases)
    if cases:
        print(f"days to fix: median {days[len(days) // 2]:.0f}, max {days[-1]:.0f}")
        print(f"ground-truth lines per case: median {gt[len(gt) // 2]}, max {gt[-1]}")
    if args.cutoff:
        split = manifest.split_by_date(cases, args.cutoff)
        print(f"relative to cutoff {args.cutoff}:")
        for name, group in split.items():
            print(f"  {name:18s} {len(group)}")
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    data = manifest.load(args.manifest)
    ids = validation.sample(data["cases"], args.size, args.seed)
    out = args.out or DEFAULT_VALIDATION / f"sample-seed{args.seed}-n{args.size}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"manifest_hash": data.get("cases_hash"), "seed": args.seed, "case_ids": ids}, indent=2
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"sampled {len(ids)} cases -> {out}")
    return 0


def cmd_label(args: argparse.Namespace) -> int:
    data = manifest.load(args.manifest)
    by_id = {c["id"]: c for c in data["cases"]}
    ids: list[str] = json.loads(args.sample.read_text(encoding="utf-8"))["case_ids"]
    done = validation.latest_by_case(validation.load_verdicts(args.verdicts), args.labeler)
    todo = [i for i in ids if i not in done and i in by_id]
    print(validation.GUIDE)
    print(f"{len(done)} labeled, {len(todo)} to go. Labeler: {args.labeler}\n")
    for index, case_id in enumerate(todo, 1):
        case = by_id[case_id]
        print(validation.render_case(case, repo_dir(case["repo"])))
        while True:
            answer = input(f"[{index}/{len(todo)}] (v)alid (i)nvalid (u)nsure (s)kip (q)uit > ")
            choice = answer.strip().lower()[:1]
            if choice in ("v", "i", "u", "s", "q"):
                break
        if choice == "q":
            break
        if choice == "s":
            continue
        verdict = {"v": "valid", "i": "invalid", "u": "unsure"}[choice]
        note = input("note (optional) > ").strip()
        validation.append_verdict(args.verdicts, case_id, verdict, note, args.labeler)
    print(json.dumps(validation.noise_report(validation.load_verdicts(args.verdicts)), indent=2))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    verdicts = validation.load_verdicts(args.verdicts)
    labelers = sorted({v.labeler for v in verdicts})
    report: dict[str, Any] = {"all": validation.noise_report(verdicts)}
    for labeler in labelers:
        report[labeler] = validation.noise_report(verdicts, labeler)
    if len(labelers) >= 2:
        first = validation.latest_by_case(verdicts, labelers[0])
        second = validation.latest_by_case(verdicts, labelers[1])
        report["agreement"] = {
            "labelers": labelers[:2],
            **validation.cohen_kappa(first, second),
        }
    print(json.dumps(report, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rlbench", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def add_manifest(p: argparse.ArgumentParser) -> None:
        p.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)

    p = sub.add_parser("clone", help="clone repositories")
    p.add_argument("--repos", type=Path, default=HERE / "repos.json")
    p.add_argument("--min-free-gb", type=float, default=1.5)
    p.set_defaults(func=cmd_clone)

    defaults = BuildConfig()
    p = sub.add_parser("build", help="build the case manifest")
    p.add_argument("--repos", type=Path, default=HERE / "repos.json")
    p.add_argument("--out", type=Path, default=DEFAULT_MANIFEST)
    p.add_argument("--max-commits", type=int, default=defaults.max_commits)
    p.add_argument("--max-cases-per-repo", type=int, default=defaults.max_cases_per_repo)
    p.add_argument("--min-blame-share", type=float, default=defaults.min_blame_share)
    p.add_argument("--min-days-to-fix", type=float, default=defaults.min_days_to_fix)
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("enrich", help="add issue labels and dates (needs GITHUB_TOKEN)")
    add_manifest(p)
    p.add_argument("--out", type=Path)
    p.set_defaults(func=cmd_enrich)

    p = sub.add_parser("stats", help="summarize a manifest")
    add_manifest(p)
    p.add_argument("--cutoff", help="ISO date (YYYY-MM-DD) to split cases by, e.g. a model cutoff")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("sample", help="draw a seeded validation sample")
    add_manifest(p)
    p.add_argument("--size", type=int, default=100)
    p.add_argument("--seed", type=int, default=20261003)
    p.add_argument("--out", type=Path)
    p.set_defaults(func=cmd_sample)

    p = sub.add_parser("label", help="record verdicts for a sample")
    add_manifest(p)
    p.add_argument("--sample", type=Path, required=True)
    p.add_argument("--verdicts", type=Path, default=DEFAULT_VALIDATION / "verdicts.jsonl")
    p.add_argument(
        "--labeler", default=os.environ.get("USERNAME") or os.environ.get("USER") or "me"
    )
    p.set_defaults(func=cmd_label)

    p = sub.add_parser("report", help="label-noise rate and agreement")
    p.add_argument("--verdicts", type=Path, default=DEFAULT_VALIDATION / "verdicts.jsonl")
    p.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
