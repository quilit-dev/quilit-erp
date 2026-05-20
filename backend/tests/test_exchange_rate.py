"""
Dual-currency foundation — the manual, admin-set exchange rate.

Covers: admin can set a rate, non-admins cannot (403), invalid rates are
rejected (400), GET returns the latest rate + history and is readable by any
signed-in user.
"""
import pytest


@pytest.mark.rbac
def test_superadmin_can_set_exchange_rate(make_client):
    c = make_client("superadmin")
    r = c.post("/api/settings/exchange-rate", json={"rate": 89000, "note": "QA"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["current"]["rate"] == 89000
    assert body["current"]["note"] == "QA"
    assert body["base_currency"] == "USD"
    assert body["secondary_currency"] == "LBP"


@pytest.mark.rbac
@pytest.mark.parametrize("role", ["Viewer", "Sales", "Accountant", "Manager"])
def test_non_admin_cannot_set_exchange_rate(role, make_client):
    """Setting the rate is administrator-only — every other role must get 403."""
    r = make_client(role).post("/api/settings/exchange-rate", json={"rate": 90000})
    assert r.status_code != 500
    assert r.status_code == 403, f"{role} was allowed to set the rate ({r.status_code})"


@pytest.mark.edge
@pytest.mark.parametrize("bad", [0, -1, -8500])
def test_non_positive_rate_is_rejected(bad, make_client):
    r = make_client("superadmin").post("/api/settings/exchange-rate", json={"rate": bad})
    assert r.status_code < 500
    assert r.status_code == 400, f"rate={bad} accepted ({r.status_code})"


def test_get_returns_latest_rate_and_history(make_client):
    c = make_client("superadmin")
    c.post("/api/settings/exchange-rate", json={"rate": 88000})
    c.post("/api/settings/exchange-rate", json={"rate": 89500, "note": "morning rate"})
    r = c.get("/api/settings/exchange-rate")
    assert r.status_code == 200
    body = r.json()
    assert body["current"]["rate"] == 89500          # most recent wins
    assert len(body["history"]) == 2                 # both changes retained


def test_get_exchange_rate_readable_by_any_user(make_client):
    """Any signed-in user may read the current rate (needed for invoicing later)."""
    assert make_client("Viewer").get("/api/settings/exchange-rate").status_code == 200


def test_no_rate_set_yet_returns_null_current(make_client):
    body = make_client("superadmin").get("/api/settings/exchange-rate").json()
    assert body["current"] is None
    assert body["history"] == []
