from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import BUGGY, GOOD, RepoBuilder

from rlbench import git, manifest, validation
from rlbench.cases import BuildConfig, build_repo_cases
from rlbench.cli import main
from rlbench.fixes import classify, is_product_source, is_trivial_line


@pytest.mark.parametrize(
    ("subject", "body", "is_fix", "reason"),
    [
        ("Fix stale array entries when merging (#812)", "", True, "fix_keyword"),
        ("fix(parser): handle empty input (#3)", "", True, "explicit_fix_type"),
        ("Handle null body", "Fixes #44", False, "no_fix_keyword"),
        ("Resolve crash when body is null", "Closes #44", True, "fix_keyword"),
        ("Fix crash when body is null", "", False, "no_reference"),
        ("Fix typo in README (#5)", "", False, "not_behavior"),
        ("docs: fix broken link (#5)", "", False, "non_fix_type"),
        ("chore(deps): bump got to fix audit (#9)", "", False, "non_fix_type"),
        ('Revert "Fix retry (#7)"', "This reverts commit abc.", False, "revert"),
        ("Add maxResponseSize option (#8)", "", False, "no_fix_keyword"),
        ("Fix flaky test (#10)", "", False, "not_behavior"),
    ],
)
def test_classify(subject: str, body: str, is_fix: bool, reason: str) -> None:
    signal = classify(subject, body)
    assert (signal.is_fix, signal.reason) == (is_fix, reason)


def test_classify_extracts_references() -> None:
    signal = classify("Fix retry timing (#120)", "Fixes #118 and closes #119. See org/other#5.")
    assert signal.references == (120, 118, 119)
    assert signal.closes == (118, 119)
    assert signal.pr_number == 120


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/core/Ky.ts", True),
        ("lib/index.mjs", True),
        ("index.js", True),
        ("test/main.ts", False),
        ("src/__tests__/a.ts", False),
        ("src/a.test.ts", False),
        ("types/index.d.ts", False),
        ("docs/guide.js", False),
        ("examples/demo.js", False),
        ("dist/index.js", False),
        ("src/a.css", False),
        ("README.md", False),
    ],
)
def test_is_product_source(path: str, expected: bool) -> None:
    assert is_product_source(path) is expected


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("", True),
        ("  }", True),
        ("  // note", True),
        (" * doc", True),
        ("  });", True),
        ("  return x;", False),
    ],
)
def test_is_trivial_line(line: str, expected: bool) -> None:
    assert is_trivial_line(line) is expected


def test_parse_diff_handles_renames_and_multiple_hunks() -> None:
    text = (
        "diff --git a/src/a.js b/src/b.js\n"
        "similarity index 90%\nrename from src/a.js\nrename to src/b.js\n"
        "--- a/src/a.js\n+++ b/src/b.js\n"
        "@@ -3 +3,2 @@ ctx\n-old\n+new1\n+new2\n"
        "@@ -10,0 +12 @@\n+added\n"
    )
    [change] = git.parse_diff(text)
    assert (change.old_path, change.new_path) == ("src/a.js", "src/b.js")
    assert [(h.old_start, h.old_count, h.new_start, h.new_count) for h in change.hunks] == [
        (3, 1, 3, 2),
        (10, 0, 12, 1),
    ]
    assert change.hunks[0].deleted == ("old",)
    assert change.added_lines() == {3, 4, 12}


def _case(
    case_id: str, repo: str, introduced: str = "2026-01-01", fixed: str = "2026-02-01"
) -> dict[str, Any]:
    return {
        "id": case_id,
        "repo": repo,
        "license": "MIT",
        "base_sha": "a" * 40,
        "head_sha": "b" * 40,
        "input_key": f"{repo}@{'b' * 40}",
        "introduced": {
            "sha": "b" * 40,
            "committed_at": f"{introduced}T00:00:00+00:00",
            "subject": "x",
            "pr_number": None,
        },
        "fix": {
            "sha": "c" * 40,
            "committed_at": f"{fixed}T00:00:00+00:00",
            "subject": "Fix x (#1)",
            "files": ["src/a.js"],
        },
        "ground_truth": [{"path": "src/a.js", "lines": [3], "ranges": [[3, 3]]}],
        "stats": {"days_to_fix": 31.0, "ground_truth_lines": 1},
        "provenance": {"method": "szz-blame-v1", "blame_share": 1.0},
    }


def _manifest(cases: list[dict[str, Any]]) -> dict[str, Any]:
    return {"schema_version": 1, "benchmark": "A", "generator": {}, "repos": [], "cases": cases}


