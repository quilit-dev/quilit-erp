#!/usr/bin/env python3
"""
seed.py — populate a fresh ERP database with rich, generically-named demo data
that exercises every screen, state, KPI and report in the system.

Naming convention
-----------------
Every entity uses a neutral placeholder name so the dataset is presentable to
any audience and carries no real-world branding:

    Clients      Client Alpha … Client Sigma
    Suppliers    Supplier Alpha … Supplier Zeta
    Inventory    Material Alpha, Component Beta, Product Gamma, Consumable Delta
    Projects     Project Alpha … Project Mu
    Leads/Deals  Lead A … Lead H  /  Deal Alpha … Deal Epsilon
    Employees    Employee A … Employee J
    Assets       Equipment A, Vehicle B, Facility C …
    Warehouses   Warehouse Alpha / Beta

Descriptive words that are already generic (Materials, Rent, Utilities,
Technician, Full-time…) are kept as-is — they are categories, not names.

What you get
------------
    Login          admin / Admin123!  (superadmin)
                   plus one user per RBAC role — u_<role> / Test1234!
    Financials     18 months of history: ~$600k revenue, growing month over
                   month, profitable every month at a realistic net margin.
                   Every trend chart, P&L, balance sheet, cash-flow and aging
                   report is populated across the whole window.
    Accounting     Custom GL accounts, ~15 manual journal entries (capital,
                   loan drawdown + repayments, prepaid amortisation, accruals
                   and their reversals, FX, bank charges, owner drawings),
                   auto-posted revenue/expense/payroll/depreciation entries,
                   and two locked historical periods.
    Every module   Clients, suppliers, inventory (all product types + stock
                   states), warehouses + stock transfers, promotions,
                   projects, quotations, invoices (every payment state),
                   purchases, expenses, recurring expenses, POS, manufacturing
                   (BOMs, resources, QC, lots, partial completion), fixed
                   assets + depreciation, cash reconciliation, CRM, planning,
                   HR (contracts, payroll, leave, attendance), recruitment,
                   approvals, announcements and attachments.

Design notes
------------
The script drives the **real HTTP routers** via FastAPI's TestClient — no
direct SQL except (a) the one-line admin-password reset and (b) the historical
date-shift described in the "Historical backfill" section. Going through the
API guarantees every seeded row carries the same side-effects a real user would
produce (audit logs, notifications, tax snapshots, stock movements, ledger
postings), so the seeded DB is a faithful preview of normal operation.

Run
---
    python seed.py                # seeds against $DB_PATH (or ../erp.db)
    python seed.py --reset        # WIPE that DB file first, then seed
"""
from __future__ import annotations

import argparse
import io
import math
import os
import random
import sqlite3
import sys
import uuid
from calendar import monthrange
from datetime import datetime, timedelta
from pathlib import Path

# Windows consoles often default to a code page that can't print Unicode
# (cp1256, cp1252, etc.). Force UTF-8 on stdout so our progress lines —
# arrows, en-dashes, the box-drawing dividers — render everywhere.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                  line_buffering=True)

# Reproducible: re-running the seed produces the same figures every time.
random.seed(20250101)


# ── Bootstrap — env must be set BEFORE importing the backend ────────────────
_BACKEND_DIR = Path(__file__).resolve().parent
os.environ.setdefault("SECRET_KEY", "seed-only-secret-not-for-production-0123456789abcd")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:5173")
sys.path.insert(0, str(_BACKEND_DIR))


# ── CLI ─────────────────────────────────────────────────────────────────────
_ap = argparse.ArgumentParser(description="Seed the ERP database with demo data.")
_ap.add_argument("--reset", action="store_true",
                 help="delete the target database file before seeding")
_args = _ap.parse_args()

DB_PATH = os.environ.get("DB_PATH") or str(_BACKEND_DIR.parent / "erp.db")
os.environ["DB_PATH"] = DB_PATH

if _args.reset:
    for suffix in ("", "-wal", "-shm"):
        p = Path(DB_PATH + suffix)
        if p.exists():
            p.unlink()
    print(f"✗  removed existing database at {DB_PATH}")


# ── Schema + system seed (roles, tax rates, Main Till, admin user) ──────────
import database  # noqa: E402
database.init_db()


# ── Force a known admin password so the seed doesn't depend on the random
#    one init_db prints on a fresh install ─────────────────────────────────
from auth_utils import hash_password  # noqa: E402

ADMIN_PASSWORD = "Admin123!"
with sqlite3.connect(DB_PATH) as _con:
    _con.execute(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE username='admin'",
        (hash_password(ADMIN_PASSWORD),),
    )
    # Mark first-run setup as complete so a freshly --reset DB opens straight to
    # the login screen instead of the setup wizard.
    _con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    _con.execute(
        "INSERT INTO settings (key, value) VALUES ('setup_complete', '1') "
        "ON CONFLICT(key) DO UPDATE SET value='1'")
    _con.commit()


# ── Per-role logins — one active user per RBAC role so every permission set can
#    be exercised end-to-end. All share Test1234! with must_change_password=0. ─
import seed_users  # noqa: E402

ROLE_PASSWORD = seed_users.TEST_PASSWORD
seed_users.seed()


# ── Authenticated TestClient — every record below goes through the same
#    HTTP path the UI uses, so tax snapshots / audit logs / notifications /
#    stock movements all fire exactly like real usage ─────────────────────
from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
_r = client.post("/api/auth/login",
                 json={"username": "admin", "password": ADMIN_PASSWORD})
if _r.status_code != 200:
    raise RuntimeError(f"admin login failed: {_r.status_code} {_r.text}")


# ── Helpers ─────────────────────────────────────────────────────────────────
def POST(path: str, body=None, *, expect=(200, 201)) -> dict:
    r = client.post(path, json=body or {})
    if r.status_code not in expect:
        raise RuntimeError(f"POST {path} → {r.status_code}: {r.text}")
    try:
        return r.json()
    except Exception:
        return {}


def PUT(path: str, body=None, *, expect=(200,)) -> dict:
    r = client.put(path, json=body or {})
    if r.status_code not in expect:
        raise RuntimeError(f"PUT {path} → {r.status_code}: {r.text}")
    return r.json() if r.content else {}


def PATCH(path: str, body=None, *, expect=(200,)) -> dict:
    r = client.patch(path, json=body or {})
    if r.status_code not in expect:
        raise RuntimeError(f"PATCH {path} → {r.status_code}: {r.text}")
    return r.json() if r.content else {}


def GET(path: str):
    r = client.get(path)
    if r.status_code != 200:
        raise RuntimeError(f"GET {path} → {r.status_code}: {r.text}")
    return r.json()


def header(title: str):
    print(f"\n── {title} {'─' * max(2, 62 - len(title))}")


_TODAY = datetime.utcnow()


def days_ago(n: int) -> str:
    return (_TODAY - timedelta(days=n)).strftime("%Y-%m-%d")


def days_ahead(n: int) -> str:
    return (_TODAY + timedelta(days=n)).strftime("%Y-%m-%d")


def months_back(n: int):
    """(year, month) n whole months before the current month."""
    y, m = _TODAY.year, _TODAY.month - n
    while m <= 0:
        m += 12
        y -= 1
    return y, m


def dstr(y: int, m: int, day: int) -> str:
    """Safe YYYY-MM-DD — clamps the day to the month's length."""
    return f"{y:04d}-{m:02d}-{min(day, monthrange(y, m)[1]):02d}"


_month = _TODAY.strftime("%Y-%m")

# How much history to build. 18 months gives every chart a full window plus a
# prior calendar year for year-over-year comparisons and year-end closing.
HISTORY_MONTHS = 18
# The company "starts" at the beginning of that window (the capital injection
# below is dated there). Nothing — assets, hires, contracts — predates it, so
# depreciation and payroll never appear in months that have no revenue.
COMPANY_START_DAYS = 30 * HISTORY_MONTHS - 20          # ≈ the window's first month


# ════════════════════════════════════════════════════════════════════════════
# 1. Settings + tax engine
# ════════════════════════════════════════════════════════════════════════════
header("Settings & tax")
PUT("/api/settings/", {
    "tax_enabled":      "1",
    "company_name":     "Demo Company",
    "show_discount_col": "1",
})
# A reduced rate so the VAT report has more than one taxable bucket to break
# down — the per-rate chart only really sings with ≥ 2 active rates.
POST("/api/tax-rates/", {"name": "Reduced VAT 5%", "rate": 5,
                         "tax_type": "standard", "is_default": False})
_rates = GET("/api/tax-rates/")
default_rate = next(r for r in _rates if r["is_default"])
zero_rate    = next(r for r in _rates if r["rate"] == 0 and r["tax_type"] == "zero")
reduced_rate = next(r for r in _rates if abs(r["rate"] - 5) < 0.01)
TAX_DEFAULT, TAX_REDUCED, TAX_ZERO = default_rate["id"], reduced_rate["id"], zero_rate["id"]
print(f"  tax on; rates: {default_rate['name']} / {reduced_rate['name']} / {zero_rate['name']}")


# ════════════════════════════════════════════════════════════════════════════
# 2. Category registry — owner-defined lists that feed every picker
# ════════════════════════════════════════════════════════════════════════════
header("Categories")
_cat_added = 0
for domain, names in [
    ("inventory", ["Components", "Finished Goods"]),
    ("expense",   ["Maintenance", "Marketing"]),
    ("asset",     ["Machinery", "Fixtures"]),
    ("project",   ["Installation", "Consulting"]),
]:
    for n in names:
        r = client.post("/api/categories/", json={"domain": domain, "name": n})
        _cat_added += 1 if r.status_code in (200, 201) else 0
print(f"  +{_cat_added} owner-defined categories across 4 domains")


# ════════════════════════════════════════════════════════════════════════════
# 3. Warehouses — a second + third location so transfers and the
#    per-warehouse valuation report have something to show
# ════════════════════════════════════════════════════════════════════════════
header("Warehouses")
_wh_existing = {w["code"]: w for w in GET("/api/warehouses/")}
_wh_main = _wh_existing["MAIN"]


def _warehouse(code, **body):
    """Create the warehouse, or reuse it when re-seeding without --reset."""
    if code in _wh_existing:
        return _wh_existing[code]
    return POST("/api/warehouses/", {"code": code, **body})


wh_beta = _warehouse("WHB", name="Warehouse Beta", type="Branch",
                     address="Secondary site", notes="Overflow + branch stock")
wh_gamma = _warehouse("WHG", name="Warehouse Gamma", type="Production",
                      address="Production floor", notes="Work-in-progress staging")
WH_MAIN, WH_BETA, WH_GAMMA = _wh_main["id"], wh_beta["id"], wh_gamma["id"]
print(f"  +2 warehouses (Warehouse Beta / Gamma) alongside {_wh_main['name']}")


