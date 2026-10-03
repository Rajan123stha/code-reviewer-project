"""HTTP service that scores candidate comments: `POST /score`, `GET /health`."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import model as model_io
from .features import FEATURES_VERSION, FeatureError
from .model import Model

MAX_ITEMS = 500


class ScoreRequest(BaseModel):
    features_version: str
    # The pipeline's CandidateFeatures objects, as stored with each candidate.
    items: list[dict[str, Any]] = Field(max_length=MAX_ITEMS)


class ScoreResponse(BaseModel):
    model_version: str
    features_version: str
    scores: list[float]


def create_app(model: Model) -> FastAPI:
    app = FastAPI(title="Reviewlens filter", version=model.version)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "model_version": model.version,
            "model_kind": model.kind,
            "features_version": model.features_version,
            # The harness reads this to refuse evaluating on a training repository.
            "train_repos": model.meta.get("train_repos", []),
            "dataset_hash": model.meta.get("dataset_hash"),
        }

    @app.post("/score", response_model=ScoreResponse)
    def score(request: ScoreRequest) -> ScoreResponse:
        if request.features_version != FEATURES_VERSION:
            raise HTTPException(
                status_code=409,
                detail=f"this model scores {FEATURES_VERSION}, not {request.features_version}",
            )
        try:
            scores = model.score(request.items)
        except FeatureError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return ScoreResponse(
            model_version=model.version, features_version=FEATURES_VERSION, scores=scores
        )

    return app


def resolve_model_path(path: Path) -> Path:
    """A model file, or a directory whose `current.json` names one."""
    if path.is_dir():
        pointer = path / "current.json"
        if not pointer.exists():
            raise FileNotFoundError(f"no model trained yet: {pointer} does not exist")
        import json

        return path / str(json.loads(pointer.read_text(encoding="utf-8"))["model"])
    return path


def app_from_env() -> FastAPI:
    """Factory for `uvicorn rlfilter.app:app_from_env --factory`; reads FILTER_MODEL."""
    default = Path(__file__).resolve().parents[2] / "models"
    path = resolve_model_path(Path(os.environ.get("FILTER_MODEL") or default))
    return create_app(model_io.load(path))
