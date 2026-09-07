"""Punches arriving from a machine that will send the same ones again.

The agent at the customer's site re-sends an overlapping window every cycle,
and re-sends its whole cursor after losing its state file, because the server's
natural key is what actually guarantees a punch is recorded once. So the
central assertion here is not "a punch can be stored" --- it is "the same punch
arriving five times is still one punch, and the reply says so without
complaining".

The other half is what happens to a punch nobody has claimed. A finger gets
enrolled on the terminal days before anyone in the ERP says whose it is, and
dropping those punches would lose real hours silently.
"""
import pytest

pytestmark = pytest.mark.critical

BEARER = "Authorization"
DAY = "2026-09-07"


@pytest.fixture()
def clock(make_client):
    """An admin client, a device, and an anonymous client holding its token."""
    admin = make_client("superadmin")
    r = admin.post("/api/hr/timeclock/devices", json={"name": "Front door"})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    agent = make_client()
    agent.headers.update({BEARER: "Bearer " + body["token"]})
    return admin, agent, body["id"]


def batch(*pairs):
    return {"punches": [{"device_user_id": u, "punched_at": t} for u, t in pairs]}


def _employee(admin, name="Rami Haddad"):
    r = admin.post("/api/hr/employees", json={
        "full_name": name, "employment_type": "Full-time", "status": "Active"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _mapping(admin, device_user_id):
    rows = admin.get("/api/hr/timeclock/device-users").json()
    return next(r for r in rows if r["device_user_id"] == device_user_id)


# ── the happy path ───────────────────────────────────────────────────────────
def test_punches_are_stored(clock, db):
    _, agent, did = clock
    r = agent.post("/api/time/punches",
                   json=batch(("7", DAY + " 08:00:00"), ("7", DAY + " 17:00:00")))
    assert r.status_code == 200, r.text
    assert r.json() == {"accepted": 2, "duplicates": 0, "rejected": 0}
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 2


def test_the_local_date_is_filled_in_for_indexing(clock, db):
    _, agent, _ = clock
    agent.post("/api/time/punches", json=batch(("7", DAY + " 08:00:00")))
    row = db.execute("SELECT * FROM time_punches").fetchone()
    assert row["local_date"] == DAY
    assert row["source"] == "device"


def test_the_device_records_when_it_last_heard_something(clock, db):
    _, agent, did = clock
    agent.post("/api/time/punches",
               json=batch(("7", DAY + " 08:00:00"), ("7", DAY + " 17:00:00")))
    row = db.execute("SELECT * FROM time_devices WHERE id=?", (did,)).fetchone()
    assert row["last_punch_at"] == DAY + " 17:00:00"
    assert row["last_seen_at"], "silence is the dangerous failure; this is how it shows"


# ── the replay, which is the whole point ─────────────────────────────────────
def test_the_same_batch_twice_is_still_one_set_of_punches(clock, db):
    _, agent, _ = clock
    body = batch(("7", DAY + " 08:00:00"), ("7", DAY + " 17:00:00"))
    first = agent.post("/api/time/punches", json=body).json()
    second = agent.post("/api/time/punches", json=body).json()

    assert first == {"accepted": 2, "duplicates": 0, "rejected": 0}
    assert second == {"accepted": 0, "duplicates": 2, "rejected": 0}, \
        "a replay must be absorbed, not refused -- a 409 would stall the agent"
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 2


def test_replaying_five_times_changes_nothing(clock, db):
    _, agent, _ = clock
    body = batch(("7", DAY + " 08:00:00"))
    for _ in range(5):
        assert agent.post("/api/time/punches", json=body).status_code == 200
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 1


def test_an_overlapping_window_lands_only_the_new_punches(clock, db):
    # Exactly what the agent does every cycle: re-send the last two days.
    _, agent, _ = clock
    agent.post("/api/time/punches",
               json=batch(("7", DAY + " 08:00:00"), ("7", DAY + " 12:00:00")))
    r = agent.post("/api/time/punches", json=batch(
        ("7", DAY + " 12:00:00"), ("7", DAY + " 13:00:00"),
        ("7", DAY + " 17:00:00"))).json()
    assert r == {"accepted": 2, "duplicates": 1, "rejected": 0}
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 4


def test_two_devices_may_both_use_enrolment_number_one(clock, make_client, db):
    # The reason the mapping is a table and not a column on hr_employees. Two
    # sites each starting their enrolment numbers at 1 is the normal case, and
    # these punches must not collide or be mistaken for each other.
    admin, agent, _ = clock
    other = admin.post("/api/hr/timeclock/devices",
                       json={"name": "Workshop"}).json()
    agent2 = make_client()
    agent2.headers.update({BEARER: "Bearer " + other["token"]})

    body = batch(("1", DAY + " 08:00:00"))
    assert agent.post("/api/time/punches", json=body).json()["accepted"] == 1
    assert agent2.post("/api/time/punches", json=body).json()["accepted"] == 1, \
        "the other site's employee 1 is a different person"
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 2


# ── the finger nobody has claimed ────────────────────────────────────────────
def test_an_unknown_enrolment_number_is_kept_not_dropped(clock, db):
    _, agent, _ = clock
    assert agent.post("/api/time/punches",
                      json=batch(("42", DAY + " 08:00:00"))).status_code == 200
    row = db.execute("SELECT * FROM time_punches").fetchone()
    assert row["employee_id"] is None, "kept, waiting for somebody to claim it"
    assert row["device_user_id"] == "42"


def test_it_shows_up_as_unclaimed_for_somebody_to_fix(clock):
    # Without this screen the punches pile up against nobody and the first
    # anyone hears of it is a month with no hours in it.
    admin, agent, _ = clock
    agent.post("/api/time/punches", json=batch(("42", DAY + " 08:00:00")))
    m = _mapping(admin, "42")
    assert m["employee_id"] is None
    assert m["punch_count"] == 1
    assert m["device"] == "Front door"


def test_claiming_a_number_back_fills_the_punches_it_already_has(clock, db):
    admin, agent, _ = clock
    agent.post("/api/time/punches",
               json=batch(("42", DAY + " 08:00:00"), ("42", DAY + " 17:00:00")))
    emp = _employee(admin)
    m = _mapping(admin, "42")

    r = admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
                  json={"employee_id": emp})
    assert r.status_code == 200, r.text
    assert r.json()["punches_claimed"] == 2

    owned = db.execute("SELECT COUNT(*) c FROM time_punches WHERE employee_id=?",
                       (emp,)).fetchone()["c"]
    assert owned == 2


def test_later_punches_go_straight_to_the_right_employee(clock, db):
    admin, agent, _ = clock
    emp = _employee(admin)
    agent.post("/api/time/punches", json=batch(("42", DAY + " 08:00:00")))
    m = _mapping(admin, "42")
    admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
              json={"employee_id": emp})

    agent.post("/api/time/punches", json=batch(("42", DAY + " 17:00:00")))
    row = db.execute("SELECT * FROM time_punches WHERE punched_at=?",
                     (DAY + " 17:00:00",)).fetchone()
    assert row["employee_id"] == emp


