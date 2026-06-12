"""Project void / unvoid lifecycle.

Projects follow the same reversible-void pattern as quotations: /void
remembers the previous status (void_prev_status) and /unvoid restores it
exactly. A voided project is inert — no edit, no status change, and the
commercial auto-advance (bump_project_status) skips it. Legacy 'Cancelled'
projects stay terminal and unvoid like voided ones.
"""
import pytest


def _project(c, status="In Progress"):
    r = c.post("/api/projects/", json={"name": f"PV {status}", "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_void_restores_exact_previous_status(make_client):
    c = make_client("superadmin")
    pid = _project(c, status="In Progress")

    assert c.patch(f"/api/projects/{pid}/void",
                   json={"reason": "t"}).status_code == 200
    assert c.get(f"/api/projects/{pid}").json()["status"] == "Voided"
    # Double-void → 400.
    assert c.patch(f"/api/projects/{pid}/void",
                   json={"reason": "t"}).status_code == 400

    assert c.patch(f"/api/projects/{pid}/unvoid").status_code == 200
    assert c.get(f"/api/projects/{pid}").json()["status"] == "In Progress"
    # Unvoiding a live project → 400.
    assert c.patch(f"/api/projects/{pid}/unvoid").status_code == 400


def test_voided_project_is_inert(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    assert c.patch(f"/api/projects/{pid}/void",
                   json={"reason": "t"}).status_code == 200

    # No edit, no manual status change, no smuggling Voided via update/status.
    assert c.put(f"/api/projects/{pid}",
                 json={"name": "PV renamed"}).status_code == 400
    assert c.patch(f"/api/projects/{pid}/status?status=Completed").status_code == 400
    p2 = _project(c)
    assert c.patch(f"/api/projects/{p2}/status?status=Voided").status_code == 400

    # After unvoid everything works again.
    assert c.patch(f"/api/projects/{pid}/unvoid").status_code == 200
    assert c.put(f"/api/projects/{pid}",
                 json={"name": "PV renamed"}).status_code == 200


def test_commercial_auto_advance_skips_voided(make_client, db):
    """bump_project_status (quotation sent / invoiced hooks) must not pull a
    voided project back onto the status ladder."""
    c = make_client("superadmin")
    pid = _project(c, status="Inquiry")
    assert c.patch(f"/api/projects/{pid}/void",
                   json={"reason": "t"}).status_code == 200

    from routers.projects import bump_project_status
    bump_project_status(db, pid, "Invoiced")
    db.commit()
    assert c.get(f"/api/projects/{pid}").json()["status"] == "Voided"


def test_void_then_archive_and_restore(make_client):
    """Void and archive are orthogonal: a voided project can still be archived
    (delete-tier) and restored, keeping its Voided status."""
    c = make_client("superadmin")
    pid = _project(c)
    assert c.patch(f"/api/projects/{pid}/void",
                   json={"reason": "t"}).status_code == 200
    assert c.patch(f"/api/projects/{pid}/archive",
                   json={"reason": "t"}).status_code == 200
    assert c.patch(f"/api/projects/{pid}/unarchive").status_code == 200
    assert c.get(f"/api/projects/{pid}").json()["status"] == "Voided"


def test_cancel_endpoint_is_gone(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    assert c.patch(f"/api/projects/{pid}/cancel",
                   json={"reason": "t"}).status_code in (404, 405)
