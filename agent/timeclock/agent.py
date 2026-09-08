"""Quilit time-clock agent --- reads a ZKTeco terminal and posts punches to the ERP.

Why this program exists at all: the terminal speaks ZKTeco's own protocol on TCP
port 4370, and the ERP runs in the cloud. Nothing on the internet can reach a
device sitting behind an office router, so the pull has to happen from inside
the office. This is that pull, and it is deliberately the only piece of software
that has to know anything about ZKTeco.

Everything it sends goes over ordinary HTTPS as JSON, which is why the server
side can be tested end to end without a physical terminal anywhere near it.

Three things worth knowing before changing anything here:

  * **The terminal is the queue.** If the ERP is unreachable, or this PC is off
    for a day, nothing is lost --- the punches are still in the device's own
    memory, and the next successful cycle delivers them. That is why the cursor
    below only advances after a 2xx.

  * **The cursor is an optimisation, not the correctness mechanism.** The server
    holds a UNIQUE key on (device, enrolment number, punch time), so re-sending
    is free. This deliberately re-sends an overlapping window every cycle, and
    re-sends everything if `state.json` is lost. Losing that file costs one slow
    upload and changes no figures.

  * **It never clears the device.** `zk.clear_attendance()` appears nowhere in
    this file and must not be added. The terminal's log is the only backup of
    the raw record, and once it is gone it is gone.

Usage:
    python agent.py                 run forever, polling on a timer
    python agent.py --once          one cycle and exit (what the tests use)
    python agent.py --dry-run       read the device, print, send nothing
    python agent.py --check         verify the ERP token and report clock skew
    python agent.py --replay f.json send a recorded dump instead of a device
"""
import argparse
import configparser
import json
import logging
import logging.handlers
import os
import sys
import time
from datetime import datetime, timedelta, timezone

AGENT_VERSION = "1.0.0"


