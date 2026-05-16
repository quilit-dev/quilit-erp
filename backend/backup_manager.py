"""
backup_manager.py — Automatic local backup for ERP System
========================================================

Strategy (single-user local app):
  • On every launch  : run a startup backup if none exists for today.
  • Daily cadence    : keep the last 30 daily backups  (one per calendar day).
  • Weekly cadence   : keep the last 4  weekly backups (Sunday snapshots).
  • Manual trigger   : API can request an immediate backup at any time.
  • Safe copy method : uses SQLite's built-in Online Backup API — safe even
                       while the database is being written to.
  • Auto-prune       : after each backup run, excess files are deleted so
                       the backup folder never grows unbounded.
  • Checksums        : each backup writes a .sha256 sidecar file so corruption
                       is detectable without restoring.
  • Restore test     : each backup is verified via PRAGMA integrity_check on a
                       temp copy before being counted as valid.
  • Startup check    : live database integrity is verified at every launch.
  • Zero dependencies: only Python stdlib (sqlite3, threading, pathlib, …).

Backup folder layout:
  When installed (frozen):
    %APPDATA%/ERP System/
      erp.db                        ← live database
      backups/
        daily/   (max 30 files, ISO-8601 named)
        weekly/  (max 4 files,  ISO-8601 named)

  When running from source (dev):
    <db_dir>/backups/  (same structure, next to the database)
"""

import sqlite3
import os
import hashlib
import shutil
import tempfile
import threading
import time
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("backup_manager")

# ── Configuration ──────────────────────────────────────────────────────────

KEEP_DAILY   = 30   # days
KEEP_WEEKLY  = 4    # weeks
CHECK_INTERVAL_HOURS = 1   # how often the background thread checks if a new
                            # daily backup is needed (lightweight; backup only
                            # runs once per calendar day)

# ── Internal state ─────────────────────────────────────────────────────────

_backup_dir: Path | None = None
_db_path: str | None     = None
_lock = threading.Lock()

_last_backup_info: dict = {
    "last_backup_at":   None,   # ISO string of last successful backup
    "last_backup_file": None,   # filename only
    "last_error":       None,   # last error message if backup failed
    "total_daily":      0,
    "total_weekly":     0,
    "startup_integrity": None,  # result of startup integrity check
}


# ── Public API ─────────────────────────────────────────────────────────────

def _get_backup_dir(db_path: str) -> Path:
    """
    Resolve the backup directory.
    When running as a PyInstaller bundle, Program Files is read-protected,
    so writable data goes to APPDATA instead.
    In dev mode the backup folder sits next to the database, as before.
    """
    import sys
    if getattr(sys, "frozen", False):
        base = Path(os.environ.get("APPDATA", os.path.expanduser("~"))) / "ERP System"
    else:
        base = Path(db_path).parent
    return base / "backups"


def init(db_path: str):
    """
    Call once at startup (from launcher.py or database.py).
    Initialises paths, runs a startup backup if needed, then starts the
    background scheduler thread.
    Integrity check runs in the same background thread so startup is instant.
    """
    global _db_path, _backup_dir

    _db_path    = db_path
    _backup_dir = _get_backup_dir(db_path)

    (_backup_dir / "daily").mkdir(parents=True, exist_ok=True)
    (_backup_dir / "weekly").mkdir(parents=True, exist_ok=True)

    logger.info(f"Backup manager initialised. Folder: {_backup_dir}")

    # Both integrity check and startup backup run in one background thread
    # so the server starts accepting requests immediately.
    threading.Thread(target=_startup_backup, daemon=True, name="erp-backup-startup").start()

    # Long-running scheduler: check every hour, back up if date has changed.
    threading.Thread(target=_scheduler_loop, daemon=True, name="erp-backup-scheduler").start()


def run_manual_backup() -> dict:
    """
    Trigger an immediate backup (called from the API).
    Blocks until the backup finishes (usually < 1 s for a small DB).
    Returns a status dict.
    """
    if not _db_path or not _backup_dir:
        return {"ok": False, "error": "Backup manager not initialised"}
    return _do_backup(reason="manual")


