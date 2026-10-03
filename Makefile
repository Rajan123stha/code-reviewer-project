# Evaluation targets. On Windows without make, run the commands directly (see eval/harness/README.md).
#
#   make eval-smoke                 end-to-end check on a synthetic repository; no model, no network
#   make eval EXPERIMENT=E1-strategies   run (or resume) an experiment, then score it
#   make eval-score EXPERIMENT=...  score only
#   make filter-smoke               filter service and CLI end to end, on a synthetic model
#   make filter-train               build the training set from eval results, then train
#   make filter-serve               serve the trained model on http://127.0.0.1:8000

PYTHON ?= python
EXPERIMENT ?= E1-strategies
WORKERS ?= 1

export PYTHONPATH := eval/harness/src:eval/benchmark/src:services/filter/src

.PHONY: build eval-smoke eval eval-score eval-test filter-smoke filter-train filter-serve

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
	cd services/filter && $(PYTHON) -m pytest -q

# A synthetic model served over HTTP, scored against through the real CLI.
filter-smoke: build
	$(PYTHON) -m rlfilter.smoke

# Needs review results from the training repositories: make eval EXPERIMENT=F1-filter-data
filter-train:
	$(PYTHON) -m rlfilter.cli check
	$(PYTHON) -m rlfilter.cli dataset
	$(PYTHON) -m rlfilter.cli train
	$(PYTHON) -m rlfilter.cli check

filter-serve:
	$(PYTHON) -m rlfilter.cli serve
