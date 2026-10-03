"""Optional enrichment from the GitHub API: issue labels and dates for referenced numbers.

The benchmark builds without it. With a token (GITHUB_TOKEN) it adds two checks that git
history alone cannot make: whether a referenced issue carries a bug label, and whether the
commit SZZ blamed is newer than the issue report (in which case it cannot be the cause).

Every response is cached on disk, so a rebuild makes no repeat requests. The client stops
and waits when the rate limit is exhausted.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BUG_LABEL_WORDS = ("bug", "regression", "defect", "crash", "confirmed")

# (url, headers) -> (status, headers, body). Injectable for tests.
Fetch = Callable[[str, dict[str, str]], tuple[int, dict[str, str], str]]


def _urllib_fetch(url: str, headers: dict[str, str]) -> tuple[int, dict[str, str], str]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return (
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as error:
        return (
            error.code,
            {k.lower(): v for k, v in error.headers.items()},
            error.read().decode("utf-8", errors="replace"),
        )


@dataclass
class IssueInfo:
    number: int
    kind: str  # "issue" | "pull_request" | "missing"
    labels: list[str]
    created_at: str | None
    closed_at: str | None

    @property
    def bug_labeled(self) -> bool:
        return any(word in label.lower() for label in self.labels for word in BUG_LABEL_WORDS)


class GitHubClient:
    def __init__(
        self,
        token: str,
        cache_dir: Path,
        fetch: Fetch = _urllib_fetch,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.token = token
        self.cache_dir = cache_dir
        self.fetch = fetch
        self.sleep = sleep
        self.now = now
        self.requests = 0

    def issue(self, repo: str, number: int) -> IssueInfo:
        cache = self.cache_dir / repo.replace("/", "__") / f"issue-{number}.json"
        if cache.exists():
            return IssueInfo(**json.loads(cache.read_text(encoding="utf-8")))
        info = self._fetch_issue(repo, number)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(info.__dict__), encoding="utf-8")
        return info

    def _fetch_issue(self, repo: str, number: int) -> IssueInfo:
        url = f"https://api.github.com/repos/{repo}/issues/{number}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "rlbench",
        }
        for _attempt in range(5):
            status, response_headers, body = self.fetch(url, headers)
            self.requests += 1
            if status == 200:
                data: dict[str, Any] = json.loads(body)
                return IssueInfo(
                    number=number,
                    kind="pull_request" if "pull_request" in data else "issue",
                    labels=[label["name"] for label in data.get("labels", [])],
                    created_at=data.get("created_at"),
                    closed_at=data.get("closed_at"),
                )
            if status in (404, 410):
                return IssueInfo(number, "missing", [], None, None)
            if status in (403, 429):
                # Primary limit: wait for the reset. Secondary limit: honor retry-after.
                retry_after = response_headers.get("retry-after")
                reset = response_headers.get("x-ratelimit-reset")
                if retry_after:
                    wait = float(retry_after)
                elif response_headers.get("x-ratelimit-remaining") == "0" and reset:
                    wait = max(0.0, float(reset) - self.now()) + 1
                else:
                    raise RuntimeError(f"GitHub API {status} for {url}: {body[:200]}")
                self.sleep(wait)
                continue
            if status >= 500:
                self.sleep(5)
                continue
            raise RuntimeError(f"GitHub API {status} for {url}: {body[:200]}")
        raise RuntimeError(f"GitHub API kept failing for {url}")


def enrich_case(case: dict[str, Any], client: GitHubClient) -> None:
    """Add `fix.issues`, `fix.bug_labeled` and `provenance.introduced_after_report`."""
    numbers = list(dict.fromkeys([*case["fix"].get("closes", []), *case["fix"]["references"]]))
    issues = [client.issue(case["repo"], n) for n in numbers[:5]]
    case["fix"]["issues"] = [
        {"number": i.number, "kind": i.kind, "labels": i.labels, "created_at": i.created_at}
        for i in issues
    ]
    reports = [i for i in issues if i.kind == "issue"]
    case["fix"]["bug_labeled"] = any(i.bug_labeled for i in issues)
    # A bug cannot be introduced after it was reported. ISO dates in UTC compare as text.
    introduced = case["introduced"]["committed_at"]
    earliest = min((i.created_at for i in reports if i.created_at), default=None)
    case["provenance"]["introduced_after_report"] = (
        None if earliest is None else _utc(introduced) > _utc(earliest)
    )


def _utc(iso: str) -> str:
    from datetime import datetime, timezone

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
