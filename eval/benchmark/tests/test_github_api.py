from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from rlbench.github_api import GitHubClient, enrich_case


def _issue(labels: list[str], created: str, pull_request: bool = False) -> str:
    data: dict[str, Any] = {
        "labels": [{"name": name} for name in labels],
        "created_at": created,
        "closed_at": None,
    }
    if pull_request:
        data["pull_request"] = {}
    return json.dumps(data)


def _client(tmp_path: Path, responses: list[tuple[int, dict[str, str], str]]) -> GitHubClient:
    queue = list(responses)
    sleeps: list[float] = []

    def fetch(url: str, headers: dict[str, str]) -> tuple[int, dict[str, str], str]:
        assert headers["Authorization"] == "Bearer t"
        return queue.pop(0)

    client = GitHubClient("t", tmp_path, fetch=fetch, sleep=sleeps.append, now=lambda: 1000.0)
    client.sleeps = sleeps  # type: ignore[attr-defined]
    return client


def test_issue_is_fetched_once_and_cached(tmp_path: Path) -> None:
    client = _client(tmp_path, [(200, {}, _issue(["Bug", "p1"], "2026-01-05T00:00:00Z"))])
    first = client.issue("o/r", 7)
    assert (first.kind, first.labels, first.bug_labeled) == ("issue", ["Bug", "p1"], True)
    assert client.issue("o/r", 7) == first
    assert client.requests == 1


def test_missing_issue_and_pull_request_kind(tmp_path: Path) -> None:
    client = _client(
        tmp_path,
        [(404, {}, "{}"), (200, {}, _issue([], "2026-01-01T00:00:00Z", pull_request=True))],
    )
    assert client.issue("o/r", 1).kind == "missing"
    assert client.issue("o/r", 2).kind == "pull_request"


def test_waits_for_rate_limit_reset_then_retries(tmp_path: Path) -> None:
    client = _client(
        tmp_path,
        [
            (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1030"}, "limit"),
            (429, {"retry-after": "5"}, "secondary"),
            (200, {}, _issue(["enhancement"], "2026-01-01T00:00:00Z")),
        ],
    )
    info = client.issue("o/r", 3)
    assert info.bug_labeled is False
    assert client.sleeps == [31.0, 5.0]  # type: ignore[attr-defined]


def test_other_errors_are_raised(tmp_path: Path) -> None:
    client = _client(tmp_path, [(403, {}, "forbidden")])
    with pytest.raises(RuntimeError, match="403"):
        client.issue("o/r", 4)


def test_enrich_case_flags_labels_and_impossible_provenance(tmp_path: Path) -> None:
    case: dict[str, Any] = {
        "repo": "o/r",
        "introduced": {"committed_at": "2026-02-01T10:00:00+02:00"},
        "fix": {"references": [12, 11], "closes": [11]},
        "provenance": {},
    }
    client = _client(
        tmp_path,
        [
            (200, {}, _issue(["bug"], "2026-01-20T00:00:00Z")),  # issue 11, reported first
            (200, {}, _issue([], "2026-02-03T00:00:00Z", pull_request=True)),  # PR 12
        ],
    )
    enrich_case(case, client)
    assert case["fix"]["bug_labeled"] is True
    assert [i["number"] for i in case["fix"]["issues"]] == [11, 12]
    # Introduced on Feb 1, but the bug was reported on Jan 20: blame picked the wrong commit.
    assert case["provenance"]["introduced_after_report"] is True