# ════════════════════════════════════════════════════════════════════════════
# 4. Clients — 16, mixed business + private
# ════════════════════════════════════════════════════════════════════════════
header("Clients")
_GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
          "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Sigma"]

clients_seed = []
for i, g in enumerate(_GREEK):
    business = i < 10
    clients_seed.append({
        "name":    f"Client {g}",
        "company": f"Client {g} Ltd" if business else None,
        "phone":   f"+1 555 01{i:02d}",
        "email":   f"contact@client-{g.lower()}.example",
        "address": f"{100 + i} Example Street, Unit {i + 1}",
        "type":    "business" if business else "private",
    })
CLIENT_IDS = [POST("/api/clients/", {k: v for k, v in c.items() if v is not None})["id"]
              for c in clients_seed]
CL = dict(zip(_GREEK, CLIENT_IDS))          # CL["Alpha"] → id
BUSINESS_CLIENTS = CLIENT_IDS[:10]
print(f"  +{len(CLIENT_IDS)} clients (10 business + 6 private)")


# ════════════════════════════════════════════════════════════════════════════
# 5. Suppliers
# ════════════════════════════════════════════════════════════════════════════
header("Suppliers")
supplier_ids = []
for i, g in enumerate(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]):
    supplier_ids.append(POST("/api/suppliers/", {
        "name":         f"Supplier {g}",
        "contact_name": f"Contact {chr(65 + i)}",
        "phone":        f"+1 555 02{i:02d}",
        "email":        f"sales@supplier-{g.lower()}.example",
        "payment_terms_days": [30, 15, 60, 30, 45, 30][i],
        "notes":        f"Supplies group {g}",
    })["id"])
SUP_A, SUP_B, SUP_C, SUP_D, SUP_E, SUP_F = supplier_ids
print(f"  +{len(supplier_ids)} suppliers with varied payment terms")


# ════════════════════════════════════════════════════════════════════════════
# 6. Inventory — every product type + every stock state
# ════════════════════════════════════════════════════════════════════════════
header("Inventory")
inv = {}
INV_NAME: dict[str, str] = {}          # key → display name (create response omits it)
# Every item carries a selling price. Finished goods run the fattest margin
# (~130%); materials and components are also sold over the counter as spares,
# at the thinner ~45-50% markup that trade counters typically charge.
inventory_seed = [
    # key,        name,               category,         type,            qty,  cost,  sale, min, supplier
    ("mat_a",  "Material Alpha",   "Materials",      "raw_material",   1400,  4.00,  5.80,  200, "Supplier Alpha"),
    ("mat_b",  "Material Beta",    "Materials",      "raw_material",   6000,  0.05,  0.10,  500, "Supplier Alpha"),
    ("mat_c",  "Material Gamma",   "Materials",      "raw_material",    240, 12.00, 17.50,   40, "Supplier Beta"),
    ("mat_d",  "Material Delta",   "Materials",      "raw_material",     18,  9.50, 13.75,   30, "Supplier Beta"),   # low
    ("cmp_a",  "Component Alpha",  "Components",     "semi_finished",    60, 35.00, 52.00,   10, None),
    ("cmp_b",  "Component Beta",   "Components",     "semi_finished",    26, 22.00, 33.00,   10, None),
    ("prd_a",  "Product Alpha",    "Finished Goods", "finished",         42, 96.00,  220,   10, None),
    ("prd_b",  "Product Beta",     "Finished Goods", "finished",        130, 18.00,   55,   25, None),
    ("prd_c",  "Product Gamma",    "Finished Goods", "finished",        260,  8.00,   18,   40, "Supplier Gamma"),
    ("prd_d",  "Product Delta",    "Finished Goods", "finished",          0,  4.00,   12,   15, "Supplier Gamma"),  # out
    ("prd_e",  "Product Epsilon",  "Finished Goods", "finished",          6,  3.50,    9,   20, "Supplier Gamma"),  # low
    ("prd_f",  "Product Zeta",     "Finished Goods", "finished",         85, 26.00,   62,   15, None),
    ("con_a",  "Consumable Alpha", "Consumables",    "consumable",        9,  2.00,    4,   30, "Supplier Delta"),  # low
    ("con_b",  "Consumable Beta",  "Consumables",    "consumable",     2200,  0.10,    1,  400, "Supplier Delta"),
    ("con_c",  "Consumable Gamma", "Consumables",    "consumable",      320,  3.20,    7,   60, "Supplier Delta"),
]
for key, name, cat, ptype, qty, cost, sale, mn, sup in inventory_seed:
    body = {"name": name, "category": cat, "product_type": ptype,
            "quantity": qty, "unit_cost": cost, "sale_price": sale,
            "min_stock": mn, "unit": "pcs"}
    if sup:
        body["supplier"] = sup
    inv[key] = POST("/api/inventory/", body)
    INV_NAME[key] = name

# Lot-tracked pair used by the QC / traceability production run below.
inv["lot_raw"] = POST("/api/inventory/", {
    "name": "Material Epsilon (lot-tracked)", "category": "Materials",
    "product_type": "raw_material", "quantity": 900, "unit_cost": 2.0,
    "sale_price": 3.20, "unit": "kg", "lot_tracked": True, "shelf_life_days": 365})
inv["lot_fg"] = POST("/api/inventory/", {
    "name": "Product Eta (lot-tracked)", "category": "Finished Goods",
    "product_type": "finished", "quantity": 0, "unit_cost": 17.50, "sale_price": 40,
    "min_stock": 10, "unit": "pcs", "lot_tracked": True, "shelf_life_days": 730})
INV_NAME["lot_raw"], INV_NAME["lot_fg"] = "Material Epsilon (lot-tracked)", "Product Eta (lot-tracked)"
print(f"  +{len(inv)} items — 1 out of stock, 3 below minimum → low-stock alerts")


# ════════════════════════════════════════════════════════════════════════════
# 7. Promotions — POS discount rules
# ════════════════════════════════════════════════════════════════════════════
header("Promotions")
POST("/api/promotions/", {
    "name": "Promotion Alpha — 10% off Finished Goods", "scope_type": "category",
    "scope_value": "Finished Goods", "discount_value": 10,
    "start_date": days_ago(20), "end_date": days_ahead(20), "active": True})
POST("/api/promotions/", {
    "name": "Promotion Beta — 15% off Product Gamma", "scope_type": "item",
    "scope_value": str(inv["prd_c"]["id"]), "discount_value": 15,
    "start_date": days_ago(5), "end_date": days_ahead(30),
    "max_quantity": 100, "active": True})
POST("/api/promotions/", {
    "name": "Promotion Gamma — expired storewide", "scope_type": "all",
    "discount_value": 5, "start_date": days_ago(90), "end_date": days_ago(60),
    "active": False})
print("  +3 promotions (2 live, 1 expired)")


# ════════════════════════════════════════════════════════════════════════════
# 8. Projects — 12 across the full status spectrum
# ════════════════════════════════════════════════════════════════════════════
header("Projects")
projects_seed = [
    ("Project Alpha",   "Alpha",   "Active",    -40,  None,  9000, 14000, "Fit-out and installation"),
    ("Project Beta",    "Beta",    "Completed", -150,  -35,  7000, 11000, "Delivered and signed off"),
    ("Project Gamma",   "Gamma",   "Inquiry",     10,  None,  4000,  6500, "Awaiting client approval"),
    ("Project Delta",   "Delta",   "On Hold",    -70,  None, 12000, 18000, "Paused pending client decision"),
    ("Project Epsilon", "Epsilon", "Active",     -25,  None,  3500,  5500, "Phase 1 of 3"),
    ("Project Zeta",    "Zeta",    "Active",     -55,  None,  5500,  8500, "Multi-site rollout"),
    ("Project Eta",     "Eta",     "Completed", -220, -120,  6200,  9800, "Closed last quarter"),
    ("Project Theta",   "Theta",   "Inquiry",     20,  None,  6000,  9000, "Scoping in progress"),
    ("Project Iota",    "Iota",    "Active",     -15,  None,  4200,  6800, "On schedule"),
    ("Project Kappa",   "Kappa",   "On Hold",    -95,  None,  2000,  3200, "Awaiting material selection"),
    ("Project Lambda",  "Lambda",  "Completed", -300, -210,  8000, 12500, "Prior-year delivery"),
    ("Project Mu",      "Mu",      "Active",     -10,  None,  5000,  7600, "Recently started"),
]
PRJ = {}
for name, cl_key, status, start_off, end_off, est, rev, desc in projects_seed:
    body = {"name": name, "client_id": CL[cl_key], "status": status,
            "start_date": days_ago(-start_off) if start_off < 0 else days_ahead(start_off),
            "estimated_cost": est, "expected_revenue": rev, "description": desc,
            "location": "Site " + name.split()[-1]}
    if end_off is not None:
        body["end_date"] = days_ago(-end_off)
    PRJ[name.split()[-1]] = POST("/api/projects/", body)["id"]
print(f"  +{len(PRJ)} projects (Active / Completed / Inquiry / On Hold)")


# ════════════════════════════════════════════════════════════════════════════
# 9. Quotations — every status, several converted to invoices
# ════════════════════════════════════════════════════════════════════════════
header("Quotations")
quotes_seed = [
    ("Alpha",   "Alpha",   "Draft",    [("Service package A", 1, 1800, TAX_DEFAULT),
                                        ("Product Beta",      6,  120, TAX_DEFAULT)]),
    ("Gamma",   "Gamma",   "Sent",     [("Product Alpha",     8,  320, TAX_DEFAULT),
                                        ("Product Beta",      8,  180, TAX_DEFAULT),
                                        ("Installation",      1,   90, TAX_REDUCED)]),
    ("Epsilon", "Epsilon", "Accepted", [("Service package B", 1, 1900, TAX_DEFAULT),
                                        ("Product Zeta",      4,  130, TAX_DEFAULT)]),
    ("Zeta",    "Zeta",    "Accepted", [("Fixtures set",      1, 3400, TAX_DEFAULT)]),
    ("Theta",   "Theta",   "Sent",     [("Product Gamma",     3,  520, TAX_REDUCED)]),
    ("Iota",    "Iota",    "Rejected", [("Custom unit",       1, 1250, TAX_DEFAULT)]),
    ("Delta",   "Delta",   "Sent",     [("Product Alpha",     5,  260, TAX_DEFAULT)]),
    ("Nu",      None,      "Draft",    [("Repair service",    1,  480, TAX_DEFAULT)]),
    ("Xi",      None,      "Rejected", [("Product Delta",     2,  310, TAX_DEFAULT)]),
    ("Mu",      "Mu",      "Accepted", [("Product Zeta",      6,  180, TAX_DEFAULT)]),
]
_converted = 0
for cl_key, prj_key, status, lines in quotes_seed:
    items = [{"name": n, "quantity": q, "unit_price": p, "tax_rate_id": t}
             for n, q, p, t in lines]
    body = {"client_id": CL[cl_key], "items": items,
            "notes": f"Quotation for Client {cl_key}"}
    if prj_key:
        body["project_id"] = PRJ[prj_key]
    q = POST("/api/quotations/", body)
    if status != "Draft":
        upd = {"client_id": CL[cl_key], "status": status, "items": items}
        if prj_key:
            upd["project_id"] = PRJ[prj_key]
        PUT(f"/api/quotations/{q['id']}", upd)
    if status == "Accepted":
        POST(f"/api/quotations/{q['id']}/convert-to-invoice")
        _converted += 1
