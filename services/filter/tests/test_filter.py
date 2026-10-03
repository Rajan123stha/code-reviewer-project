from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers import SPLIT, TEST, TRAIN, candidate, case, features, synthetic_rows, write_run

from rlfilter import dataset, evaluate, train
from rlfilter import model as model_io
from rlfilter.app import create_app
from rlfilter.features import COLUMNS, FEATURES_VERSION, FeatureError, vectorize
from rlfilter.model import Model, ModelError, fit_gbm, fit_logistic

# --- features -------------------------------------------------------------------------------


def test_vectorize_encodes_every_column_in_order() -> None:
    row = dict(zip(COLUMNS, vectorize(features()), strict=True))
    assert row["confidence"] == 0.8
    assert row["severity"] == 2.0
    assert row["claim_chars_log"] == pytest.approx(math.log1p(120))
    assert row["symbol_callers_log"] == pytest.approx(math.log1p(2))
    assert row["symbol_callers_known"] == 1.0
    assert [k for k, v in row.items() if k.startswith("category_") and v] == ["category_bug"]
    assert [k for k, v in row.items() if k.startswith("ext_") and v] == ["ext_ts"]
    assert [k for k, v in row.items() if k.startswith("strategy_") and v] == ["strategy_S4"]


def test_vectorize_handles_missing_centrality_and_unknown_extensions() -> None:
    row = dict(zip(COLUMNS, vectorize(features(symbolCallers=None, fileExt="vue")), strict=True))
    assert (row["symbol_callers_log"], row["symbol_callers_known"]) == (0.0, 0.0)
    assert row["ext_other"] == 1.0


@pytest.mark.parametrize(
    "bad",
    [{"category": "style"}, {"confidence": "high"}, {"hasFix": 1}, {"confidence": float("nan")}],
)
def test_vectorize_rejects_values_the_version_does_not_define(bad: dict[str, Any]) -> None:
    with pytest.raises(FeatureError):
        vectorize(features(**bad))


def test_feature_version_matches_the_pipeline() -> None:
    source = Path(__file__).resolve().parents[3] / "packages/review-core/src/features.ts"
    assert f"FEATURES_VERSION = '{FEATURES_VERSION}'" in source.read_text(encoding="utf-8")


# --- metrics --------------------------------------------------------------------------------


def test_auroc_known_values() -> None:
    assert evaluate.auroc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]) == 1.0
    assert evaluate.auroc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9]) == 0.0
    assert evaluate.auroc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]) == 0.5
    # One of the four positive/negative pairs is in the wrong order.
    assert evaluate.auroc([0, 1, 0, 1], [0.1, 0.4, 0.6, 0.9]) == 0.75
    assert math.isnan(evaluate.auroc([1, 1], [0.2, 0.3]))


def test_average_precision_and_precision_at_k() -> None:
    assert evaluate.average_precision([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1]) == pytest.approx(
        (1 / 1 + 2 / 3) / 2
    )
    labels = [1, 0, 0, 0, 1, 0]
    scores = [0.9, 0.5, 0.1, 0.8, 0.7, 0.2]
    groups = ["r1", "r1", "r1", "r2", "r2", "r2"]
    assert evaluate.precision_at_k(labels, scores, groups, 1) == 0.5  # r1 right, r2 wrong
    assert evaluate.precision_at_k(labels, scores, groups, 2) == 0.5  # 2 useful of 4 kept


def test_calibration_metrics() -> None:
    labels = [0, 0, 1, 1]
    assert evaluate.brier(labels, [0.0, 0.0, 1.0, 1.0]) == 0.0
    assert evaluate.expected_calibration_error(labels, [0.05, 0.05, 0.95, 0.95]) == pytest.approx(
        0.05
    )
    # Scores of 0.5 for a group that is half useful are perfectly calibrated.
    assert evaluate.expected_calibration_error(labels, [0.5] * 4) == 0.0


def test_threshold_sweep_reports_what_each_threshold_keeps() -> None:
    labels = [1, 0, 0, 1]
    scores = [0.9, 0.6, 0.2, 0.4]
    sweep = evaluate.threshold_sweep(labels, scores, ["a", "a", "b", "b"], [0.0, 0.5])
    assert sweep[0] == {
        "threshold": 0.0,
        "comments_kept_share": 1.0,
        "positives_kept_share": 1.0,
        "precision": 0.5,
        "comments_per_review": 2.0,
    }
    assert sweep[1]["comments_kept_share"] == 0.5
    assert sweep[1]["positives_kept_share"] == 0.5
    assert evaluate.thresholds_for_keep_shares(scores, [0.5, 0.25]) == {"0.5": 0.6, "0.25": 0.9}


# --- models ---------------------------------------------------------------------------------


def xy(n: int = 400, seed: int = 3) -> tuple[Any, Any, list[dict[str, Any]]]:
    rows = synthetic_rows(n, seed)
    x, y = train.matrices(rows)
    return x, y, rows


