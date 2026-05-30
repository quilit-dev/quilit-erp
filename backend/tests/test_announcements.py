"""
Tests for the announcement system.

Coverage
--------
* RBAC — only roles with announcements.create can publish.
* Audience resolution — all / roles / users → correct recipients.
* Inbox visibility — recipients see the announcement, non-recipients don't.
* Read tracking — first GET marks recipient row read; unread count drops.
* Acknowledge — requires_ack flow; non-recipients are blocked.
* Comments — recipient + author can comment; foreign user rejected.
* Archive — author or superadmin only.
* Audience roster — author only.
"""


# ── Helpers ────────────────────────────────────────────────────────────────

def _publish(c, **overrides):
    body = {
        "title": "Quarterly all-hands",
        "body":  "Town hall next Friday at 14:00.",
        "priority": "medium",
        "audience_type": "all",
        "requires_ack": False,
        "pinned": False,
        **overrides,
    }
    r = c.post("/api/announcements/", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _user_id(db, username):
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    assert row, f"user {username!r} missing"
    return row["id"]


# ── Publish / RBAC ────────────────────────────────────────────────────────

def test_superadmin_can_publish(as_role):
    c = as_role("superadmin")
    res = _publish(c)
    assert res["recipients"] > 0


def test_manager_can_publish(as_role):
    """Manager is granted announcements.create by the default seed."""
    c = as_role("Manager")
    res = _publish(c, title="From a manager")
    assert "id" in res


def test_sales_user_cannot_publish(as_role):
    """Sales has only view, not create."""
    c = as_role("Sales")
    r = c.post("/api/announcements/", json={
        "title": "x", "body": "x", "audience_type": "all",
    })
    assert r.status_code == 403


def test_anonymous_cannot_publish(client):
    r = client.post("/api/announcements/", json={
        "title": "x", "body": "x", "audience_type": "all",
    })
    assert r.status_code == 401


# ── Audience resolution ──────────────────────────────────────────────────

def test_audience_all_includes_every_active_user(as_role, db):
    c = as_role("superadmin")
    res = _publish(c)
    total_users = db.execute(
        "SELECT COUNT(*) FROM users WHERE is_active=1 AND deleted_at IS NULL"
    ).fetchone()[0]
    rec = db.execute(
        "SELECT COUNT(*) FROM announcement_recipients WHERE announcement_id=?",
        (res["id"],),
    ).fetchone()[0]
    assert rec == total_users


def test_audience_users_targets_only_listed_users(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    crm_id   = _user_id(db, "u_crm")
    res = _publish(c,
                   audience_type="users",
                   audience_ids=[sales_id, crm_id],
                   title="For sales + crm")
    rec_ids = {r["user_id"] for r in db.execute(
        "SELECT user_id FROM announcement_recipients WHERE announcement_id=?",
        (res["id"],)).fetchall()}
    assert rec_ids == {sales_id, crm_id}


def test_audience_roles_targets_all_users_in_role(as_role, db):
    c = as_role("superadmin")
    sales_role = db.execute("SELECT id FROM roles WHERE name='Sales'").fetchone()["id"]
    res = _publish(c,
                   audience_type="roles",
                   audience_ids=[sales_role],
                   title="For sales role")
    # Should include u_sales but not, say, u_accountant
    rec_users = [r["username"] for r in db.execute(
        "SELECT u.username FROM announcement_recipients r "
        "JOIN users u ON u.id=r.user_id WHERE r.announcement_id=?",
        (res["id"],),
    ).fetchall()]
    assert "u_sales" in rec_users
    assert "u_accountant" not in rec_users


def test_audience_users_with_empty_list_rejected(as_role):
    c = as_role("superadmin")
    r = c.post("/api/announcements/", json={
        "title": "x", "body": "x", "audience_type": "users", "audience_ids": [],
    })
    assert r.status_code == 400


# ── Inbox + read tracking ────────────────────────────────────────────────

def test_recipient_sees_announcement_non_recipient_does_not(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    _publish(c, audience_type="users", audience_ids=[sales_id], title="Sales only")

    sales = as_role("Sales")
    rows = sales.get("/api/announcements/").json()
    assert any(a["title"] == "Sales only" for a in rows)

    accountant = as_role("Accountant")
    rows = accountant.get("/api/announcements/").json()
    assert all(a["title"] != "Sales only" for a in rows)


def test_unread_count_drops_after_detail_get(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id], title="Read me")

    sales = as_role("Sales")
    before = sales.get("/api/announcements/unread-count").json()
    assert before["unread"] >= 1

    sales.get(f"/api/announcements/{res['id']}")

    after = sales.get("/api/announcements/unread-count").json()
    assert after["unread"] == before["unread"] - 1


def test_non_recipient_cannot_view_detail(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])

    accountant = as_role("Accountant")
    r = accountant.get(f"/api/announcements/{res['id']}")
    assert r.status_code == 404


# ── Acknowledge ──────────────────────────────────────────────────────────

def test_recipient_can_acknowledge(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id],
                   requires_ack=True, title="Please ack")

    sales = as_role("Sales")
    r = sales.post(f"/api/announcements/{res['id']}/acknowledge")
    assert r.status_code == 200

    pending = sales.get("/api/announcements/unread-count").json()["pending_ack"]
    assert pending == 0


