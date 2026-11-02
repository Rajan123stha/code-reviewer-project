"""Render the technical report (docs/paper.md) from a template and the result files.

Every number in the report comes from a file in the repository: the benchmark manifest, the
validation labels, experiment summaries (`eval/results/<name>/<hash>/summary.json`) and the
filter's training report. Nothing is typed by hand. An experiment that has not been run is
rendered as an explicit "not yet run" note, never as an empty or estimated table.

Template directives (one per line, alone on the line, or inline for scalars):

    {{benchmark.cases}}              a scalar from the facts below
    {{table benchmark.repos}}        the per-repository table
    {{experiment E1-strategies}}     results block for one experiment (latest scored run)
    {{filter}}                       the filter's latest training report
    {{provenance}}                   which files and commit the numbers came from
"""

from __future__ import annotations

import json
import math
import re
import statistics
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rlbench import validation

from .runner import REPO_ROOT

RESULTS = REPO_ROOT / "eval" / "results"
MANIFEST = REPO_ROOT / "eval" / "benchmark" / "manifests" / "benchmark-a.v1.json"
VERDICTS = REPO_ROOT / "eval" / "benchmark" / "validation" / "verdicts.jsonl"
FILTER_REPORTS = REPO_ROOT / "services" / "filter" / "reports"
TEMPLATE = REPO_ROOT / "docs" / "paper" / "template.md"
OUTPUT = REPO_ROOT / "docs" / "paper.md"

# Below this many scored cases a result shows the harness ran, not which arm is better.
SMALL_SAMPLE = 30

_DIRECTIVE = re.compile(r"\{\{\s*(?:(table|experiment)\s+)?([A-Za-z0-9_.\-]+)\s*\}\}")


