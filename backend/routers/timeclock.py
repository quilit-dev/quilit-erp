"""The fingerprint clock: what the site agent may do, and what HR may do.

Two routers live here, with two completely different ways of authenticating,
and they are in one file on purpose --- the whole surface a device token can
reach should be readable on one screen.

  * `device_router` (/api/time)   Bearer token, no user, no RBAC. TWO endpoints.
                                  Append-only. Returns counts and nothing else.
  * `router` (/api/hr/timeclock)  the ordinary cookie session plus require_perm,
                                  for the people who register devices and say
                                  which enrolment number is whose.

Nothing else in the application reads an Authorization header, so a stolen
device token is inert outside the two handlers below. See device_auth.py for
the credential itself and for the risks that cannot be designed away.

This commit stores punches and stops. Deriving them into hr_attendance is
deliberately not wired up yet: a customer should be able to install the agent,
watch a week of real punches arrive, and only then switch attendance over ---
so that the day the automation starts affecting figures is a day somebody chose.
"""
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import attendance_sync
from database import get_db
from device_auth import hash_token, require_device
from permissions import require_perm
from routers.audit import log_action
from utils import _now

device_router = APIRouter()
router = APIRouter()

# A clock with the wrong year set is far likelier than an attacker, and it does
# more damage: punches dated 2098 would sit in every future month forever.
MAX_FUTURE_HOURS = 24      # generous, because device clocks drift and DST exists
MAX_PAST_DAYS = 400        # a year of history on first install, plus slack
MAX_BATCH = 1000


# ── models ───────────────────────────────────────────────────────────────────
class PunchIn(BaseModel):
    device_user_id: str = Field(min_length=1, max_length=64)
    punched_at: str = Field(min_length=10, max_length=25)
    # Recorded, not trusted. The terminal only fills these in when somebody has
    # configured its IN/OUT function keys; pairing is by alternation regardless.
    # Keeping them means the rule can be tightened later without re-collecting.
    direction: Optional[str] = Field(default=None, max_length=8)
    raw_punch: Optional[int] = None
    raw_status: Optional[int] = None


class DeviceUserIn(BaseModel):
    device_user_id: str = Field(min_length=1, max_length=64)
    name: Optional[str] = Field(default=None, max_length=120)


class PunchBatch(BaseModel):
    punches: List[PunchIn] = Field(min_length=1, max_length=MAX_BATCH)
    # The names enrolled on the terminal itself. Optional, and describing the
    # DEVICE rather than the punches -- an agent that cannot read them still
    # delivers attendance perfectly well. They exist so the mapping screen can
    # show "6 - Abdalah" instead of a bare 6, which is the difference between a
    # screen somebody can use and one that needs institutional memory.
    users: Optional[List[DeviceUserIn]] = Field(default=None, max_length=MAX_BATCH)


class DeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    serial_number: Optional[str] = Field(default=None, max_length=64)
    branch_id: Optional[int] = None


class MappingIn(BaseModel):
    employee_id: Optional[int] = None


# ── helpers ──────────────────────────────────────────────────────────────────
def _parse_punch(value: str) -> Optional[datetime]:
    s = str(value).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s[:19] if len(s) >= 19 else s, fmt)
        except ValueError:
            continue
    return None


def _new_device_token() -> str:
    """32 bytes, not the 16 a share link uses.

    That one rides in a URL a customer clicks, where length is a cost. This is
    pasted into a config file once, so length is free --- and unlike a share
    link, this token can write.
    """
    return secrets.token_urlsafe(32)


def _device_row(db, row) -> dict:
    """A device as HR sees it. The token is not in here and never can be."""
    return {
        "id": row["id"], "name": row["name"],
        "serial_number": row["serial_number"], "branch_id": row["branch_id"],
        "token_prefix": row["token_prefix"],
        "last_seen_at": row["last_seen_at"], "last_punch_at": row["last_punch_at"],
        "agent_version": row["agent_version"],
        "revoked_at": row["revoked_at"], "created_at": row["created_at"],
        "punch_count": db.execute(
            "SELECT COUNT(*) c FROM time_punches WHERE device_id=?",
            (row["id"],)).fetchone()["c"],
    }


# ═════════════════════════════════════════════════════════════════════════════
# DEVICE-FACING. Bearer token only. Everything a stolen token can reach is here.
# ═════════════════════════════════════════════════════════════════════════════
@device_router.get("/ping")
def ping(device: dict = Depends(require_device)):
    """Confirm the token works, and expose the server's clock.

    The clock matters more than it looks: a TX628 does not follow daylight
    saving on its own, so it runs an hour out twice a year until somebody
    changes it on the keypad. The agent logs the difference between these two
    values so the drift is visible before it reaches a payslip.
    """
    return {"ok": True, "device": device["name"], "server_time": _now()}