def _here():
    """The folder the agent's own files live in.

    Beside the script normally --- but beside the EXE when frozen, not inside
    PyInstaller's temp extraction folder. `__file__` points into that temp
    folder in a onefile build, so using it would make the agent look for
    config.ini somewhere that is deleted when the process exits: it would work
    in development and fail on every customer PC.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


HERE = _here()
CONFIG_PATH = os.path.join(HERE, "config.ini")
STATE_PATH = os.path.join(HERE, "state.json")
LOG_PATH = os.path.join(HERE, "agent.log")

# Re-send this far back on every cycle. The server dedupes, so the only cost is
# bandwidth --- and the benefit is that a punch written to the device while a
# cycle was mid-flight is never skipped.
OVERLAP_DAYS = 2

# The server caps a batch at 1000.
BATCH_SIZE = 500

# Backoff when the ERP is unreachable. Capped, because an office that comes back
# online should not wait an hour to find out.
BACKOFF_START = 30
BACKOFF_MAX = 300

log = logging.getLogger("timeclock")


def setup_logging(verbose=False):
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s")
    # Size-capped: this runs unattended for years on a PC nobody looks at.
    fh = logging.handlers.RotatingFileHandler(
        LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.handlers[:] = [fh, sh]


# ── configuration ────────────────────────────────────────────────────────────
def load_config(path=CONFIG_PATH):
    if not os.path.isfile(path):
        raise SystemExit(
            "No config.ini beside agent.py.\n"
            "Copy config.example.ini to config.ini and fill it in.")
    cp = configparser.ConfigParser()
    cp.read(path, encoding="utf-8")
    try:
        d = cp["timeclock"]
    except KeyError:
        raise SystemExit("config.ini has no [timeclock] section.")

    cfg = {
        "device_ip": d.get("device_ip", "").strip(),
        "device_port": d.getint("device_port", 4370),
        "device_password": d.getint("device_password", 0),
        "erp_url": d.get("erp_url", "").strip().rstrip("/"),
        "tenant_slug": d.get("tenant_slug", "").strip(),
        "device_token": d.get("device_token", "").strip(),
        "poll_seconds": d.getint("poll_seconds", 300),
        "timeout": d.getint("timeout", 20),
        # The oldest punch worth sending, as YYYY-MM-DD. Blank means "from the
        # day this agent first runs" -- see first_run_floor() for why that is
        # the default rather than "everything on the device".
        "start_date": d.get("start_date", "").strip(),
    }
    missing = [k for k in ("erp_url", "device_token") if not cfg[k]]
    if missing:
        raise SystemExit("config.ini is missing: " + ", ".join(missing))
    return cfg


# ── the cursor ───────────────────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        # Losing this file is survivable by design: the next cycle re-sends
        # everything on the device and the server dedupes it away.
        return {}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_PATH)      # atomic, so a power cut cannot truncate it


def first_run_floor(cfg, today=None):
    """The oldest punch this agent will ever send.

    These terminals keep years of history --- the unit this was written against
    held records going back to May 2024 --- and almost nobody wants that
    imported. It is not wrong data, but it lands as attendance against whoever
    the fingers are later mapped to, in months that have already been paid.

    So the default is TODAY: a clock starts counting when you install it. Set
    `start_date` in config.ini to pull older records in deliberately.
    """
    if cfg.get("start_date"):
        try:
            return datetime.strptime(cfg["start_date"][:10], "%Y-%m-%d")
        except ValueError:
            raise SystemExit(
                "start_date in config.ini is not a date: %r (use YYYY-MM-DD)"
                % cfg["start_date"])
    base = today or datetime.now()
    return base.replace(hour=0, minute=0, second=0, microsecond=0)


def effective_cutoff(cfg, state, today=None):
    """The later of the two floors, so neither can be undercut.

    The cursor stops the whole log being re-uploaded every cycle; the start
    floor stops old history arriving at all. Deleting state.json must not
    resurrect 2024, which is exactly what taking only the cursor would do.
    """
    floor = first_run_floor(cfg, today)
    cursor = cutoff_from(state)
    return floor if cursor is None else max(floor, cursor)


def cutoff_from(state):
    last = state.get("last_punch_at")
    if not last:
        return None
    try:
        return (datetime.strptime(last[:19], "%Y-%m-%d %H:%M:%S")
                - timedelta(days=OVERLAP_DAYS))
    except ValueError:
        return None


# ── the device ───────────────────────────────────────────────────────────────
def read_users(conn):
    """Enrolment number -> the name typed into the terminal.

    Worth the extra call: without it the mapping screen in the ERP shows bare
    numbers, and somebody has to already know that finger 6 is Abdalah. With
    it, the screen suggests the answer.
    """
    out = []
    try:
        for u in (conn.get_users() or []):
            uid = str(getattr(u, "user_id", "")).strip()
            if uid:
                out.append({"device_user_id": uid,
                            "name": (getattr(u, "name", "") or "").strip()})
    except Exception as exc:
        # A nicety, not the job. Punches still go.
        log.debug("could not read the enrolled users (%s)", exc)
    return out


def read_device(cfg):
    """Every attendance record the terminal is holding.

    These terminals keep no server-side cursor, so this is always the whole log
    --- filtering is ours to do. Returns dicts, so `--replay` can feed the exact
    same shape through the rest of the program with no device present.
    """
    try:
        from zk import ZK
    except ImportError:
        raise SystemExit(
            "pyzk is not installed. Run:  pip install -r requirements.txt")

    zk = ZK(cfg["device_ip"], port=cfg["device_port"], timeout=cfg["timeout"],
            password=cfg["device_password"], force_udp=False, ommit_ping=False)
    conn = None
    try:
        try:
            conn = zk.connect()
        except Exception as exc:
            raise SystemExit("\n".join([
                "Could not reach the fingerprint terminal at %s:%d"
                % (cfg["device_ip"], cfg["device_port"]),
                "",
                "  * check the terminal is switched on and on the network",
                "  * check device_ip in config.ini matches the address shown",
                "    on the terminal under  Menu > Comm > Ethernet",
                "  * if the router gave it a new address, set a fixed one",
                "",
                "(%s)" % type(exc).__name__,
            ]))
        # Stops people punching while the log is being read. Released in
        # `finally`, so a crash here cannot leave the terminal locked.
        conn.disable_device()
        records = conn.get_attendance() or []
        cfg["_users"] = read_users(conn)
        out = []
        for r in records:
            ts = getattr(r, "timestamp", None)
            if ts is None:
                continue
            out.append({
                "device_user_id": str(getattr(r, "user_id", "")).strip(),
                "punched_at": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "raw_punch": getattr(r, "punch", None),
                "raw_status": getattr(r, "status", None),
            })
        return out
    finally:
        if conn is not None:
            try:
                conn.enable_device()
            finally:
                conn.disconnect()


def load_replay(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["punches"] if isinstance(data, dict) else data


# ── the ERP ──────────────────────────────────────────────────────────────────
def _headers(cfg):
    h = {"Authorization": "Bearer " + cfg["device_token"],
         "X-Agent-Version": AGENT_VERSION,
         "Content-Type": "application/json"}
    # Only needed on multi-tenant hosting; harmless on a single-tenant install.
    if cfg["tenant_slug"]:
        h["X-Tenant"] = cfg["tenant_slug"]
    return h


def _requests():
    try:
        import requests
    except ImportError:
        raise SystemExit(
            "requests is not installed. Run:  pip install -r requirements.txt")
    return requests


def _unreachable(cfg, exc):
    """A message somebody in an office can act on.

    The person running this is following a printed page, not reading Python.
    A ConnectionError traceback tells them nothing they can use, and it is the
    single likeliest thing to go wrong on a first install -- a typo in the URL,
    no internet, or a firewall.
    """
    return SystemExit("\n".join([
        "Could not reach the ERP at %s" % cfg["erp_url"],
        "",
        "  * check the office internet is working",
        "  * check erp_url in config.ini is exactly right (no trailing slash)",
        "  * if it is an https:// address, try opening it in a browser here",
        "",
        "Nothing was lost -- punches stay on the terminal until this works.",
        "(%s)" % type(exc).__name__,
    ]))


def ping(cfg):
    requests = _requests()
    try:
        r = requests.get(cfg["erp_url"] + "/api/time/ping",
                         headers=_headers(cfg), timeout=cfg["timeout"])
    except requests.exceptions.RequestException as exc:
        raise _unreachable(cfg, exc)
    if r.status_code == 401:
        raise SystemExit("\n".join([
            "The ERP rejected this device token.",
            "It may have been revoked or rotated. Get a new one from",
            "HR -> Time clock -> Devices, and put it in config.ini.",
        ]))
    r.raise_for_status()
    return r.json()


def send_batch(cfg, punches, users=None):
    requests = _requests()
    body = {"punches": punches}
    if users:
        body["users"] = users
    try:
        r = requests.post(cfg["erp_url"] + "/api/time/punches",
                          headers=_headers(cfg),
                          json=body, timeout=cfg["timeout"])
    except requests.exceptions.RequestException as exc:
        # In the polling loop this is caught and retried with backoff; on a
        # one-shot run it is the message the installer needs to see.
        raise _unreachable(cfg, exc)
    if r.status_code == 401:
        raise SystemExit(
            "The ERP rejected this device token.\n"
            "It may have been revoked or rotated. Get a new one from\n"
            "HR -> Time clock -> Devices, and put it in config.ini.")
    if r.status_code == 429:
        raise RuntimeError("throttled by the ERP; backing off")
    r.raise_for_status()
    return r.json()


# ── one cycle ────────────────────────────────────────────────────────────────
def filter_new(punches, cutoff):
    if cutoff is None:
        return list(punches)
    keep = []
    for p in punches:
        try:
            when = datetime.strptime(p["punched_at"][:19], "%Y-%m-%d %H:%M:%S")
        except (ValueError, KeyError):
            # Keep it and let the server judge: it counts what it cannot use and
            # reports the number, which is more useful than dropping it silently.
            keep.append(p)
            continue
        if when >= cutoff:
            keep.append(p)
    return keep


def run_once(cfg, punches=None, dry_run=False):
    state = load_state()
    if punches is None:
        punches = read_device(cfg)
    log.info("device holds %d record(s)", len(punches))

    cutoff = effective_cutoff(cfg, state)
    pending = sorted(filter_new(punches, cutoff),
                     key=lambda p: p.get("punched_at", ""))
    skipped = len(punches) - len(pending)
    if skipped:
        log.info("ignoring %d record(s) older than %s",
                 skipped, cutoff.strftime("%Y-%m-%d"))
    if not pending:
        log.info("nothing new to send")
        return {"sent": 0, "accepted": 0, "duplicates": 0, "rejected": 0}

    if dry_run:
        log.info("--dry-run: would send %d punch(es)", len(pending))
        for p in pending[:20]:
            log.info("   %s  user %s", p["punched_at"], p["device_user_id"])
        if len(pending) > 20:
            log.info("   ... and %d more", len(pending) - 20)
        return {"sent": 0, "accepted": 0, "duplicates": 0, "rejected": 0,
                "dry_run": True}

    totals = {"sent": 0, "accepted": 0, "duplicates": 0, "rejected": 0}
    for i in range(0, len(pending), BATCH_SIZE):
        chunk = pending[i:i + BATCH_SIZE]
        # Names ride along with the first chunk only; they describe the device,
        # not the punches, and repeating them per batch is noise.
        result = send_batch(cfg, chunk, cfg.get("_users") if i == 0 else None)
        totals["sent"] += len(chunk)
        for k in ("accepted", "duplicates", "rejected"):
            totals[k] += result.get(k, 0)
        # Only after a 2xx. If the next chunk fails, the cursor still reflects
        # what actually landed, and the overlap re-sends the rest.
        state["last_punch_at"] = max(
            state.get("last_punch_at") or "", chunk[-1]["punched_at"])
        save_state(state)

    log.info("sent %(sent)d: %(accepted)d new, %(duplicates)d already had, "
             "%(rejected)d unusable", totals)
    if totals["rejected"]:
        log.warning("%d punch(es) were refused --- check the terminal's date "
                    "and time", totals["rejected"])
    return totals


def check(cfg):
    """Confirm the token works and report how far the device clock has drifted.

    A TX628 does not follow daylight saving on its own, so it runs an hour out
    twice a year until somebody changes it on the keypad. An hour of drift moves
    punches across the boundary of a working day, so it is worth saying out loud
    rather than leaving to be discovered in a payslip.
    """
    info = ping(cfg)
    log.info("ERP reachable. Device registered as %r.", info.get("device"))
    log.info("server time: %s", info.get("server_time"))
    try:
        server = datetime.strptime(info["server_time"][:19], "%Y-%m-%d %H:%M:%S")
        # Not utcnow(): it is deprecated in 3.12 and prints a warning into the
        # middle of output an office manager is reading to decide whether the
        # install worked.
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
        skew = abs((now_utc - server).total_seconds())
        # The server stamps UTC; this PC is local. Only a gross difference is
        # worth reporting, and it is reported as a hint rather than an error.
        log.info("this PC differs from the server by about %d minute(s) "
                 "(time zone included)", int(skew // 60))
    except (KeyError, ValueError):
        pass
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description="Quilit time-clock agent")
    ap.add_argument("--once", action="store_true", help="one cycle, then exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="read the device and print; send nothing")
    ap.add_argument("--check", action="store_true",
                    help="verify the ERP token and report clock skew")
    ap.add_argument("--replay", metavar="FILE",
                    help="send a recorded JSON dump instead of reading a device")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    setup_logging(args.verbose)
    cfg = load_config(args.config)
    log.info("Quilit time-clock agent %s", AGENT_VERSION)

    if args.check:
        check(cfg)
        return 0

    punches = load_replay(args.replay) if args.replay else None

    if args.once or args.dry_run or args.replay:
        run_once(cfg, punches=punches, dry_run=args.dry_run)
        return 0

    backoff = BACKOFF_START
    while True:
        try:
            run_once(cfg)
            backoff = BACKOFF_START
            time.sleep(cfg["poll_seconds"])
        except KeyboardInterrupt:
            log.info("stopped")
            return 0
        except SystemExit:
            raise
        except Exception as exc:
            # Nothing here is worth dying for. The punches are still on the
            # terminal, and the next cycle will collect them.
            log.warning("cycle failed (%s); retrying in %ds", exc, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)


if __name__ == "__main__":
    sys.exit(main())
