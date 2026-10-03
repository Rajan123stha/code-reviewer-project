"""Turn fix commits into benchmark cases, with every filter decision recorded."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import git, szz
from .fixes import classify, is_product_source, pr_number_of


@dataclass(frozen=True)
class BuildConfig:
    """Every threshold that decides which cases exist. Stored in the manifest."""

    # Fix commits must reference an issue or pull request (#N).
    require_reference: bool = True
    # A fix that is small is more likely to be about one bug.
    max_fix_source_files: int = 5
    max_fix_changed_lines: int = 120
    # The introducing change is what the reviewer sees; huge diffs are refactors or imports.
    max_intro_files: int = 30
    max_intro_changed_lines: int = 1_500
    # Share of the fix's blamed lines that the chosen commit must own.
    min_blame_share: float = 0.6
    # A fix landing this soon after the change is often a follow-up to the same work.
    min_days_to_fix: float = 0.0
    # Newest commits scanned per repository, and cases kept per repository.
    max_commits: int = 6_000
    max_cases_per_repo: int = 60


def _days_between(earlier: str, later: str) -> float:
    return (
        datetime.fromisoformat(later) - datetime.fromisoformat(earlier)
    ).total_seconds() / 86_400


def _ranges(lines: list[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for n in sorted(set(lines)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


@dataclass
class RepoResult:
    cases: list[dict[str, Any]]
    scanned_commits: int
    fix_commits: int
    dropped: Counter[str]
    rejected_messages: Counter[str]


def build_repo_cases(
    repo_dir: Path,
    full_name: str,
    license_id: str,
    config: BuildConfig,
) -> RepoResult:
    commits = git.log(repo_dir, "HEAD", limit=config.max_commits)
    dropped: Counter[str] = Counter()
    rejected: Counter[str] = Counter()
    cases: list[dict[str, Any]] = []
    fix_commits = 0
    by_sha = {c.sha: c for c in commits}

    for fix in commits:
        if len(cases) >= config.max_cases_per_repo:
            break
        if len(fix.parents) != 1:
            continue
        signal = classify(fix.subject, fix.body, config.require_reference)
        if not signal.is_fix:
            rejected[signal.reason] += 1
            continue
        fix_commits += 1

        fix_sources = [f for f in fix.files if is_product_source(f)]
        if not fix_sources:
            dropped["fix_touches_no_product_source"] += 1
            continue
        if len(fix_sources) > config.max_fix_source_files:
            dropped["fix_too_many_files"] += 1
            continue
        fix_stat = git.numstat(repo_dir, fix.parents[0], fix.sha)
        if fix_stat.added + fix_stat.deleted > config.max_fix_changed_lines:
            dropped["fix_too_large"] += 1
            continue

        try:
            blamed = szz.run(repo_dir, fix)
        except git.GitError:
            # A blame that fails or times out leaves the provenance unknown.
            dropped["blame_failed"] += 1
            continue
        if not blamed.lines:
            dropped["nothing_to_blame"] += 1
            continue
        counts = blamed.by_commit()
        intro_sha, intro_lines = counts.most_common(1)[0]
        share = intro_lines / len(blamed.lines)
        if share < config.min_blame_share:
            dropped["ambiguous_provenance"] += 1
            continue

        intro = by_sha.get(intro_sha) or git.show_commit(repo_dir, intro_sha)
        if len(intro.parents) == 0:
            dropped["introduced_by_root_commit"] += 1
            continue
        if intro.is_merge:
            dropped["introduced_by_merge_commit"] += 1
            continue
        days = _days_between(intro.committed_at, fix.committed_at)
        if days < config.min_days_to_fix:
            dropped["fixed_too_soon"] += 1
            continue
        base_sha = intro.parents[0]
        intro_stat = git.numstat(repo_dir, base_sha, intro.sha)
        if (
            intro_stat.files > config.max_intro_files
            or intro_stat.added + intro_stat.deleted > config.max_intro_changed_lines
        ):
            dropped["intro_too_large"] += 1
            continue

        # Ground truth: blamed lines that the introducing commit itself added. Lines must be
        # in its diff, or a reviewer of that change could not have commented on them.
        added_by_path = {
            c.new_path: c.added_lines()
            for c in git.diff(repo_dir, base_sha, intro.sha)
            if c.new_path is not None
        }
        truth: dict[str, list[int]] = {}
        for line in blamed.lines:
            if line.blamed_sha != intro_sha:
                continue
            if line.orig_line in added_by_path.get(line.orig_path, set()):
                truth.setdefault(line.orig_path, []).append(line.orig_line)
        truth = {p: ls for p, ls in truth.items() if is_product_source(p)}
        if not truth:
            dropped["ground_truth_not_in_intro_diff"] += 1
            continue

        owner, name = full_name.split("/")
        gt_lines = sum(len(set(v)) for v in truth.values())
        cases.append(
            {
                "id": f"{owner}__{name}__{intro.sha[:10]}__{fix.sha[:10]}",
                "repo": full_name,
                "license": license_id,
                # The change under review: base...head is the bug-introducing commit.
                "base_sha": base_sha,
                "head_sha": intro.sha,
                # Cases sharing an input are the same review; the harness reviews it once.
                "input_key": f"{full_name}@{intro.sha}",
                "introduced": {
                    "sha": intro.sha,
                    "committed_at": intro.committed_at,
                    "subject": intro.subject,
                    "pr_number": pr_number_of(intro.subject),
                },
                "fix": {
                    "sha": fix.sha,
                    "committed_at": fix.committed_at,
                    "subject": fix.subject,
                    "pr_number": signal.pr_number,
                    "references": list(signal.references),
                    "closes": list(signal.closes),
                    "signal": signal.reason,
                    "files": list(fix_sources),
                },
                # Lines of the head commit that the fix later removed or rewrote.
                "ground_truth": [
                    {"path": path, "lines": sorted(set(lines)), "ranges": _ranges(lines)}
                    for path, lines in sorted(truth.items())
                ],
                "stats": {
                    "intro_files": intro_stat.files,
                    "intro_lines_added": intro_stat.added,
                    "intro_lines_deleted": intro_stat.deleted,
                    "fix_lines_added": fix_stat.added,
                    "fix_lines_deleted": fix_stat.deleted,
                    "ground_truth_lines": gt_lines,
                    "days_to_fix": round(days, 2),
                },
                "provenance": {
                    "method": szz.METHOD,
                    "blame_share": round(share, 3),
                    "blamed_lines": len(blamed.lines),
                    "blamed_on_introducing": intro_lines,
                    "other_blamed_commits": {
                        sha: n for sha, n in sorted(counts.items()) if sha != intro_sha
                    },
                    "fix_deleted_lines": blamed.deleted_lines,
                    "fix_trivial_lines_skipped": blamed.trivial_lines,
                    "fix_added_only_hunks": blamed.added_only_hunks,
                },
            }
        )

    return RepoResult(cases, len(commits), fix_commits, dropped, rejected)


def config_dict(config: BuildConfig) -> dict[str, Any]:
    return asdict(config)