print(f"  +{len(quotes_seed)} quotations ({_converted} accepted → invoices)")


# ════════════════════════════════════════════════════════════════════════════
# 10. Invoices — the current-state payment matrix (history comes later)
# ════════════════════════════════════════════════════════════════════════════
header("Invoices")


def _invoice(cl_key, lines, *, due_in=None, pay=None, project=None, notes=None):
    """Create an invoice; `pay` in {None,'full','partial'}. Returns (id, amount)."""
    body = {"client_id": CL[cl_key],
            "items": [{"name": n, "quantity": q, "unit_price": p, "tax_rate_id": t}
                      for n, q, p, t in lines]}
    if due_in is not None:
        body["due_date"] = days_ahead(due_in) if due_in >= 0 else days_ago(-due_in)
    if project:
        body["project_id"] = PRJ[project]
    if notes:
        body["notes"] = notes
    iv  = POST("/api/invoices/", body)
    amt = GET(f"/api/invoices/{iv['id']}")["amount"]
    if pay == "full":
        POST(f"/api/invoices/{iv['id']}/payments",
             {"amount": amt, "method": "Bank Transfer",
              "idempotency_key": str(uuid.uuid4())})
    elif pay == "partial":
        POST(f"/api/invoices/{iv['id']}/payments",
             {"amount": round(amt * 0.4, 2), "method": "Cash",
              "idempotency_key": str(uuid.uuid4())})
    return iv["id"], amt


inv_paid_id, _ = _invoice("Beta", [("Consulting hours", 5, 80, TAX_DEFAULT)],
                          pay="full", notes="Settled in full")
_invoice("Alpha", [("Maintenance retainer", 1, 600, TAX_DEFAULT)], pay="partial")
_invoice("Kappa", [("Product Alpha", 1, 880, TAX_DEFAULT)], due_in=10)
_invoice("Nu",    [("Delivery service", 1, 250, TAX_DEFAULT)], due_in=-20)
_invoice("Xi",    [("Product Beta", 2, 210, TAX_DEFAULT)], due_in=-45)
# Mixed-rate invoice so the VAT-by-rate report has real variety.
_invoice("Delta", [("Standard goods", 2, 500, TAX_DEFAULT),
                   ("Reduced-rate goods", 1, 300, TAX_REDUCED),
                   ("Zero-rated item", 1, 50, TAX_ZERO)], due_in=14)
# Voided
_void_id, _ = _invoice("Omicron", [("Cancelled order", 1, 410, TAX_DEFAULT)])
PATCH(f"/api/invoices/{_void_id}/void", {"reason": "Customer cancelled before delivery"})
print("  +7 invoices: paid / partial / open / overdue / mixed-rate / voided")


# ════════════════════════════════════════════════════════════════════════════
# 11. Purchases — every status; paid ones post expenses + input VAT
# ════════════════════════════════════════════════════════════════════════════
header("Purchases")
purchases = [
    ("Supplier Alpha", "Material Alpha",  inv["mat_a"]["id"], 300, 4.00,  25, TAX_DEFAULT, "Ordered"),
    ("Supplier Alpha", "Material Beta",   inv["mat_b"]["id"], 2000, 0.05,  0, TAX_DEFAULT, "Received"),
    ("Supplier Beta",  "Material Gamma",  inv["mat_c"]["id"], 120, 11.00,  5, TAX_DEFAULT, "Paid"),
    ("Supplier Gamma", "Product Gamma",   inv["prd_c"]["id"], 200,  7.50, 30, TAX_DEFAULT, "Paid"),
    ("Supplier Delta", "Consumable Gamma", inv["con_c"]["id"], 150, 2.80,  8, TAX_REDUCED, "Paid"),
    ("Supplier Beta",  "Material Delta",  inv["mat_d"]["id"], 100,  9.00, 12, TAX_DEFAULT, "Ordered"),
    ("Supplier Delta", "Consumable Alpha", inv["con_a"]["id"], 200, 1.90,  6, TAX_DEFAULT, "Received"),
]
for sup, pname, iid, qty, cost, extra, tax, status in purchases:
    POST("/api/purchases/", {
        "supplier": sup, "product_name": pname, "inventory_id": iid,
        "quantity": qty, "unit_cost": cost, "additional_costs": extra,
        "tax_rate_id": tax, "status": status})
print(f"  +{len(purchases)} purchases (2 Ordered, 2 Received, 3 Paid → expenses)")


# ════════════════════════════════════════════════════════════════════════════
# 12. Recurring expense templates — 3 frequencies, each back-posted
# ════════════════════════════════════════════════════════════════════════════
header("Recurring expenses")
recurring_seed = [
    {"name": "Recurring — Facility Rent", "category": "Rent", "amount": 1100,
     "frequency": "monthly", "start_date": days_ago(120),
     "tax_rate_id": TAX_DEFAULT, "description": "Monthly facility rent"},
    {"name": "Recurring — Connectivity", "category": "Utilities", "amount": 330,
     "frequency": "quarterly", "start_date": days_ago(120),
     "tax_rate_id": TAX_DEFAULT, "description": "Network and phone lines"},
    {"name": "Recurring — Software Licence", "category": "Subscription", "amount": 440,
     "frequency": "annual", "start_date": days_ago(60),
     "tax_rate_id": TAX_DEFAULT, "description": "Annual software seat"},
]
for tpl_body in recurring_seed:
    tpl = POST("/api/recurring-expenses", tpl_body)
    POST(f"/api/recurring-expenses/{tpl['id']}/run")
print(f"  +{len(recurring_seed)} templates, each posted onto the P&L")


# ════════════════════════════════════════════════════════════════════════════
# 13. POS — open session, varied tenders, one refund
# ════════════════════════════════════════════════════════════════════════════
header("POS")
POST("/api/pos/session/open", {"opening_float": 200})


def _checkout(items, method="Cash", tendered=None):
    body = {"items": items, "payment_method": method,
            "idempotency_key": str(uuid.uuid4())}
    if method.lower() == "cash":
        body["amount_tendered"] = tendered if tendered is not None else \
            sum(i["quantity"] * i["unit_price"] for i in items) + 10
    else:
        body["amount_tendered"] = 0
    return POST("/api/pos/checkout", body)


def _line(key, qty, price):
    return {"inventory_id": inv[key]["id"], "name": INV_NAME[key],
            "quantity": qty, "unit_price": price, "tax_rate_id": TAX_DEFAULT}


_checkout([_line("prd_c", 2, 18), _line("con_a", 1, 4)])
_checkout([_line("prd_b", 1, 55), _line("prd_c", 3, 18)])
_checkout([_line("prd_b", 2, 55)], method="Card")
_checkout([{"inventory_id": None, "name": "Custom service line",
            "quantity": 1, "unit_price": 35, "tax_rate_id": TAX_DEFAULT}])
_checkout([_line("prd_f", 1, 62), _line("con_b", 10, 1)], method="Card")
_checkout([_line("prd_c", 4, 18)])
_checkout([_line("con_c", 6, 7)], method="Cash")
_sale_return = _checkout([_line("prd_c", 4, 18)])
POST(f"/api/pos/sales/{_sale_return['id']}/return", {"reason": "Customer changed their mind"})
print("  open session + 8 sales (cash / card / service line) + 1 refund")


# ════════════════════════════════════════════════════════════════════════════
# 14. Manufacturing — BOMs, versions, resources, QC + lots, partial completion
# ════════════════════════════════════════════════════════════════════════════
header("Manufacturing")
res_labor = POST("/api/manufacturing/resources", {"name": "Resource Labour",     "hourly_rate": 12})["id"]
res_power = POST("/api/manufacturing/resources", {"name": "Resource Power",      "hourly_rate": 3})["id"]
res_mach  = POST("/api/manufacturing/resources", {"name": "Resource Machine A",  "hourly_rate": 20})["id"]
res_oven  = POST("/api/manufacturing/resources", {"name": "Resource Machine B",  "hourly_rate": 8})["id"]

bom_a_v1 = POST("/api/manufacturing/boms", {
    "name": "BOM — Product Alpha", "output_inventory_id": inv["prd_a"]["id"],
    "output_quantity": 1, "labor_cost": 30, "overhead_cost": 10,
    "components": [
        {"component_inventory_id": inv["mat_a"]["id"], "quantity": 4, "scrap_pct": 5},
        {"component_inventory_id": inv["mat_b"]["id"], "quantity": 20},
        {"component_inventory_id": inv["mat_c"]["id"], "quantity": 1},
    ]})
POST(f"/api/manufacturing/boms/{bom_a_v1['id']}/new-version", {
    "name": "BOM — Product Alpha", "output_inventory_id": inv["prd_a"]["id"],
    "output_quantity": 1, "labor_cost": 35, "overhead_cost": 10,
    "revision_note": "Added Component Alpha; reduced Material Gamma per unit",
    "components": [
        {"component_inventory_id": inv["mat_a"]["id"], "quantity": 4, "scrap_pct": 5},
        {"component_inventory_id": inv["mat_b"]["id"], "quantity": 18},
        {"component_inventory_id": inv["mat_c"]["id"], "quantity": 1},
        {"component_inventory_id": inv["cmp_a"]["id"], "quantity": 1},
    ]})

bom_b = POST("/api/manufacturing/boms", {
    "name": "BOM — Product Beta", "output_inventory_id": inv["prd_b"]["id"],
    "output_quantity": 1, "labor_cost": 8, "overhead_cost": 3,
    "components": [
        {"component_inventory_id": inv["mat_a"]["id"], "quantity": 2},
        {"component_inventory_id": inv["mat_b"]["id"], "quantity": 12},
        {"component_inventory_id": inv["mat_c"]["id"], "quantity": 1},
    ]})

# Completed batch → stock + cost roll-up
mo_done = POST("/api/manufacturing/orders", {"bom_id": bom_a_v1["id"], "quantity": 5,
                                             "notes": "Batch 1", "priority": "Normal"})
POST(f"/api/manufacturing/orders/{mo_done['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_done['id']}/start")
POST(f"/api/manufacturing/orders/{mo_done['id']}/complete")

# In progress
mo_wip = POST("/api/manufacturing/orders", {"bom_id": bom_b["id"], "quantity": 10,
                                            "notes": "Restock run", "priority": "High",
                                            "due_date": days_ahead(6)})
POST(f"/api/manufacturing/orders/{mo_wip['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_wip['id']}/start")

