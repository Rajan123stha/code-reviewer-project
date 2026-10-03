from __future__ import annotations

from conftest import BUGGY, GOOD, RepoBuilder

from rlbench import git, szz
from rlbench.cases import BuildConfig, build_repo_cases


def build(repo: RepoBuilder, **overrides: object):  # type: ignore[no-untyped-def]
    config = BuildConfig(**overrides)  # type: ignore[arg-type]
    return build_repo_cases(repo.path, "octo/shop", "MIT", config)


def test_szz_blames_the_commit_that_introduced_the_fixed_line(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    intro = repo.commit("Simplify loop (#10)", {"src/cart.js": BUGGY})
    # Unrelated later edit to another function must not take the blame.
    repo.commit("Label uses title", {"src/cart.js": BUGGY.replace("item.name", "item.title")})
    fix = repo.commit(
        "Fix off-by-one in total (#12)", {"src/cart.js": GOOD.replace("item.name", "item.title")}
    )

    result = szz.run(repo.path, git.show_commit(repo.path, fix))
    assert [(line.blamed_sha, line.orig_path, line.orig_line) for line in result.lines] == [
        (intro, "src/cart.js", 3)
    ]
    assert result.lines[0].content.strip() == "for (let i = 0; i <= items.length; i++) {"


def test_whitespace_only_commit_does_not_take_the_blame(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    intro = repo.commit("Simplify loop (#10)", {"src/cart.js": BUGGY})
    reindented = BUGGY.replace("  for (let i", "    for (let i")
    repo.commit("Reindent", {"src/cart.js": reindented})
    fix = repo.commit("Fix off-by-one (#12)", {"src/cart.js": GOOD})

    result = szz.run(repo.path, git.show_commit(repo.path, fix))
    assert {line.blamed_sha for line in result.lines} == {intro}


def test_blame_follows_a_renamed_file(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    intro = repo.commit("Simplify loop (#10)", {"src/cart.js": BUGGY})
    repo.move("src/cart.js", "src/basket.js")
    repo.commit("Rename cart to basket", {})
    fix = repo.commit("Fix off-by-one (#12)", {"src/basket.js": GOOD})

    result = szz.run(repo.path, git.show_commit(repo.path, fix))
    assert [(line.blamed_sha, line.orig_path) for line in result.lines] == [(intro, "src/cart.js")]


def test_build_produces_a_case_with_ground_truth_in_the_introducing_diff(repo: RepoBuilder) -> None:
    base = repo.commit("Add cart", {"src/cart.js": GOOD})
    intro = repo.commit("Simplify loop (#10)", {"src/cart.js": BUGGY}, days_later=2)
    fix = repo.commit(
        "Fix off-by-one in total (#12)\n\nFixes #11", {"src/cart.js": GOOD}, days_later=5
    )

    result = build(repo)
    assert result.fix_commits == 1
    [case] = result.cases
    assert case["id"] == f"octo__shop__{intro[:10]}__{fix[:10]}"
    assert (case["base_sha"], case["head_sha"]) == (base, intro)
    assert case["ground_truth"] == [{"path": "src/cart.js", "lines": [3], "ranges": [[3, 3]]}]
    assert case["fix"]["pr_number"] == 12
    assert case["fix"]["references"] == [12, 11]
    assert case["fix"]["closes"] == [11]
    assert case["introduced"]["pr_number"] == 10
    assert case["stats"]["days_to_fix"] == 5.0
    assert case["provenance"] == {
        "method": "szz-blame-v1",
        "blame_share": 1.0,
        "blamed_lines": 1,
        "blamed_on_introducing": 1,
        "other_blamed_commits": {},
        "fix_deleted_lines": 1,
        "fix_trivial_lines_skipped": 0,
        "fix_added_only_hunks": 0,
    }
    assert case["license"] == "MIT"
    assert case["input_key"] == f"octo/shop@{intro}"


def test_filters_record_why_a_fix_was_dropped(repo: RepoBuilder) -> None:
    repo.commit("Add cart and test", {"src/cart.js": GOOD, "test/cart.test.js": "test(1);\n"})
    # A fix whose only blamed lines come from the very first commit.
    repo.commit(
        "Fix label for missing names (#3)",
        {"src/cart.js": GOOD.replace("item.name", "item.name ?? ''")},
    )
    # A fix that only adds a guard: nothing to blame.
    guarded = GOOD.replace("  let sum = 0;", "  if (!items) return 0;\n  let sum = 0;")
    repo.commit(
        "Fix crash on missing items (#4)",
        {"src/cart.js": guarded.replace("item.name", "item.name ?? ''")},
    )
    # A fix that touches tests only.
    repo.commit("Fix flaky assertion (#5)", {"test/cart.test.js": "test(2);\n"})
    # A fix with no issue or PR reference.
    repo.commit(
        "Fix label fallback", {"src/cart.js": guarded.replace("item.name", "item.name || ''")}
    )

    result = build(repo)
    assert result.cases == []
    assert dict(result.dropped) == {
        "introduced_by_root_commit": 1,
        "nothing_to_blame": 1,
    }
    assert result.rejected_messages["no_reference"] == 1
    assert result.rejected_messages["not_behavior"] == 1  # "flaky"

    relaxed = build(repo, require_reference=False)
    assert relaxed.fix_commits == 3


def test_ambiguous_blame_is_dropped(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    repo.commit("Change loop (#10)", {"src/cart.js": BUGGY})
    both = BUGGY.replace("return item.name;", "return item.nam;")
    repo.commit("Change label (#11)", {"src/cart.js": both})
    repo.commit("Fix loop and label (#12)", {"src/cart.js": GOOD})

    result = build(repo)
    assert result.cases == []
    assert result.dropped["ambiguous_provenance"] == 1
    # With a lower threshold one of the two commits is accepted.
    assert len(build(repo, min_blame_share=0.5).cases) == 1


def test_large_changes_are_dropped(repo: RepoBuilder) -> None:
    repo.commit("Add cart", {"src/cart.js": GOOD})
    filler = "".join(f"export const v{i} = {i};\n" for i in range(60))
    repo.commit("Big change (#10)", {"src/cart.js": BUGGY, "src/filler.js": filler})
    repo.commit("Fix off-by-one (#12)", {"src/cart.js": GOOD})

    assert build(repo, max_intro_changed_lines=20).dropped["intro_too_large"] == 1
    assert len(build(repo).cases) == 1