def test_logistic_artifact_reproduces_sklearn() -> None:
    from sklearn.linear_model import LogisticRegression

    x, y, _ = xy()
    model = fit_logistic(x, y)
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale == 0] = 1.0
    reference = LogisticRegression(C=1.0, max_iter=2000, random_state=0).fit((x - mean) / scale, y)
    assert np.allclose(model.predict(x), reference.predict_proba((x - mean) / scale)[:, 1])


@pytest.mark.parametrize("fit", [fit_logistic, fit_gbm])
def test_model_survives_save_and_load(fit: Any, tmp_path: Path) -> None:
    x, y, _ = xy()
    model = fit(x, y)
    model.meta = {"train_repos": list(TRAIN)}
    model.save(tmp_path / "m.json")
    loaded = model_io.load(tmp_path / "m.json")
    assert loaded.version == model.version
    assert loaded.meta == model.meta
    assert np.allclose(loaded.predict(x), model.predict(x))
    assert all(0.0 <= s <= 1.0 for s in loaded.score([features(), features(confidence=0.1)]))


def test_training_is_deterministic() -> None:
    x, y, _ = xy()
    assert fit_logistic(x, y).version == fit_logistic(x, y).version
    assert fit_gbm(x, y, 1).version == fit_gbm(x, y, 1).version


def test_edited_or_incompatible_model_files_are_refused(tmp_path: Path) -> None:
    x, y, _ = xy()
    raw = fit_logistic(x, y).to_dict()
    raw["params"]["intercept"] += 1.0
    with pytest.raises(ModelError, match="edited"):
        model_io.from_dict(raw)
    with pytest.raises(ModelError, match="features/v0"):
        model_io.from_dict({**fit_logistic(x, y).to_dict(), "features_version": "features/v0"})
    with pytest.raises(ModelError, match="one class"):
        fit_logistic(x, np.zeros(len(y)))


def test_both_models_learn_a_planted_signal_on_held_out_repositories() -> None:
    rows = synthetic_rows(800, seed=11)
    model, report = train.run(rows, SPLIT, "synthetic", seed=0)
    assert report["models"]["lr"]["auroc"] > 0.75
    assert report["models"]["gbm"]["auroc"] > 0.7
    # Learning from all features beats ranking by confidence alone, which is one of them.
    assert report["models"]["lr"]["auroc"] > report["baseline_llm_confidence"]["auroc"]
    assert report["chosen"] in ("lr", "gbm")
    assert model.meta["train_repos"] == sorted(TRAIN)
    assert "Too little data" not in train.to_markdown(report)


def test_report_says_so_when_data_is_too_small() -> None:
    _, report = train.run(synthetic_rows(60, seed=2), SPLIT, "tiny")
    assert report["enough_data_for_claims"] is False
    assert "Too little data for conclusions" in train.to_markdown(report)


# --- split hygiene --------------------------------------------------------------------------


def test_leave_one_repo_out_never_trains_on_the_held_out_repository() -> None:
    rows = synthetic_rows(200, seed=5)
    x, y = train.matrices(rows)
    repos = [r["repo"] for r in rows]
    # Mark each row with its repository in an unused column, so the fitter can see it.
    marker = COLUMNS.index("strategy_S0")
    for i, repo in enumerate(repos):
        x[i, marker] = float(TRAIN.index(repo))
    folds: list[tuple[set[float], set[float]]] = []

    class Spy(Model):
        def predict(self, x_test: Any) -> Any:
            folds[-1][1].update(x_test[:, marker])
            return np.full(len(x_test), 0.5)

    def fit(x_train: Any, y_train: Any, seed: int) -> Model:
        folds.append((set(x_train[:, marker]), set()))
        return Spy(kind="lr", params={})

    scores, skipped = evaluate.loro_scores(x, y, repos, fit)
    assert skipped == [] and not np.isnan(scores).any()
    assert len(folds) == len(TRAIN)
    for trained_on, scored in folds:
        assert len(scored) == 1 and not (trained_on & scored)
    assert {next(iter(scored)) for _, scored in folds} == {0.0, 1.0, 2.0, 3.0}


def test_training_refuses_rows_from_test_repositories() -> None:
    rows = synthetic_rows(100, seed=1, repos=(*TRAIN, TEST[0]))
    with pytest.raises(ValueError, match="trained on repositories it is being evaluated on"):
        train.run(rows, SPLIT, "leaky")


def test_the_committed_split_and_experiments_keep_train_and_test_apart() -> None:
    from rlfilter import cli, split

    fixed = split.load()
    assert not (fixed.train_repos & fixed.test_repos)
    manifest = json.loads(cli.DEFAULT_MANIFEST.read_text(encoding="utf-8"))
    assert fixed.manifest_hash == manifest["cases_hash"]
    assert {c["repo"] for c in manifest["cases"]} == fixed.train_repos | fixed.test_repos
    # Remaking the split from its recorded seed gives the same repositories.
    remade = split.make(manifest, fixed.seed, 1 / 3)
    assert set(remade["test_repos"]) == fixed.test_repos
    # E5 reviews only test repos, F1 only train repos, and no dataset or model crosses over.
    assert (
        cli.check(split.DEFAULT_SPLIT, cli.DEFAULT_DATASET, cli.DEFAULT_MODELS, cli.EXPERIMENTS)
        == []
    )