# Draft
POST("/api/manufacturing/orders", {"bom_id": bom_b["id"], "quantity": 15,
                                   "notes": "Planned — awaiting materials"})

# QC + lot traceability
bom_lot = POST("/api/manufacturing/boms", {
    "name": "BOM — Product Eta", "output_inventory_id": inv["lot_fg"]["id"],
    "output_quantity": 10, "standard_hours": 2, "qc_required": True,
    "components": [{"component_inventory_id": inv["lot_raw"]["id"], "quantity": 5}],
    "resources": [{"resource_id": res_labor}, {"resource_id": res_power},
                  {"resource_id": res_mach}, {"name": "Inspection", "hourly_rate": 5}]})
mo_qc = POST("/api/manufacturing/orders", {"bom_id": bom_lot["id"], "quantity": 10,
                                           "priority": "High", "due_date": days_ahead(7),
                                           "notes": "QC + lot-tracked batch"})
POST(f"/api/manufacturing/orders/{mo_qc['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_qc['id']}/start")
_done = POST(f"/api/manufacturing/orders/{mo_qc['id']}/complete", {"production_hours": 2.5})
if _done.get("qc_id"):
    POST(f"/api/manufacturing/qc/{_done['qc_id']}/resolve", {
        "passed_qty": 7, "rejected_qty": 3, "rework_qty": 2,
        "defects": [{"reason": "Surface defect", "quantity": 2},
                    {"reason": "Dimensional variance", "quantity": 1}],
        "notes": "Two reworkable, one scrapped."})

# Resource-costed BOM completed across two partial runs (auto-closes)
bom_partial = POST("/api/manufacturing/boms", {
    "name": "BOM — Component Beta", "output_inventory_id": inv["cmp_b"]["id"],
    "output_quantity": 1, "standard_hours": 0.5,
    "components": [{"component_inventory_id": inv["mat_a"]["id"], "quantity": 1}],
    "resources": [{"resource_id": res_labor}, {"resource_id": res_oven}]})
mo_partial = POST("/api/manufacturing/orders", {
    "bom_id": bom_partial["id"], "quantity": 10, "priority": "Normal",
    "planned_start_date": days_ago(2), "due_date": days_ahead(5)})
POST(f"/api/manufacturing/orders/{mo_partial['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_partial['id']}/complete",
     {"quantity_produced": 6, "production_hours": 3, "close": False})
POST(f"/api/manufacturing/orders/{mo_partial['id']}/complete",
     {"quantity_produced": 4, "production_hours": 2})
print("  +4 resources, 4 BOMs (1 versioned), 6 orders incl. QC batch + partial runs")


# ════════════════════════════════════════════════════════════════════════════
# 15. Stock transfers between warehouses
# ════════════════════════════════════════════════════════════════════════════
# ════════════════════════════════════════════════════════════════════════════
# 16b. Service — customer equipment and the jobs done on it
# ════════════════════════════════════════════════════════════════════════════
header("Service")

# The technician jobs get assigned to. Looked up rather than hardcoded, the same
# way the warehouse-access grant below does it.
_tech_id = next((u["id"] for u in GET("/api/users/")
                 if u.get("username") == "u_operations_manager"), None)

# Equipment: machines the customer owns, at their site. Serial numbers matter —
# it is how a technician identifies the unit in front of them — so every one
# carries a plausible plate.
_equip_seed = [
    # client,   name,                 manufacturer, model,     serial,      location
    ("Alpha",  "Production Line A",  "Maker Alpha", "PL-2000", "SN-AL-0142", "Plant floor, bay 1"),
    ("Alpha",  "Compressor Unit",    "Maker Beta",  "CU-40",   "SN-AL-0871", "Utility room"),
    ("Beta",   "Packing Machine",    "Maker Alpha", "PK-15",   "SN-BE-3310", "Packing hall"),
    ("Gamma",  "Chiller Unit",       "Maker Gamma", "CH-8",    "SN-GA-2205", "Roof plant"),
    ("Delta",  "Conveyor Belt",      "Maker Beta",  "CV-120",  "SN-DE-0064", "Warehouse"),
    ("Epsilon","Generator 60kVA",    "Maker Delta", "GN-60",   "SN-EP-7788", "External enclosure"),
]
EQ = {}
for _cl, _name, _mfr, _model, _serial, _loc in _equip_seed:
    EQ[_name] = POST("/api/service/equipment", {
        "client_id":     CL[_cl],
        "name":          _name,
        "manufacturer":  _mfr,
        "model":         _model,
        "serial_number": _serial,
        "install_date":  days_ago(400),
        "location":      _loc,
    })["id"]


def _job(cl, *, equipment=None, jtype="Repair", fault, parts=(), charges=(),
         scheduled=None, priority="Normal", work_done=None):
    """One service job. `parts` are (inventory-key, qty, price) drawn from
    stock — priced explicitly, the way `_line` does it, because the create
    response carries only the id. `charges` are (label, amount) flat fees."""
    items = []
    for _key, _qty, _price in parts:
        items.append({"line_type": "part", "inventory_id": inv[_key]["id"],
                      "name": INV_NAME[_key], "quantity": _qty,
                      "unit_price": _price})
    for _label, _amount in charges:
        items.append({"line_type": "charge", "name": _label,
                      "quantity": 1, "unit_price": _amount})
    body = {"client_id": CL[cl], "job_type": jtype, "priority": priority,
            "reported_fault": fault, "items": items}
    if equipment:
        body["equipment_id"] = EQ[equipment]
    if scheduled:
        body["scheduled_date"] = scheduled
    if work_done:
        body["work_done"] = work_done
    if _tech_id:
        body["assigned_to"] = _tech_id
    return POST("/api/service/jobs", body)


# ── Open work — a technician's list. Every one of these is Open: a job is
#    open from the call until the sheet comes back and is typed up.──────────
_draft = _job("Gamma", equipment="Chiller Unit", jtype="Inspection",
              fault="Annual inspection due",
              charges=[("Inspection visit", 90)])

_sched = _job("Beta", equipment="Packing Machine", jtype="Maintenance",
              fault="Scheduled 6-month service",
              scheduled=days_ahead(4),
              parts=[("mat_c", 2, 17.50)], charges=[("Service labour", 120)])

_started = _job("Delta", equipment="Conveyor Belt", jtype="Repair",
                fault="Belt slipping under load", priority="High",
                scheduled=days_ago(1),
                parts=[("cmp_b", 1, 33.00)], charges=[("Callout", 60), ("Labour", 140)])

# ── Closed and invoiced — the normal end state. Closing consumes the
#    parts, posts their cost, and (auto-invoice being on by default) raises the
#    invoice, which is then paid so the revenue split shows in the ledger.
_done = _job("Alpha", equipment="Production Line A", jtype="Repair",
             fault="Line stopped mid-shift, drive fault",
             scheduled=days_ago(9), priority="High",
             work_done="Replaced drive component and realigned the belt. "
                       "Ran a full cycle under load — no fault repeated.",
             parts=[("cmp_a", 1, 52.00), ("mat_a", 4, 5.80)],
             charges=[("Emergency callout", 120), ("Labour, 3h", 180)])
_done_res = POST(f"/api/service/jobs/{_done['id']}/complete")
if _done_res.get("invoice"):
    POST(f"/api/invoices/{_done_res['invoice']['invoice_id']}/payments", {
        "amount": _done_res["invoice"]["amount"], "currency": "USD",
        "method": "Bank Transfer", "idempotency_key": f"seed-svc-{_done['id']}"})

_done2 = _job("Alpha", equipment="Compressor Unit", jtype="Maintenance",
              fault="Pressure dropping overnight",
              scheduled=days_ago(24),
              work_done="Replaced seals, pressure-tested to 8 bar.",
              parts=[("mat_c", 1, 17.50)], charges=[("Labour, 2h", 120)])
POST(f"/api/service/jobs/{_done2['id']}/complete")

# ── Completed but NOT invoiced — the state the dashboard's "awaiting invoice"
#    tile and the service report both exist to surface. Auto-invoicing has to
#    be switched off around it, or there is nothing left unbilled to show.
PUT("/api/settings/", {"service_auto_invoice": "0"})
_unbilled = _job("Epsilon", equipment="Generator 60kVA", jtype="Repair",
                 fault="Fails to start on mains failure",
                 scheduled=days_ago(3),
                 work_done="Replaced starter relay; test-started three times.",
                 parts=[("cmp_b", 1, 33.00)], charges=[("Labour, 1.5h", 90)])
POST(f"/api/service/jobs/{_unbilled['id']}/complete")
PUT("/api/settings/", {"service_auto_invoice": "1"})

# ── Cancelled — a job the customer called off before anyone travelled.
_cancelled = _job("Delta", jtype="Installation",
                  fault="Install second conveyor drive",
                  charges=[("Installation, day rate", 400)])
POST(f"/api/service/jobs/{_cancelled['id']}/cancel",
     {"reason": "Customer deferred to next quarter"})

# ── An older completed job on the same machine, so at least one piece of
#    equipment has a HISTORY rather than a single visit. That history is the
#    reason equipment is a record instead of a text field on the job.
_hist = _job("Alpha", equipment="Production Line A", jtype="Maintenance",
             fault="Routine service",
             scheduled=days_ago(120),
             work_done="Lubricated bearings, replaced filters, no faults found.",
             parts=[("mat_b", 20, 0.10)], charges=[("Labour, 2h", 120)])
POST(f"/api/service/jobs/{_hist['id']}/complete")

print(f"  +{len(EQ)} equipment; 7 jobs "
      "(draft, scheduled, in progress, 3 completed incl. 1 unbilled, 1 cancelled)")


header("Stock transfers")
# Completed: Main → Beta
_t1 = POST("/api/warehouses/transfers/", {
    "from_warehouse_id": WH_MAIN, "to_warehouse_id": WH_BETA,
    "items": [{"inventory_id": inv["prd_c"]["id"], "quantity": 40},
              {"inventory_id": inv["con_b"]["id"], "quantity": 300}],
    "notes": "Branch replenishment"})
POST(f"/api/warehouses/transfers/{_t1['id']}/dispatch")
POST(f"/api/warehouses/transfers/{_t1['id']}/receive", {"note": "Received in full"})

# In transit: Main → Gamma
_t2 = POST("/api/warehouses/transfers/", {
    "from_warehouse_id": WH_MAIN, "to_warehouse_id": WH_GAMMA,
    "items": [{"inventory_id": inv["mat_a"]["id"], "quantity": 200}],
    "notes": "Production floor staging"})
POST(f"/api/warehouses/transfers/{_t2['id']}/dispatch")

# Draft
POST("/api/warehouses/transfers/", {
    "from_warehouse_id": WH_MAIN, "to_warehouse_id": WH_BETA,
    "items": [{"inventory_id": inv["prd_b"]["id"], "quantity": 15}],
    "notes": "Planned — not yet dispatched"})

