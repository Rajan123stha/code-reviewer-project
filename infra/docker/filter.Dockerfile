# syntax=docker/dockerfile:1
# The learned-filter scoring service. Usage (from the repo root):
#   docker build -f infra/docker/filter.Dockerfile -t reviewlens-filter .
# Serves the model named by services/filter/models/current.json, or FILTER_MODEL.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src
WORKDIR /app
# Scoring needs numpy and, for gradient-boosted models, LightGBM; not scikit-learn,
# which only training uses.
RUN pip install --no-cache-dir "numpy>=1.26" "lightgbm>=4" "fastapi>=0.110" "uvicorn>=0.30"
COPY services/filter/src ./src
COPY services/filter/models ./models
RUN useradd --system --uid 10001 filter
USER filter
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
CMD ["uvicorn", "rlfilter.app:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000"]
