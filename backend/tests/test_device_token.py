"""The first credential in this system that is not a person.

Everything else here authenticates a human through a cookie tied to a `users`
row. This one is a bearer secret held by a program on a PC in somebody's
office, and unlike the only other token in the codebase --- the read-only
document share link --- it can WRITE.

So the tests that matter are mostly negative. What a device token can do is one
short list; what it must never do is everything else, and the parametrised
sweep below is the part worth keeping honest as the API grows.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical

BEARER = "Authorization"


def _device(c, name="Front door"):
    """Register a device as an admin and return (id, plaintext token)."""
    r = c.post("/api/hr/timeclock/devices", json={"name": name})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    return body["id"], body["token"]


def _punch(when="2026-09-07 08:00:00", user="7"):
    return {"punches": [{"device_user_id": user, "punched_at": when}]}


# ── the secret itself ────────────────────────────────────────────────────────
def test_the_token_is_returned_once_and_never_again(make_client):
    c = make_client("superadmin")
    did, token = _device(c)
    assert len(token) >= 40, "a writing credential should not be short"

    listed = c.get("/api/hr/timeclock/devices").json()
    row = next(x for x in listed if x["id"] == did)
    assert "token" not in row, "the plaintext must not come back on a read"
    assert row["token_prefix"] == token[:8], "a prefix, so two devices can be told apart"


def test_only_the_hash_is_stored(make_client, db):
    c = make_client("superadmin")
    did, token = _device(c)
    row = db.execute("SELECT * FROM time_devices WHERE id=?", (did,)).fetchone()
    stored = " ".join(str(v) for v in dict(row).values())
    assert token not in stored, "the plaintext is in the database"
    assert row["token_hash"] and row["token_hash"] != token


def test_two_devices_get_different_tokens(make_client):
    c = make_client("superadmin")
    _, a = _device(c, "Front door")
    _, b = _device(c, "Workshop")
    assert a != b


# ── failing to authenticate ──────────────────────────────────────────────────
def test_a_valid_token_is_accepted(make_client):
    c = make_client("superadmin")
    _, token = _device(c)
    anon = make_client()
    r = anon.get("/api/time/ping", headers={BEARER: "Bearer " + token})
    assert r.status_code == 200, r.text
    assert r.json()["device"] == "Front door"


def test_every_rejection_looks_identical(make_client):
    # Telling "revoked" apart from "never existed" confirms to somebody probing
    # that a token was once real. The share link returns a flat 404 for the same
    # reason; this returns a flat 401.
    c = make_client("superadmin")
    did, token = _device(c)
    assert c.delete("/api/hr/timeclock/devices/%d" % did).status_code == 200

    anon = make_client()
    attempts = {
        "revoked":   anon.get("/api/time/ping", headers={BEARER: "Bearer " + token}),
        "unknown":   anon.get("/api/time/ping", headers={BEARER: "Bearer " + "x" * 43}),
        "no header": anon.get("/api/time/ping"),
        # No "Bearer " prefix at all.
        "malformed": anon.get("/api/time/ping", headers={BEARER: token}),
        # Short enough to be rejected before it is even hashed. This one is here
        # because it takes its own branch through require_device, and a branch
        # with no test on it is exactly where a helpful error message gets added
        # later without anyone noticing it has become an oracle.
        "too short": anon.get("/api/time/ping", headers={BEARER: "Bearer abc"}),
        "empty":     anon.get("/api/time/ping", headers={BEARER: "Bearer "}),
    }

    for label, r in attempts.items():
        assert r.status_code == 401, "%s -> %s %s" % (label, r.status_code, r.text)
    bodies = {r.text for r in attempts.values()}
    assert len(bodies) == 1, "the failures are distinguishable: %r" % bodies


def test_revocation_bites_on_the_very_next_request(make_client):
    c = make_client("superadmin")
    did, token = _device(c)
    anon = make_client()
    hdr = {BEARER: "Bearer " + token}
    assert anon.post("/api/time/punches", json=_punch(), headers=hdr).status_code == 200

    assert c.delete("/api/hr/timeclock/devices/%d" % did).status_code == 200
    # No caching anywhere: the check is a query on every request.
    assert anon.post("/api/time/punches",
                     json=_punch("2026-09-07 17:00:00"),
                     headers=hdr).status_code == 401


def test_rotating_the_token_kills_the_old_one(make_client):
    c = make_client("superadmin")
    did, old = _device(c)
    new = c.post("/api/hr/timeclock/devices/%d/rotate" % did).json()["token"]
    assert new != old

    anon = make_client()
    assert anon.get("/api/time/ping",
                    headers={BEARER: "Bearer " + old}).status_code == 401
    assert anon.get("/api/time/ping",
                    headers={BEARER: "Bearer " + new}).status_code == 200


# ── what the token must NOT reach ────────────────────────────────────────────
@pytest.mark.parametrize("path", [
    "/api/hr/employees",
    "/api/hr/attendance",
    "/api/hr/payroll/runs",
    "/api/hr/timeclock/devices",
    "/api/hr/timeclock/device-users",
    "/api/settings/",
    "/api/invoices/",
    "/api/clients/",
    "/api/dashboard/",
    "/api/users/",
])
def test_a_device_token_opens_nothing_but_its_two_endpoints(make_client, path):
    # The sweep that has to keep being true as the API grows. Nothing outside
    # /api/time reads an Authorization header, so a stolen token is inert --- and
    # this is what proves it rather than asserting it in a comment.
    c = make_client("superadmin")
    _, token = _device(c)
    anon = make_client()
    r = anon.get(path, headers={BEARER: "Bearer " + token})
    assert r.status_code != 200, \
        "a device token reached %s: %s" % (path, r.text[:200])
    assert r.status_code in (401, 403, 404, 405), (path, r.status_code)


def test_a_device_cannot_register_or_revoke_a_device(make_client):
    c = make_client("superadmin")
    did, token = _device(c)
    anon = make_client()
    hdr = {BEARER: "Bearer " + token}
    assert anon.post("/api/hr/timeclock/devices",
                     json={"name": "Mine"}, headers=hdr).status_code != 200
    assert anon.post("/api/hr/timeclock/devices/%d/rotate" % did,
                     headers=hdr).status_code != 200
    assert anon.delete("/api/hr/timeclock/devices/%d" % did,
                       headers=hdr).status_code != 200


def test_the_reply_carries_counts_and_nothing_else(make_client):
    # A device has no business knowing who works here. If the response ever
    # grew a name or a roster, a stolen token would start leaking on read as
    # well as on write.
    c = make_client("superadmin")
    _, token = _device(c)
    anon = make_client()
    body = anon.post("/api/time/punches", json=_punch(),
                     headers={BEARER: "Bearer " + token}).json()
    assert set(body) == {"accepted", "duplicates", "rejected"}
    assert all(isinstance(v, int) for v in body.values())

    ping = anon.get("/api/time/ping", headers={BEARER: "Bearer " + token}).json()
    assert set(ping) == {"ok", "device", "server_time"}


def test_it_cannot_edit_or_delete_a_punch_it_already_sent(make_client):
    # Ingest is append-only by construction: there is no UPDATE and no DELETE on
    # time_punches behind this credential, so injected data can be found and
    # removed but real history cannot be rewritten.
    c = make_client("superadmin")
    _, token = _device(c)
    anon = make_client()
    hdr = {BEARER: "Bearer " + token}
    anon.post("/api/time/punches", json=_punch(), headers=hdr)
    for verb in ("put", "patch", "delete"):
        r = getattr(anon, verb)("/api/time/punches", headers=hdr)
        assert r.status_code in (404, 405), (verb, r.status_code)


# ── permissions on the human side ────────────────────────────────────────────
def test_a_viewer_cannot_register_a_device(make_client):
    c = make_client("Viewer")
    r = c.post("/api/hr/timeclock/devices", json={"name": "Sneaky"})
    assert r.status_code == 403, r.text


def test_registering_a_device_is_audited(make_client, db):
    c = make_client("superadmin")
    name = "Audited %s" % uuid.uuid4().hex[:5]
    did, _ = _device(c, name)
    row = db.execute(
        "SELECT * FROM audit_log WHERE module='time_device' AND record_id=? "
        "ORDER BY id DESC LIMIT 1", (did,)).fetchone()
    assert row is not None, "registering a writing credential must leave a trace"
    assert row["action"] == "create"
    assert row["record_ref"] == name


def test_an_ingest_batch_is_audited_as_a_machine(make_client, db):
    c = make_client("superadmin")
    _, token = _device(c)
    anon = make_client()
    anon.post("/api/time/punches", json=_punch(),
              headers={BEARER: "Bearer " + token})
    row = db.execute("SELECT * FROM audit_log WHERE action='ingest' "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    assert "device:" in (row["username"] or ""), \
        "the actor was a machine and the log should not borrow somebody's name"