def run_integrity_check(db_path: str = None) -> dict:
    """
    Run PRAGMA integrity_check and quick_check on the live (or specified)
    database. Returns a dict with ok, integrity_check, quick_check, checked_at.
    Safe to call at any time — opens a read-only connection.
    """
    target = db_path or _db_path
    if not target or not os.path.exists(target):
        return {"ok": False, "error": "Database not found"}
    try:
        conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
        ic   = conn.execute("PRAGMA integrity_check").fetchone()[0]
        qc   = conn.execute("PRAGMA quick_check").fetchone()[0]
        conn.close()
        ok = (ic == "ok" and qc == "ok")
        return {
            "ok":               ok,
            "integrity_check":  ic,
            "quick_check":      qc,
            "checked_at":       datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_status() -> dict:
    """Return current backup status + list of existing backup files."""
    with _lock:
        status = dict(_last_backup_info)

    daily_files  = _list_backups("daily")
    weekly_files = _list_backups("weekly")

    status["daily_backups"]  = daily_files
    status["weekly_backups"] = weekly_files
    status["total_daily"]    = len(daily_files)
    status["total_weekly"]   = len(weekly_files)
    status["backup_folder"]  = str(_backup_dir) if _backup_dir else None
    return status


# ── Checksum helpers ────────────────────────────────────────────────────────

def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_checksum(path: str) -> str:
    """Write a .sha256 sidecar file next to path. Returns the hex digest."""
    digest = _sha256_file(path)
    sidecar = Path(path).with_suffix(".sha256")
    sidecar.write_text(f"{digest}  {Path(path).name}\n", encoding="utf-8")
    return digest


def _verify_checksum(path: str) -> tuple[bool, str]:
    """
    Verify a backup file against its .sha256 sidecar.
    Returns (ok, message).
    """
    sidecar = Path(path).with_suffix(".sha256")
    if not sidecar.exists():
        return False, "no_sidecar"
    try:
        expected = sidecar.read_text(encoding="utf-8").split()[0]
    except Exception:
        return False, "unreadable_sidecar"
    actual = _sha256_file(path)
    if actual == expected:
        return True, expected[:12] + "…"
    return False, f"mismatch (expected {expected[:8]}… got {actual[:8]}…)"


# ── Restore test helper ─────────────────────────────────────────────────────

def _test_restore(path: str) -> tuple[bool, str]:
    """
    Copy the backup to a temp file and run PRAGMA integrity_check on it.
    Returns (ok, result_string).  The temp file is deleted afterwards.
    Uses NamedTemporaryFile (replaces deprecated mktemp) and opens the copy
    read-only so no WAL journal is created next to the temp file.
    """
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".db") as f:
            tmp = f.name
        shutil.copy2(path, tmp)
        conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.close()
        return result == "ok", result
    except Exception as e:
        return False, str(e)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ── Internal helpers ────────────────────────────────────────────────────────

def _list_backups(sub: str) -> list[dict]:
    """Return backup files sorted newest-first with size, checksum, and test status."""
    if not _backup_dir:
        return []
    folder = _backup_dir / sub
    files  = sorted(folder.glob("*.db"), key=lambda f: f.stat().st_mtime, reverse=True)
    result = []
    for f in files:
        try:
            size_kb = round(f.stat().st_size / 1024, 1)
            mtime   = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            cs_ok, cs_msg = _verify_checksum(str(f))
            entry = {
                "filename":       f.name,
                "size_kb":        size_kb,
                "modified_at":    mtime,
                "checksum_ok":    cs_ok,
                "checksum_short": cs_msg,
            }
            result.append(entry)
        except OSError:
            pass
    return result


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _current_week_str() -> str:
    # ISO 8601 week (%G-W%V): weeks start Monday, consistent with _is_sunday() logic.
    # %W (old) numbered from Monday but its year anchor differed near Jan 1.
    return datetime.now().strftime("%G-W%V")   # e.g. 2026-W20


def _is_sunday() -> bool:
    return datetime.now().weekday() == 6   # 0=Monday … 6=Sunday


def _sqlite_online_backup(src_path: str, dst_path: str):
    """
    Copy src → dst using SQLite's built-in Online Backup API.
    This is the ONLY safe way to copy a live SQLite database —
    it works correctly even if the source is being written to.
    """
    src = sqlite3.connect(src_path)
    dst = sqlite3.connect(dst_path)
    try:
        src.backup(dst, pages=100)   # 100 pages per step ≈ 400 KB chunks
    finally:
        dst.close()
        src.close()