def test_reassigning_a_finger_slot_never_rewrites_history(clock, db):
    # A leaver's enrolment slot gets reused. Last month's hours must stay with
    # the leaver --- otherwise a payroll run that has already been paid quietly
    # changes meaning, and the payslip no longer matches the record.
    admin, agent, _ = clock
    leaver = _employee(admin, "Old Hand")
    joiner = _employee(admin, "New Start")

    agent.post("/api/time/punches", json=batch(("9", DAY + " 08:00:00")))
    m = _mapping(admin, "9")
    admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
              json={"employee_id": leaver})

    r = admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
                  json={"employee_id": joiner})
    assert r.json()["punches_claimed"] == 0, "nothing should have been re-pointed"

    row = db.execute("SELECT * FROM time_punches WHERE device_user_id='9'").fetchone()
    assert row["employee_id"] == leaver, "the leaver's hour was taken from them"


def test_claiming_a_number_for_a_nonexistent_employee_is_refused(clock):
    admin, agent, _ = clock
    agent.post("/api/time/punches", json=batch(("42", DAY + " 08:00:00")))
    m = _mapping(admin, "42")
    assert admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
                     json={"employee_id": 999999}).status_code == 404


# ── a terminal with the wrong clock ──────────────────────────────────────────
def test_a_punch_from_the_far_future_is_skipped_and_counted(clock, db):
    # One terminal with the wrong year set would otherwise write punches into
    # every future month forever -- far likelier than an attack, and worse.
    _, agent, _ = clock
    r = agent.post("/api/time/punches", json=batch(
        ("7", DAY + " 08:00:00"), ("7", "2098-01-01 08:00:00"))).json()
    assert r == {"accepted": 1, "duplicates": 0, "rejected": 1}
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 1


def test_an_ancient_punch_is_skipped_too(clock, db):
    _, agent, _ = clock
    r = agent.post("/api/time/punches",
                   json=batch(("7", "1999-01-01 08:00:00"))).json()
    assert r["rejected"] == 1 and r["accepted"] == 0
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 0


def test_the_good_punches_in_a_bad_batch_still_land(clock):
    # A date that is the right shape and still impossible -- the 45th of the
    # 13th, which is what a terminal with corrupted memory produces.
    #
    # Deliberately NOT a 422 for the whole batch. Bad timestamps are burned into
    # the device's own log, so refusing the batch would stall ingestion forever
    # while the agent re-sent the same rows on every cycle.
    _, agent, _ = clock
    r = agent.post("/api/time/punches", json=batch(
        ("7", DAY + " 08:00:00"), ("7", "2026-13-45 08:00:00"),
        ("7", DAY + " 17:00:00"))).json()
    assert r == {"accepted": 2, "duplicates": 0, "rejected": 1}


