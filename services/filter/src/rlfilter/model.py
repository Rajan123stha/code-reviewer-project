"""The two filter models and their on-disk form.

A model is saved as plain JSON (coefficients, or LightGBM's own text dump), not as a pickle:
the file is readable, diffable, and loading it runs no code. A model's version is a hash of
that JSON, so a version names exactly one set of parameters.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from .features import COLUMNS, FEATURES_VERSION, vectorize

Matrix = npt.NDArray[np.float64]
Vector = npt.NDArray[np.float64]

KINDS = ("lr", "gbm")


class ModelError(ValueError):
    pass


@dataclass
class Model:
    kind: str
    params: dict[str, Any]
    columns: tuple[str, ...] = COLUMNS
    features_version: str = FEATURES_VERSION
    # Where the model came from: training repos, dataset hash, seed, metrics. Not hashed.
    meta: dict[str, Any] = field(default_factory=dict)
    _booster: Any = field(default=None, repr=False, compare=False)

    @property
    def version(self) -> str:
        identity = {
            "kind": self.kind,
            "columns": list(self.columns),
            "features_version": self.features_version,
            "params": self.params,
        }
        canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        return f"{self.kind}-{hashlib.sha256(canonical.encode()).hexdigest()[:12]}"

    def predict(self, x: Matrix) -> Vector:
        """Probability that each row's comment is useful."""
        if x.ndim != 2 or x.shape[1] != len(self.columns):
            raise ModelError(f"expected {len(self.columns)} columns, got shape {x.shape}")
        if x.shape[0] == 0:
            return np.zeros(0, dtype=np.float64)
        if self.kind == "lr":
            mean = np.asarray(self.params["mean"], dtype=np.float64)
            scale = np.asarray(self.params["scale"], dtype=np.float64)
            coef = np.asarray(self.params["coef"], dtype=np.float64)
            z = ((x - mean) / scale) @ coef + float(self.params["intercept"])
            return np.asarray(1.0 / (1.0 + np.exp(-z)), dtype=np.float64)
        if self.kind == "gbm":
            if self._booster is None:
                import lightgbm as lgb

                self._booster = lgb.Booster(model_str=self.params["model"])
            return np.asarray(self._booster.predict(x), dtype=np.float64)
        raise ModelError(f"unknown model kind {self.kind}")

    def score(self, items: list[dict[str, Any]]) -> list[float]:
        """Score candidates given as the pipeline's feature objects."""
        if not items:
            return []
        x = np.asarray([vectorize(f) for f in items], dtype=np.float64)
        return [float(min(1.0, max(0.0, p))) for p in self.predict(x)]

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "kind": self.kind,
            "features_version": self.features_version,
            "columns": list(self.columns),
            "params": self.params,
            "meta": self.meta,
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(self.to_dict(), indent=1, sort_keys=True) + "\n"
        path.write_text(text, encoding="utf-8", newline="\n")


def from_dict(raw: dict[str, Any]) -> Model:
    if raw.get("kind") not in KINDS:
        raise ModelError(f"unknown model kind {raw.get('kind')!r}")
    model = Model(
        kind=raw["kind"],
        params=raw["params"],
        columns=tuple(raw["columns"]),
        features_version=raw["features_version"],
        meta=raw.get("meta", {}),
    )
    if model.features_version != FEATURES_VERSION or model.columns != COLUMNS:
        raise ModelError(
            f"model was trained on {model.features_version} with {len(model.columns)} columns; "
            f"this service encodes {FEATURES_VERSION} with {len(COLUMNS)}"
        )
    if "version" in raw and raw["version"] != model.version:
        raise ModelError("model file was edited: its version does not match its contents")
    return model


def load(path: Path) -> Model:
    return from_dict(json.loads(path.read_text(encoding="utf-8")))


def _check_training_data(x: Matrix, y: Vector) -> None:
    if x.shape[0] != y.shape[0]:
        raise ModelError("x and y differ in length")
    if len(np.unique(y)) < 2:
        raise ModelError("training data has one class only; a filter cannot be fitted")


def fit_logistic(x: Matrix, y: Vector, seed: int = 0) -> Model:
    """L2-regularized logistic regression on standardized columns.

    No class weighting: the output is meant to be a probability, and reweighting the rare
    positive class would inflate every score.
    """
    from sklearn.linear_model import LogisticRegression

    _check_training_data(x, y)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale == 0] = 1.0  # a constant column carries no information; leave it at zero
    clf = LogisticRegression(C=1.0, max_iter=2000, random_state=seed)
    clf.fit((x - mean) / scale, y)
    return Model(
        kind="lr",
        params={
            "mean": [float(v) for v in mean],
            "scale": [float(v) for v in scale],
            "coef": [float(v) for v in clf.coef_[0]],
            "intercept": float(clf.intercept_[0]),
        },
    )


# Small trees and strong minimum leaf size: the training sets are hundreds of rows, not millions.
GBM_PARAMS: dict[str, Any] = {
    "n_estimators": 150,
    "learning_rate": 0.05,
    "num_leaves": 7,
    "min_child_samples": 10,
    "colsample_bytree": 0.8,
    "reg_lambda": 1.0,
}


def fit_gbm(x: Matrix, y: Vector, seed: int = 0) -> Model:
    """Gradient-boosted trees (LightGBM), single-threaded and deterministic."""
    import lightgbm as lgb

    _check_training_data(x, y)
    clf = lgb.LGBMClassifier(
        **GBM_PARAMS,
        random_state=seed,
        n_jobs=1,
        deterministic=True,
        force_row_wise=True,
        verbose=-1,
    )
    clf.fit(x, y)
    return Model(kind="gbm", params={"model": clf.booster_.model_to_string()})


FITTERS = {"lr": fit_logistic, "gbm": fit_gbm}
