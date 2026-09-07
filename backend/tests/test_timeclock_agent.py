"""The agent's cursor, tested without a fingerprint terminal in the room.

The agent is the one piece of this feature that cannot run in CI end to end ---
nothing here speaks ZKTeco. What CAN be tested is everything that decides which
punches get sent, and that is where the expensive mistakes live: a cursor that
advances too early skips somebody's hours forever, and one that never advances
re-uploads a year of data every five minutes.

The device conversation itself is covered by `--dry-run` and `--replay` against
a recorded dump, which is what the hour with the physical unit is for.
"""
import importlib.util
import json
import os
import pytest

_AGENT = os.path.join(os.path.dirname(__file__), "..", "..",
                      "agent", "timeclock", "agent.py")


@pytest.fixture(autouse=True)
def fresh_db():
    """Override conftest's autouse database rebuild.

    Nothing in this file touches the ERP database --- it is testing a program
    that runs on a PC in somebody's office.
    """
    yield


@pytest.fixture()
def agent(tmp_path, monkeypatch):
    """Import agent.py directly. It is not on the path and must not be.

    `pyzk` and `requests` are imported lazily inside the functions that need
    them, precisely so this import works in an environment that has neither.
    """
    spec = importlib.util.spec_from_file_location("timeclock_agent", _AGENT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setattr(mod.log, "handlers", [])
    return mod


def punches(*stamps, user="7"):
    return [{"device_user_id": user, "punched_at": s} for s in stamps]


CFG = {"erp_url": "https://example.invalid", "device_token": "t" * 43,
       "tenant_slug": "demo", "timeout": 5, "poll_seconds": 300,
       "device_ip": "10.0.0.1", "device_port": 4370, "device_password": 0,
       # Deliberately far back. The tests above are about the cursor, and
       # without pinning this they would start failing on their own as the real
       # date moved past their fixture dates. The start floor has its own tests.
       "start_date": "2020-01-01"}


# ── the file that is safe to lose ────────────────────────────────────────────
def test_a_missing_state_file_means_send_everything(agent):
    # Losing state.json must cost one slow upload, not a gap in somebody's pay.
    assert agent.load_state() == {}
    assert agent.cutoff_from({}) is None
    all_of_them = punches("2020-01-01 08:00:00", "2026-09-07 08:00:00")
    assert agent.filter_new(all_of_them, None) == all_of_them


def test_a_corrupt_state_file_is_treated_as_missing(agent):
    with open(agent.STATE_PATH, "w", encoding="utf-8") as fh:
        fh.write("{ this is not json")
    assert agent.load_state() == {}


def test_the_cursor_survives_a_round_trip(agent):
    agent.save_state({"last_punch_at": "2026-09-07 17:00:00"})
    assert agent.load_state()["last_punch_at"] == "2026-09-07 17:00:00"


def test_the_cursor_is_written_atomically(agent):
    # A power cut mid-write must not leave a truncated file that reads as a
    # different, earlier cursor.
    agent.save_state({"last_punch_at": "2026-09-07 17:00:00"})
    assert not os.path.exists(agent.STATE_PATH + ".tmp")
    with open(agent.STATE_PATH, encoding="utf-8") as fh:
        json.load(fh)


# ── the deliberate overlap ───────────────────────────────────────────────────
def test_it_re_sends_the_last_two_days_on_purpose(agent):
    # Not a bug and not laziness: a punch written to the device while a cycle
    # was in flight would otherwise be skipped forever. The server holds a
    # uniqueness constraint, so the repeat costs bandwidth and nothing else.
    cutoff = agent.cutoff_from({"last_punch_at": "2026-09-07 17:00:00"})
    assert cutoff.strftime("%Y-%m-%d") == "2026-09-05"

    kept = agent.filter_new(punches(
        "2026-09-04 08:00:00",   # older than the overlap -- dropped
        "2026-09-06 08:00:00",   # inside the overlap -- re-sent
        "2026-09-08 08:00:00",   # new
    ), cutoff)
    assert [p["punched_at"] for p in kept] == [
        "2026-09-06 08:00:00", "2026-09-08 08:00:00"]


def test_an_unreadable_timestamp_is_sent_rather_than_dropped(agent):
    # The server counts what it cannot use and reports the number, which is how
    # a terminal with a broken clock gets noticed. Dropping it here would hide
    # exactly the thing worth seeing.
    kept = agent.filter_new(punches("not a date"),
                            agent.cutoff_from({"last_punch_at": "2026-09-07 17:00:00"}))
    assert len(kept) == 1


# ── the cursor only moves on success ─────────────────────────────────────────
def test_nothing_is_marked_sent_until_the_erp_says_so(agent, monkeypatch):
    def explode(cfg, chunk, users=None):
        raise RuntimeError("ERP unreachable")
    monkeypatch.setattr(agent, "send_batch", explode)

    with pytest.raises(RuntimeError):
        agent.run_once(CFG, punches=punches("2026-09-07 08:00:00"))

    assert agent.load_state() == {}, \
        "the cursor moved past punches the ERP never received"


def test_a_successful_send_advances_the_cursor(agent, monkeypatch):
    monkeypatch.setattr(agent, "send_batch",
                        lambda cfg, chunk, users=None: {"accepted": len(chunk),
                                            "duplicates": 0, "rejected": 0})
    out = agent.run_once(CFG, punches=punches("2026-09-07 08:00:00",
                                              "2026-09-07 17:00:00"))
    assert out["sent"] == 2 and out["accepted"] == 2
    assert agent.load_state()["last_punch_at"] == "2026-09-07 17:00:00"


def test_a_second_cycle_does_not_re_upload_the_whole_log(agent, monkeypatch):
    # The terminal holds everything forever, so without a cursor every cycle
    # would push a year of history. What the cursor guarantees is not "only the
    # new one" -- the deliberate two-day overlap re-sends recent punches too --
    # but that anything older than that window is left behind.
    sent = []
    monkeypatch.setattr(agent, "send_batch",
                        lambda cfg, chunk, users=None: (sent.extend(chunk),
                                            {"accepted": len(chunk),
                                             "duplicates": 0, "rejected": 0})[1])
    on_device = punches("2026-01-15 08:00:00",      # months old
                        "2026-09-01 08:00:00", "2026-09-01 17:00:00")
    agent.run_once(CFG, punches=on_device)

    sent.clear()
    on_device += punches("2026-09-02 08:00:00")
    agent.run_once(CFG, punches=on_device)

    times = [p["punched_at"] for p in sent]
    assert "2026-01-15 08:00:00" not in times, "the whole log was re-uploaded"
    assert "2026-09-02 08:00:00" in times, "the new punch was skipped"
    assert len(times) < len(on_device)


def test_a_half_delivered_run_keeps_what_landed(agent, monkeypatch):
    # First batch lands, second fails. The cursor has to reflect the first --
    # and the overlap picks up whatever the second was carrying.
    calls = {"n": 0}

    def flaky(cfg, chunk, users=None):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("connection dropped")
        return {"accepted": len(chunk), "duplicates": 0, "rejected": 0}

    monkeypatch.setattr(agent, "send_batch", flaky)
    monkeypatch.setattr(agent, "BATCH_SIZE", 2)

    with pytest.raises(RuntimeError):
        agent.run_once(CFG, punches=punches(
            "2026-09-07 08:00:00", "2026-09-07 09:00:00",
            "2026-09-07 10:00:00", "2026-09-07 11:00:00"))

    assert agent.load_state()["last_punch_at"] == "2026-09-07 09:00:00"


def test_batches_are_split_under_the_server_cap(agent, monkeypatch):
    sizes = []
    monkeypatch.setattr(agent, "send_batch",
                        lambda cfg, chunk, users=None: (sizes.append(len(chunk)),
                                            {"accepted": len(chunk),
                                             "duplicates": 0, "rejected": 0})[1])
    many = punches(*["2026-09-07 %02d:%02d:00" % (i // 60, i % 60)
                     for i in range(1200)])
    agent.run_once(CFG, punches=many)
    assert max(sizes) <= agent.BATCH_SIZE
    assert max(sizes) <= 1000, "the server refuses a batch over 1000"
    assert sum(sizes) == 1200


def test_punches_are_sent_oldest_first(agent, monkeypatch):
    # The cursor is set from the LAST item of each chunk, so an unsorted batch
    # would advance it past punches that had not been sent.
    sent = []
    monkeypatch.setattr(agent, "send_batch",
                        lambda cfg, chunk, users=None: (sent.extend(chunk),
                                            {"accepted": len(chunk),
                                             "duplicates": 0, "rejected": 0})[1])
    agent.run_once(CFG, punches=punches("2026-09-07 17:00:00",
                                        "2026-09-07 08:00:00"))
    assert [p["punched_at"] for p in sent] == [
        "2026-09-07 08:00:00", "2026-09-07 17:00:00"]


# ── dry run ──────────────────────────────────────────────────────────────────
def test_dry_run_sends_nothing_and_moves_nothing(agent, monkeypatch):
    def explode(cfg, chunk, users=None):
        raise AssertionError("--dry-run sent something")
    monkeypatch.setattr(agent, "send_batch", explode)

    out = agent.run_once(CFG, punches=punches("2026-09-07 08:00:00"),
                         dry_run=True)
    assert out["dry_run"] is True
    assert agent.load_state() == {}


# ── the one that would lose everything ───────────────────────────────────────
def test_the_agent_never_clears_the_device():
    # The terminal's own log is the only backup of the raw record. Clearing it
    # would make any punch that had not yet reached the ERP unrecoverable, and
    # it is the kind of call somebody adds later to "keep the device tidy".
    with open(_AGENT, encoding="utf-8") as fh:
        src = fh.read()
    assert "clear_attendance" not in src.replace(
        "`zk.clear_attendance()` appears nowhere in", ""), \
        "the agent must never clear the terminal's memory"


# ── how far back it reaches ──────────────────────────────────────────────────
def test_by_default_it_starts_from_today_not_from_2024(agent):
    # The real TX628 this was written against held records back to May 2024.
    # Sending those would post attendance into months that have already been
    # paid, against whoever the fingers are later mapped to. A clock starts
    # counting when you install it.
    cfg = dict(CFG, start_date="")
    today = agent.datetime(2026, 9, 8, 14, 30)
    floor = agent.first_run_floor(cfg, today)
    assert floor == agent.datetime(2026, 9, 8, 0, 0),         "the floor must be midnight today, not the moment of first run"

    kept = agent.filter_new(punches(
        "2024-05-03 12:59:57", "2026-02-27 15:42:08",
        "2026-09-08 08:00:00"), agent.effective_cutoff(cfg, {}, today))
    assert [p["punched_at"] for p in kept] == ["2026-09-08 08:00:00"]


def test_an_explicit_start_date_is_honoured(agent):
    cfg = dict(CFG, start_date="2026-02-01")
    today = agent.datetime(2026, 9, 8, 14, 30)
    kept = agent.filter_new(punches(
        "2024-05-03 12:59:57", "2026-02-27 15:42:08",
        "2026-09-08 08:00:00"), agent.effective_cutoff(cfg, {}, today))
    assert [p["punched_at"] for p in kept] == [
        "2026-02-27 15:42:08", "2026-09-08 08:00:00"]


def test_deleting_the_state_file_does_not_resurrect_old_history(agent):
    # The cursor is safe to lose -- but only because the start floor is a
    # SEPARATE guard. Taking the cursor alone would re-open the whole log.
    cfg = dict(CFG, start_date="2026-09-01")
    today = agent.datetime(2026, 9, 8, 14, 30)
    kept = agent.filter_new(punches("2024-05-03 12:59:57"),
                            agent.effective_cutoff(cfg, {}, today))
    assert kept == [], "losing state.json brought 2024 back"


def test_the_floor_and_the_cursor_do_not_undercut_each_other(agent):
    cfg = dict(CFG, start_date="2026-09-01")
    today = agent.datetime(2026, 9, 30, 12, 0)
    # A cursor far ahead of the floor wins: no point re-sending three weeks.
    late = agent.effective_cutoff(cfg, {"last_punch_at": "2026-09-20 17:00:00"}, today)
    assert late > agent.datetime(2026, 9, 1)
    # A floor ahead of the cursor wins: old history stays out.
    cfg2 = dict(CFG, start_date="2026-09-25")
    early = agent.effective_cutoff(cfg2, {"last_punch_at": "2026-09-02 17:00:00"}, today)
    assert early == agent.datetime(2026, 9, 25)


def test_a_malformed_start_date_stops_the_agent_rather_than_guessing(agent):
    # Silently falling back to "today" would look like it worked while quietly
    # ignoring what somebody asked for.
    import pytest as _p
    with _p.raises(SystemExit):
        agent.first_run_floor(dict(CFG, start_date="last tuesday"))


# ── the names on the terminal ────────────────────────────────────────────────
def test_enrolled_names_ride_along_with_the_first_batch_only(agent, monkeypatch):
    # They describe the device, not the punches. Repeating them on every chunk
    # would be noise on the wire for no gain.
    seen = []
    monkeypatch.setattr(agent, "send_batch",
                        lambda cfg, chunk, users=None: (
                            seen.append(users),
                            {"accepted": len(chunk), "duplicates": 0,
                             "rejected": 0})[1])
    monkeypatch.setattr(agent, "BATCH_SIZE", 1)
    cfg = dict(CFG, start_date="2026-09-01",
               _users=[{"device_user_id": "6", "name": "Abdalah"}])
    agent.run_once(cfg, punches("2026-09-07 08:00:00", "2026-09-07 17:00:00"))
    assert seen[0] == [{"device_user_id": "6", "name": "Abdalah"}]
    assert seen[1] is None