def test_a_structurally_broken_payload_is_refused_outright(clock, db):
    # Different case, different answer. A timestamp too short to be a date at
    # all is a bug in the agent, not a clock that drifted -- and the loud 422
    # is what gets that fixed instead of quietly counted for weeks.
    _, agent, _ = clock
    assert agent.post("/api/time/punches",
                      json=batch(("7", "nonsense"))).status_code == 422
    assert agent.post("/api/time/punches",
                      json=batch(("", DAY + " 08:00:00"))).status_code == 422
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 0


def test_an_oversized_batch_is_refused_before_any_work(clock, db):
    _, agent, _ = clock
    huge = {"punches": [{"device_user_id": "7",
                         "punched_at": "2026-09-07 08:00:%02d" % (i % 60)}
                        for i in range(1001)]}
    assert agent.post("/api/time/punches", json=huge).status_code == 422
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 0


def test_an_empty_batch_is_refused(clock):
    _, agent, _ = clock
    assert agent.post("/api/time/punches", json={"punches": []}).status_code == 422


# ── nothing reaches attendance yet ───────────────────────────────────────────
def test_ingest_does_not_touch_hr_attendance(clock, db):
    # This commit stores punches and stops. A customer should be able to run the
    # agent for a week and watch real data arrive before anything they read
    # starts being computed from it.
    admin, agent, _ = clock
    emp = _employee(admin)
    agent.post("/api/time/punches",
               json=batch(("7", DAY + " 08:00:00"), ("7", DAY + " 17:00:00")))
    m = _mapping(admin, "7")
    admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
              json={"employee_id": emp})

    assert db.execute("SELECT COUNT(*) c FROM hr_attendance").fetchone()["c"] == 0, \
        "punches must not become attendance until somebody turns that on"


# ── the throttle ─────────────────────────────────────────────────────────────
def test_a_device_that_floods_is_throttled_but_keeps_what_it_sent(clock, db):
    import device_auth
    _, agent, _ = clock
    limit = device_auth.RATE_MAX_PER_WINDOW

    codes = []
    for i in range(limit + 5):
        codes.append(agent.post("/api/time/punches", json=batch(
            ("7", "2026-09-07 %02d:%02d:00" % (i // 60, i % 60)))).status_code)

    assert 429 in codes, "an unbounded writer needs a ceiling"
    assert codes.count(200) == limit, \
        "everything up to the ceiling should have been accepted normally"
    stored = db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"]
    assert stored == limit, "the punches sent before the ceiling were kept"


# ── the names enrolled on the terminal ───────────────────────────────────────
def test_the_enrolled_name_is_stored_beside_the_number(clock):
    # Without it the mapping screen shows a bare "6" and somebody has to already
    # know that finger 6 is Abdalah. The name is a LABEL, never an identity --
    # pay depends on the ERP's own employee record, which a human still links.
    admin, agent, _ = clock
    r = agent.post("/api/time/punches", json={
        "punches": [{"device_user_id": "6", "punched_at": DAY + " 08:00:00"}],
        "users": [{"device_user_id": "6", "name": "Abdalah"},
                  {"device_user_id": "2", "name": "JINANE"}]})
    assert r.status_code == 200, r.text
    m = _mapping(admin, "6")
    assert m["device_name"] == "Abdalah"
    assert m["employee_id"] is None, "a name is not a claim"


def test_a_name_changed_on_the_keypad_catches_up(clock):
    admin, agent, _ = clock
    body = {"punches": [{"device_user_id": "6", "punched_at": DAY + " 08:00:00"}],
            "users": [{"device_user_id": "6", "name": "Abdalah"}]}
    agent.post("/api/time/punches", json=body)
    body["users"] = [{"device_user_id": "6", "name": "Abdalah H"}]
    body["punches"] = [{"device_user_id": "6", "punched_at": DAY + " 17:00:00"}]
    agent.post("/api/time/punches", json=body)
    assert _mapping(admin, "6")["device_name"] == "Abdalah H"


def test_a_name_never_moves_the_employee_link(clock, db):
    # A relabelled finger must not silently re-point somebody's hours.
    admin, agent, _ = clock
    emp = _employee(admin)
    agent.post("/api/time/punches", json={
        "punches": [{"device_user_id": "6", "punched_at": DAY + " 08:00:00"}],
        "users": [{"device_user_id": "6", "name": "Abdalah"}]})
    m = _mapping(admin, "6")
    admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
              json={"employee_id": emp})

    agent.post("/api/time/punches", json={
        "punches": [{"device_user_id": "6", "punched_at": DAY + " 17:00:00"}],
        "users": [{"device_user_id": "6", "name": "Somebody Else"}]})
    after = _mapping(admin, "6")
    assert after["employee_id"] == emp, "a rename re-pointed the mapping"
    assert after["device_name"] == "Somebody Else"


def test_punches_still_land_when_the_agent_sends_no_names(clock):
    # An older agent, or one whose get_users() call failed. Attendance is the
    # job; the label is a nicety.
    _, agent, _ = clock
    r = agent.post("/api/time/punches", json=batch(("6", DAY + " 08:00:00")))
    assert r.status_code == 200
    assert r.json()["accepted"] == 1