# Cancelled
_t4 = POST("/api/warehouses/transfers/", {
    "from_warehouse_id": WH_MAIN, "to_warehouse_id": WH_GAMMA,
    "items": [{"inventory_id": inv["mat_c"]["id"], "quantity": 20}],
    "notes": "Raised in error"})
POST(f"/api/warehouses/transfers/{_t4['id']}/cancel", {"reason": "Duplicate request"})
print("  +4 transfers: Completed / In Transit / Draft / Cancelled")


# ════════════════════════════════════════════════════════════════════════════
# 16. Fixed assets + catch-up depreciation
# ════════════════════════════════════════════════════════════════════════════
header("Fixed assets")
assets_seed = [
    {"name": "Vehicle A", "category": "Vehicles", "supplier_id": SUP_B,
     "acquisition_cost": 12000, "acquisition_date": days_ago(COMPANY_START_DAYS),
     "in_service_date": days_ago(COMPANY_START_DAYS - 5), "depreciation_method": "straight_line",
     "useful_life_months": 60, "salvage_value": 1500},
    {"name": "Equipment A", "category": "Computers", "supplier_id": SUP_D,
     "acquisition_cost": 4800, "acquisition_date": days_ago(420),
     "in_service_date": days_ago(420), "depreciation_method": "straight_line",
     "useful_life_months": 36, "salvage_value": 200},
    {"name": "Equipment B", "category": "Machinery", "supplier_id": SUP_B,
     "acquisition_cost": 15500, "acquisition_date": days_ago(300),
     "in_service_date": days_ago(300), "depreciation_method": "straight_line",
     "useful_life_months": 84, "salvage_value": 1000},
    {"name": "Equipment C", "category": "Machinery",
     "acquisition_cost": 6400, "acquisition_date": days_ago(150),
     "in_service_date": days_ago(150), "depreciation_method": "straight_line",
     "useful_life_months": 60, "salvage_value": 400},
    {"name": "Fixtures A", "category": "Furniture",
     "acquisition_cost": 2200, "acquisition_date": days_ago(90),
     "in_service_date": days_ago(90), "depreciation_method": "straight_line",
     "useful_life_months": 60, "salvage_value": 100},
    # Land/building — depreciation_method=none means no monthly charge.
    {"name": "Facility A", "category": "Buildings",
     "acquisition_cost": 80000, "acquisition_date": days_ago(COMPANY_START_DAYS),
     "in_service_date": days_ago(COMPANY_START_DAYS), "depreciation_method": "none",
     "useful_life_months": 0},
]
_asset_capex = []      # (date, name, cost) → capitalisation entries posted below
for a in assets_seed:
    POST("/api/assets", a)
    _asset_capex.append((a["acquisition_date"], a["name"], a["acquisition_cost"]))
_dep = POST("/api/assets/depreciation/run", {"period": _month})
print(f"  +{len(assets_seed)} assets; depreciation posted for "
      f"{_dep.get('total_periods', 0)} period(s)")


# ════════════════════════════════════════════════════════════════════════════
# 17. Cash — second drawer + reconciliations (one with a variance)
# ════════════════════════════════════════════════════════════════════════════
header("Cash")
POST("/api/cash/drawers", {"name": "Drawer Beta — Back Office",
                           "is_active": True, "auto_capture": False})
_drawers  = GET("/api/cash/drawers")
main_till = next(d for d in _drawers if d["auto_capture"])

for day_off, counted, note in [
    (1,  200, "Balanced close"),
    (2,  188, "Short by 12 — under investigation"),
    (3,  200, "Balanced close"),
    (6,  205, "Over by 5 — rounding"),
]:
    rec = POST("/api/cash/reconciliations",
               {"drawer_id": main_till["id"], "business_date": days_ago(day_off),
                "opening_balance": 200})
    POST(f"/api/cash/reconciliations/{rec['id']}/close",
         {"counted_cash": counted, "counted_cash_lbp": 0, "note": note})
print("  +1 drawer; 4 reconciliations closed (2 balanced, 1 short, 1 over)")


# ════════════════════════════════════════════════════════════════════════════
# 18. CRM — leads, deals, contacts, activities
# ════════════════════════════════════════════════════════════════════════════
header("CRM")
leads_seed = [
    ("Lead A", "Prospect Alpha", "referral",  "Qualified",  70, 4500, None),
    ("Lead B", "Prospect Beta",  "web",       "New",        30, 1200, None),
    ("Lead C", "Prospect Gamma", "cold_call", "Contacted",  45, 3300, None),
    ("Lead D", "Prospect Delta", "social",    "Proposal",   80, 9500, None),
    ("Lead E", "Prospect Epsilon", "referral","Won",        95, 6000, None),
    ("Lead F", "Prospect Zeta",  "web",       "Lost",       15,  800, "Chose another vendor"),
    ("Lead G", "Prospect Eta",   "referral",  "Contacted",  55, 2600, None),
    ("Lead H", "Prospect Theta", "web",       "Negotiation", 85, 12000, None),
]
lead_ids = []
for name, company, source, status, score, value, notes in leads_seed:
    body = {"name": name, "company": company, "source": source, "status": status,
            "score": score, "estimated_value": value,
            "phone": f"+1 555 03{len(lead_ids):02d}",
            "email": f"{name.replace(' ', '.').lower()}@prospect.example"}
    if notes:
        body["notes"] = notes
    lead_ids.append(POST("/api/crm/leads", body)["id"])

deals_seed = [
    ("Deal Alpha",   "Alpha",   "Proposal",      6000,  60),
    ("Deal Beta",    "Gamma",   "Negotiation",   7500,  80),
    ("Deal Gamma",   "Beta",    "Qualification", 3200,  30),
    ("Deal Delta",   "Delta",   "Won",           9000, 100),
    ("Deal Epsilon", "Epsilon", "Lost",          2400,   0),
]
for title, cl_key, stage, value, prob in deals_seed:
    POST("/api/crm/deals", {"title": title, "client_id": CL[cl_key],
                            "stage": stage, "value": value, "probability": prob})

contacts_seed = [
    {"client_id": CL["Alpha"],  "name": "Contact Alpha", "title": "Operations Manager",
     "email": "ops@client-alpha.example", "phone": "+1 555 0400", "is_primary": True},
    {"client_id": CL["Beta"],   "name": "Contact Beta",  "title": "Logistics Lead",
     "email": "logistics@client-beta.example", "phone": "+1 555 0401"},
    {"client_id": CL["Gamma"],  "name": "Contact Gamma", "title": "Partner",
     "email": "partner@client-gamma.example", "phone": "+1 555 0402"},
    {"client_id": CL["Delta"],  "name": "Contact Delta", "title": "Purchasing Director",
     "email": "purchasing@client-delta.example", "phone": "+1 555 0403"},
    {"lead_id":   lead_ids[0],  "name": "Contact Epsilon", "title": "Operations",
     "email": "ops@prospect-alpha.example"},
]
for c in contacts_seed:
    POST("/api/crm/contacts", c)

activities_seed = [
    {"type": "call",    "subject": "Follow-up call",     "lead_id": lead_ids[1],
     "due_date": days_ahead(2)},
    {"type": "meeting", "subject": "Site visit",         "client_id": CL["Delta"],
     "due_date": days_ahead(7)},
    {"type": "email",   "subject": "Send revised quote", "client_id": CL["Gamma"],
     "due_date": days_ahead(1)},
    {"type": "task",    "subject": "Prepare proposal",   "lead_id": lead_ids[3],
     "due_date": days_ahead(4)},
    {"type": "note",    "subject": "Budget confirmed",   "lead_id": lead_ids[7],
     "due_date": days_ago(2)},
]
for a in activities_seed:
    POST("/api/crm/activities", a)
print(f"  +{len(leads_seed)} leads, +{len(deals_seed)} deals, "
      f"+{len(contacts_seed)} contacts, +{len(activities_seed)} activities")


# ════════════════════════════════════════════════════════════════════════════
# 19. Planning — plans, tasks, milestones, calendar events
# ════════════════════════════════════════════════════════════════════════════
header("Planning")
plan_a = POST("/api/planning/projects", {
    "name": "Plan Alpha", "client_id": CL["Alpha"],
    "start_date": days_ago(30), "end_date": days_ahead(15), "status": "Active"})
plan_b = POST("/api/planning/projects", {
    "name": "Plan Beta", "client_id": CL["Gamma"],
    "start_date": days_ahead(7), "end_date": days_ahead(60), "status": "Active"})
plan_c = POST("/api/planning/projects", {
    "name": "Plan Gamma", "client_id": CL["Zeta"],
    "start_date": days_ago(80), "end_date": days_ago(10), "status": "Completed"})

task_seed = [
    (plan_a, "Task A1 — Site survey",     "Done",        "High",   -30, -25, 100),
    (plan_a, "Task A2 — Design sign-off", "Done",        "High",   -24, -15, 100),
    (plan_a, "Task A3 — Installation",    "In Progress", "Medium",  -5,   2,  40),
    (plan_a, "Task A4 — Finishing",       "To Do",       "Medium",   3,  10,   0),
    (plan_a, "Task A5 — Walkthrough",     "To Do",       "Low",     12,  14,   0),
    (plan_b, "Task B1 — Measurements",    "To Do",       "Medium",   7,   9,   0),
    (plan_b, "Task B2 — Place orders",    "To Do",       "High",    10,  14,   0),
    (plan_b, "Task B3 — Install week",    "To Do",       "High",    20,  27,   0),
    (plan_c, "Task C1 — Delivery",        "Done",        "High",   -80, -60, 100),
    (plan_c, "Task C2 — Handover",        "Done",        "Medium", -20, -10, 100),
]
for plan, name, status, prio, sd, ed, prog in task_seed:
    POST("/api/planning/tasks", {
        "project_id": plan["id"], "name": name, "status": status, "priority": prio,
        "start_date": days_ahead(sd) if sd >= 0 else days_ago(-sd),
        "end_date":   days_ahead(ed) if ed >= 0 else days_ago(-ed),
        "progress": prog})

for pid, name, due in [
    (plan_a["id"], "Milestone A1 — Design approved",  days_ago(15)),
    (plan_a["id"], "Milestone A2 — Install complete", days_ahead(2)),
    (plan_a["id"], "Milestone A3 — Handover",         days_ahead(14)),
    (plan_b["id"], "Milestone B1 — Measurements done", days_ahead(9)),
    (plan_b["id"], "Milestone B2 — Install complete",  days_ahead(27)),
]:
    POST("/api/planning/milestones", {"project_id": pid, "name": name, "due_date": due})