@device_router.post("/punches")
def ingest_punches(data: PunchBatch, device: dict = Depends(require_device),
                   db: sqlite3.Connection = Depends(get_db)):
    """Append raw punches. Idempotent, append-only, and counts-only in reply.

    **Duplicates are not an error.** The agent deliberately re-sends an
    overlapping window every cycle, and re-sends its whole cursor after losing
    its state file, because the natural key here is what guarantees a punch is
    recorded once. Answering 409 the way a double-clicked payment does would
    stall the agent permanently.

    Out-of-range timestamps are **skipped and counted**, not a 422 for the whole
    batch. A clock set to the wrong year has those timestamps burned into the
    device's own log, so rejecting the batch would stall ingestion forever while
    the agent re-sent the same bad rows; this way good punches keep flowing and
    the count tells somebody to go and look.

    The reply carries counts and nothing else --- no names, no roster. A device
    has no business knowing who works here, and a stolen token then leaks
    nothing at all on read.
    """
    now = _now()
    now_dt = datetime.strptime(now, "%Y-%m-%d %H:%M:%S")
    horizon = now_dt + timedelta(hours=MAX_FUTURE_HOURS)
    floor = now_dt - timedelta(days=MAX_PAST_DAYS)

    accepted = duplicates = rejected = 0
    latest = None
    seen_users = {}
    touched_days = set()
    names = {u.device_user_id.strip(): (u.name or "").strip()
             for u in (data.users or []) if u.device_user_id.strip()}

    for p in data.punches:
        when = _parse_punch(p.punched_at)
        if when is None or when > horizon or when < floor:
            rejected += 1
            continue

        # A finger is enrolled on the terminal before anyone here says whose it
        # is, so an unknown enrolment number opens a mapping row with no
        # employee rather than dropping the punch. That row is the onboarding
        # screen: "the device reports user 7 and nobody has claimed it".
        uid = p.device_user_id.strip()
        if uid not in seen_users:
            m = db.execute(
                "SELECT employee_id FROM time_device_users "
                "WHERE device_id=? AND device_user_id=?",
                (device["id"], uid)).fetchone()
            if m is None:
                db.execute(
                    "INSERT OR IGNORE INTO time_device_users "
                    "(device_id, device_user_id, employee_id, device_name, "
                    " created_at) VALUES (?, ?, NULL, ?, ?)",
                    (device["id"], uid, names.get(uid) or None, now))
                seen_users[uid] = None
            else:
                seen_users[uid] = m["employee_id"]

        stamp = when.strftime("%Y-%m-%d %H:%M:%S")
        cur = db.execute(
            "INSERT OR IGNORE INTO time_punches "
            "(device_id, device_user_id, employee_id, punched_at, local_date, "
            " direction, raw_punch, raw_status, source, received_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'device', ?, ?)",
            (device["id"], uid, seen_users[uid], stamp, stamp[:10],
             p.direction, p.raw_punch, p.raw_status, now, now))
        if cur.rowcount:
            accepted += 1
            touched_days.add(stamp[:10])
            if latest is None or stamp > latest:
                latest = stamp
        else:
            duplicates += 1

    for uid, label in names.items():
        if label:
            db.execute(
                "UPDATE time_device_users SET device_name=?, updated_at=? "
                " WHERE device_id=? AND device_user_id=? "
                "   AND COALESCE(device_name,'') <> ?",
                (label, now, device["id"], uid, label))

    if latest:
        db.execute(
            "UPDATE time_devices SET last_punch_at=? WHERE id=? "
            "AND (last_punch_at IS NULL OR last_punch_at < ?)",
            (latest, device["id"], latest))
    # Re-derive exactly the (employee, day) pairs this batch touched. This is
    # what makes the feature work without a scheduler: there is none in this
    # codebase, and recurring.py sets the precedent that time-based work rides
    # on a request. A no-op until the tenant switches attendance to the clock.
    derived = attendance_sync.derive_for_punches(
        db, [e for e in seen_users.values() if e], touched_days)

    # The actor is a machine, and the audit row says so rather than borrowing
    # somebody's name. Logged before the commit, because log_action inserts
    # without committing -- the same order every other router here uses.
    if accepted or rejected:
        log_action(db, {"id": None, "username": "device:%s" % device["name"]},
                   "ingest", "time_punch", device["id"], device["name"],
                   {"accepted": accepted, "duplicates": duplicates,
                    "rejected": rejected, "derived": derived.get("written", 0)})
    db.commit()

    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


# ═════════════════════════════════════════════════════════════════════════════
# HR-FACING. Ordinary session + RBAC. A device token cannot reach any of this.
# ═════════════════════════════════════════════════════════════════════════════
@router.get("/devices")
def list_devices(user=Depends(require_perm("hr", "view")),
                 db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM time_devices ORDER BY revoked_at IS NOT NULL, name"
    ).fetchall()
    return [_device_row(db, r) for r in rows]


