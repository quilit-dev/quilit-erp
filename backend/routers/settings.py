"""
Settings — single-row configuration table.
Covers: Company Info, Financial Defaults, Document Preferences.
Backup/Restore endpoints are also here.

Note: `enabled_modules` is NOT a settings-table field. It lives in
`backend/vendor_config.py` as a compile-time constant so a customer can't
flip it from a running ERP. The GET endpoint here surfaces it for the
Sidebar to read, but no write path accepts the field.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from database import get_db, DB_PATH
from permissions import require_auth, require_admin
from utils import _now
import vendor_config
import sqlite3, os, shutil, tempfile, sys

router = APIRouter()

# ── Schema ────────────────────────────────────────────────────────────────────

DEFAULTS = {
    # Company
    "company_name":        "My Company",
    "company_tagline":     "",
    "company_address":     "",
    "company_city":        "",
    "company_country":     "",
    "company_phone":       "",
    "company_email":       "",
    "company_website":     "",
    "company_tax_number":  "",
    "company_reg_number":  "",
    "default_currency":    "USD",
    "secondary_currency":  "LBP",
    # Bank Details
    "bank_name":           "",
    "bank_account":        "",
    "bank_iban":           "",
    "bank_swift":          "",
    # Financial
    "default_tax_rate":    "11",   # Lebanon VAT — preset; applies to fresh installs
    "tax_enabled":         "0",
    "payment_terms_days":  "15",
    "invoice_prefix":      "INV-",
    "quotation_prefix":    "QTN-",
    "contract_prefix":     "CTR-",
    # Inventory cost-flow assumption: weighted_avg (default) / fifo / lifo.
    # Drives how cost-of-goods-sold is valued on every stock-OUT.
    "inventory_costing_method": "weighted_avg",
    # Manufacturing: electricity price per kWh, multiplied by a work center's
    # power draw (kW) × actual run hours to cost the electricity of a job.
    "electricity_tariff_per_kwh": "0",
    # Payroll defaults — all 0 = no tax / no NSSF (opt-in per install).
    "payroll_tax_pct":              "0",
    "payroll_nssf_employee_pct":    "0",
    "payroll_nssf_employer_pct":    "0",
    "payroll_overtime_multiplier":  "1.5",
    # Document
    "footer_text":         "Thank you for your business.",
    "show_discount_col":   "0",
    "show_tax_col":        "1",
    # Email (SMTP) — OFF until enabled. SMTP credentials may instead come from
    # environment vars (SMTP_*), preferred for cloud so no secrets sit in the DB.
    "email_enabled":       "0",
    "smtp_host":           "",
    "smtp_port":           "587",
    "smtp_user":           "",
    "smtp_password":       "",
    "smtp_use_tls":        "1",
    "smtp_from":           "",
    # Setup
    "setup_complete":      "0",
}

class SettingsUpdate(BaseModel):
    company_name:       Optional[str] = None
    company_tagline:    Optional[str] = None
    company_address:    Optional[str] = None
    company_city:       Optional[str] = None
    company_country:    Optional[str] = None
    company_phone:      Optional[str] = None
    company_email:      Optional[str] = None
    company_website:    Optional[str] = None
    company_tax_number: Optional[str] = None
    company_reg_number: Optional[str] = None
    default_currency:   Optional[str] = None
    secondary_currency: Optional[str] = None
    bank_name:          Optional[str] = None
    bank_account:       Optional[str] = None
    bank_iban:          Optional[str] = None
    bank_swift:         Optional[str] = None
    default_tax_rate:   Optional[str] = None
    tax_enabled:        Optional[str] = None
    payment_terms_days: Optional[str] = None
    invoice_prefix:     Optional[str] = None
    quotation_prefix:   Optional[str] = None
    contract_prefix:    Optional[str] = None
    inventory_costing_method: Optional[str] = None
    electricity_tariff_per_kwh: Optional[str] = None
    payroll_tax_pct:             Optional[str] = None
    payroll_nssf_employee_pct:   Optional[str] = None
    payroll_nssf_employer_pct:   Optional[str] = None
    payroll_overtime_multiplier: Optional[str] = None
    footer_text:        Optional[str] = None
    show_discount_col:  Optional[str] = None
    show_tax_col:       Optional[str] = None
    email_enabled:      Optional[str] = None
    smtp_host:          Optional[str] = None
    smtp_port:          Optional[str] = None
    smtp_user:          Optional[str] = None
    smtp_password:      Optional[str] = None
    smtp_use_tls:       Optional[str] = None
    smtp_from:          Optional[str] = None
    # `enabled_modules` is deliberately absent — it lives in vendor_config.py
    # as an immutable constant. A PUT body containing it is rejected by
    # pydantic with 422 ("extra field not permitted") via model_config below.

    # Pydantic v2 — reject unknown fields outright (e.g. enabled_modules) so
    # the caller gets an immediate 422 instead of silently dropping the field.
    model_config = {"extra": "forbid"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ensure_table(db: sqlite3.Connection):
    db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    db.commit()

def _get_all(db: sqlite3.Connection) -> dict:
    _ensure_table(db)
    rows = db.execute("SELECT key, value FROM settings").fetchall()
    data = {**DEFAULTS}
    for r in rows:
        data[r["key"]] = r["value"]
    # `enabled_modules` is sourced from the immutable build-time constant,
    # not the settings table. Any stale row in the DB (e.g. from a pre-080
    # install) is overwritten here so the API only ever reports the value
    # baked into this build.
    data["enabled_modules"] = vendor_config.ENABLED_MODULES
    # Read-only capability flag (never persisted — not in WRITABLE_SETTINGS).
    # Local file / USB backup and the "works offline" pitch only apply to the
    # SQLite (desktop / self-hosted) edition; a cloud (Postgres) deployment is
    # backed up server-side, so the UI hides that whole section when this is false.
    from database import DB_BACKEND
    data["local_backup"] = DB_BACKEND in ("sqlite", "sqlite3")
    # Never expose the SMTP password to the browser — report only whether one is set.
    data["smtp_password_set"] = bool(data.get("smtp_password"))
    data["smtp_password"] = ""
    return data

def _set_keys(db: sqlite3.Connection, updates: dict):
    _ensure_table(db)
    for k, v in updates.items():
        if v is not None:
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, v)
            )
    db.commit()
    # Drop any cached settings for this tenant so changes take effect immediately
    # (no-op when CACHE=none, i.e. for desktop / single-tenant installs).
    import cache
    cache.delete_prefix("setting:")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/")
def get_settings(user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    return _get_all(db)


class EmailTestRequest(BaseModel):
    to: str


@router.post("/email-test")
def email_test(body: EmailTestRequest, user=Depends(require_admin),
               db: sqlite3.Connection = Depends(get_db)):
    """Send a test email to verify SMTP configuration (admin only)."""
    import mailer
    if not mailer.is_enabled(db):
        raise HTTPException(400, "Email is disabled or not configured. Turn it on "
                                 "and set SMTP details (or use SMTP_* env vars).")
    mailer.send(db, body.to, "ERP — test email",
                "<p>This is a test message from your ERP. "
                "If you received it, outbound email is working.</p>")
    return {"message": f"Test email sent to {body.to}."}


@router.put("/")
def update_settings(
    body: SettingsUpdate,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    # `enabled_modules` cannot reach this handler — it's not declared on
    # SettingsUpdate, and the model rejects unknown fields outright. The
    # immutable source of truth is vendor_config.ENABLED_MODULES.
    updates = {k: v for k, v in body.dict().items() if v is not None}
    # A blank SMTP password from the (masked) form must not wipe the stored one.
    if updates.get("smtp_password") == "":
        updates.pop("smtp_password", None)

    # Inventory costing method: validate and, when switched to a lot-based
    # method, rebase the cost layers so they match on-hand stock immediately.
    new_method = updates.get("inventory_costing_method")
    if new_method is not None:
        import costing
        if new_method not in costing.VALID_METHODS:
            raise HTTPException(
                400,
                "inventory_costing_method must be one of: "
                + ", ".join(sorted(costing.VALID_METHODS)),
            )
        prev_method = _get_all(db).get("inventory_costing_method", "weighted_avg")
        _set_keys(db, updates)
        if new_method in ("fifo", "lifo") and new_method != prev_method:
            costing.rebase_layers(db, _now())
            db.commit()
        return _get_all(db)

    _set_keys(db, updates)
    return _get_all(db)


# ── Exchange rate (dual-currency foundation) ──────────────────────────────────
# The rate is the number of `secondary_currency` units per 1 `default_currency`
# unit (e.g. LBP per 1 USD). It is set MANUALLY by an administrator — there is no
# automatic / online rate lookup — and every change is kept in `exchange_rates`
# as an audit history.

class ExchangeRateUpdate(BaseModel):
    rate: float
    note: Optional[str] = None


@router.get("/exchange-rate")
def get_exchange_rate(user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    """Latest manual exchange rate + recent change history. Readable by any signed-in user."""
    cfg = _get_all(db)
    try:
        current = db.execute(
            "SELECT id, rate, set_by_name, note, created_at "
            "FROM exchange_rates ORDER BY id DESC LIMIT 1"
        ).fetchone()
        history = db.execute(
            "SELECT id, rate, set_by_name, note, created_at "
            "FROM exchange_rates ORDER BY id DESC LIMIT 20"
        ).fetchall()
    except sqlite3.OperationalError:
        current, history = None, []
    return {
        "base_currency":      cfg.get("default_currency", "USD"),
        "secondary_currency": cfg.get("secondary_currency", "LBP"),
        "current":            dict(current) if current else None,
        "history":            [dict(h) for h in history],
    }


@router.post("/exchange-rate")
def set_exchange_rate(
    body: ExchangeRateUpdate,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Record a new manual exchange rate. Administrator only; each change is kept as history."""
    if body.rate is None or body.rate <= 0:
        raise HTTPException(400, "Exchange rate must be a positive number.")
    db.execute(
        "INSERT INTO exchange_rates (rate, set_by, set_by_name, note, created_at) "
        "VALUES (?,?,?,?,?)",
        (body.rate, user["id"], user.get("full_name") or user.get("username"),
         (body.note or None), _now()),
    )
    db.commit()
    return get_exchange_rate(user, db)