for eb in [
    {"title": "Weekly team standup", "start_date": days_ahead(1),
     "all_day": 0, "start_time": "09:00", "end_time": "09:30"},
    {"title": "Site walkthrough", "start_date": days_ahead(3), "all_day": 0,
     "start_time": "14:00", "end_time": "15:30", "description": "Review progress"},
    {"title": "Supplier review", "start_date": days_ahead(8), "all_day": 1,
     "color": "#f5a623"},
    {"title": "Quarterly planning", "start_date": days_ahead(21), "all_day": 1,
     "color": "#4a90d9"},
]:
    POST("/api/planning/events", eb)
print(f"  +3 plans, {len(task_seed)} tasks, 5 milestones, 4 events")


# ════════════════════════════════════════════════════════════════════════════
# 20. HR — departments, employees, leave, contracts, payroll, attendance
# ════════════════════════════════════════════════════════════════════════════
header("HR")
dept_ops   = POST("/api/hr/departments", {"name": "Department Alpha", "description": "Operations"})
dept_sales = POST("/api/hr/departments", {"name": "Department Beta",  "description": "Sales & CRM"})
dept_admin = POST("/api/hr/departments", {"name": "Department Gamma", "description": "Admin & Finance"})

employees_seed = [
    ("Employee A", "Technician",        dept_ops,   "Full-time", COMPANY_START_DAYS, 1200),
    ("Employee B", "Assistant",         dept_ops,   "Part-time", 120,  700),
    ("Employee C", "Sales Manager",     dept_sales, "Full-time", 450, 1800),
    ("Employee D", "Account Executive", dept_sales, "Full-time", 180, 1100),
    ("Employee E", "Bookkeeper",        dept_admin, "Full-time", COMPANY_START_DAYS, 1500),
    ("Employee F", "Office Lead",       dept_admin, "Full-time", 540, 1400),
    ("Employee G", "Technician",        dept_ops,   "Full-time", 260, 1150),
    ("Employee H", "Coordinator",       dept_ops,   "Contract",   95,  950),
    ("Employee I", "Analyst",           dept_admin, "Full-time", 330, 1300),
]
emp_ids = []
for name, title, dept, etype, hired_days, salary in employees_seed:
    emp_ids.append(POST("/api/hr/employees", {
        "full_name": name, "job_title": title, "department_id": dept["id"],
        "employment_type": etype, "hire_date": days_ago(hired_days),
        "salary": salary,
        "email": f"{name.replace(' ', '.').lower()}@company.example"})["id"])

# Leave: one finished, one active now, one pending
_past = POST("/api/hr/leave", {"employee_id": emp_ids[1], "leave_type": "Annual",
                               "start_date": days_ago(14), "end_date": days_ago(8),
                               "reason": "Annual leave"})
POST(f"/api/hr/leave/{_past['id']}/approve", {"note": ""})
_active = POST("/api/hr/leave", {"employee_id": emp_ids[3], "leave_type": "Sick",
                                 "start_date": days_ago(1), "end_date": days_ahead(4),
                                 "reason": "Medical"})
POST(f"/api/hr/leave/{_active['id']}/approve", {"note": "Approved"})
POST("/api/hr/leave", {"employee_id": emp_ids[2], "leave_type": "Annual",
                       "start_date": days_ahead(20), "end_date": days_ahead(27),
                       "reason": "Planned holiday"})

# Contracts
for eid, ctype, title, start_days, salary in [
    (emp_ids[0], "Permanent",  "Technician",    COMPANY_START_DAYS, 1200),
    (emp_ids[2], "Permanent",  "Sales Manager", 450, 1800),
    (emp_ids[4], "Permanent",  "Bookkeeper",    COMPANY_START_DAYS, 1500),
    (emp_ids[1], "Fixed-term", "Assistant",     120,  700),
    (emp_ids[6], "Permanent",  "Technician",    260, 1150),
]:
    c = POST("/api/hr/contracts/", {
        "employee_id": eid, "contract_type": ctype, "status": "Draft",
        "start_date": days_ago(start_days), "job_title": title, "salary": salary,
        "weekly_hours": 40 if ctype == "Permanent" else 24,
        "work_schedule": "Mon–Fri 09:00–17:00"})
    POST(f"/api/hr/contracts/{c['id']}/status", {"status": "Active"})

# Attendance — the last 12 working days for every employee
_att_rows = 0
for back in range(1, 17):
    d = _TODAY - timedelta(days=back)
    if d.weekday() >= 5:           # skip weekends
        continue
    for i, eid in enumerate(emp_ids):
        roll = random.random()
        if roll < 0.86:
            status, hours = "Present", 8
        elif roll < 0.92:
            status, hours = "Late", 7.5
        elif roll < 0.96:
            status, hours = "Half-day", 4
        else:
            status, hours = "Absent", 0
        POST("/api/hr/attendance", {
            "employee_id": eid, "date": d.strftime("%Y-%m-%d"),
            "status": status, "hours": hours})
        _att_rows += 1

# Payroll — one paid run, one draft
_run = POST("/api/hr/payroll/runs", {"period_start": days_ago(31),
                                     "period_end": days_ago(1),
                                     "notes": "Current period"})
POST(f"/api/hr/payroll/runs/{_run['id']}/approve")
_paid = POST(f"/api/hr/payroll/runs/{_run['id']}/mark-paid")
POST("/api/hr/payroll/runs", {"period_start": days_ago(61), "period_end": days_ago(32),
                              "notes": "Prior period — draft"})

for a in [
    {"activity_type": "Meeting", "subject": "1:1 — Employee A",
     "scheduled_at": days_ahead(2) + " 10:00", "duration_min": 30,
     "employee_id": emp_ids[0], "reminder_minutes_before": 30},
    {"activity_type": "Interview", "subject": "Panel — Position Beta",
     "scheduled_at": days_ahead(4) + " 11:00", "duration_min": 60,
     "reminder_minutes_before": 60},
    {"activity_type": "Note", "subject": "Update handbook",
     "scheduled_at": days_ahead(6) + " 09:00", "duration_min": 0,
     "reminder_minutes_before": 0},
]:
    POST("/api/hr-activities", a)

print(f"  +3 departments, {len(emp_ids)} employees, 5 contracts, 3 leave records")
print(f"  +{_att_rows} attendance rows, 1 paid payroll run + 1 draft, 3 HR activities")


# ════════════════════════════════════════════════════════════════════════════
# 21. Recruitment — positions → applicants → interviews → offer → hire
# ════════════════════════════════════════════════════════════════════════════
header("Recruitment")
pos_a = POST("/api/recruitment/positions", {
    "title": "Position Alpha — Technician", "department_id": dept_ops["id"],
    "employment_type": "Full-time", "headcount": 2, "status": "Open",
    "location": "Main site", "salary_min": 800, "salary_max": 1200,
    "description": "Hands-on production role.",
    "requirements": "1+ year relevant experience."})
pos_b = POST("/api/recruitment/positions", {
    "title": "Position Beta — Sales Associate", "department_id": dept_sales["id"],
    "employment_type": "Full-time", "headcount": 1, "status": "Open",
    "salary_min": 900, "salary_max": 1300})
pos_c = POST("/api/recruitment/positions", {
    "title": "Position Gamma — Junior Accountant", "department_id": dept_admin["id"],
    "employment_type": "Full-time", "headcount": 1, "status": "On Hold",
    "salary_min": 1000, "salary_max": 1400})
POST("/api/recruitment/positions", {
    "title": "Position Delta — Seasonal Support", "department_id": dept_ops["id"],
    "employment_type": "Contract", "headcount": 3, "status": "Open"})


def _applicant(name, pos_id, stages, *, rating=None, salary=None, source="Website"):
    body = {"full_name": name, "position_id": pos_id, "source": source,
            "email": f"{name.replace(' ', '.').lower()}@applicant.example",
            "phone": "+1 555 05" + name[-1:].rjust(2, "0")}
    if rating:
        body["rating"] = rating
    if salary:
        body["expected_salary"] = salary
    app = POST("/api/recruitment/applicants", body)
    for st in stages:
        POST(f"/api/recruitment/applicants/{app['id']}/status", {"new_status": st})
    return app


app_hire = _applicant("Applicant A", pos_a["id"], ["Screening", "Interview"],
                      rating=5, salary=1050, source="Referral")
POST(f"/api/recruitment/applicants/{app_hire['id']}/interviews", {
    "interview_type": "Phone", "scheduled_at": days_ago(10) + " 10:00",
    "duration_min": 45, "status": "Completed", "score": 8, "decision": "Hire",
    "notes": "Strong background."})
POST(f"/api/recruitment/applicants/{app_hire['id']}/interviews", {
    "interview_type": "On-site", "scheduled_at": days_ago(6) + " 14:00",
    "duration_min": 90, "status": "Completed", "score": 9, "decision": "Strong hire",
    "notes": "Excellent practical test."})
_offer = POST(f"/api/recruitment/applicants/{app_hire['id']}/offers", {
    "contract_type": "Permanent", "job_title": "Technician",
    "department_id": dept_ops["id"], "start_date": days_ahead(14),
    "salary": 1050, "salary_currency": "USD", "payment_schedule": "Monthly",
    "probation_months": 3, "weekly_hours": 40, "annual_leave_days": 15})
POST(f"/api/recruitment/offers/{_offer['id']}/status", {"status": "Sent"})
POST(f"/api/recruitment/offers/{_offer['id']}/status", {"status": "Accepted"})
POST(f"/api/recruitment/applicants/{app_hire['id']}/status",
     {"new_status": "Accepted", "reason": "Top candidate — offer accepted."})
POST(f"/api/recruitment/applicants/{app_hire['id']}/convert", {
    "accepted_offer_id": _offer["id"], "department_id": dept_ops["id"],
    "job_title": "Technician", "salary": 1050, "hire_date": days_ahead(14)})

_applicant("Applicant B", pos_a["id"], ["Screening"], rating=3, salary=950)
_applicant("Applicant C", pos_b["id"], ["Screening", "Interview"], rating=4,
           salary=1100, source="Referral")
_applicant("Applicant D", pos_b["id"], ["Screening", "Interview", "Technical Test"],
           rating=4, salary=1200)
_applicant("Applicant E", pos_c["id"], ["Screening"], rating=2, salary=1000)
_applicant("Applicant F", pos_a["id"], ["Screening", "Rejected"], rating=2,
           source="Walk-in")
print("  +4 positions, 6 applicants (1 hired → employee), interviews + offer")


# ════════════════════════════════════════════════════════════════════════════
# 22. Announcements
# ════════════════════════════════════════════════════════════════════════════
header("Announcements")
POST("/api/announcements/", {
    "title": "Welcome to the ERP system",
    "body": "All teams are now live on the new system. Please review your module "
            "access and report any issues to the administrator.",
    "priority": "high", "audience_type": "all", "requires_ack": True, "pinned": True})
POST("/api/announcements/", {
    "title": "Quarterly inventory count",
    "body": "A full stock count is scheduled for the first of next month. "
            "Please freeze non-urgent stock movements the evening before.",
    "priority": "medium", "audience_type": "all", "requires_ack": False})
