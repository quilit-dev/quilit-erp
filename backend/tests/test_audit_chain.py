"""
Tamper-evident audit log.

Every audit row hashes the previous row's hash + its own content, so the admin
verify endpoint can prove the chain is intact — and pinpoint a row that was
edited or deleted directly in the database.
"""


def _make_activity(c, n=6):
    """Generate audited actions (client creates each write one audit row)."""
    for i in range(n):
        r = c.post("/api/clients/", json={"name": f"Chain Co {i}"})
        assert r.status_code in (200, 201), r.text


def _hashed_ids(db):
    return [r["id"] for r in db.execute(
        "SELECT id FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id"
    ).fetchall()]


def test_intact_chain_verifies(as_role, db):
    c = as_role("superadmin")
    _make_activity(c)
    v = c.get("/api/audit/verify").json()
    assert v["ok"] is True
    assert v["checked"] >= 6
    assert v["tip_hash"]


def test_content_edit_is_detected(as_role, db):
    c = as_role("superadmin")
    _make_activity(c)
    ids = _hashed_ids(db)
    victim = ids[len(ids) // 2]                      # a middle row
    db.execute("UPDATE audit_log SET detail=? WHERE id=?",
               ('{"tampered":true}', victim))
    db.commit()

    v = c.get("/api/audit/verify").json()
    assert v["ok"] is False
    assert v["broken_at_id"] == victim
    assert v["reason"] == "content_modified"


def test_midchain_deletion_is_detected(as_role, db):
    c = as_role("superadmin")
    _make_activity(c)
    ids = _hashed_ids(db)
    victim = ids[len(ids) // 2]                      # delete a middle row
    successor = min(i for i in ids if i > victim)
    db.execute("DELETE FROM audit_log WHERE id=?", (victim,))
    db.commit()

    v = c.get("/api/audit/verify").json()
    assert v["ok"] is False
    assert v["reason"] == "row_deleted_or_reordered"
    assert v["broken_at_id"] == successor
