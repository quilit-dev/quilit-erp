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
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from typing import Optional
from database import get_db, DB_PATH
from permissions import require_auth, require_admin
from routers.audit import log_action
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
    # Receipt vouchers count in their own sequence, separate from invoices: the
    # voucher acknowledges money received and is referenced as its own document
    # in the ledger and by the customer holding it.
    "receipt_voucher_prefix": "RV-",
    # Inventory cost-flow assumption: weighted_avg (default) / fifo / lifo.
    # Drives how cost-of-goods-sold is valued on every stock-OUT.
    "inventory_costing_method": "weighted_avg",
    # Vertical the shop operates in (Apparel / Electronics / Food & Beverage /
    # General). Drives which product-attribute presets are offered. Empty = not
    # chosen yet (General behaviour — no preset attributes).
    "business_type": "",
    # Payroll defaults — all 0 = no tax / no NSSF (opt-in per install).
    "payroll_tax_pct":              "0",
    "payroll_nssf_employee_pct":    "0",
    "payroll_nssf_employer_pct":    "0",
    "payroll_overtime_multiplier":  "1.5",
    # Document
    "footer_text":         "Thank you for your business.",
    "show_discount_col":   "0",
    "show_tax_col":        "1",
    # Off by default: both add width or height to a document that already fits,
    # and a business that does not stock barcoded goods would only be puzzled by
    # an empty column. Switched on per company in Settings → Document Settings.
    "show_barcode_col":    "0",
    "show_total_words":    "0",
    # Set when the company prints onto stationery that already carries its
    # letterhead. The design is then omitted from the company's OWN export —
    # printing it again would double it, and any misregistration in the printer
    # shows up as a ghosted edge. The copy a customer opens from a share link is
    # unaffected: they have no such paper, so their document carries the design.
    "preprinted_stationery": "0",
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
    receipt_voucher_prefix: Optional[str] = None
    inventory_costing_method: Optional[str] = None
    business_type:      Optional[str] = None
    payroll_tax_pct:             Optional[str] = None
    payroll_nssf_employee_pct:   Optional[str] = None
    payroll_nssf_employer_pct:   Optional[str] = None
    payroll_overtime_multiplier: Optional[str] = None
    footer_text:        Optional[str] = None
    show_discount_col:  Optional[str] = None
    show_tax_col:       Optional[str] = None
    show_barcode_col:   Optional[str] = None
    show_total_words:   Optional[str] = None
    preprinted_stationery: Optional[str] = None
    # `document_template` is deliberately absent for the same reason as
    # `enabled_modules` below: it is a vendor decision, and `extra: forbid`
    # turns an attempt to set it into a 422 rather than a silent no-op.
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
    # `enabled_modules` is never read from the settings table. Any stale row
    # (e.g. from a pre-080 install) is overwritten here.
    #
    # Source of truth depends on the deployment:
    #   * multi-tenant cloud — the customer's licence in public.tenants,
    #     dependency-closed, so the sidebar hides exactly what they did not buy;
    #   * single-tenant / desktop — the immutable build-time constant.
    #
    # enabled_modules_set() already encodes that precedence and is what the
    # server-side paywall enforces, so sourcing the UI from it keeps the menu
    # and the API in agreement. Returning the raw constant here was why a
    # licensed tenant still saw every module in the sidebar.
    _licensed = vendor_config.enabled_modules_set()
    data["enabled_modules"] = ("" if _licensed is None
                               else ",".join(sorted(_licensed)))
    # Read-only capability flag (never persisted — not in WRITABLE_SETTINGS).
    # Local file / USB backup and the "works offline" pitch only apply to the
    # SQLite (desktop / self-hosted) edition; a cloud (Postgres) deployment is
    # backed up server-side, so the UI hides that whole section when this is false.
    from database import DB_BACKEND
    data["local_backup"] = DB_BACKEND in ("sqlite", "sqlite3")
    # Which letterhead invoices and quotations print on. Resolved from the
    # tenant, never from the settings table, and absent from SettingsUpdate —
    # so a stale row cannot select a design and a PUT cannot set one. A tenant
    # granting itself another company's branding would be a real problem, not a
    # cosmetic one, which is why this is vendor-side.
    data["document_template"] = vendor_config.document_template()
    # The email feature was removed. Drop any stale email/SMTP rows left in the
    # DB from a prior version so old secrets never reach the browser (the rows
    # are inert; this is just defensive — they're harmless if present).
    for _k in ("email_enabled", "smtp_host", "smtp_port", "smtp_user",
               "smtp_password", "smtp_use_tls", "smtp_from", "resend_api_key"):
        data.pop(_k, None)
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
        log_action(db, user, "update", "settings", None, "Settings",
                   {"keys": sorted(updates)})
        db.commit()
        return _get_all(db)

    _set_keys(db, updates)
    # Choosing/confirming a business type seeds its attribute presets so the
    # product builder immediately offers the right fields (idempotent).
    bt = updates.get("business_type")
    if bt:
        from routers.products import seed_attribute_presets, BUSINESS_TYPES
        if bt in BUSINESS_TYPES:
            seed_attribute_presets(db, bt)
    log_action(db, user, "update", "settings", None, "Settings",
               {"keys": sorted(updates)})
    db.commit()
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
    log_action(db, user, "update", "settings", None, "Exchange rate",
               {"rate": body.rate, "note": body.note})
    db.commit()
    return get_exchange_rate(user, db)