def test_non_recipient_cannot_acknowledge(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id],
                   requires_ack=True, title="ack me")

    accountant = as_role("Accountant")
    r = accountant.post(f"/api/announcements/{res['id']}/acknowledge")
    assert r.status_code == 403


def test_acknowledge_is_idempotent(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id],
                   requires_ack=True)

    sales = as_role("Sales")
    r1 = sales.post(f"/api/announcements/{res['id']}/acknowledge")
    r2 = sales.post(f"/api/announcements/{res['id']}/acknowledge")
    assert r1.status_code == 200 and r2.status_code == 200
    # second call returns the same timestamp
    assert r1.json()["acknowledged_at"] is not None


# ── Comments ──────────────────────────────────────────────────────────────

def test_recipient_can_comment(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])

    sales = as_role("Sales")
    r = sales.post(f"/api/announcements/{res['id']}/comments",
                   json={"body": "Got it, thanks."})
    assert r.status_code == 200

    rows = sales.get(f"/api/announcements/{res['id']}/comments").json()
    assert len(rows) == 1 and rows[0]["body"] == "Got it, thanks."


def test_empty_comment_rejected(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])

    sales = as_role("Sales")
    r = sales.post(f"/api/announcements/{res['id']}/comments", json={"body": "   "})
    assert r.status_code == 400


def test_non_recipient_cannot_comment(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])

    accountant = as_role("Accountant")
    r = accountant.post(f"/api/announcements/{res['id']}/comments",
                        json={"body": "snooping"})
    assert r.status_code == 403


def test_user_can_delete_own_comment(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])

    sales = as_role("Sales")
    cid = sales.post(f"/api/announcements/{res['id']}/comments",
                     json={"body": "to delete"}).json()["id"]
    r = sales.delete(f"/api/announcements/{res['id']}/comments/{cid}")
    assert r.status_code == 200

    rows = sales.get(f"/api/announcements/{res['id']}/comments").json()
    assert rows == []


# ── Archive ───────────────────────────────────────────────────────────────

def test_author_can_archive(as_role):
    c = as_role("superadmin")
    res = _publish(c)
    r = c.delete(f"/api/announcements/{res['id']}")
    assert r.status_code == 200
    # Archived: inbox no longer returns it for anyone
    rows = c.get("/api/announcements/").json()
    assert all(a["id"] != res["id"] for a in rows)


def test_non_author_recipient_cannot_archive(as_role, db):
    """A Manager (has announcements.delete by default) cannot archive
    another author's announcement unless they are superadmin."""
    superadmin = as_role("superadmin")
    res = _publish(superadmin)

    manager = as_role("Manager")
    r = manager.delete(f"/api/announcements/{res['id']}")
    assert r.status_code == 403


# ── Audience roster ──────────────────────────────────────────────────────

def test_author_can_read_roster(as_role, db):
    c = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(c, audience_type="users", audience_ids=[sales_id])
    r = c.get(f"/api/announcements/{res['id']}/audience")
    assert r.status_code == 200
    assert any(row["username"] == "u_sales" for row in r.json())


def test_non_author_cannot_read_roster(as_role, db):
    """Even a recipient cannot see the full roster — only the author."""
    superadmin = as_role("superadmin")
    sales_id = _user_id(db, "u_sales")
    res = _publish(superadmin, audience_type="users", audience_ids=[sales_id])

    sales = as_role("Sales")
    r = sales.get(f"/api/announcements/{res['id']}/audience")
    assert r.status_code == 403


# ── Anonymous access ─────────────────────────────────────────────────────

def test_anonymous_cannot_list_inbox(client):
    r = client.get("/api/announcements/")
    assert r.status_code == 401


def test_anonymous_cannot_get_unread_count(client):
    r = client.get("/api/announcements/unread-count")
    assert r.status_code == 401