POST("/api/announcements/", {
    "title": "Upcoming public holiday",
    "body": "Offices will be closed for the public holiday. Point of sale and "
            "online orders continue as normal.",
    "priority": "low", "audience_type": "all", "expires_at": days_ahead(30)})
print("  +3 announcements (1 pinned, acknowledgement required)")


# ════════════════════════════════════════════════════════════════════════════
# 23. Accounting — custom GL accounts + a set of manual journal entries
#     spread across the whole history window
# ════════════════════════════════════════════════════════════════════════════
header("Accounting — accounts & manual entries")
# One extra account so financing has a proper home. 1300 Prepaid Expenses is
# no longer created here — it ships in the chart now that recurring costs
# spanning several months are held there and released monthly.
for code, name, atype, subtype in [
    ("2300", "Bank Loan",        "Liability", "Long-term Liability"),
]:
    r = client.post("/api/accounting/accounts",
                    json={"code": code, "name": name, "type": atype, "subtype": subtype})
    if r.status_code not in (200, 201):
        print(f"  ! account {code} not created: {r.status_code} {r.text[:80]}")

ACCT = {a["code"]: a["id"] for a in GET("/api/accounting/accounts")}


def JE(date: str, memo: str, lines: list[tuple[str, float, float]]):
    """lines = [(account_code, debit, credit)] — skipped if a code is missing."""
    if any(c not in ACCT for c, _, _ in lines):
        return None
    body = {"entry_date": date, "memo": memo, "lines": [
        {"account_id": ACCT[c], **({"debit": d} if d else {"credit": cr})}
        for c, d, cr in lines]}
    return POST("/api/accounting/journal-entries", body)


_y0, _m0 = months_back(HISTORY_MONTHS - 1)          # oldest month in the window
_je_count = 0

# Capitalise the fixed assets. The assets module posts monthly depreciation but
# not the original purchase, so without these the balance sheet would carry
# accumulated depreciation with no gross asset behind it — and the cash-flow
# statement would show no investing activity at all.
for _d, _n, _c in _asset_capex:
    _je_count += 1 if JE(_d, f"Purchase of {_n}",
                         [("1500", _c, 0), ("1000", 0, _c)]) else 0

# Opening capital + financing
_je_count += 1 if JE(dstr(_y0, _m0, 2), "Owner capital injection",
                     [("1000", 60000, 0), ("3000", 0, 60000)]) else 0
_je_count += 1 if JE(dstr(_y0, _m0, 5), "Bank loan drawdown",
                     [("1000", 40000, 0), ("2300", 0, 40000)]) else 0

# Quarterly loan repayments (principal only, for a clean demo)
for q in range(1, 6):
    yq, mq = months_back(HISTORY_MONTHS - 1 - q * 3)
    _je_count += 1 if JE(dstr(yq, mq, 5), f"Bank loan repayment {q}",
                         [("2300", 2500, 0), ("1000", 0, 2500)]) else 0

# Prepaid insurance paid up front, then amortised monthly
_je_count += 1 if JE(dstr(_y0, _m0, 8), "Annual insurance paid in advance",
                     [("1300", 3600, 0), ("1000", 0, 3600)]) else 0
for k in range(1, 13):
    yk, mk = months_back(HISTORY_MONTHS - 1 - k)
    _je_count += 1 if JE(dstr(yk, mk, 28), "Insurance amortisation",
                         [("6850", 300, 0), ("1300", 0, 300)]) else 0

# Accrued utilities at a quarter end, reversed the following month
_ya, _ma = months_back(6)
_yb, _mb = months_back(5)
_je_count += 1 if JE(dstr(_ya, _ma, 30), "Accrue unbilled utilities",
                     [("6200", 480, 0), ("2000", 0, 480)]) else 0
_je_count += 1 if JE(dstr(_yb, _mb, 1), "Reverse utilities accrual",
                     [("2000", 480, 0), ("6200", 0, 480)]) else 0

# Bank charges, other income and FX movements sprinkled through the window
for k in (14, 11, 8, 5, 2):
    yk, mk = months_back(k)
    _je_count += 1 if JE(dstr(yk, mk, 26), "Bank charges",
                         [("6900", 45, 0), ("1000", 0, 45)]) else 0
for k, amt in ((12, 900), (7, 1250), (3, 640)):
    yk, mk = months_back(k)
    _je_count += 1 if JE(dstr(yk, mk, 18), "Other income — scrap and rebates",
                         [("1000", amt, 0), ("4900", 0, amt)]) else 0
_yf, _mf = months_back(9)
_je_count += 1 if JE(dstr(_yf, _mf, 22), "Foreign exchange gain on settlement",
                     [("1000", 380, 0), ("4910", 0, 380)]) else 0
_yg, _mg = months_back(4)
_je_count += 1 if JE(dstr(_yg, _mg, 22), "Foreign exchange loss on settlement",
                     [("6920", 260, 0), ("1000", 0, 260)]) else 0

# Owner drawings
for k, amt in ((10, 3000), (4, 2500)):
    yk, mk = months_back(k)
    _je_count += 1 if JE(dstr(yk, mk, 27), "Owner drawings",
                         [("3000", amt, 0), ("1000", 0, amt)]) else 0

print(f"  +2 custom accounts; +{_je_count} manual journal entries across the window")


# ════════════════════════════════════════════════════════════════════════════
# 24. Approval policies (+ one live pending request)
# ════════════════════════════════════════════════════════════════════════════
header("Approvals")
POST("/api/approval-policies/", {
    "name":            "Large expense review",
    "description":     "Any expense over $1,000 must be approved by Finance",
    "module":          "expense", "trigger_action": "create",
    "condition_logic": "AND",
    "conditions":      [{"field": "amount", "op": ">", "value": "1000"}],
    "approval_type":   "single", "approver_roles": ["Finance Manager"],
    "priority":        10, "is_active": True})
POST("/api/approval-policies/", {
    "name":            "Capital expenditure over $5k",
    "description":     "Fixed asset purchases above $5k need Finance approval",
    "module":          "fixed_asset", "trigger_action": "create",
    "condition_logic": "AND",
    "conditions":      [{"field": "acquisition_cost", "op": ">", "value": "5000"}],
    "approval_type":   "single", "approver_roles": ["Finance Manager"],
    "priority":        10, "is_active": True})
print("  +2 policies (expense + fixed asset)")


# ════════════════════════════════════════════════════════════════════════════
# 24b. Remaining module coverage — dual currency, product attributes, cash
#      movements, saved documents, announcement engagement, warehouse access
# ════════════════════════════════════════════════════════════════════════════
header("Module coverage extras")

# Dual-currency display: a manual USD→secondary rate powers <DualMoney> and the
# LBP tender path in POS / payments.
POST("/api/settings/exchange-rate", {"rate": 89500, "note": "Opening reference rate"})

# Attribute definitions + one variant product, so the Product Builder and the
# "Inventory by Attribute" report have real data behind them.
for _d in [
    {"scope_type": "global", "name": "Colour", "input_type": "enum",
     "options": ["Black", "White", "Grey"], "is_variant_axis": True, "sort_order": 1},
    {"scope_type": "global", "name": "Size", "input_type": "enum",
     "options": ["Small", "Medium", "Large"], "is_variant_axis": True, "sort_order": 2},
    {"scope_type": "global", "name": "Finish", "input_type": "text",
     "is_variant_axis": False, "sort_order": 3},
]:
    r = client.post("/api/products/attribute-defs", json=_d)
    if r.status_code not in (200, 201):
        print(f"  ! attribute def {_d['name']}: {r.status_code} {r.text[:70]}")

_prod = client.post("/api/products/", json={
    "name": "Product Theta", "category": "Finished Goods", "product_type": "finished",
    "unit": "pcs", "unit_cost": 24, "sale_price": 68, "min_stock": 5,
    "initial_quantity": 12,
    "axes": [{"name": "Colour", "values": ["Black", "White"]},
             {"name": "Size",   "values": ["Small", "Large"]}],
    "descriptors": {"Finish": "Matte"}})
_variants = 0
if _prod.status_code in (200, 201):
    _variants = _prod.json().get("variant_count") or len(_prod.json().get("variants") or [])
else:
    print(f"  ! product builder: {_prod.status_code} {_prod.text[:90]}")

# Cash in/out movements on an open reconciliation (petty-cash style activity).
_rec_open = POST("/api/cash/reconciliations",
                 {"drawer_id": main_till["id"], "business_date": days_ago(0),
                  "opening_balance": 200})
for _mv in [
    {"direction": "in",  "currency": "USD", "amount": 150, "category": "Sales",
     "description": "Counter takings"},
    {"direction": "out", "currency": "USD", "amount": 40,  "category": "Supplies",
     "description": "Office supplies"},
    {"direction": "out", "currency": "USD", "amount": 25,  "category": "Transport",
     "description": "Courier"},
]:
    POST(f"/api/cash/reconciliations/{_rec_open['id']}/movements", _mv)

# A saved/rendered document against an invoice.
POST("/api/documents/", {
    "record_type": "invoice", "record_id": inv_paid_id, "client_id": CL["Beta"],
    "title": "Invoice — Client Beta", "html_content":
        "<h1>Invoice</h1><p>Client Beta — consulting services.</p>"})

# Announcement engagement: acknowledge the pinned notice and leave a comment.
_anns = GET("/api/announcements/")
_ann_rows = _anns if isinstance(_anns, list) else _anns.get("items", [])
if _ann_rows:
    _aid = _ann_rows[0]["id"]
    client.post(f"/api/announcements/{_aid}/acknowledge", json={})
    client.post(f"/api/announcements/{_aid}/comments",
                json={"body": "Acknowledged — thanks for the update."})

# Warehouse access grant, so the Warehouses → Access tab is not empty.
_uid = next((u["id"] for u in GET("/api/users/")
             if u.get("username") == "u_inventory"), None)
if _uid:
    client.post(f"/api/warehouses/{WH_BETA}/access", json={"user_id": _uid})

print(f"  exchange rate set; 3 attribute defs (+{_variants} product variants); "
      "3 cash movements; 1 document; announcement ack + comment; 1 access grant")


# ════════════════════════════════════════════════════════════════════════════
# 25. Attachments — files on clients / projects / invoices / suppliers
# ════════════════════════════════════════════════════════════════════════════
header("Attachments")


def _attach(entity_type, entity_id, fname, content, ctype):
    r = client.post(f"/api/attachments/{entity_type}/{entity_id}",
                    files={"file": (fname, content, ctype)})
    return 1 if r.status_code in (200, 201) else 0


_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF")
_att = 0
_att += _attach("clients", CL["Alpha"], "onboarding-brief.txt",
                b"Client Alpha onboarding brief.\nPreferred contact: email.\n", "text/plain")
_att += _attach("projects", PRJ["Alpha"], "site-measurements.csv",
                b"area,width,length\nzone-a,3.2,1.1\nzone-b,6.0,4.5\n", "text/csv")