MAX_LOGO_SIZE  = 2 * 1024 * 1024   # 2 MB
MAX_DB_SIZE    = 100 * 1024 * 1024  # 100 MB

def _logo_path() -> str:
    """
    The LEGACY on-disk logo, kept only so an existing self-hosted install does
    not lose its branding on upgrade. New uploads go to the database instead
    (see `upload_logo`); this path is read as a fallback and never written.
    - Frozen (PyInstaller onedir): next to the .exe in the dist folder
    - Plain Python dev mode: two levels up from this file → static/logo.png
    """
    if getattr(sys, "frozen", False):
        # onedir: exe lives next to the static/ folder
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return os.path.join(base, "static", "logo.png")


def _stored_logo(db):
    """The tenant's logo as (bytes, mime), or None.

    Reads the database first and the legacy file only as a fallback, so a
    self-hosted install that already had `static/logo.png` keeps showing it
    until someone uploads a replacement.
    """
    try:
        row = db.execute("SELECT data, mime FROM company_logo WHERE id = 1").fetchone()
    except sqlite3.Error:
        row = None                      # table not created yet — fall through
    if row is not None and row["data"] is not None:
        data = row["data"]
        # psycopg hands back memoryview for BYTEA; sqlite3 hands back bytes.
        return bytes(data), (row["mime"] or "image/png")

    legacy = _logo_path()
    if os.path.exists(legacy):
        try:
            with open(legacy, "rb") as f:
                return f.read(), "image/png"
        except OSError:
            pass
    return None


@router.get("/logo")
def get_logo(db: sqlite3.Connection = Depends(get_db)):
    """Serve the company logo. Returns 404 if no logo has been uploaded yet.

    Deliberately unauthenticated: the login screen shows the logo before anyone
    has a session, and so does the document a customer opens from a share link.
    The tenant comes from the request's own schema, which the tenancy
    middleware resolves from the host — so an anonymous reader on
    aman.quilit.dev gets AMAN's logo and never another customer's.
    """
    found = _stored_logo(db)
    if found is None:
        raise HTTPException(404, "No logo uploaded")
    data, mime = found
    # No-store: the logo is per-tenant and these responses must never be reused
    # across workspaces by a shared cache.
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "no-store"})


def _vendor_icon() -> str:
    """The bundled product mark, shown when a workspace has uploaded no logo."""
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return os.path.join(base, "static", "icon-192.png")


