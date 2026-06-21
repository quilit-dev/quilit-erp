"""Projects no longer have a void/unvoid lifecycle.

The reversible-void action was removed from the projects module. The terminal
state for a project now arrives only via approval rejection ('Cancelled'); the
void/unvoid endpoints must be gone, and those terminal statuses must not be
settable through a plain edit or status change. Archive remains the way to hide
a project.
"""
import pytest


def _project(c, status="In Progress"):
    r = c.post("/api/projects/", json={"name": f"PV {status}", "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_void_and_unvoid_endpoints_are_gone(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    # Routes were removed entirely → method-not-allowed / not-found, never 2xx.
    assert c.patch(f"/api/projects/{pid}/void", json={"reason": "t"}).status_code in (404, 405)
    assert c.patch(f"/api/projects/{pid}/unvoid").status_code in (404, 405)


def test_terminal_statuses_cannot_be_set_manually(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    # Neither a plain edit nor a status change may smuggle in a terminal status.
    assert c.put(f"/api/projects/{pid}",
                 json={"name": "PV", "status": "Voided"}).status_code == 400
    assert c.put(f"/api/projects/{pid}",
                 json={"name": "PV", "status": "Cancelled"}).status_code == 400
    assert c.patch(f"/api/projects/{pid}/status?status=Voided").status_code == 400
    assert c.patch(f"/api/projects/{pid}/status?status=Cancelled").status_code == 400


def test_cancel_endpoint_is_gone(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    assert c.patch(f"/api/projects/{pid}/cancel",
                   json={"reason": "t"}).status_code in (404, 405)
