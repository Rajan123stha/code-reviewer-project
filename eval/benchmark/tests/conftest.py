"""Synthetic git repositories with known bug histories."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


class RepoBuilder:
    """Builds a small repository commit by commit, with controlled dates."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._day = 0
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "user.name", "Test")
        self._git("config", "core.autocrlf", "false")
        self._git("config", "commit.gpgsign", "false")

    def _git(self, *args: str, env: dict[str, str] | None = None) -> str:
        proc = subprocess.run(
            ["git", "-C", str(self.path), *args],
            capture_output=True,
            text=True,
            env={**os.environ, **(env or {})},
            check=True,
        )
        return proc.stdout.strip()

    def commit(
        self,
        message: str,
        files: dict[str, str | None],
        days_later: int = 1,
    ) -> str:
        """Write (or delete, when the content is None) files and commit them."""
        for name, content in files.items():
            target = self.path / name
            if content is None:
                target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8", newline="\n")
        self._day += days_later
        date = f"2026-01-{self._day:02d}T12:00:00+00:00"
        self._git("add", "-A")
        self._git(
            "commit",
            "-q",
            "-m",
            message,
            env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date},
        )
        return self._git("rev-parse", "HEAD")

    def move(self, src: str, dst: str) -> None:
        (self.path / dst).parent.mkdir(parents=True, exist_ok=True)
        self._git("mv", src, dst)


@pytest.fixture
def repo(tmp_path: Path) -> RepoBuilder:
    path = tmp_path / "repo"
    path.mkdir()
    return RepoBuilder(path)


GOOD = """\
export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price;
  }
  return sum;
}

export function label(item) {
  return item.name;
}
"""

BUGGY = GOOD.replace("i < items.length", "i <= items.length")
