# syntax=docker/dockerfile:1
#
# Multi-target image for the cloud deployment (Phase 5 — docs/SAAS_ARCHITECTURE.md §10).
#   target `app` — the FastAPI API served by gunicorn + uvicorn workers.
#   target `web` — Caddy serving the built SPA and reverse-proxying /api → app.
# Both reuse the `frontend` stage, so the Vite bundle is built once.

# ── Stage: build the frontend (Vite → /build/static) ─────────────────────────
FROM node:20-slim AS frontend
WORKDIR /build/frontend_src
COPY frontend_src/package.json frontend_src/package-lock.json* ./
RUN npm ci
COPY frontend_src/ ./
RUN npm run build          # vite outDir is '../static' → /build/static

# ── Target: app (API only) ───────────────────────────────────────────────────
FROM python:3.12-slim AS app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements-cloud.txt ./
RUN pip install -r requirements.txt -r requirements-cloud.txt
COPY backend/ ./backend/
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app
USER appuser
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["gunicorn", "main:app", "-k", "uvicorn.workers.UvicornWorker", \
     "-b", "0.0.0.0:8000", "-w", "3", "--timeout", "120", "--access-logfile", "-"]

# ── Target: web (Caddy + SPA, TLS, /api reverse proxy) ───────────────────────
FROM caddy:2-alpine AS web
COPY --from=frontend /build/static /srv/www
COPY deploy/Caddyfile /etc/caddy/Caddyfile