@router.post("/devices")
def create_device(data: DeviceIn, user=Depends(require_perm("hr", "create")),
                  db: sqlite3.Connection = Depends(get_db)):
    """Register a terminal and issue its token.

    The plaintext is returned HERE and nowhere else, ever. Storing it would put
    a writing credential one careless export away from anybody with read access
    to the database, which is the same reasoning that keeps the Resend API key
    out of tenant settings.
    """
    token = _new_device_token()
    now = _now()
    cur = db.execute(
        "INSERT INTO time_devices (name, serial_number, branch_id, token_hash, "
        " token_prefix, window_count, created_by, created_at) "
        "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        (data.name.strip(), (data.serial_number or "").strip() or None,
         data.branch_id, hash_token(token), token[:8], user["id"], now))
    log_action(db, user, "create", "time_device", cur.lastrowid, data.name)
    db.commit()
    row = db.execute("SELECT * FROM time_devices WHERE id=?",
                     (cur.lastrowid,)).fetchone()
    return {**_device_row(db, row), "token": token}


@router.post("/devices/{device_id}/rotate")
def rotate_device_token(device_id: int,
                        user=Depends(require_perm("hr", "edit")),
                        db: sqlite3.Connection = Depends(get_db)):
    """Issue a new secret for the same device. The old one stops working now."""
    row = db.execute("SELECT * FROM time_devices WHERE id=?",
                     (device_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Device not found.")
    token = _new_device_token()
    db.execute("UPDATE time_devices SET token_hash=?, token_prefix=?, "
               "updated_at=? WHERE id=?",
               (hash_token(token), token[:8], _now(), device_id))
    log_action(db, user, "update", "time_device", device_id, row["name"],
               {"rotated": True})
    db.commit()
    row = db.execute("SELECT * FROM time_devices WHERE id=?",
                     (device_id,)).fetchone()
    return {**_device_row(db, row), "token": token}


@router.delete("/devices/{device_id}")
def revoke_device(device_id: int, user=Depends(require_perm("hr", "delete")),
                  db: sqlite3.Connection = Depends(get_db)):
    """Revoke, never delete. Punches reference the device, and the record of
    where an hour came from outlives the terminal that reported it."""
    row = db.execute("SELECT * FROM time_devices WHERE id=?",
                     (device_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Device not found.")
    db.execute("UPDATE time_devices SET revoked_at=?, updated_at=? WHERE id=?",
               (_now(), _now(), device_id))
    log_action(db, user, "delete", "time_device", device_id, row["name"])
    db.commit()
    return {"ok": True}




# ── work schedules ───────────────────────────────────────────────────────────
# What a normal working day is. Without one, punch times mean nothing: Late
# needs a start time and a grace period, Half-day needs a threshold, and Absent
# needs to know which days are working days at all.
class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    is_default: bool = False
    start_time: str = Field(default="08:00", max_length=5)
    end_time: str = Field(default="17:00", max_length=5)
    break_minutes: int = Field(default=0, ge=0, le=480)
    grace_minutes: int = Field(default=15, ge=0, le=240)
    min_hours_full_day: float = Field(default=6.0, ge=0, le=24)
    workdays: str = Field(default="1,2,3,4,5", max_length=20)
    crosses_midnight: bool = False


@router.get("/schedules")
def list_schedules(user=Depends(require_perm("hr", "view")),
                   db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM work_schedules WHERE archived_at IS NULL "
                      "ORDER BY is_default DESC, name").fetchall()
    return [dict(r) for r in rows]


def _only_one_default(db, schedule_id: int, is_default: bool):
    """Exactly one company default, or none at all.

    None is a perfectly good state --- attendance_derive falls back to a built-in
    08:00-17:00 --- but two would make which schedule applies depend on row
    order, and somebody's Late would start depending on an id.
    """
    if is_default:
        db.execute("UPDATE work_schedules SET is_default=0 WHERE id <> ?",
                   (schedule_id,))


@router.post("/schedules")
def create_schedule(data: ScheduleIn, user=Depends(require_perm("hr", "create")),
                    db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    cur = db.execute(
        "INSERT INTO work_schedules (name, is_default, start_time, end_time, "
        " break_minutes, grace_minutes, min_hours_full_day, workdays, "
        " crosses_midnight, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (data.name.strip(), 1 if data.is_default else 0, data.start_time,
         data.end_time, data.break_minutes, data.grace_minutes,
         data.min_hours_full_day, data.workdays,
         1 if data.crosses_midnight else 0, now))
    _only_one_default(db, cur.lastrowid, data.is_default)
    log_action(db, user, "create", "work_schedule", cur.lastrowid, data.name)
    db.commit()
    return dict(db.execute("SELECT * FROM work_schedules WHERE id=?",
                           (cur.lastrowid,)).fetchone())


@router.put("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, data: ScheduleIn,
                    user=Depends(require_perm("hr", "edit")),
                    db: sqlite3.Connection = Depends(get_db)):
    """Editing a schedule does NOT rewrite the past on its own.

    The days already derived keep the figures they were given until somebody
    re-runs the derivation, and a period inside an Approved or Paid payroll run
    will not move even then.
    """
    if not db.execute("SELECT 1 FROM work_schedules WHERE id=?",
                      (schedule_id,)).fetchone():
        raise HTTPException(404, "Schedule not found.")
    db.execute(
        "UPDATE work_schedules SET name=?, is_default=?, start_time=?, end_time=?, "
        " break_minutes=?, grace_minutes=?, min_hours_full_day=?, workdays=?, "
        " crosses_midnight=?, updated_at=? WHERE id=?",
        (data.name.strip(), 1 if data.is_default else 0, data.start_time,
         data.end_time, data.break_minutes, data.grace_minutes,
         data.min_hours_full_day, data.workdays,
         1 if data.crosses_midnight else 0, _now(), schedule_id))
    _only_one_default(db, schedule_id, data.is_default)
    log_action(db, user, "update", "work_schedule", schedule_id, data.name)
    db.commit()
    return dict(db.execute("SELECT * FROM work_schedules WHERE id=?",
                           (schedule_id,)).fetchone())


@router.delete("/schedules/{schedule_id}")
def archive_schedule(schedule_id: int, user=Depends(require_perm("hr", "delete")),
                     db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM work_schedules WHERE id=?",
                     (schedule_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Schedule not found.")
    db.execute("UPDATE work_schedules SET archived_at=?, is_default=0 WHERE id=?",
               (_now(), schedule_id))
    # Anyone pointed at it falls back to the company default, which is a working
    # day either way -- better than an employee whose schedule is a dangling id.
    db.execute("UPDATE hr_employees SET work_schedule_id=NULL "
               " WHERE work_schedule_id=?", (schedule_id,))
    log_action(db, user, "archive", "work_schedule", schedule_id, row["name"])
    db.commit()
    return {"ok": True}



@router.get("/device-users")
def list_device_users(user=Depends(require_perm("hr", "view")),
                      db: sqlite3.Connection = Depends(get_db)):
    """Every enrolment number the devices have reported, mapped or not.

    The unmapped ones are the point of this screen. Without somewhere to see
    them, punches pile up against nobody and the first anyone hears of it is a
    month with no hours in it.
    """
    rows = db.execute(
        "SELECT u.*, d.name AS device, e.full_name AS employee_name, "
        "       (SELECT COUNT(*) FROM time_punches p "
        "         WHERE p.device_id=u.device_id "
        "           AND p.device_user_id=u.device_user_id) AS punch_count "
        "  FROM time_device_users u "
        "  JOIN time_devices d ON d.id = u.device_id "
        "  LEFT JOIN hr_employees e ON e.id = u.employee_id "
        " ORDER BY u.employee_id IS NOT NULL, d.name, u.device_user_id"
    ).fetchall()
    return [dict(r) for r in rows]


@router.put("/device-users/{mapping_id}")
def set_device_user(mapping_id: int, data: MappingIn,
                    user=Depends(require_perm("hr", "edit")),
                    db: sqlite3.Connection = Depends(get_db)):
    """Say who an enrolment number belongs to.

    Punches already recorded against it are back-filled ONLY where they belong
    to nobody yet. Re-pointing a mapping never rewrites history: when a leaver's
    finger slot is reused, last month's hours must stay with the leaver, or a
    payroll run that has already been paid quietly changes meaning.
    """
    row = db.execute("SELECT * FROM time_device_users WHERE id=?",
                     (mapping_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Mapping not found.")
    if data.employee_id is not None:
        emp = db.execute("SELECT id FROM hr_employees WHERE id=?",
                         (data.employee_id,)).fetchone()
        if not emp:
            raise HTTPException(404, "Employee not found.")

    db.execute("UPDATE time_device_users SET employee_id=?, updated_at=? "
               "WHERE id=?", (data.employee_id, _now(), mapping_id))
    filled = 0
    if data.employee_id is not None:
        cur = db.execute(
            "UPDATE time_punches SET employee_id=? "
            " WHERE device_id=? AND device_user_id=? AND employee_id IS NULL",
            (data.employee_id, row["device_id"], row["device_user_id"]))
        filled = cur.rowcount or 0
    log_action(db, user, "update", "time_device_user", mapping_id,
               row["device_user_id"],
               {"employee_id": data.employee_id, "punches_claimed": filled})
    db.commit()
    return {"ok": True, "punches_claimed": filled}