MAX_LOGO_SIZE  = 2 * 1024 * 1024   # 2 MB
MAX_DB_SIZE    = 100 * 1024 * 1024  # 100 MB

def _logo_path() -> str:
    """
    Resolve the logo path relative to the running exe / script.
    - Frozen (PyInstaller onedir): next to the .exe in the dist folder
    - Plain Python dev mode: two levels up from this file → static/logo.png
    This ensures the saved logo is in the same static/ folder the server serves.
    """
    if getattr(sys, "frozen", False):
        # onedir: exe lives next to the static/ folder
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return os.path.join(base, "static", "logo.png")

@router.get("/logo")
def get_logo():
    """Serve the company logo. Returns 404 if no logo has been uploaded yet."""
    logo_path = _logo_path()
    if not os.path.exists(logo_path):
        raise HTTPException(404, "No logo uploaded")
    return FileResponse(logo_path, media_type="image/png")


_IMG_MAGIC = {
    b'\x89PNG':          'png',
    b'\xff\xd8\xff':     'jpeg',
    b'GIF8':             'gif',
    b'RIFF':             'webp',  # RIFF....WEBP
}

def _detect_image(data: bytes) -> bool:
    for sig in _IMG_MAGIC:
        if data[:len(sig)] == sig:
            return True
    return False

