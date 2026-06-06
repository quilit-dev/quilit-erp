#!/bin/sh
# Container entrypoint for the `app` image (Phase 5).
# Runs the DB bootstrap once (only where asked, so the worker doesn't race it),
# then execs the given command (gunicorn for the API, python worker.py for jobs).
set -e

if [ "${RUN_BOOTSTRAP:-0}" = "1" ]; then
    echo "entrypoint: running DB bootstrap…"
    python bootstrap.py
fi

exec "$@"
