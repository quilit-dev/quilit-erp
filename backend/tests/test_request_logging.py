"""
Request correlation + structured logging.

Every response carries an X-Request-ID (echoing an inbound one when provided),
and the JSON formatter emits one parseable object per line with that id.
"""
import json
import logging

from logging_setup import JsonFormatter, request_id_var


# ── Correlation header ────────────────────────────────────────────────────────
def test_response_has_request_id(client):
    r = client.get("/api/settings/setup-status")   # public endpoint
    assert r.status_code == 200
    assert r.headers.get("x-request-id")            # generated


def test_inbound_request_id_is_echoed(client):
    r = client.get("/api/settings/setup-status", headers={"X-Request-ID": "trace-abc-123"})
    assert r.status_code == 200
    assert r.headers["x-request-id"] == "trace-abc-123"


def test_requests_still_work_under_middleware(client):
    # Middleware must not alter status/body of normal traffic.
    r = client.get("/api/settings/setup-status")
    assert r.status_code == 200
    assert "setup_complete" in r.json()


# ── JSON formatter ────────────────────────────────────────────────────────────
def test_json_formatter_emits_parseable_line_with_fields():
    token = request_id_var.set("rid-xyz")
    try:
        rec = logging.LogRecord("erp.access", logging.INFO, __file__, 1,
                                "request", (), None)
        rec.status = 200
        rec.path = "/api/x"
        line = JsonFormatter().format(rec)
        obj = json.loads(line)                       # must be valid JSON
        assert obj["msg"] == "request"
        assert obj["request_id"] == "rid-xyz"
        assert obj["status"] == 200 and obj["path"] == "/api/x"
        assert obj["level"] == "INFO"
    finally:
        request_id_var.reset(token)