def _do_backup(reason: str = "scheduled") -> dict:
    """Core backup logic. Thread-safe via _lock."""
    with _lock:
        if not _db_path or not _backup_dir:
            return {"ok": False, "error": "Not initialised"}

        if not os.path.exists(_db_path):
            return {"ok": False, "error": f"Database not found: {_db_path}"}

        today = _today_str()
        week  = _current_week_str()

        # ── Daily backup ──────────────────────────────────────────────
        daily_name = f"erp_{today}.db"
        daily_path = _backup_dir / "daily" / daily_name

        # Race-condition guard: if two threads both passed _today_backup_exists()
        # before either acquired the lock, the second one skips silently.
        if reason == "scheduled-daily" and daily_path.exists():
            return {"ok": True, "skipped": True, "reason": "already_exists"}

        # Disk space guard: need at least 2x the DB size (backup + restore-test copy).
        try:
            db_size = os.path.getsize(_db_path)
            free    = shutil.disk_usage(str(_backup_dir)).free
            if free < db_size * 2:
                err = (f"Insufficient disk space: "
                       f"{free // 1024 // 1024} MB free, "
                       f"need {db_size * 2 // 1024 // 1024} MB")
                logger.error(err)
                _last_backup_info["last_error"] = err
                return {"ok": False, "error": err}
        except OSError as e:
            logger.warning(f"Disk space check failed (proceeding anyway): {e}")

        try:
            _sqlite_online_backup(_db_path, str(daily_path))
            size_kb = round(daily_path.stat().st_size / 1024, 1)
            logger.info(f"Daily backup written: {daily_name} ({size_kb} KB) [{reason}]")
        except Exception as e:
            err = f"Daily backup failed: {e}"
            logger.error(err)
            _last_backup_info["last_error"] = err
            return {"ok": False, "error": err}

        # Write checksum sidecar
        try:
            digest = _write_checksum(str(daily_path))
            logger.info(f"Checksum written for {daily_name}: {digest[:12]}…")
        except Exception as e:
            logger.warning(f"Checksum write failed (backup still ok): {e}")
            digest = None

        # Restore test
        restore_ok, restore_msg = _test_restore(str(daily_path))
        if restore_ok:
            logger.info(f"Restore test PASSED for {daily_name}")
        else:
            logger.error(f"Restore test FAILED for {daily_name}: {restore_msg}")

        # ── Weekly backup (on Sundays OR if no weekly exists yet) ─────
        weekly_name = f"erp_week_{week}.db"
        weekly_path = _backup_dir / "weekly" / weekly_name

        if _is_sunday() or not weekly_path.exists():
            try:
                _sqlite_online_backup(_db_path, str(weekly_path))
                _write_checksum(str(weekly_path))
                logger.info(f"Weekly backup written: {weekly_name}")
            except Exception as e:
                logger.warning(f"Weekly backup failed (daily still ok): {e}")

        # ── Prune old files ───────────────────────────────────────────
        _prune("daily",  KEEP_DAILY)
        _prune("weekly", KEEP_WEEKLY)

        # ── Update status ─────────────────────────────────────────────
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _last_backup_info["last_backup_at"]   = now_str
        _last_backup_info["last_backup_file"] = daily_name
        _last_backup_info["last_error"]       = None

        return {
            "ok":           True,
            "reason":       reason,
            "file":         daily_name,
            "size_kb":      size_kb,
            "backed_up_at": now_str,
            "checksum":     digest,
            "restore_ok":   restore_ok,
            "restore_msg":  restore_msg,
        }


def _prune(sub: str, keep: int):
    """Delete oldest backups (and their .sha256 sidecars) beyond the keep limit."""
    folder = _backup_dir / sub
    files  = sorted(folder.glob("*.db"), key=lambda f: f.stat().st_mtime, reverse=True)  # newest first
    for old in files[keep:]:
        try:
            old.unlink()
            logger.info(f"Pruned old backup: {old.name}")
        except OSError as e:
            logger.warning(f"Could not delete {old.name}: {e}")
        # Also remove the checksum sidecar if present
        sidecar = old.with_suffix(".sha256")
        if sidecar.exists():
            try:
                sidecar.unlink()
            except OSError:
                pass


def _today_backup_exists() -> bool:
    if not _backup_dir:
        return False
    daily_name = f"erp_{_today_str()}.db"
    return (_backup_dir / "daily" / daily_name).exists()


def _startup_backup():
    """
    Run at launch (in background thread):
      1. Integrity check on the live DB — logged before any backup attempt.
      2. Backup only if today's backup doesn't already exist.
    Running both here keeps init() non-blocking so the server starts instantly.
    """
    time.sleep(2)   # give the server a moment to finish init

    # Integrity check
    integrity = run_integrity_check(_db_path)
    _last_backup_info["startup_integrity"] = integrity
    if integrity["ok"]:
        logger.info("Startup integrity check: PASSED")
    else:
        logger.error(
            f"Startup integrity check: FAILED — "
            f"{integrity.get('integrity_check') or integrity.get('error')}"
        )

    # Backup
    if not _today_backup_exists():
        logger.info("No backup for today found — running startup backup.")
        result = _do_backup(reason="startup")
        if result.get("ok"):
            logger.info(f"Startup backup complete: {result['file']}")
        else:
            logger.error(f"Startup backup failed: {result.get('error')}")
    else:
        logger.info("Today's backup already exists — skipping startup backup.")


def _scheduler_loop():
    """
    Background thread: wakes every CHECK_INTERVAL_HOURS and backs up
    if a new calendar day has started since the last backup.
    Handles the case where the app is left running past midnight.
    """
    while True:
        time.sleep(CHECK_INTERVAL_HOURS * 3600)
        if not _today_backup_exists():
            logger.info("Scheduler: new day detected — running daily backup.")
            _do_backup(reason="scheduled-daily")