@router.post("/logo")
async def upload_logo(
    file: UploadFile = File(...),
    user=Depends(require_admin),
):
    data = await file.read(MAX_LOGO_SIZE + 1)
    if len(data) > MAX_LOGO_SIZE:
        raise HTTPException(413, "Logo file too large (max 2 MB)")
    if not _detect_image(data):
        raise HTTPException(400, "File must be a valid image (PNG, JPEG, GIF, or WEBP)")
    logo_path = _logo_path()
    os.makedirs(os.path.dirname(logo_path), exist_ok=True)
    with open(logo_path, "wb") as f:
        f.write(data)
    return {"ok": True, "message": "Logo updated"}


# ── Backup / Restore ─────────────────────────────────────────────────────────

def _assert_local_backup():
    """Local file / USB backup + restore is a SQLite (self-hosted) feature. On a
    cloud (Postgres) deployment, backups are handled server-side (pg_dump), so
    reject these endpoints with a clear message rather than acting on a stale or
    absent local file."""
    from database import DB_BACKEND
    if DB_BACKEND not in ("sqlite", "sqlite3"):
        raise HTTPException(400, "Local backup is only available on the self-hosted "
                                 "(SQLite) edition; this cloud deployment is backed up "
                                 "server-side.")


@router.get("/backup")
def download_backup(user=Depends(require_admin)):
    _assert_local_backup()
    if not os.path.exists(DB_PATH):
        raise HTTPException(404, "Database file not found")
    return FileResponse(
        DB_PATH,
        media_type="application/octet-stream",
        filename="erp_backup.db",
    )