@router.get("/favicon")
def get_favicon(db: sqlite3.Connection = Depends(get_db)):
    """The browser tab's icon: the tenant's logo, or the product mark.

    Separate from `/logo` because the two have opposite failure modes. `/logo`
    must 404 when there is none — callers rely on that to decide whether to draw
    one at all. A favicon must ALWAYS return an image: a `<link rel="icon">`
    pointing at a 404 leaves the tab on the browser's default globe.

    Answering that here, rather than probing from JavaScript and swapping the
    tag, is what makes it work. Chrome reads the icon once while parsing the
    head and does not reliably repaint when a script later rewrites the href —
    the DOM changes and the tab does not. A plain URL that always resolves needs
    no script, and applies before any JavaScript has run.

    Unauthenticated for the same reason `/logo` is: the tab has an icon on the
    login screen and on the page a customer opens from a share link, neither of
    which has a session. The tenant comes from the request host.
    """
    found = _stored_logo(db)
    if found is not None:
        data, mime = found
    else:
        try:
            with open(_vendor_icon(), "rb") as f:
                data, mime = f.read(), "image/png"
        except OSError:
            # No logo and no bundled mark. An empty 200 would be cached by the
            # browser as the tab's icon; 404 at least lets it fall back.
            raise HTTPException(404, "No icon available")

    # no-cache, not no-store: browsers cache favicons hard, and a tenant who
    # uploads a new logo must see the tab change. This revalidates each time
    # while still allowing a 304, and keeps one tenant's icon out of a shared
    # cache for another.
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "no-cache, private"})


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


def _image_mime(data: bytes) -> str:
    """The content type to serve these bytes back with.

    The file used to be saved as logo.png and served as image/png whatever it
    actually was — which happened to work because browsers sniff, but stored
    bytes deserve an honest type.
    """
    for sig, kind in _IMG_MAGIC.items():
        if data[:len(sig)] == sig:
            return f"image/{kind}"
    return "application/octet-stream"

