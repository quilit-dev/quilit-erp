"""The first credential in this system that does not belong to a person.

Everything else authenticates a human: an HS256 JWT in an HttpOnly cookie, tied
to a row in `users`, checked against `user_sessions` on every request. A
fingerprint terminal has no user to be, and the PC agent that reads it is not
sitting at a browser, so none of that machinery applies.

The shape is borrowed from the one existing token in the codebase --- the
document share link in communications.py --- because it is the same problem:
a bearer secret, stored only as a hash, revocable, and giving its holder
exactly one narrow capability. Two things differ, and both are deliberate.

**It is longer.** `new_token()` for a share link is 16 bytes, and the comment
there explains why: it rides in a URL a customer clicks, and 43 characters of
noise makes a link look like something you should not open. This one is pasted
into a config file once by whoever installs the agent, so length costs nothing
--- and unlike a share link, this token can WRITE.

**It is not read-only.** That is the risk worth naming plainly rather than
burying: anyone holding this token can fabricate punches, and once a tenant has
switched attendance over to the clock, fabricated punches become hours for an
hourly employee. It cannot be designed away, because a time clock is a machine
whose whole job is to assert that something happened. What can be done, and is:

  * the token opens exactly two endpoints, and nothing else in the application
    reads an Authorization header at all, so it is inert everywhere else;
  * ingest only ever appends --- there is no path here that updates or deletes
    a punch, so history cannot be rewritten, only added to;
  * every punch carries its device_id, so anything injected is attributable and
    can be removed;
  * revocation is checked on every single request, with no caching;
  * derivation refuses to touch a day inside an Approved or Paid payroll run,
    so fabricated punches cannot reach a payslip that has already been paid;
  * salaried pay is not computed from attendance at all.

**Every rejection returns the same 401 with the same body.** Distinguishing
"revoked" from "never existed" would confirm to somebody probing that a token
was once real, which is the reasoning already written into the share link's
flat 404.

Tenant resolution needs nothing new. `resolve_tenant_from_scope` in tenancy.py
already accepts an `X-Tenant` header with no cookie present, and the middleware
pins `search_path` before this dependency runs --- so a token issued by tenant A
simply does not exist when the request declares tenant B. The isolation is the
schema, not a check written here.
"""
import hashlib
import sqlite3
from datetime import datetime

from fastapi import Depends, Header, HTTPException

from database import get_db
from utils import _now

# A minute's worth of requests from one device. An agent polling every five
# minutes uses twelve requests an hour, so this has roughly three hundred times
# the headroom a real installation needs and can only ever be hit by something
# that has gone wrong or is being abused.
RATE_WINDOW_SECONDS = 60
RATE_MAX_PER_WINDOW = 60

# Below this, do not even hash it. A share link uses the same early reject.
_MIN_TOKEN_LEN = 20

_UNAUTHORISED = HTTPException(status_code=401, detail="Invalid device token.")


def hash_token(token: str) -> str:
    """SHA-256, the same as communications.hash_token.

    Not imported from there: that module pulls in the email stack, and this one
    is reached by an endpoint that must keep working when email is unconfigured.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _seconds_since(stamp) -> float:
    """How long ago `stamp` was, or a very large number if it cannot be read.

    Unreadable means "treat the window as expired", which resets the counter
    rather than locking a device out on the strength of a malformed string.
    """
    try:
        return (datetime.strptime(_now(), "%Y-%m-%d %H:%M:%S")
                - datetime.strptime(str(stamp), "%Y-%m-%d %H:%M:%S")).total_seconds()
    except (ValueError, TypeError):
        return float("inf")


def require_device(
    authorization: str = Header(None),
    x_agent_version: str = Header(None),
    db: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Resolve `Authorization: Bearer <token>` to a time_devices row.

    Returns the device. Raises an indistinguishable 401 for every failure, and
    429 once a device exceeds its window --- which it can only reach after
    authenticating, so it tells an attacker nothing they did not already have.
    """
    header = (authorization or "").strip()
    if not header.lower().startswith("bearer "):
        raise _UNAUTHORISED
    token = header[7:].strip()
    if len(token) < _MIN_TOKEN_LEN:
        raise _UNAUTHORISED

    row = db.execute(
        "SELECT * FROM time_devices WHERE token_hash = ?", (hash_token(token),)
    ).fetchone()
    # A device belonging to another tenant is not "wrong", it is absent: the
    # schema this query runs against was pinned from X-Tenant before we got here.
    if not row or row["revoked_at"]:
        raise _UNAUTHORISED

    now = _now()
    if _seconds_since(row["window_started_at"]) >= RATE_WINDOW_SECONDS:
        db.execute(
            "UPDATE time_devices SET window_started_at=?, window_count=1, "
            "last_seen_at=?, agent_version=COALESCE(?, agent_version) WHERE id=?",
            (now, now, x_agent_version, row["id"]))
        db.commit()
    elif (row["window_count"] or 0) >= RATE_MAX_PER_WINDOW:
        # Deliberately does NOT stamp last_seen_at: a device being throttled is
        # not a device that is healthy, and the staleness banner is the only
        # thing standing between a dead agent and a payroll built on nothing.
        raise HTTPException(
            status_code=429,
            detail="Too many requests from this device. Slow down and retry.")
    else:
        db.execute(
            "UPDATE time_devices SET window_count = window_count + 1, "
            "last_seen_at=?, agent_version=COALESCE(?, agent_version) WHERE id=?",
            (now, x_agent_version, row["id"]))
        db.commit()

    return dict(row)
