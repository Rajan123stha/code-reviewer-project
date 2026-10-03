"""Thin, read-only wrappers around the git CLI.

Only plumbing that reads objects is used (log, diff, blame, show, rev-parse). Nothing from a
mined repository is ever executed; external diff drivers and textconv filters are disabled.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# ASCII record/unit separators cannot appear in commit messages or paths.
RS = "\x1e"
US = "\x1f"


class GitError(RuntimeError):
    pass


def run(repo: Path | None, *args: str, check: bool = True) -> str:
    cmd = ["git"]
    if repo is not None:
        cmd += ["-C", str(repo)]
    cmd += list(args)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and proc.returncode != 0:
        raise GitError(f"git {' '.join(args[:3])} failed: {proc.stderr.strip()[:300]}")
    return proc.stdout


def version() -> str:
    return run(None, "--version").strip()


def clone_bare(url: str, dest: Path) -> None:
    """Full-history bare clone of the default branch (blame needs every blob)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(None, "clone", "--bare", "--single-branch", "--no-tags", "--quiet", url, str(dest))


def head_sha(repo: Path) -> str:
    return run(repo, "rev-parse", "HEAD").strip()


def default_branch(repo: Path) -> str:
    return run(repo, "symbolic-ref", "--short", "HEAD", check=False).strip() or "HEAD"


@dataclass(frozen=True)
class Commit:
    sha: str
    parents: tuple[str, ...]
    committed_at: str  # ISO 8601
    subject: str
    body: str
    files: tuple[str, ...] = field(default=())

    @property
    def message(self) -> str:
        return f"{self.subject}\n\n{self.body}".strip()

    @property
    def is_merge(self) -> bool:
        return len(self.parents) > 1


_LOG_FORMAT = f"{RS}%H{US}%P{US}%cI{US}%s{US}%b{US}"


def log(repo: Path, rev: str = "HEAD", limit: int | None = None) -> list[Commit]:
    """Commits reachable from `rev`, newest first, with the paths each one touched."""
    args = ["log", rev, f"--format={_LOG_FORMAT}", "--name-only"]
    if limit is not None:
        args.append(f"-n{limit}")
    commits: list[Commit] = []
    for record in run(repo, *args).split(RS):
        parts = record.split(US)
        if len(parts) < 6:
            continue
        sha, parents, date, subject, body, files = parts[:6]
        commits.append(
            Commit(
                sha=sha.strip(),
                parents=tuple(parents.split()),
                committed_at=date.strip(),
                subject=subject.strip(),
                body=body.strip(),
                files=tuple(f.strip() for f in files.split("\n") if f.strip()),
            )
        )
    return commits


def show_commit(repo: Path, sha: str) -> Commit:
    commits = log(repo, sha, limit=1)
    if not commits:
        raise GitError(f"commit not found: {sha}")
    return commits[0]


@dataclass(frozen=True)
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    deleted: tuple[str, ...]  # contents of removed lines, in order
    added: tuple[str, ...]


@dataclass(frozen=True)
class FileChange:
    old_path: str | None
    new_path: str | None
    hunks: tuple[Hunk, ...]

    def added_lines(self) -> set[int]:
        """New-side line numbers this change added."""
        return {h.new_start + i for h in self.hunks for i in range(h.new_count)}


_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _strip_prefix(path: str) -> str | None:
    path = path.strip()
    if path == "/dev/null":
        return None
    if path.startswith('"') and path.endswith('"'):
        path = path[1:-1]
    return path[2:] if path[:2] in ("a/", "b/") else path


def diff(repo: Path, base: str, head: str, paths: list[str] | None = None) -> list[FileChange]:
    """Zero-context diff between two commits, as per-file hunks with line numbers."""
    args = [
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        base,
        head,
    ]
    if paths:
        args += ["--", *paths]
    return parse_diff(run(repo, *args))


