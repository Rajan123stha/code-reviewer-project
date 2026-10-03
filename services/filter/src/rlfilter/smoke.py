"""End-to-end check of the filter path without a reviewing model: `make filter-smoke`.

Trains a model on synthetic rows, serves it over HTTP, and runs the real TypeScript CLI on the
example change with scripted comments and the filter switched on. It then checks that the
scores in the CLI's output are the scores this model gives the features in that same output,
and that the threshold dropped exactly the comments below it.

It proves the two halves agree on the wire format and the feature encoding. It says nothing
about whether a filter trained on real data is any good.
"""

from __future__ import annotations

import json
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn

from . import train
from .app import create_app
from .features import CATEGORIES, FEATURES_VERSION
from .model import fit_logistic
from .split import REPO_ROOT

CLI = REPO_ROOT / "apps" / "cli" / "dist" / "main.js"
EXAMPLE = REPO_ROOT / "apps" / "cli" / "examples" / "cart"

# Two comments on the example change. The model below is trained to follow confidence, so
# the first should score high and the second low.
COMMENTS = [
    {
        "file": "src/cart.ts",
        "line": 16,
        "category": "bug",
        "severity": "low",
        "claim": "Loop runs one past the end of items, so reading .price throws.",
        "evidence": "for (let i = 0; i <= items.length; i++) {",
        "suggested_fix": "Use i < items.length.",
        "confidence": 0.97,
    },
    {
        "file": "src/cart.ts",
        "line": 24,
        "category": "maintainability",
        "severity": "critical",
        "claim": "The discount helper could have a clearer name.",
        "evidence": "return sum - sum * coupon.pct;",
        "suggested_fix": None,
        "confidence": 0.03,
    },
]


def synthetic_rows(n: int, seed: int) -> list[dict[str, Any]]:
    """Rows where usefulness follows the comment's confidence."""
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        confidence = rng.random()
        rows.append(
            {
                "repo": f"synthetic/r{i % 3}",
                "review": f"synthetic/{i // 4}",
                "label": int(rng.random() < confidence**2),
                "features": {
                    "category": rng.choice(CATEGORIES),
                    "severity": rng.choice(["low", "medium", "high", "critical"]),
                    "confidence": confidence,
                    "claimChars": rng.randint(40, 200),
                    "evidenceLines": 1,
                    "hasFix": rng.random() < 0.5,
                    "evidenceInAddedLines": rng.random() < 0.5,
                    "fileExt": "ts",
                    "isTest": False,
                    "lineIsAdded": True,
                    "fileChangedLines": rng.randint(1, 50),
                    "prChangedLines": rng.randint(50, 200),
                    "prFiles": rng.randint(1, 6),
                    "symbolCallers": None,
                    "strategy": "S1",
                    "duplicateClusterSize": 1,
                    "candidatesInReview": rng.randint(1, 5),
                    "verifierAgreement": None,
                    "repoCategoryAcceptRate": None,
                },
            }
        )
    return rows


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


def main() -> int:
    if not CLI.exists():
        print(f"CLI not built: {CLI} (run `pnpm build`)")
        return 1
    x, y = train.matrices(synthetic_rows(600, seed=1))
    model = fit_logistic(x, y)
    model.meta = {"train_repos": ["synthetic/r0", "synthetic/r1", "synthetic/r2"]}

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(create_app(model), host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline:
            print("filter service did not start")
            return 1
        time.sleep(0.05)

    failures: list[str] = []

    def check(name: str, ok: bool, detail: object = "") -> None:
        if not ok:
            failures.append(f"{name}: {detail}")

    try:
        with tempfile.TemporaryDirectory() as tmp:
            scripted = Path(tmp) / "comments.json"
            scripted.write_text(json.dumps(COMMENTS), encoding="utf-8")
            out = Path(tmp) / "run.json"
            threshold = 0.3
            proc = subprocess.run(
                [
                    "node",
                    str(CLI),
                    "review",
                    "--diff",
                    str(EXAMPLE / "change.diff"),
                    "--repo",
                    str(EXAMPLE / "repo"),
                    "--strategy",
                    "S1",
                    "--config-json",
                    json.dumps({"filterThreshold": threshold, "filterModel": model.version}),
                    "--fake-llm",
                    str(scripted),
                    "--filter-url",
                    f"http://127.0.0.1:{port}",
                    "--out",
                    str(out),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=REPO_ROOT,
            )
            if proc.returncode != 0:
                print(proc.stderr[-2000:])
                print("filter-smoke FAILED: the CLI exited with an error")
                return 1
            run = json.loads(out.read_text(encoding="utf-8"))

            candidates = run["candidates"]
            if run["filter"] is None:
                print("filter-smoke FAILED: the review was not filtered", run["candidates"])
                return 1
            check(
                "features version",
                run["featuresVersion"] == FEATURES_VERSION,
                run["featuresVersion"],
            )
            check("model version", run["filter"]["modelVersion"] == model.version, run["filter"])
            check("candidates", len(candidates) == 2, len(candidates))
            check("all scored", all(c["filterScore"] is not None for c in candidates))
            # The service's answer must be this model's answer for the features in the output.
            expected = model.score([c["features"] for c in candidates])
            for c, want in zip(candidates, expected, strict=True):
                check(
                    f"score of #{c['index']}",
                    abs(c["filterScore"] - want) < 1e-9,
                    (c["filterScore"], want),
                )
            for c in candidates:
                want_status = "selected" if c["filterScore"] >= threshold else "filtered"
                check(f"status of #{c['index']}", c["status"] == want_status, c["status"])
            check("high confidence kept", candidates[0]["status"] == "selected", candidates[0])
            check("low confidence dropped", candidates[1]["status"] == "filtered", candidates[1])
            check("filter summary", run["filter"]["dropped"] == 1 and run["filter"]["scored"] == 2)
            check("posted", [c["index"] for c in run["selected"]] == [0], run["selected"])

            # A pinned model version that is not the one served must fail the review.
            pinned = subprocess.run(
                [
                    *proc.args[:-2],
                    "--config-json",
                    json.dumps({"filterThreshold": threshold, "filterModel": "lr-someothermodel"}),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=REPO_ROOT,
            )
            check("pinned model mismatch fails", pinned.returncode == 1, pinned.returncode)
            check(
                "mismatch is explained", "pins filter model" in pinned.stderr, pinned.stderr[-300:]
            )
    finally:
        server.should_exit = True
        thread.join(timeout=10)

    if failures:
        print("filter-smoke FAILED")
        for failure in failures:
            print("  " + failure)
        return 1
    print(f"filter-smoke ok: CLI and service agree ({model.version}, {FEATURES_VERSION})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
