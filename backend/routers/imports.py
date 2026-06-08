"""
Bulk import wizard — CSV/Excel onboarding for master data.

Files are parsed on the FRONTEND (the SheetJS `xlsx` lib already bundled for
exports reads both .csv and .xlsx), which keeps the backend free of a new
spreadsheet dependency. The frontend posts already-mapped rows here. Two phases:

    POST /api/imports/{entity}/validate  → dry run, NO writes; per-row preview
    POST /api/imports/{entity}/commit    → inserts valid rows through the SAME
                                           create path the normal UI uses

The commit phase calls the existing `create_*` route functions directly, so no
business logic (validation, audit logging, stock movements, cost layers, …) is
re-implemented or bypassed. Each row commits independently: a row that fails is
rolled back and reported, valid rows are kept.

Supported entities: clients, suppliers, inventory.
"""
import sqlite3
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError

from database import get_db
from permissions import require_auth, check_perm

from routers.clients import ClientCreate, create_client
from routers.suppliers import SupplierCreate, create_supplier
from routers.inventory import InventoryCreate, create_item
from routers.accounting import AccountCreate, create_account
from routers.crm import LeadCreate, create_lead
from routers.hr import EmployeeBody, create_employee

router = APIRouter()

# A single import call is capped so a stray huge file can't tie up a worker.
MAX_ROWS = 5000


# ── Duplicate detectors ──────────────────────────────────────────────────────
# Return the id of an existing (non-archived) record the row would clash with,
# mirroring the uniqueness the normal create endpoints already enforce.
def _dup_supplier(db, m) -> Optional[int]:
    r = db.execute("SELECT id FROM suppliers WHERE name=? AND archived_at IS NULL",
                   (m.name,)).fetchone()
    return r["id"] if r else None


def _dup_inventory(db, m) -> Optional[int]:
    bc = (m.barcode or "").strip()
    if not bc:
        return None
    r = db.execute("SELECT id FROM inventory WHERE barcode=? AND archived_at IS NULL",
                   (bc,)).fetchone()
    return r["id"] if r else None


def _dup_account(db, m) -> Optional[int]:
    code = (m.code or "").strip()
    if not code:
        return None
    r = db.execute("SELECT id FROM chart_of_accounts WHERE code=?", (code,)).fetchone()
    return r["id"] if r else None


