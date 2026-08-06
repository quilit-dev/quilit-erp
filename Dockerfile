# syntax=docker/dockerfile:1
#
# Multi-target image for the cloud deployment (docs/SAAS_ARCHITECTURE.md §10).
#   target `app` (DEFAULT — last stage) — FastAPI API **and** the built SPA,
#     served by gunicorn on $PORT. Self-contained: this is what `docker build .`
#     produces, and what single-service hosts (Render, Fly, a bare VM) run.
#   target `web` — Caddy serving the SPA + reverse-proxying /api → app. Used by
#     the Docker Compose stack as the TLS/static edge in front of the `app` service.
# Both reuse the `frontend` stage, so the Vite bundle is built once.

# ── Stage: build the frontend (Vite → /build/static) ─────────────────────────
FROM node:20-slim AS frontend
WORKDIR /build/frontend_src
COPY frontend_src/package.json frontend_src/package-lock.json* ./
RUN npm ci
COPY frontend_src/ ./
RUN npm run build          # vite outDir is '../static' → /build/static

# ── Target: web (Caddy + SPA, TLS, /api reverse proxy) — compose edge ────────
FROM caddy:2-alpine AS web
COPY --from=frontend /build/static /srv/www
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# ── Target: app (API + SPA, single self-contained service) — DEFAULT ─────────
FROM python:3.12-slim AS app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements-cloud.txt backend/constraints.txt ./
# -c constraints.txt pins the whole transitive tree. The requirements files
# carry deliberate >= security floors and stay readable; the constraints file
# is the lockfile that makes a rebuild reproducible. Without it, two builds of
# the same commit can ship different dependency versions — so "it passed CI"
# says nothing about what is actually running, and a bad upstream release
# reaches production on the next unrelated deploy.
RUN pip install -r requirements.txt -r requirements-cloud.txt -c constraints.txt
COPY backend/ ./backend/
# Bundle the built SPA so this single service can serve it (main.py serves
# STATIC_DIR=../static when present). In the compose stack Caddy fronts it; here
# the app serves it directly.
COPY --from=frontend /build/static /app/static
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app
USER appuser
WORKDIR /app/backend
EXPOSE 8000
# Bind $PORT so single-service hosts (Render sets it) route correctly; default
# 8000 keeps the compose stack (Caddy → app:8000) unchanged.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS http://localhost:${PORT:-8000}/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# --forwarded-allow-ips='*': the container is only reachable through the
# platform's proxy (Render/LB), so trust its X-Forwarded-* headers. Without
# this, request.client.host is the proxy IP for everyone — making the login
# rate-limit a single global bucket and recording the wrong IP in audit logs
# and user_sessions. (Per-account lockout is a recommended follow-up to harden
# against X-Forwarded-For spoofing.)
CMD exec gunicorn main:app -k uvicorn.workers.UvicornWorker \
    -b 0.0.0.0:${PORT:-8000} -w ${WEB_CONCURRENCY:-3} --timeout 120 \
    --forwarded-allow-ips='*' --access-logfile -
