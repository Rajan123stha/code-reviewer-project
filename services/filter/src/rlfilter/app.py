"""HTTP service that scores candidate comments: `POST /score`, `GET /health`."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import model as model_io
from .features import FEATURES_VERSION, FeatureError
from .model import Model

MAX_ITEMS = 500
# 500 feature objects are about 300 kB of JSON; anything far beyond that is not a real request.
MAX_BODY_BYTES = 1_000_000


class BodyLimit:
    """Refuse request bodies over a size, before they are read into memory or parsed.

    Checks Content-Length up front and counts streamed (chunked) bodies as they arrive, since
    a client can omit or understate the header.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length" and (not value.isdigit() or int(value) > self.max_bytes):
                await _too_large(send)
                return
        # Read the whole body here, never more than the limit, then hand the app a replay.
        chunks: list[bytes] = []
        seen = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                await self.app(scope, receive, send)  # disconnect: let the app see it
                return
            chunk = message.get("body", b"")
            seen += len(chunk)
            if seen > self.max_bytes:
                await _too_large(send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        sent = False

        async def replay() -> Message:
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)


async def _too_large(send: Send) -> None:
    body = b'{"detail":"request body too large"}'
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class ScoreRequest(BaseModel):
    features_version: str
    # The pipeline's CandidateFeatures objects, as stored with each candidate.
    items: list[dict[str, Any]] = Field(max_length=MAX_ITEMS)


class ScoreResponse(BaseModel):
    model_version: str
    features_version: str
    scores: list[float]


def create_app(model: Model, max_body_bytes: int = MAX_BODY_BYTES) -> FastAPI:
    app = FastAPI(title="Reviewlens filter", version=model.version)
    app.add_middleware(BodyLimit, max_bytes=max_body_bytes)

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