def test_check_reports_a_model_trained_on_test_repositories(tmp_path: Path) -> None:
    from rlfilter import cli, split

    x, y, _ = xy(100)
    leaky = fit_logistic(x, y)
    leaky.meta = {"train_repos": ["colinhacks/zod"]}  # a test repository of the real split
    leaky.save(tmp_path / "models" / "leaky.json")
    problems = cli.check(
        split.DEFAULT_SPLIT, tmp_path / "none.jsonl", tmp_path / "models", cli.EXPERIMENTS
    )
    assert problems == ["leaky.json was trained on test repositories"]


# --- dataset --------------------------------------------------------------------------------


def test_dataset_labels_rows_and_drops_what_must_not_be_trained_on(tmp_path: Path) -> None:
    manifest = {
        "cases": [
            case("o/a", "111", "src/a.ts", [10]),
            case("o/x", "222", "src/a.ts", [10]),
        ]
    }
    exp = write_run(
        tmp_path,
        "E1",
        "S4",
        1,
        "o/a@111",
        [
            candidate(0, 12),  # within 3 lines of the fix: useful
            candidate(1, 40),  # elsewhere
            candidate(2, 41, status="over_cap"),
            candidate(3, 12, status="duplicate"),
            candidate(4, 99, status="invalid"),
            candidate(5, 50, status="filtered"),
        ],
    )
    # The same cached response seen again by another experiment: not a new row.
    write_run(tmp_path, "E3", "depth2", 1, "o/a@111", [candidate(0, 12)])
    # A test repository: never part of the training set.
    write_run(tmp_path, "E1", "S4", 1, "o/x@222", [candidate(0, 10)])
    # A person looked at the comment on line 40 and found it valid.
    item = hashlib.sha1(b"S4|1|o/a@111|1").hexdigest()[:16]
    (exp / "comments").mkdir()
    (exp / "comments" / "human.jsonl").write_text(
        json.dumps({"id": item, "verdict": "valid"}) + "\n", encoding="utf-8"
    )

    rows, stats = dataset.build(tmp_path, manifest, SPLIT)

    assert len({r["id"] for r in rows}) == 4
    summary = sorted((r["status"], r["label"], r["label_source"]) for r in rows)
    assert summary == [
        ("filtered", 0, "benchmark"),
        ("over_cap", 0, "benchmark"),
        ("selected", 1, "benchmark"),
        ("selected", 1, "human"),
    ]
    assert {r["repo"] for r in rows} == {"o/a"}
    assert dict(stats.dropped) == {
        "status_duplicate": 1,
        "status_invalid": 1,
        "repeat_of_cached_response": 1,
        "test_repo": 1,
    }
    assert stats.positives == 2

    meta = dataset.save(rows, stats, SPLIT, tmp_path / "out" / "d.jsonl")
    assert dataset.load(tmp_path / "out" / "d.jsonl") == rows
    assert meta["dataset_hash"] == dataset.content_hash(rows)


def test_dataset_skips_runs_made_with_other_feature_definitions(tmp_path: Path) -> None:
    manifest = {"cases": [case("o/a", "111", "src/a.ts", [10])]}
    write_run(
        tmp_path, "E1", "S4", 1, "o/a@111", [candidate(0, 12)], features_version="features/v0"
    )
    rows, stats = dataset.build(tmp_path, manifest, SPLIT)
    assert rows == [] and dict(stats.dropped) == {"other_features_version": 1}


# --- service --------------------------------------------------------------------------------


@pytest.fixture()
def client() -> TestClient:
    x, y, _ = xy()
    model = fit_logistic(x, y)
    model.meta = {"train_repos": list(TRAIN), "dataset_hash": "abc"}
    return TestClient(create_app(model))


def test_health_names_the_model_and_its_training_repositories(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["model_version"].startswith("lr-")
    assert body["features_version"] == FEATURES_VERSION
    assert body["train_repos"] == list(TRAIN)


def test_score_returns_one_probability_per_item_in_order(client: TestClient) -> None:
    items = [features(confidence=0.95), features(confidence=0.05, isTest=True)]
    body = client.post("/score", json={"features_version": FEATURES_VERSION, "items": items}).json()
    assert body["model_version"] == client.get("/health").json()["model_version"]
    assert len(body["scores"]) == 2
    assert body["scores"][0] > body["scores"][1]  # the planted signal: confidence up, tests down
    again = client.post("/score", json={"features_version": FEATURES_VERSION, "items": items})
    assert again.json()["scores"] == body["scores"]
    empty = client.post("/score", json={"features_version": FEATURES_VERSION, "items": []})
    assert empty.json()["scores"] == []


def test_score_refuses_other_feature_versions_and_bad_features(client: TestClient) -> None:
    stale = client.post("/score", json={"features_version": "features/v0", "items": [features()]})
    assert stale.status_code == 409
    bad = client.post(
        "/score",
        json={"features_version": FEATURES_VERSION, "items": [features(category="style")]},
    )
    assert bad.status_code == 422 and "category" in bad.json()["detail"]
