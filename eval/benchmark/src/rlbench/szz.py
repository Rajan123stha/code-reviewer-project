"""Simplified SZZ: find the commit that introduced the lines a fix removed or changed.

Variant implemented ("szz-blame-v1"):

1. Take the fix commit's zero-context diff against its parent, product source files only.
2. For every line the fix deleted or replaced (ignoring blank, comment-only and
   punctuation-only lines), ask `git blame -w -M -C` at the parent which commit last
   changed that line.
3. The commit owning the largest share of those lines is the bug-introducing candidate.

Known weaknesses of blame-based SZZ, which the filters in cases.py and the manual
validation are there to bound:

- Fixes that only add lines (a missing check) have nothing to blame and are skipped.
- A line is blamed on the last commit to touch it, which may be a refactor that moved or
  reworded the buggy logic without introducing it.
- The fix may change lines that were fine in order to fix a bug that lives elsewhere.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from . import git
from .fixes import is_product_source, is_trivial_line

METHOD = "szz-blame-v1"


@dataclass(frozen=True)
class BlamedLine:
    fix_path: str  # path in the fix's parent
    fix_parent_line: int  # line number in the fix's parent
    content: str
    blamed_sha: str
    orig_path: str  # path in the blamed commit
    orig_line: int  # line number in the blamed commit


@dataclass
class SzzResult:
    fix_sha: str
    parent_sha: str
    lines: list[BlamedLine] = field(default_factory=list)
    deleted_lines: int = 0  # deleted or replaced lines in product source
    trivial_lines: int = 0  # of those, skipped as trivial
    added_only_hunks: int = 0  # hunks with nothing to blame

    def by_commit(self) -> Counter[str]:
        return Counter(line.blamed_sha for line in self.lines)


def run(repo: Path, fix: git.Commit) -> SzzResult:
    if len(fix.parents) != 1:
        raise ValueError("SZZ needs a non-merge, non-root fix commit")
    parent = fix.parents[0]
    result = SzzResult(fix_sha=fix.sha, parent_sha=parent)

    for change in git.diff(repo, parent, fix.sha):
        path = change.old_path
        if path is None or not is_product_source(path):
            continue
        for hunk in change.hunks:
            if hunk.old_count == 0:
                result.added_only_hunks += 1
                continue
            result.deleted_lines += hunk.old_count
            wanted = {
                hunk.old_start + i
                for i, content in enumerate(hunk.deleted)
                if not is_trivial_line(content)
            }
            result.trivial_lines += hunk.old_count - len(wanted)
            if not wanted:
                continue
            end = hunk.old_start + hunk.old_count - 1
            for line in git.blame(repo, parent, path, hunk.old_start, end):
                if line.final_line in wanted:
                    result.lines.append(
                        BlamedLine(
                            fix_path=path,
                            fix_parent_line=line.final_line,
                            content=line.content,
                            blamed_sha=line.sha,
                            orig_path=line.orig_path,
                            orig_line=line.orig_line,
                        )
                    )
    return result