@router.get("/backup-status")
def backup_status(user=Depends(require_admin)):
    """Return auto-backup status: last run, file list, folder location."""
    try:
        backend_dir = os.path.dirname(os.path.dirname(__file__))
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)
        import backup_manager
        return backup_manager.get_status()
    except Exception as e:
        raise HTTPException(500, f"Could not read backup status: {e}")


@router.post("/backup-now")
def backup_now(user=Depends(require_admin)):
    """Trigger an immediate manual backup."""
    _assert_local_backup()
    try:
        backend_dir = os.path.dirname(os.path.dirname(__file__))
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)
        import backup_manager
        result = backup_manager.run_manual_backup()
        if not result.get("ok"):
            raise HTTPException(500, result.get("error", "Backup failed"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Backup error: {e}")


class BackupExportRequest(BaseModel):
    path: str


@router.post("/backup-export")
def backup_export(body: BackupExportRequest, user=Depends(require_admin)):
    """One-click backup to an external folder (USB drive / network share)."""
    _assert_local_backup()
    try:
        backend_dir = os.path.dirname(os.path.dirname(__file__))
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)
        import backup_manager
        result = backup_manager.export_to_path(body.path)
        if not result.get("ok"):
            raise HTTPException(400, result.get("error", "Backup export failed"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Backup export error: {e}")


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    user=Depends(require_admin),
):
    _assert_local_backup()
    if not file.filename.endswith(".db"):
        raise HTTPException(400, "Only .db files are accepted")

    # Write to a temp file first, then validate it's a real SQLite db
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    try:
        data = await file.read()
        if len(data) > MAX_DB_SIZE:
            raise HTTPException(413, "Database file too large (max 100 MB)")
        tmp.write(data)
        tmp.flush()
        tmp.close()
        # Quick sanity-check: open the file with sqlite3
        conn = sqlite3.connect(tmp.name)
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        conn.close()
        if not tables:
            raise HTTPException(400, "File does not appear to be a valid ERP database")

        # Replace the live database
        shutil.copy2(tmp.name, DB_PATH)
    finally:
        os.unlink(tmp.name)

    return {"ok": True, "message": "Database restored. Please restart the server."}


@router.get("/setup-status")
def setup_status(db: sqlite3.Connection = Depends(get_db)):
    """Public — no auth. Returns whether the first-run wizard has been completed."""
    data = _get_all(db)
    return {"setup_complete": data.get("setup_complete", "0") == "1"}


class CompleteSetupRequest(BaseModel):
    admin_password:  str
    company_name:    Optional[str] = "My Company"
    company_email:   Optional[str] = ""
    default_currency: Optional[str] = "USD"


@router.post("/complete-setup")
def complete_setup(body: CompleteSetupRequest, db: sqlite3.Connection = Depends(get_db)):
    """
    Public — no auth. One-time endpoint: sets admin password, saves basic company
    info, and marks setup as complete. Returns 403 if already completed.
    """
    data = _get_all(db)
    if data.get("setup_complete", "0") == "1":
        raise HTTPException(403, "Setup already completed.")
    if len(body.admin_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")

    # If the database file was deleted while the server was running, a new empty
    # file gets created on the next request and the wizard's status check
    # auto-creates only the `settings` table — leaving the rest of the schema
    # (including `users`) absent. Detect that half-initialised state and return
    # a clean, actionable error instead of a raw 500: a restart re-runs init_db
    # and recreates everything.
    if not db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
    ).fetchone():
        raise HTTPException(
            503,
            "The database isn't fully initialised yet. Please restart the "
            "application, then complete setup.",
        )

    # Update admin password and clear must_change_password
    from auth_utils import hash_password
    db.execute(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE username='admin'",
        (hash_password(body.admin_password),)
    )

    # Save company settings + mark complete
    _set_keys(db, {
        "company_name":     body.company_name or "My Company",
        "company_email":    body.company_email or "",
        "default_currency": body.default_currency or "USD",
        "setup_complete":   "1",
    })
    db.commit()
    return {"ok": True, "message": "Setup complete. You can now log in."}


@router.get("/integrity-check")
def integrity_check(user=Depends(require_admin)):
    """Run PRAGMA integrity_check on the live database and return the result."""
    try:
        backend_dir = os.path.dirname(os.path.dirname(__file__))
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)
        import backup_manager
        result = backup_manager.run_integrity_check()
        return result
    except Exception as e:
        raise HTTPException(500, f"Integrity check error: {e}")