# ── Per-entity wizard config ─────────────────────────────────────────────────
# `fields` drives the column-mapping UI; `model` + `create` are the authoritative
# validation + insert path. `dup`/`dup_key` power duplicate skip/flagging.
ENTITIES: Dict[str, dict] = {
    "clients": {
        "module": "clients", "model": ClientCreate, "create": create_client,
        "dup": None, "dup_key": None,
        "fields": [
            {"key": "name",    "label": "Name", "required": True},
            {"key": "company", "label": "Company"},
            {"key": "phone",   "label": "Phone"},
            {"key": "email",   "label": "Email"},
            {"key": "address", "label": "Address"},
            {"key": "type",    "label": "Type", "hint": "private or company"},
            {"key": "notes",   "label": "Notes"},
        ],
    },
    "suppliers": {
        "module": "suppliers", "model": SupplierCreate, "create": create_supplier,
        "dup": _dup_supplier, "dup_key": "name",
        "fields": [
            {"key": "name",               "label": "Name", "required": True},
            {"key": "contact_name",       "label": "Contact name"},
            {"key": "phone",              "label": "Phone"},
            {"key": "email",              "label": "Email"},
            {"key": "payment_terms_days", "label": "Payment terms (days)", "type": "int"},
            {"key": "notes",              "label": "Notes"},
        ],
    },
    "inventory": {
        "module": "inventory", "model": InventoryCreate, "create": create_item,
        "dup": _dup_inventory, "dup_key": "barcode",
        "fields": [
            {"key": "name",            "label": "Name", "required": True},
            {"key": "category",        "label": "Category"},
            {"key": "product_type",    "label": "Product type",
             "hint": "raw_material / semi_finished / finished / consumable"},
            {"key": "quantity",        "label": "Quantity", "type": "number"},
            {"key": "min_stock",       "label": "Min stock", "type": "number"},
            {"key": "unit_cost",       "label": "Unit cost", "type": "number"},
            {"key": "sale_price",      "label": "Sale price", "type": "number"},
            {"key": "supplier",        "label": "Supplier"},
            {"key": "unit",            "label": "Unit"},
            {"key": "barcode",         "label": "Barcode"},
            {"key": "lot_tracked",     "label": "Lot tracked", "type": "bool"},
            {"key": "shelf_life_days", "label": "Shelf life (days)", "type": "int"},
        ],
    },
    "accounts": {
        "module": "accounting", "model": AccountCreate, "create": create_account,
        "dup": _dup_account, "dup_key": "code",
        "fields": [
            {"key": "code",           "label": "Code", "required": True},
            {"key": "name",           "label": "Name", "required": True},
            {"key": "type",           "label": "Type", "required": True,
             "hint": "Asset / Liability / Equity / Income / Expense"},
            {"key": "subtype",        "label": "Group"},
            {"key": "normal_balance", "label": "Normal balance", "hint": "debit or credit (optional)"},
            {"key": "description",    "label": "Description"},
        ],
    },
    "leads": {
        "module": "crm", "model": LeadCreate, "create": create_lead,
        "dup": None, "dup_key": None,
        "fields": [
            {"key": "name",            "label": "Name", "required": True},
            {"key": "company",         "label": "Company"},
            {"key": "email",           "label": "Email"},
            {"key": "phone",           "label": "Phone"},
            {"key": "source",          "label": "Source", "hint": "web / referral / cold_call / social / other"},
            {"key": "status",          "label": "Status", "hint": "New / Contacted / Qualified / Proposal / Negotiation / Won / Lost"},
            {"key": "score",           "label": "Score", "type": "int"},
            {"key": "estimated_value", "label": "Estimated value", "type": "number"},
            {"key": "expected_close",  "label": "Expected close", "hint": "YYYY-MM-DD"},
            {"key": "notes",           "label": "Notes"},
        ],
    },
    "employees": {
        "module": "hr", "model": EmployeeBody, "create": create_employee,
        "dup": None, "dup_key": None,
        "fields": [
            {"key": "full_name",       "label": "Full name", "required": True},
            {"key": "job_title",       "label": "Job title"},
            {"key": "employment_type", "label": "Employment type", "hint": "Full-time / Part-time / Contract"},
            {"key": "status",          "label": "Status", "hint": "Active / On leave / Terminated"},
            {"key": "hire_date",       "label": "Hire date", "hint": "YYYY-MM-DD"},
            {"key": "end_date",        "label": "End date", "hint": "YYYY-MM-DD"},
            {"key": "email",           "label": "Email"},
            {"key": "phone",           "label": "Phone"},
            {"key": "salary",          "label": "Salary", "type": "number"},
            {"key": "address",         "label": "Address"},
            {"key": "notes",           "label": "Notes"},
        ],
    },
}


class ImportPayload(BaseModel):
    rows: List[Dict[str, Any]]
    on_duplicate: Optional[str] = "skip"   # "skip" | "error"


def _entity_or_404(entity: str) -> dict:
    cfg = ENTITIES.get(entity)
    if not cfg:
        raise HTTPException(404, f"Unknown import type '{entity}'.")
    return cfg


def _clean(raw: Dict[str, Any], fields: list) -> Dict[str, Any]:
    """Drop unknown keys, strip strings, and turn blanks into None so optional
    columns left empty fall back to their model defaults instead of failing
    type coercion (e.g. '' → int)."""
    keys = {f["key"] for f in fields}
    out: Dict[str, Any] = {}
    for k, v in (raw or {}).items():
        if k not in keys:
            continue
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        out[k] = v
    return out


def _parse_row(cfg: dict, raw: Dict[str, Any]):
    """(model, errors) — Pydantic validates exactly as the live endpoint does."""
    try:
        return cfg["model"](**_clean(raw, cfg["fields"])), []
    except ValidationError as e:
        errs = []
        for err in e.errors():
            loc = ".".join(str(x) for x in err.get("loc", [])) or "row"
            errs.append(f"{loc}: {err.get('msg')}")
        return None, errs


