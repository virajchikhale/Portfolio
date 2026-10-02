FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install -r requirements.txt

# Local embedding model is baked in at build time: the container runs read-only and offline-capable.
# The build args mirror the runtime .env (compose passes the same values to both). The MODEL NAME is deliberately NOT
# stored in the image's environment: a baked-in default would be handed to the wrong provider if you later switch to
# EMBEDDING_PROVIDER=gemini and leave EMBEDDING_MODEL unset.
ARG EMBEDDING_PROVIDER=local
ARG EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
ENV EMBEDDING_CACHE_DIR=/srv/models HF_HUB_OFFLINE=1
RUN if [ "$EMBEDDING_PROVIDER" = "local" ]; then \
      HF_HUB_OFFLINE=0 python -c "from fastembed import TextEmbedding; import os; \
TextEmbedding(model_name=os.environ['EMBEDDING_MODEL'], cache_dir='/srv/models')"; \
    fi

# Run as an unprivileged user
RUN useradd --system --uid 10001 --no-create-home app
COPY --chown=app:app app ./app
COPY --chown=app:app skills ./skills
COPY --chown=app:app data ./data
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app evals ./evals
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"
# --proxy-headers only trusts the nginx container; app-level TRUST_PROXY_HEADERS gates X-Forwarded-For use
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
