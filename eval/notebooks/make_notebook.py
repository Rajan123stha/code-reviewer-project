"""Generate eval/notebooks/ablation.ipynb (kept as a script so the notebook stays reviewable)."""

import json
import sys
from pathlib import Path


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(True)}


def code(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.strip("\n").splitlines(True),
    }


cells = [
    md(
        """
# Reviewlens ablation results

Renders the tables and the recall / noise / cost plot for one experiment from the result files
in `eval/results`. Nothing here calls a model: run the experiment first with
`python -m rlharness.cli run eval/harness/experiments/<name>.yaml`.

Every number comes from the harness's scoring code (`rlharness.report.score`), the same code
that writes `summary.json` and `report.md`; none is typed by hand.
"""
    ),
    code(
        """
import sys
from pathlib import Path

ROOT = next(p for p in [Path.cwd(), *Path.cwd().parents] if (p / "pnpm-workspace.yaml").exists())
for src in ("eval/harness/src", "eval/benchmark/src"):
    sys.path.insert(0, str(ROOT / src))

from rlharness import report
from rlharness.cli import prepare, results_dir

EXPERIMENT = "E1-strategies"   # any file name in eval/harness/experiments, without .yaml
CUTOFF = "2026-01-01"          # contamination split date, or None
"""
    ),
    code(
        """
experiment, manifest, inputs, cases = prepare(ROOT / "eval/harness/experiments" / f"{EXPERIMENT}.yaml")
results = results_dir(experiment)
summary = report.score(experiment, inputs, cases, results, manifest, cutoff=CUTOFF)
print(f"{experiment.name} [{experiment.spec_hash()}]: {summary['cases_complete_in_all_arms']} cases scored, "
      f"{len(inputs)} inputs selected, results in {results}")
"""
    ),
    md("## Ablation table and paired comparisons"),
    code(
        """
text = report.to_markdown(summary)
try:
    from IPython.display import Markdown, display
    display(Markdown(text))
except ImportError:
    print(text)
"""
    ),
    md(
        """
## Recall vs. noise vs. cost

Each point is one arm. Up is better (more bugs caught), left is better (fewer comments per
review, the noise proxy), and smaller markers are cheaper (fewer input tokens). Error bars are
95% bootstrap intervals over cases.
"""
    ),
    code(
        """
import math
import matplotlib.pyplot as plt

k_max = str(max(summary["k"]))
arms = [a for a in summary["arms"] if not math.isnan(a["recall_at"][k_max]["mean"])]
fig, ax = plt.subplots(figsize=(7, 4.5))
if arms:
    biggest = max(a["tokens_in"] for a in arms) or 1
    for arm in arms:
        recall = 100 * arm["recall_at"][k_max]["mean"]
        low, high = (100 * v for v in arm["recall_at"][k_max]["ci95"])
        x = arm["comments_per_review"]
        ax.errorbar(x, recall, yerr=[[recall - low], [high - recall]], color="#888", capsize=3, lw=1)
        ax.scatter(x, recall, s=60 + 340 * arm["tokens_in"] / biggest, alpha=0.75, edgecolor="#333")
        ax.annotate(arm["arm"], (x, recall), textcoords="offset points", xytext=(8, 6))
ax.set_xlabel("Comments posted per review (lower is better)")
ax.set_ylabel(f"Bug-catch recall@{k_max} (%)")
ax.set_title(f"{summary['experiment']}: recall vs. comments (marker size = input tokens)")
ax.grid(alpha=0.3)
fig.tight_layout()
"""
    ),
    md(
        "## Contamination split\n\nRecall for cases fixed before the cutoff, introduced after it, and straddling it."
    ),
    code(
        """
split = summary.get("date_split")
if split:
    for name, group in split["groups"].items():
        recalls = ", ".join(
            f"{arm} {100 * r:.1f}%" if r is not None else f"{arm} n/a" for arm, r in group["recall"].items()
        )
        print(f"{name:18s} {group['cases']:4d} cases   {recalls}")
else:
    print("No cutoff set.")
"""
    ),
    md(
        "## Run-to-run variance\n\nRecall in each repeat of each arm: the spread is LLM nondeterminism."
    ),
    code(
        """
for arm in summary["arms"]:
    runs = ", ".join(f"{100 * r:.1f}%" for r in arm["recall_at"][k_max]["per_run"])
    print(f"{arm['arm']:14s} recall@{k_max} per run: {runs}   (sd {100 * arm['recall_at'][k_max]['run_sd']:.1f} pts)")
"""
    ),
]

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(notebook, indent=1) + "\n", encoding="utf-8")
print("wrote", out)