@router.post("/logo")
async def upload_logo(
    file: UploadFile = File(...),
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    data = await file.read(MAX_LOGO_SIZE + 1)
    if len(data) > MAX_LOGO_SIZE:
        raise HTTPException(413, "Logo file too large (max 2 MB)")
    if not _detect_image(data):
        raise HTTPException(400, "File must be a valid image (PNG, JPEG, GIF, or WEBP)")
    # Into the database, NOT onto disk. The filesystem is wrong on both counts:
    # a hosted deployment bakes static/ into the image with no volume behind it,
    # so an uploaded file dies with the next deploy; and one path is shared by
    # every tenant, so an upload replaced other customers' branding.
    mime = _image_mime(data)
    now = _now()
    db.execute("DELETE FROM company_logo WHERE id = 1")
    db.execute(
        "INSERT INTO company_logo (id, data, mime, filename, size_bytes, updated_at) "
        "VALUES (1, ?, ?, ?, ?, ?)",
        (data, mime, file.filename, len(data), now))
    log_action(db, user, "update", "settings", None, "Company logo",
               {"filename": file.filename, "size": len(data)})
    db.commit()
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
def download_backup(user=Depends(require_admin), db: sqlite3.Connection = Depends(get_db)):
    _assert_local_backup()
    if not os.path.exists(DB_PATH):
        raise HTTPException(404, "Database file not found")
    # A full-database download is the most sensitive export there is — record it.
    log_action(db, user, "export", "settings", None, "Full database backup downloaded")
    db.commit()
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
def backup_now(user=Depends(require_admin), db: sqlite3.Connection = Depends(get_db)):
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
        log_action(db, user, "backup", "settings", None, "Manual backup")
        db.commit()
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Backup error: {e}")


class BackupExportRequest(BaseModel):
    path: str


@router.post("/backup-export")
def backup_export(body: BackupExportRequest, user=Depends(require_admin),
                  db: sqlite3.Connection = Depends(get_db)):
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
        log_action(db, user, "export", "settings", None, "Backup exported",
                   {"path": body.path})
        db.commit()
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Backup export error: {e}")


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
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

    # Best-effort: the row lands in the restored database (the connection's
    # path is the same file), so the restore event itself is on record.
    log_action(db, user, "restore", "settings", None, "Database restored from upload",
               {"filename": file.filename, "size": len(data)})
    try:
        db.commit()
    except Exception:
        pass
    return {"ok": True, "message": "Database restored. Please restart the server."}


def _wizard_is_available(db) -> bool:
    """Whether the unauthenticated first-run wizard may still be used.

    The wizard exists for a SELF-HOSTED first run, where nobody has been issued
    credentials and someone standing at the machine has to set the first
    password. On a hosted deployment that premise is false: provisioning
    generates the admin password and hands it to the owner, and the workspace
    never runs a wizard — so `setup_complete` stayed "0" forever and the
    endpoint below remained open to anyone who knew the subdomain.

    That was a full workspace takeover: set the admin password, log in as
    superadmin, read the customer's books. So in multi-tenant mode the wizard is
    closed unconditionally, regardless of the flag's value in any schema.
    """
    try:
        from tenancy import IS_SCHEMA_TENANCY
        if IS_SCHEMA_TENANCY:
            return False
    except Exception:
        pass
    return _get_all(db).get("setup_complete", "0") != "1"


@router.get("/licence-status")
def licence_status(user=Depends(require_auth)):
    """How long this business's trial or licence has left.

    The dates live in `public.tenants`, which a tenant's own schema cannot see,
    so a customer had no way to learn they were about to be suspended — the
    first sign was being locked out one morning. That is an avoidable support
    call and a bad look for a product they are paying for.

    Authenticated but not admin-gated: everyone in the business is affected by
    it stopping, and the person who can act on it is not always the person
    looking at the screen.

    Returns {"applicable": false} in single-tenant mode and for a workspace with
    no dates set, so the banner simply never renders.
    """
    try:
        import tenancy
        from tenant_context import current_schema
        if not tenancy.IS_SCHEMA_TENANCY:
            return {"applicable": False}
        return tenancy.tenant_licence_status(current_schema())
    except Exception:
        # A banner must never be the reason a page fails to load.
        return {"applicable": False}


@router.get("/setup-status")
def setup_status(db: sqlite3.Connection = Depends(get_db)):
    """Public — no auth. Returns whether the first-run wizard has been completed.

    Reports complete whenever the wizard is unavailable, so this cannot be used
    to enumerate which workspaces are still claimable.
    """
    return {"setup_complete": not _wizard_is_available(db)}


class CompleteSetupRequest(BaseModel):
    admin_password:  str
    company_name:    Optional[str] = "My Company"
    company_email:   Optional[str] = ""
    default_currency: Optional[str] = "USD"
    business_type:   Optional[str] = ""


@router.post("/complete-setup")
def complete_setup(body: CompleteSetupRequest, db: sqlite3.Connection = Depends(get_db)):
    """
    Public — no auth. One-time endpoint: sets admin password, saves basic company
    info, and marks setup as complete. Returns 403 if already completed.
    """
    if not _wizard_is_available(db):
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
        "business_type":    body.business_type or "",
        "setup_complete":   "1",
    })
    # Seed the chosen vertical's product-attribute presets so the inventory
    # builder is ready on first login (idempotent; unknown/empty = no-op).
    if body.business_type:
        from routers.products import seed_attribute_presets, BUSINESS_TYPES
        if body.business_type in BUSINESS_TYPES:
            seed_attribute_presets(db, body.business_type)
    # Pre-auth one-time event — recorded under the admin account it configures.
    log_action(db, {"id": None, "username": "admin"}, "complete_setup", "settings",
               None, "Initial setup wizard completed",
               {"company_name": body.company_name or "My Company"})
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
