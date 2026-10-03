# Evaluation targets. On Windows without make, run the commands directly (see eval/harness/README.md).
#
#   make eval-smoke                 end-to-end check on a synthetic repository; no model, no network
#   make eval EXPERIMENT=E1-strategies   run (or resume) an experiment, then score it
#   make eval-score EXPERIMENT=...  score only

PYTHON ?= python
EXPERIMENT ?= E1-strategies
WORKERS ?= 1

export PYTHONPATH := eval/harness/src:eval/benchmark/src

.PHONY: build eval-smoke eval eval-score eval-test

build:
	pnpm install --frozen-lockfile
	pnpm --filter @reviewlens/db generate
	pnpm build

# Ten synthetic bugs, reviewed through the real CLI with scripted comments.
eval-smoke: build
	$(PYTHON) -m rlharness.smoke

# Resumable: finished reviews are skipped, so re-run after a quota stop.
eval: build
	$(PYTHON) -m rlharness.cli run eval/harness/experiments/$(EXPERIMENT).yaml --workers $(WORKERS)
	$(PYTHON) -m rlharness.cli score eval/harness/experiments/$(EXPERIMENT).yaml

eval-score:
	$(PYTHON) -m rlharness.cli score eval/harness/experiments/$(EXPERIMENT).yaml

eval-test:
	cd eval/benchmark && $(PYTHON) -m pytest -q
	cd eval/harness && $(PYTHON) -m pytest -q
