"""Malformed and malicious requests to the scoring service."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from helpers import features, synthetic_rows

from rlfilter import train
from rlfilter.app import create_app
from rlfilter.features import FEATURES_VERSION
from rlfilter.model import fit_logistic


@pytest.fixture(scope="module")
def client() -> TestClient:
    x, y = train.matrices(synthetic_rows(200, seed=4))
    return TestClient(create_app(fit_logistic(x, y)))


def score(client: TestClient, body: Any, **kwargs: Any) -> Any:
    return client.post(
        "/score", content=json.dumps(body), headers={"content-type": "application/json"}, **kwargs
    )


def test_ordinary_request_is_scored(client: TestClient) -> None:
    res = score(client, {"features_version": FEATURES_VERSION, "items": [features()]})
    assert res.status_code == 200 and len(res.json()["scores"]) == 1


def test_oversized_body_is_refused_before_it_is_parsed(client: TestClient) -> None:
    # 500 items is the cap, but each item can be padded; the body itself must be capped.
    item = {**features(), "padding": "x" * 50_000}
    res = score(client, {"features_version": FEATURES_VERSION, "items": [item] * 60})
    assert res.status_code == 413


def test_body_without_content_length_is_capped_too(client: TestClient) -> None:
    def chunks() -> Any:
        yield b'{"features_version": "' + FEATURES_VERSION.encode() + b'", "items": ['
        for _ in range(200):
            yield json.dumps({**features(), "pad": "y" * 20_000}).encode() + b","
        yield json.dumps(features()).encode() + b"]}"

    res = client.post("/score", content=chunks(), headers={"content-type": "application/json"})
    assert res.status_code == 413


@pytest.mark.parametrize(
    "body",
    [
        {"items": [features()]},  # no version
        {"features_version": FEATURES_VERSION, "items": "not a list"},
        {"features_version": FEATURES_VERSION, "items": [features()] * 501},
        {"features_version": FEATURES_VERSION, "items": [{**features(), "confidence": 1e999}]},
        {"features_version": FEATURES_VERSION, "items": [{**features(), "category": "<script>"}]},
        [1, 2, 3],
    ],
)
def test_malformed_requests_get_a_client_error(client: TestClient, body: Any) -> None:
    res = score(client, body)
    assert res.status_code in (409, 422)
    assert "Traceback" not in res.text


def test_internal_errors_do_not_leak_details() -> None:
    class Broken:
        version = "lr-x"
        kind = "lr"
        features_version = FEATURES_VERSION
        meta: dict[str, Any] = {}

        def score(self, _items: Any) -> Any:
            raise RuntimeError("model file /srv/secret/path.json is corrupt")

    res = TestClient(create_app(Broken()), raise_server_exceptions=False).post(  # type: ignore[arg-type]
        "/score", json={"features_version": FEATURES_VERSION, "items": [features()]}
    )
    assert res.status_code == 500
    assert "/srv/secret" not in res.text
