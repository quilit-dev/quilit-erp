"""
/api/health reports the commit it is running.

Deploys were otherwise unverifiable from outside. After pushing a security fix,
the only way to tell whether it had actually gone live was to trigger the bug —
which is not something you do against a customer's workspace. During the
pre-delivery audit that left "is the fix deployed?" answerable only by trusting
the platform's dashboard.
"""
import importlib
import os

import pytest
from fastapi.testclient import TestClient


def test_health_reports_status_and_commit(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "commit" in body, "no way to tell which build is running"
    assert isinstance(body["commit"], str) and body["commit"]


def test_health_stays_cheap(client):
    """It is a liveness probe hit every few seconds, and the container's own
    HEALTHCHECK depends on it. The commit is resolved once at import, so this
    must not touch the database or shell out per request."""
    import main
    assert isinstance(main.BUILD_COMMIT, str)
    # Same value every time — i.e. a constant, not recomputed.
    assert {client.get("/api/health").json()["commit"] for _ in range(5)} == {main.BUILD_COMMIT}


@pytest.mark.parametrize("var", ["RAILWAY_GIT_COMMIT_SHA", "GIT_COMMIT",
                                 "SOURCE_VERSION", "COMMIT_SHA"])
def test_platform_build_variables_win(monkeypatch, var):
    """The runtime image has no .git, so the host's variable is the real source.
    Each name covers a platform we might deploy on."""
    import main
    for name in ("RAILWAY_GIT_COMMIT_SHA", "GIT_COMMIT",
                 "SOURCE_VERSION", "COMMIT_SHA"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(var, "abcdef1234567890abcdef")

    assert main._build_commit() == "abcdef1234567"[:12]


def test_falls_back_to_unknown_without_git_or_env(monkeypatch, tmp_path):
    """Never raise and never block startup: an unresolvable commit is reported
    as 'unknown' rather than crashing the app or the health probe."""
    import main
    for name in ("RAILWAY_GIT_COMMIT_SHA", "GIT_COMMIT",
                 "SOURCE_VERSION", "COMMIT_SHA"):
        monkeypatch.delenv(name, raising=False)
    # Point the repo probe at a directory with no .git, as in the container.
    monkeypatch.setattr(main.os.path, "isdir", lambda p: False)

    assert main._build_commit() == "unknown"