_att += _attach("invoices", inv_paid_id, "signed-invoice.pdf", _PDF, "application/pdf")
_att += _attach("suppliers", SUP_A, "price-list.txt",
                b"Material Alpha 4.00/pcs\nMaterial Beta 0.05/pcs\n", "text/plain")
print(f"  +{_att} attachments across clients / projects / invoices / suppliers")


# ════════════════════════════════════════════════════════════════════════════
# 26. HISTORICAL BACKFILL — 18 months of collected revenue + operating cost
#
# WHY a post-seed SQL date-shift is needed (and why it is safe):
#   • Payments stamp `paid_at = now()` server-side (routers/invoices.py), so the
#     API offers no way to back-date the cash-basis revenue that drives every
#     revenue trend. Expenses DO accept an explicit `date` (and auto-date their
#     own GL entry from it), so historical COSTS need no SQL at all.
#   • For revenue we therefore create the invoices + payments through the API —
#     so every ledger, tax and audit side-effect is real — then move three date
#     columns in lockstep per invoice: invoice_payments.paid_at, the invoice's
#     created_at, and the payment's revenue journal entry (located by
#     source_type='invoice_payment' + source_id).
#   • Only DATES move, never amounts, so the trial balance stays balanced and
#     the accrual income statement matches the cash-basis finance view month by
#     month.
#
# The model targets a realistic small-business shape: revenue grows steadily
# with a mild seasonal swing, costs are dominated by materials (COGS) plus a
# fixed payroll/rent/utilities base, and every month lands in a believable
# 12–20% net margin band. A few invoices are deliberately left unpaid so the
# receivables aging report has real 30/60/90-day buckets.
# ════════════════════════════════════════════════════════════════════════════
header(f"Historical backfill ({HISTORY_MONTHS}-month trend)")

# The "expense > $1,000" policy above would trap every historical Materials /
# Salary / Rent line in pending-approval so it never reaches the ledger,
# leaving the income statement showing revenue with almost no cost. Suspend
# active policies for the backfill, then restore them afterwards.
_suspended = [p["id"] for p in GET("/api/approval-policies/") if p.get("is_active")]
for _pid in _suspended:
    PATCH(f"/api/approval-policies/{_pid}/toggle")

SALE_LINES = [
    ("Product Alpha",      650, 1200),
    ("Product Beta",       180,  340),
    ("Product Gamma",      120,  260),
    ("Product Zeta",       300,  780),
    ("Component Alpha",    260,  520),
    ("Service package A", 1400, 2600),
    ("Service package B",  900, 1800),
    ("Installation",       150,  480),
    ("Maintenance plan",   380,  520),
    ("Delivery service",    80,  260),
]

_paid_hist:   list[tuple[int, str]] = []   # (invoice_id, paid date)
_unpaid_hist: list[tuple[int, str]] = []   # (invoice_id, issue date)
_rev_total = _cost_total = 0.0


def _hist_invoice(target, tax=TAX_DEFAULT):
    """One invoice worth ≈ target (pre-tax). Returns (invoice_id, gross)."""
    items, remaining = [], target
    n_lines = random.randint(1, 3)
    for li in range(n_lines):
        name, lo, hi = random.choice(SALE_LINES)
        if li == n_lines - 1:
            unit, qty = max(50, round(remaining)), 1
        else:
            unit = round(random.uniform(lo, hi))
            qty  = random.randint(1, 2)
            remaining -= unit * qty
        items.append({"name": name, "quantity": qty, "unit_price": unit,
                      "tax_rate_id": tax})
    cid = random.choice(BUSINESS_CLIENTS if random.random() < 0.75 else CLIENT_IDS)
    iv  = POST("/api/invoices/", {"client_id": cid, "items": items})
    return iv["id"], GET(f"/api/invoices/{iv['id']}")["amount"]


for back in range(HISTORY_MONTHS - 1, -1, -1):
    y, m = months_back(back)
    is_current = (back == 0)
    progress   = (HISTORY_MONTHS - 1 - back) / max(1, HISTORY_MONTHS - 1)

    # Revenue: ~$26k → ~$42k with a mild seasonal swing and month-to-month noise.
    season     = 1.0 + 0.07 * math.sin((m / 12.0) * 2 * math.pi)
    target_rev = (26000 + 16000 * progress) * season * random.uniform(0.95, 1.05)
    # The current month is deliberately partial — collections are still coming in.
    if is_current:
        target_rev *= 0.5

    n_inv   = random.randint(4, 6) if is_current else random.randint(7, 10)
    weights = [random.uniform(0.6, 1.6) for _ in range(n_inv)]
    wsum    = sum(weights)
    month_gross = 0.0

    for k in range(n_inv):
        inv_id, amt = _hist_invoice(target_rev * weights[k] / wsum,
                                    tax=TAX_REDUCED if random.random() < 0.12 else TAX_DEFAULT)
        POST(f"/api/invoices/{inv_id}/payments",
             {"amount": amt,
              "method": random.choice(["Bank Transfer", "Bank Transfer", "Cash", "Card"]),
              "idempotency_key": str(uuid.uuid4())})
        month_gross += amt
        _rev_total  += amt
        if not is_current:      # the current month already sits at "now"
            _paid_hist.append((inv_id, dstr(y, m, random.randint(3, 27))))

    # A couple of unpaid invoices in the recent past → real aging buckets.
    if 1 <= back <= 3:
        u_id, u_amt = _hist_invoice(random.uniform(1200, 2600))
        _unpaid_hist.append((u_id, dstr(y, m, random.randint(5, 20))))

    if is_current:
        continue    # current-month operating costs come from the sections above

    # ── Operating costs, sized off this month's gross revenue ───────────────
    margin = random.uniform(0.13, 0.17) + 0.02 * progress
    costs  = month_gross * (1 - margin)
    util      = random.uniform(360, 520)
    transport = random.uniform(150, 300)
    subs      = random.uniform(200, 380)
    maint     = random.uniform(120, 340)
    payroll, rent = 7700, 1100
    materials = max(month_gross * 0.30,
                    costs - (payroll + rent + util + transport + subs + maint))

    for cat, amount, desc, day, taxed in [
        ("Materials",    materials, "Production materials and supplies",  6, True),
        ("Salary",       payroll,   "Monthly payroll",                   28, False),
        ("Rent",         rent,      "Facility rent",                      1, True),
        ("Utilities",    util,      "Power, water and fuel",              9, True),
        ("Transport",    transport, "Delivery and logistics",            12, False),
        ("Subscription", subs,      "Software and marketing",            15, True),
        ("Maintenance",  maint,     "Equipment servicing",               20, False),
    ]:
        body = {"category": cat, "amount": round(amount, 2), "description": desc,
                "date": dstr(y, m, day), "payment_method": "Bank Transfer"}
        if taxed:
            body["tax_rate_id"] = TAX_DEFAULT
        POST("/api/finance/expenses", body)
    _cost_total += payroll + rent + util + transport + subs + maint + materials

# ── The lockstep date shift (dates only — the books stay balanced) ──────────
with sqlite3.connect(DB_PATH) as _con:
    for inv_id, pay_date in _paid_hist:
        issued = (datetime.strptime(pay_date, "%Y-%m-%d")
                  - timedelta(days=random.randint(2, 12))).strftime("%Y-%m-%d %H:%M:%S")
        _con.execute("UPDATE invoice_payments SET paid_at=? WHERE invoice_id=?",
                     (pay_date + " 12:00:00", inv_id))
        _con.execute("UPDATE invoices SET created_at=? WHERE id=?", (issued, inv_id))
        _con.execute(
            "UPDATE journal_entries SET entry_date=? "
            "WHERE source_type='invoice_payment' AND source_id IN "
            "(SELECT id FROM invoice_payments WHERE invoice_id=?)",
            (pay_date, inv_id))
    # Unpaid historical invoices: shift the issue date and set a 30-day due date
    # that has already passed, so they land in the aging buckets.
    for inv_id, issue_date in _unpaid_hist:
        due = (datetime.strptime(issue_date, "%Y-%m-%d")
               + timedelta(days=30)).strftime("%Y-%m-%d")
        _con.execute("UPDATE invoices SET created_at=?, due_date=? WHERE id=?",
                     (issue_date + " 09:00:00", due, inv_id))
    _con.commit()

# Restore the approval policies suspended for the backfill.
for _pid in _suspended:
    PATCH(f"/api/approval-policies/{_pid}/toggle")

print(f"  +{len(_paid_hist)} back-dated paid invoices across {HISTORY_MONTHS - 1} prior months")
print(f"  +{len(_unpaid_hist)} unpaid invoices feeding the receivables aging buckets")
print(f"  ≈ ${_rev_total:,.0f} collected vs ${_cost_total:,.0f} operating cost "
      f"(net ≈ ${_rev_total - _cost_total:,.0f})")


# ════════════════════════════════════════════════════════════════════════════
# 27. One live pending approval + two locked historical periods
# ════════════════════════════════════════════════════════════════════════════
header("Period close & pending approval")
# Now that the policies are active again, this expense raises a real request.
POST("/api/finance/expenses", {
    "category": "Materials", "amount": 2400, "project_id": PRJ["Gamma"],
    "description": "Bulk order — pending finance review"})

_locked = 0
for back in (HISTORY_MONTHS - 1, HISTORY_MONTHS - 2):
    ly, lm = months_back(back)
    r = client.post(f"/api/finance/periods/{ly}/{lm}/lock", json={})
    _locked += 1 if r.status_code in (200, 201) else 0
print(f"  +1 pending approval request; {_locked} historical period(s) locked")


# ════════════════════════════════════════════════════════════════════════════
_summary = GET("/api/accounting/trial-balance")
_bal = "balanced" if _summary.get("balanced") else "OUT OF BALANCE"
print()
print(f"✓  Database seeded at {DB_PATH}")
print(f"   Ledger: {_bal}")
print(f"   Admin login:     admin / {ADMIN_PASSWORD}  (superadmin)")
print(f"   Per-role logins: u_<role> / {ROLE_PASSWORD}  (e.g. u_finance_manager)")
print()
print("   Try the UI tour:")
print("   • Dashboard            — KPIs and an 18-month revenue trend")
print("   • Finance / Reports    — P&L, VAT by rate, aging, expense mix")
print("   • Accounting → Ledger  — manual entries, loan, prepayments, FX")
print("   • Accounting → Closing — two locked historical periods")
print("   • Invoices             — every payment state including voided")
print("   • Warehouses           — transfers in every status")
print("   • Manufacturing        — QC batch, lots, partial completion")
print("   • Service              — equipment history, jobs in every state, one unbilled")
print("   • HR                   — contracts, payroll, leave, attendance")
print("   • Recruitment          — pipeline from applicant to hired employee")
print("   • Approvals            — one request pending finance review")