def _dup_value(cfg: dict, model) -> Optional[str]:
    key = cfg.get("dup_key")
    if not key:
        return None
    v = getattr(model, key, None)
    if isinstance(v, str):
        v = v.strip().lower()
    return v or None


def _guard(entity: str, payload: ImportPayload, user, db, action="create") -> dict:
    cfg = _entity_or_404(entity)
    check_perm(user, db, cfg["module"], action)
    if len(payload.rows) > MAX_ROWS:
        raise HTTPException(400, f"Too many rows ({len(payload.rows)}). "
                                 f"Limit is {MAX_ROWS} per import.")
    return cfg


@router.get("/{entity}/schema")
def import_schema(entity: str, user=Depends(require_auth),
                  db: sqlite3.Connection = Depends(get_db)):
    cfg = _entity_or_404(entity)
    check_perm(user, db, cfg["module"], "create")
    return {"entity": entity, "fields": cfg["fields"]}


@router.post("/{entity}/validate")
def import_validate(entity: str, payload: ImportPayload, user=Depends(require_auth),
                    db: sqlite3.Connection = Depends(get_db)):
    """Dry run: parse + duplicate-check every row. Read-only — no writes."""
    cfg = _guard(entity, payload, user, db)
    rows, ok, dup, bad = [], 0, 0, 0
    seen: Dict[str, int] = {}
    for i, raw in enumerate(payload.rows):
        model, errs = _parse_row(cfg, raw)
        if errs:
            bad += 1
            rows.append({"index": i, "status": "error", "errors": errs})
            continue
        status, note = "ok", None
        kv = _dup_value(cfg, model)
        if kv is not None:
            if kv in seen:
                status, note = "duplicate", f"duplicate {cfg['dup_key']} in file (row {seen[kv] + 1})"
            elif cfg["dup"] and cfg["dup"](db, model):
                status, note = "duplicate", f"{cfg['dup_key']} already exists"
            seen.setdefault(kv, i)
        ok += status == "ok"
        dup += status == "duplicate"
        rows.append({"index": i, "status": status, "note": note,
                     "preview": model.model_dump()})
    return {"entity": entity, "total": len(payload.rows),
            "ok": ok, "duplicates": dup, "errors": bad, "rows": rows}


@router.post("/{entity}/commit")
def import_commit(entity: str, payload: ImportPayload, user=Depends(require_auth),
                  db: sqlite3.Connection = Depends(get_db)):
    """Insert valid rows via the real create path. Each row is independent: a
    failed row is rolled back and reported; valid rows are committed."""
    cfg = _guard(entity, payload, user, db)
    created = skipped = failed = 0
    details, seen = [], {}
    for i, raw in enumerate(payload.rows):
        model, errs = _parse_row(cfg, raw)
        if errs:
            failed += 1
            details.append({"index": i, "status": "failed", "errors": errs})
            continue
        kv = _dup_value(cfg, model)
        is_dup = kv is not None and (kv in seen or (cfg["dup"] and cfg["dup"](db, model)))
        if kv is not None:
            seen.setdefault(kv, i)
        if is_dup:
            if payload.on_duplicate == "error":
                failed += 1
                details.append({"index": i, "status": "failed",
                                "errors": [f"duplicate {cfg['dup_key']}"]})
            else:
                skipped += 1
                details.append({"index": i, "status": "skipped", "note": "duplicate"})
            continue
        try:
            res = cfg["create"](data=model, user=user, db=db)
            created += 1
            details.append({"index": i, "status": "created", "id": res.get("id")})
        except HTTPException as he:
            db.rollback()
            failed += 1
            details.append({"index": i, "status": "failed", "errors": [str(he.detail)]})
        except Exception as e:   # noqa: BLE001 — surface any row error, keep going
            db.rollback()
            failed += 1
            details.append({"index": i, "status": "failed", "errors": [str(e)]})
    return {"entity": entity, "created": created, "skipped": skipped,
            "failed": failed, "rows": details}
