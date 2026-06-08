"""
Cron trigger endpoint — token-gated HTTP driver for the periodic scheduler
(used by single-service hosts that can't run scheduler.py as its own process).
"""


def test_cron_disabled_without_token(make_client, monkeypatch):
    monkeypatch.delenv("CRON_TOKEN", raising=False)
    c = make_client()                      # anonymous — endpoint is token-gated, not session-auth
    assert c.post("/api/cron/run").status_code == 503


def test_cron_rejects_missing_or_wrong_token(make_client, monkeypatch):
    monkeypatch.setenv("CRON_TOKEN", "s3cret-token")
    c = make_client()
    assert c.post("/api/cron/run").status_code == 401                       # missing
    assert c.post("/api/cron/run", params={"token": "nope"}).status_code == 401  # wrong


def test_cron_runs_with_valid_token(make_client, monkeypatch):
    monkeypatch.setenv("CRON_TOKEN", "s3cret-token")
    c = make_client()
    # Header form
    r = c.post("/api/cron/run", headers={"X-Cron-Token": "s3cret-token"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok" and isinstance(body["ran"], dict)
    # Query-param form also works
    assert c.post("/api/cron/run", params={"token": "s3cret-token"}).status_code == 200