def parse_diff(text: str) -> list[FileChange]:
    changes: list[FileChange] = []
    old_path: str | None = None
    new_path: str | None = None
    hunks: list[Hunk] = []
    current: tuple[int, int, int, int] | None = None
    deleted: list[str] = []
    added: list[str] = []
    in_file = False

    def close_hunk() -> None:
        nonlocal current, deleted, added
        if current is not None:
            hunks.append(Hunk(*current, tuple(deleted), tuple(added)))
        current, deleted, added = None, [], []

    def close_file() -> None:
        nonlocal hunks, in_file
        close_hunk()
        if in_file:
            changes.append(FileChange(old_path, new_path, tuple(hunks)))
        hunks = []

    for line in text.split("\n"):
        if line.startswith("diff --git "):
            close_file()
            in_file = True
            old_path = new_path = None
            match = re.match(r'^diff --git ("?a/.+?"?) ("?b/.+"?)$', line)
            if match:
                old_path, new_path = _strip_prefix(match.group(1)), _strip_prefix(match.group(2))
            continue
        if not in_file:
            continue
        if current is None:
            if line.startswith("--- "):
                old_path = _strip_prefix(line[4:])
                continue
            if line.startswith("+++ "):
                new_path = _strip_prefix(line[4:])
                continue
            if line.startswith("rename from "):
                old_path = line[len("rename from ") :].strip()
                continue
            if line.startswith("rename to "):
                new_path = line[len("rename to ") :].strip()
                continue
        match = _HUNK.match(line)
        if match:
            close_hunk()
            current = (
                int(match.group(1)),
                1 if match.group(2) is None else int(match.group(2)),
                int(match.group(3)),
                1 if match.group(4) is None else int(match.group(4)),
            )
            continue
        if current is not None:
            if line.startswith("-"):
                deleted.append(line[1:])
            elif line.startswith("+"):
                added.append(line[1:])
    close_file()
    return changes


@dataclass(frozen=True)
class NumStat:
    files: int
    added: int
    deleted: int


def numstat(repo: Path, base: str, head: str) -> NumStat:
    files = added = deleted = 0
    for line in run(repo, "diff", "--numstat", "--no-ext-diff", base, head).splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        added += int(parts[0]) if parts[0].isdigit() else 0
        deleted += int(parts[1]) if parts[1].isdigit() else 0
    return NumStat(files, added, deleted)


@dataclass(frozen=True)
class BlameLine:
    sha: str  # commit that last changed the line
    orig_path: str  # the line's path in that commit
    orig_line: int  # the line's number in that commit
    final_line: int  # the line's number in the blamed revision
    content: str


_BLAME_HEADER = re.compile(r"^([0-9a-f]{40}) (\d+) (\d+)")


def blame(repo: Path, rev: str, path: str, start: int, end: int) -> list[BlameLine]:
    """Blame lines start..end of `path` at `rev`.

    `-w` ignores whitespace-only changes and `-M -C` follows moved and copied lines, so a
    reformat or a file move is not mistaken for the origin of a line.
    """
    out = run(
        repo, "blame", "--line-porcelain", "-w", "-M", "-C", f"-L{start},{end}", rev, "--", path
    )
    lines: list[BlameLine] = []
    sha = ""
    orig_line = final_line = 0
    filename = path
    for line in out.split("\n"):
        header = _BLAME_HEADER.match(line)
        if header:
            sha, orig_line, final_line = header.group(1), int(header.group(2)), int(header.group(3))
        elif line.startswith("filename "):
            filename = line[len("filename ") :]
        elif line.startswith("\t"):
            lines.append(BlameLine(sha, filename, orig_line, final_line, line[1:]))
    return lines


def file_at(repo: Path, rev: str, path: str) -> str | None:
    proc = subprocess.run(
        ["git", "-C", str(repo), "show", "--no-textconv", f"{rev}:{path}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.stdout if proc.returncode == 0 else None