def test_manifest_round_trip_and_validation(tmp_path: Path) -> None:
    data = _manifest([_case("c1", "o/r"), _case("c2", "o/r")])
    path = tmp_path / "m.json"
    manifest.save(data, path)
    assert manifest.load(path)["cases"] == data["cases"]
    assert manifest.content_hash(data) == manifest.content_hash(_manifest(list(data["cases"])))

    with pytest.raises(manifest.ManifestError, match="duplicate"):
        manifest.validate(_manifest([_case("c1", "o/r"), _case("c1", "o/r")]))
    broken = _case("c3", "o/r")
    broken["ground_truth"] = []
    with pytest.raises(manifest.ManifestError, match="empty ground truth"):
        manifest.validate(_manifest([broken]))
    with pytest.raises(manifest.ManifestError, match="schema_version"):
        manifest.validate({**data, "schema_version": 99})


def test_split_by_date_uses_both_dates() -> None:
    cases = [
        _case("old", "o/r", "2025-01-01", "2025-03-01"),
        _case("straddle", "o/r", "2025-12-01", "2026-06-01"),
        _case("new", "o/r", "2026-05-01", "2026-07-01"),
    ]
    split = manifest.split_by_date(cases, "2026-03-01")
    assert {k: [c["id"] for c in v] for k, v in split.items()} == {
        "pre_cutoff": ["old"],
        "post_cutoff": ["new"],
        "straddles_cutoff": ["straddle"],
    }


def test_sample_is_seeded_and_spread_across_repos() -> None:
    cases = [_case(f"big{i}", "o/big") for i in range(50)] + [
        _case(f"small{i}", "o/small") for i in range(3)
    ]
    first = validation.sample(cases, 10, seed=7)
    assert first == validation.sample(list(reversed(cases)), 10, seed=7)
    assert first != validation.sample(cases, 10, seed=8)
    assert len(set(first)) == 10
    assert sum(1 for c in first if c.startswith("small")) == 3
    assert len(validation.sample(cases, 500, seed=7)) == 53


def test_noise_report_and_agreement(tmp_path: Path) -> None:
    path = tmp_path / "verdicts.jsonl"
    for case_id, verdict in [("c1", "valid"), ("c2", "invalid"), ("c3", "valid"), ("c4", "unsure")]:
        validation.append_verdict(path, case_id, verdict, "", "alice")
    validation.append_verdict(path, "c2", "valid", "changed my mind", "alice")
    for case_id, verdict in [("c1", "valid"), ("c2", "invalid"), ("c3", "valid")]:
        validation.append_verdict(path, case_id, verdict, "", "bob")

    verdicts = validation.load_verdicts(path)
    alice = validation.noise_report(verdicts, "alice")
    assert alice == {
        "labeled": 4,
        "valid": 3,
        "invalid": 0,
        "unsure": 1,
        "noise_rate": 0.0,
        "noise_rate_ci95": [0.0, 0.5615],
    }
    bob = validation.noise_report(verdicts, "bob")
    assert bob["noise_rate"] == pytest.approx(1 / 3)

    kappa = validation.cohen_kappa(
        validation.latest_by_case(verdicts, "alice"), validation.latest_by_case(verdicts, "bob")
    )
    assert kappa["shared"] == 3
    assert kappa["agreement"] == pytest.approx(0.6667, abs=1e-4)
    with pytest.raises(ValueError):
        validation.append_verdict(path, "c9", "maybe", "", "alice")


def test_wilson_interval() -> None:
    low, high = validation.wilson_interval(10, 100)
    assert (round(low, 3), round(high, 3)) == (0.055, 0.174)
    assert validation.wilson_interval(0, 0) == (0.0, 1.0)


def test_render_case_marks_ground_truth(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    repo.commit("Simplify loop (#10)", {"src/cart.js": BUGGY})
    repo.commit("Fix off-by-one in total (#12)", {"src/cart.js": GOOD})
    [case] = build_repo_cases(repo.path, "octo/shop", "MIT", BuildConfig()).cases
    text = validation.render_case(case, repo.path)
    assert ">>     3 |   for (let i = 0; i <= items.length; i++) {" in text
    assert "       2 |   let sum = 0;" in text
    assert "Fix off-by-one in total (#12)" in text
    assert "-  for (let i = 0; i <= items.length; i++) {" in text


def test_cli_stats_and_sample(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data = _manifest([_case("c1", "o/r"), _case("c2", "o/q")])
    data["repos"] = [
        {"full_name": "o/r", "cases": 1, "fix_commits": 4, "dropped": {"nothing_to_blame": 3}}
    ]
    path = tmp_path / "m.json"
    manifest.save(data, path)

    assert main(["stats", "--manifest", str(path), "--cutoff", "2026-01-15"]) == 0
    out = capsys.readouterr().out
    assert "2 cases" in out and "nothing_to_blame" in out and "straddles_cutoff" in out

    sample_path = tmp_path / "sample.json"
    assert (
        main(
            [
                "sample",
                "--manifest",
                str(path),
                "--size",
                "1",
                "--seed",
                "1",
                "--out",
                str(sample_path),
            ]
        )
        == 0
    )
    assert len(json.loads(sample_path.read_text())["case_ids"]) == 1