def _rel(path: Path) -> str:
    """Repository-relative path when inside the repository, else the path as given."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def pct(value: float | None, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{100 * value:.{digits}f}%"


def num(value: float | None, digits: int = 0) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:,.{digits}f}"


def _table(headers: list[str], rows: list[list[str]], right_from: int = 1) -> str:
    align = ["---" if i < right_from else "---:" for i in range(len(headers))]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(align) + " |"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


# --- Facts -----------------------------------------------------------------------------------


def benchmark_facts(manifest: dict[str, Any], verdicts_path: Path) -> dict[str, Any]:
    cases = manifest["cases"]
    signals = Counter(c["fix"]["signal"] for c in cases)
    config = manifest["generator"]["config"]
    days = [float(c["stats"]["days_to_fix"]) for c in cases]
    noise = validation.noise_report(validation.load_verdicts(verdicts_path))
    facts: dict[str, Any] = {
        "benchmark.cases": f"{len(cases):,}",
        "benchmark.repo_count": str(len(manifest["repos"])),
        "benchmark.inputs": f"{len({c['input_key'] for c in cases}):,}",
        "benchmark.hash": manifest["cases_hash"],
        "benchmark.szz": manifest["generator"]["szz_method"],
        "benchmark.signal_explicit": f"{signals.get('explicit_fix_type', 0):,}",
        "benchmark.signal_keyword": f"{signals.get('fix_keyword', 0):,}",
        "benchmark.max_cases_per_repo": str(config["max_cases_per_repo"]),
        "benchmark.max_fix_changed_lines": str(config["max_fix_changed_lines"]),
        "benchmark.min_blame_share": pct(config["min_blame_share"], 0),
        "benchmark.median_days_to_fix": num(statistics.median(days), 0),
        "benchmark.validation_labeled": str(noise["labeled"]),
    }
    if noise["noise_rate"] is None:
        facts["benchmark.noise"] = (
            "not yet measured: none of the 100 sampled cases has been labeled, so recall figures "
            "carry an unknown share of label noise"
        )
    else:
        low, high = noise["noise_rate_ci95"]
        facts["benchmark.noise"] = (
            f"{pct(noise['noise_rate'])} (95% Wilson interval {pct(low)} to {pct(high)}; "
            f"{noise['invalid']} invalid of {noise['valid'] + noise['invalid']} decided, "
            f"{noise['unsure']} unsure)"
        )
    rows = [
        [
            f"`{r['full_name']}`",
            r.get("language", ""),
            f"{r['scanned_commits']:,}",
            f"{r['fix_commits']:,}",
            f"{r['cases']:,}",
        ]
        for r in sorted(manifest["repos"], key=lambda r: -int(r["cases"]))
    ]
    facts["table:benchmark.repos"] = _table(
        ["Repository", "Language", "Commits scanned", "Fix commits", "Cases"], rows, right_from=2
    )
    return facts


def latest_summary(name: str, results: Path) -> tuple[dict[str, Any], Path] | None:
    """The most recently scored summary of an experiment, across spec hashes."""
    found: list[tuple[str, dict[str, Any], Path]] = []
    for path in sorted((results / name).glob("*/summary.json")):
        summary = json.loads(path.read_text(encoding="utf-8"))
        found.append((str(summary.get("scored_at", "")), summary, path))
    if not found:
        return None
    _, summary, path = max(found, key=lambda f: f[0])
    return summary, path


def experiment_block(name: str, results: Path) -> str:
    latest = latest_summary(name, results)
    if latest is None:
        return (
            f"> **Not yet run.** No scored results for `{name}` exist in `eval/results`. "
            f"Run `make eval EXPERIMENT={name}` and regenerate this report."
        )
    s, path = latest
    k_max = str(max(s["k"]))
    cases = int(s["cases_complete_in_all_arms"])
    lines: list[str] = []
    lines.append(
        f"*{s['description'].strip()}* {cases} cases from {s['inputs_selected']} changes, "
        f"{s['runs']} run(s) per arm; a hit is a posted comment within {s['line_tolerance']} "
        f"lines of a line the fix changed. Source: `{_rel(path)}`."
    )
    if cases < SMALL_SAMPLE:
        lines.append(
            f"\n> **Small sample ({cases} cases).** The intervals below are too wide to rank arms; "
            "this result shows that the experiment ran, not which arm is better."
        )
    rows = []
    for a in s["arms"]:
        r = a["recall_at"][k_max]
        rows.append(
            [
                a["arm"] + (" (baseline)" if a["arm"] == s["baseline"] else ""),
                pct(a["recall_at"][str(min(s["k"]))]["mean"]),
                f"{pct(r['mean'])} [{pct(r['ci95'][0])}, {pct(r['ci95'][1])}]",
                pct(a["file_recall_at_max_k"]),
                num(a["comments_per_review"], 2),
                pct(a["ground_truth_precision"]),
                num(a["tokens_in"]),
                "n/a" if a["latency_s_p50"] is None else f"{a['latency_s_p50']:.0f} s",
            ]
        )
    lines.append("")
    lines.append(
        _table(
            [
                "Arm",
                f"Recall@{min(s['k'])}",
                f"Recall@{k_max} [95% CI]",
                "File recall",
                "Comments / review",
                "GT precision",
                "Tokens in",
                "p50 time",
            ],
            rows,
        )
    )
    matched = s.get("semantic")
    if matched:
        calibration = matched.get("calibration")
        trust = (
            f"judge agreement with human labels {pct(calibration['agreement'])}, "
            f"kappa {calibration['kappa']:.2f} on {calibration['shared']} pairs"
            if calibration
            else "the judge is not yet calibrated against human labels"
        )
        semantic_rows = ", ".join(
            f"{arm} {pct(m['recall_at'][k_max]['mean'])}" for arm, m in matched["arms"].items()
        )
        lines.append(
            f"\nSemantic recall@{k_max}, counting only comments an LLM judge found to describe "
            f"the fixed bug: {semantic_rows} ({trust}; {pct(matched['coverage'])} of pairs judged)."
        )
    if s.get("comparisons"):
        comp_rows = [
            [
                f"{c['arm']} vs {c['baseline']}",
                ("+" if c["recall_diff"] > 0 else "") + pct(c["recall_diff"]),
                f"[{pct(c['ci95'][0])}, {pct(c['ci95'][1])}]",
                f"{c['only_arm']} / {c['only_baseline']}",
                "n/a" if c["mcnemar_p"] is None else f"{c['mcnemar_p']:.3f}",
            ]
            for c in s["comparisons"]
        ]
        lines.append("")
        lines.append(
            _table(
                [
                    f"Paired, recall@{k_max}",
                    "Difference",
                    "95% CI",
                    "Caught only by arm / baseline",
                    "McNemar p",
                ],
                comp_rows,
            )
        )
    return "\n".join(lines)


def filter_block(reports: Path) -> str:
    found = sorted(reports.glob("*/metrics.json"), key=lambda p: p.stat().st_mtime)
    if not found:
        return (
            "> **Not yet trained.** No filter training report exists in `services/filter/reports`. "
            "Collect training reviews (`make eval EXPERIMENT=F1-filter-data`), then "
            "`make filter-train`, and regenerate this report."
        )
    path = found[-1]
    m = json.loads(path.read_text(encoding="utf-8"))
    lines = [
        f"Model `{m['model_version']}` ({m['chosen']}), trained on {m['rows']} comments from "
        f"{len(m['repos'])} repositories, {m['positives']} useful ({pct(m['base_rate'])}). "
        f"Source: `{_rel(path)}`."
    ]
    if not m["enough_data_for_claims"]:
        lines.append(
            "\n> **Too little data for conclusions.** The figures below show the pipeline runs."
        )
    rows = []
    for name, key in (
        ("LLM confidence (no learning)", None),
        ("Logistic regression", "lr"),
        ("LightGBM", "gbm"),
    ):
        x = m["baseline_llm_confidence"] if key is None else m["models"][key]
        rows.append(
            [
                name,
                f"{num(x['auroc'], 3)} "
                f"[{num(x['auroc_ci95'][0], 3)}, {num(x['auroc_ci95'][1], 3)}]",
                pct(x["precision_at"]["1"]),
                pct(x["precision_at"]["3"]),
                num(x["brier"], 3),
                num(x["ece"], 3),
            ]
        )
    lines.append("")
    lines.append(
        _table(
            ["Scorer (leave-one-repo-out)", "AUROC [95% CI]", "P@1", "P@3", "Brier", "ECE"], rows
        )
    )
    return "\n".join(lines)


def provenance(sources: list[Path]) -> str:
    try:
        commit = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = "unknown"
    files = "\n".join(f"- `{_rel(p)}`" for p in sources)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"Generated {stamp} at commit `{commit}` by `python -m rlharness.cli paper` "
        f"from:\n\n{files}"
    )


# --- Rendering -------------------------------------------------------------------------------


def render(
    template: str,
    manifest: dict[str, Any],
    results: Path = RESULTS,
    verdicts: Path = VERDICTS,
    filter_reports: Path = FILTER_REPORTS,
) -> str:
    facts = benchmark_facts(manifest, verdicts)
    sources: list[Path] = [MANIFEST] if MANIFEST.exists() else []
    if verdicts.exists():
        sources.append(verdicts)

    def replace(match: re.Match[str]) -> str:
        kind, name = match.group(1), match.group(2)
        if kind is None and name in facts:
            return str(facts[name])
        if kind == "table" and name and f"table:{name}" in facts:
            return str(facts[f"table:{name}"])
        if kind == "experiment" and name:
            latest = latest_summary(name, results)
            if latest:
                sources.append(latest[1])
            return experiment_block(name, results)
        if kind is None and name == "filter":
            found = sorted(filter_reports.glob("*/metrics.json"))
            sources.extend(found[-1:])
            return filter_block(filter_reports)
        if kind is None and name == "provenance":
            return "\0PROVENANCE\0"
        raise ValueError(f"unknown template directive: {match.group(0)}")

    body = _DIRECTIVE.sub(replace, template)
    # Provenance goes last, once every source has been seen.
    return body.replace("\0PROVENANCE\0", provenance([p for p in sources if p.exists()]))


def write(out: Path = OUTPUT, template: Path = TEMPLATE) -> Path:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    text = render(template.read_text(encoding="utf-8"), manifest)
    out.write_text(text, encoding="utf-8", newline="\n")
    return out
