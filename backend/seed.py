#!/usr/bin/env python3
"""
seed.py — populate a fresh ERP database with rich, varied demo data
that exercises every screen, state, and KPI in the system.

What you get (richer than the minimal version)
----------------------------------------------
    Login          admin / Admin123!  (superadmin)
    Tax            VAT 11% (default) + Reduced 5% + Zero-rated; engine ON
    Clients        8 — mix of business + private, each with a phone so the
                       WhatsApp share button is usable everywhere
    Suppliers      4 — different payment terms + contacts
    Inventory      12 — raw / semi-finished / finished / consumable, with
                       several low-stock and out-of-stock states
    Projects       4 — Inquiry / Active / Completed / On Hold
    Quotations     4 — Draft / Sent / Accepted (converted) / Rejected
    Invoices       6 — Paid / Partial / Unpaid / Overdue / Voided
                       plus the one materialised from the accepted quote
    Purchases      5 — Ordered / Received / Paid; tax recorded; the Paid
                       ones automatically posted matching expenses
    Expenses       10 — Materials / Labour / Utilities / Rent / Salary /
                       Subscription / Transport / Insurance / Permits /
                       Other; some VAT-tagged, some project-linked
    Recurring      3 — Office Rent (monthly), Internet (quarterly),
                       Software (annual); each back-posted
    POS            open session + 5 sales (cash USD, cash LBP, card, mixed),
                   1 returned sale (re-stocks + voids invoice)
    Manufacturing  2 BOMs (one versioned twice) + 3 production orders
                   across Draft / In Progress / Completed states
    Fixed Assets   4 — Van / Computers / Furniture / Building; one already
                   depreciated to current period, one disposed
    Cash           Main Till + 1 secondary drawer; 2 closed reconciliations
                   (one with a deliberate variance to demo the notification)
    CRM            6 leads (New / Contacted / Qualified / Won / Lost),
                   4 deals (across all stages), 5 contacts, 3 activities
    Planning       2 projects + 8 tasks spread across statuses
    HR             3 departments, 6 employees, 1 active leave, 1 past leave
    Approvals      2 policies (Expense > $1k → Finance, Fixed Asset > $5k
                   → Finance); plus 1 pending request triggered by a
                   large expense
    Notifications  fired by inventory low_stock, POS sales, production
                   completion, depreciation run, cash variance, approval
                   creation — the bell will show ~8 unread on first login
    History        12 months of collected revenue + operating costs so every
                   trend chart reads like a real, growing SMB (~$380k/yr
                   revenue, ~18% net margin) instead of a current-month spike.
                   See section 32 for how the cash-basis revenue is back-dated
                   while keeping the ledger balanced.

Design notes
------------
The script drives the **real HTTP routers** via FastAPI's TestClient — no
direct SQL except for the one-line admin-password reset. Going through
the API guarantees every seeded row carries the same side-effects a real
user would produce (audit logs, notifications, tax snapshots, stock
movements, approval workflow triggers), so the seeded DB is a faithful
preview of normal operation.

Run
---
    python seed.py                # seeds against $DB_PATH (or ../erp.db)
    python seed.py --reset        # WIPE that DB file first, then seed
"""
from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys
import uuid
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


# ── Bootstrap — env must be set BEFORE importing the backend ────────────────
_BACKEND_DIR = Path(__file__).resolve().parent
os.environ.setdefault("SECRET_KEY", "seed-only-secret-not-for-production-0123456789abcd")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:5173")
sys.path.insert(0, str(_BACKEND_DIR))


# ── CLI ─────────────────────────────────────────────────────────────────────
_parser = argparse.ArgumentParser(description="Seed the ERP with demo data.")
_parser.add_argument(
    "--reset", action="store_true",
    help="Delete the existing database file before seeding (DESTRUCTIVE).",
)
_args = _parser.parse_args()

DB_PATH = os.environ.get("DB_PATH") or str(_BACKEND_DIR.parent / "erp.db")

if _args.reset:
    for suffix in ("", "-wal", "-shm", "-journal"):
        p = Path(DB_PATH + suffix)
        if p.exists():
            p.unlink()
    print(f"⚠  wiped {DB_PATH}")
os.environ["DB_PATH"] = DB_PATH


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
#    be exercised end-to-end. All share Test1234! with must_change_password=0.
#    seed_users reads DB_PATH from the env we just set above. ─────────────────
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


def GET(path: str) -> dict:
    r = client.get(path)
    if r.status_code != 200:
        raise RuntimeError(f"GET {path} → {r.status_code}: {r.text}")
    return r.json()


def header(title: str):
    print(f"\n── {title} {'─' * max(2, 62 - len(title))}")


def days_ago(n: int) -> str:
    return (datetime.utcnow() - timedelta(days=n)).strftime("%Y-%m-%d")


def days_ahead(n: int) -> str:
    return (datetime.utcnow() + timedelta(days=n)).strftime("%Y-%m-%d")


_today = datetime.utcnow().strftime("%Y-%m-%d")
_month = datetime.utcnow().strftime("%Y-%m")


# ════════════════════════════════════════════════════════════════════════════
# 1. Tax — enable the engine, add a reduced 5% rate for variety
# ════════════════════════════════════════════════════════════════════════════
header("Tax engine")
PUT("/api/settings/", {"tax_enabled": "1"})
# Add a reduced rate so the VAT report has more than one taxable bucket to
# break down — the per-rate chart only really sings with ≥ 2 active rates.
POST("/api/tax-rates/", {"name": "Reduced VAT 5%", "rate": 5,
                          "tax_type": "standard", "is_default": False})
_rates = GET("/api/tax-rates/")
default_rate = next(r for r in _rates if r["is_default"])
zero_rate    = next(r for r in _rates if r["rate"] == 0 and r["tax_type"] == "zero")
reduced_rate = next(r for r in _rates if abs(r["rate"] - 5) < 0.01)
TAX_DEFAULT, TAX_REDUCED, TAX_ZERO = default_rate["id"], reduced_rate["id"], zero_rate["id"]
print(f"  rates active: {default_rate['name']}, {reduced_rate['name']}, {zero_rate['name']}")


# ════════════════════════════════════════════════════════════════════════════
# 2. Clients — 8 with a mix of business + private and varied profiles
# ════════════════════════════════════════════════════════════════════════════
header("Clients")
clients = [
    {"name": "Beirut Café",      "company": "Beirut Café SAL",
     "phone": "70 123 456", "email": "hello@beirutcafe.lb",
     "address": "Hamra St 14, Beirut",        "type": "business"},
    {"name": "Cedar Logistics",  "company": "Cedar Logistics SARL",
     "phone": "01 555 200", "email": "ops@cedarlogistics.lb",
     "address": "Sin El Fil Industrial Zone", "type": "business"},
    {"name": "Atlas Architects", "company": "Atlas Architects & Co",
     "phone": "01 332 800", "email": "studio@atlas-arch.com",
     "address": "Achrafieh, Beirut",          "type": "business"},
    {"name": "Phoenicia Retail", "company": "Phoenicia Retail Group",
     "phone": "01 700 900", "email": "purchase@phoenicia.com.lb",
     "address": "Verdun Mall, Beirut",        "type": "business"},
    {"name": "Sara Khoury",      "phone": "03 555 777",
     "email": "sara.k@example.com",                                "type": "private"},
    {"name": "Jad Saliba",       "phone": "76 222 888",
     "email": "jad.saliba@example.com",                            "type": "private"},
    {"name": "Layla Najjar",     "phone": "71 404 909",
     "email": "layla.najjar@example.com",                          "type": "private"},
    {"name": "Walid Younes",     "phone": "03 818 818",
     "email": "walid.younes@example.com",                          "type": "private"},
]
client_ids = [POST("/api/clients/", c)["id"] for c in clients]
(CL_BEIRUT_CAFE, CL_CEDAR_LOG, CL_ATLAS, CL_PHOENICIA,
 CL_SARA, CL_JAD, CL_LAYLA, CL_WALID) = client_ids
print(f"  +{len(client_ids)} clients (4 business + 4 private)")


# ════════════════════════════════════════════════════════════════════════════
# 3. Suppliers
# ════════════════════════════════════════════════════════════════════════════
header("Suppliers")
suppliers = [
    {"name": "Cedar Wholesale",   "contact_name": "Rami Hannoun",
     "phone": "01 200 300", "email": "sales@cedarwh.lb",
     "payment_terms_days": 30,
     "notes": "Wood + raw materials"},
    {"name": "ProTools Lebanon",  "contact_name": "Lina Saadeh",
     "phone": "01 444 555", "email": "orders@protools.lb",
     "payment_terms_days": 15},
    {"name": "Med Beverages",     "contact_name": "Ziad Khoury",
     "phone": "01 911 911", "email": "ziad@medbev.lb",
     "payment_terms_days": 60,
     "notes": "Coffee + beverage imports"},
    {"name": "OfficeMax Lebanon", "contact_name": "Nour Daher",
     "phone": "01 660 661", "email": "nour@officemax.lb",
     "payment_terms_days": 30},
]
supplier_ids = [POST("/api/suppliers/", s)["id"] for s in suppliers]
SUP_CEDAR, SUP_PROTOOLS, SUP_MEDBEV, SUP_OFFICEMAX = supplier_ids
print(f"  +{len(supplier_ids)} suppliers")


# ════════════════════════════════════════════════════════════════════════════
# 4. Inventory — 12 items spanning every product_type + stock state
# ════════════════════════════════════════════════════════════════════════════
header("Inventory")
inv = {}
inventory_seed = [
    # name, category, ptype, qty, cost, sale, min_stock, supplier, barcode, unit
    ("wood",      "Pine Wood Plank",   "Wood",        "raw_material", 200,  4.00,    0,  20, "Cedar Wholesale", None, "pcs"),
    ("nails",     "Iron Nails 50mm",   "Hardware",    "raw_material", 1000, 0.05,    0, 100, "Cedar Wholesale", None, "pcs"),
    ("varnish",   "Wood Varnish 1L",   "Chemicals",   "raw_material", 30,   12.00,   0,  10, "Cedar Wholesale", None, "L"),
    ("subframe",  "Table Sub-frame",   "Furniture",   "semi_finished", 8,  35.00,    0,   3, None,              None, "pcs"),
    ("table",     "Dining Table",      "Furniture",   "finished",      0,   0.00,  220,   2, None,              None, "pcs"),
    ("chair",     "Wooden Chair",      "Furniture",   "finished",     12,  18.00,   55,   4, None,              None, "pcs"),
    ("coffee",    "Coffee Beans 1kg",  "Beverage",    "finished",     50,   8.00,   18,  10, "Med Beverages",   "5901234123457", "kg"),
    ("tea",       "Premium Tea 250g",  "Beverage",    "finished",     0,    4.00,   12,   5, "Med Beverages",   "5901234123464", "pack"),
    ("milk",      "Milk Powder 500g",  "Beverage",    "finished",     2,    3.50,    9,  10, "Med Beverages",   None,   "pack"),
    ("napkins",   "Paper Napkins",     "Consumables", "consumable",    3,    2.00,    4,  20, "OfficeMax Lebanon", None, "pack"),
    ("cups",      "Disposable Cups",   "Consumables", "consumable",  500,   0.10,    0, 200, "OfficeMax Lebanon", None, "pcs"),
    ("printer_p", "Printer Paper A4",  "Office",      "consumable",   80,   3.20,    0,  20, "OfficeMax Lebanon", None, "ream"),
]
for key, name, cat, ptype, qty, cost, sale, mn, sup, barcode, unit in inventory_seed:
    body = {"name": name, "category": cat, "product_type": ptype,
            "quantity": qty, "unit_cost": cost, "sale_price": sale,
            "min_stock": mn, "unit": unit}
    if sup:     body["supplier"] = sup
    if barcode: body["barcode"]  = barcode
    inv[key] = POST("/api/inventory/", body)

print(f"  +{len(inv)} inventory items "
      "(napkins/milk below min_stock, tea at 0 → low-stock notifs)")


# ════════════════════════════════════════════════════════════════════════════
# 5. Operational projects
# ════════════════════════════════════════════════════════════════════════════
header("Projects")
projects = [
    POST("/api/projects/", {
        "name": "Café fit-out",              "client_id": CL_BEIRUT_CAFE,
        "location": "Hamra", "status": "Active",
        "start_date": days_ago(30), "estimated_cost": 5000,
        "expected_revenue": 8000, "description": "New seating + bar refit"}),
    POST("/api/projects/", {
        "name": "Custom dining set",         "client_id": CL_SARA,
        "status": "Completed",
        "start_date": days_ago(45), "end_date": days_ago(5),
        "estimated_cost": 1500, "expected_revenue": 2400}),
    POST("/api/projects/", {
        "name": "Office furniture refresh",  "client_id": CL_ATLAS,
        "status": "Inquiry",
        "start_date": days_ahead(15), "estimated_cost": 4000,
        "expected_revenue": 6500,
        "description": "Replacing legacy desks and chairs"}),
    POST("/api/projects/", {
        "name": "Phoenicia branch — phase 1", "client_id": CL_PHOENICIA,
        "status": "On Hold",
        "start_date": days_ago(60), "estimated_cost": 12000,
        "expected_revenue": 18000,
        "description": "Paused while client finalises lease"}),
]
PRJ_CAFE, PRJ_DINING, PRJ_OFFICE, PRJ_PHOENICIA = (p["id"] for p in projects)
print(f"  +{len(projects)} projects (Active / Completed / Inquiry / On Hold)")


# ════════════════════════════════════════════════════════════════════════════
# 6. Quotations — covering Draft, Sent, Accepted (→ invoice), Rejected
# ════════════════════════════════════════════════════════════════════════════
header("Quotations")
q_draft = POST("/api/quotations/", {
    "client_id": CL_BEIRUT_CAFE, "project_id": PRJ_CAFE,
    "items": [
        {"name": "Bar counter (custom)", "quantity": 1, "unit_price": 1800,
         "tax_rate_id": TAX_DEFAULT},
        {"name": "Bar stools",           "quantity": 6, "unit_price":  120,
         "tax_rate_id": TAX_DEFAULT},
    ],
    "notes": "Includes delivery + installation",
})

q_sent = POST("/api/quotations/", {
    "client_id": CL_ATLAS, "project_id": PRJ_OFFICE,
    "items": [
        {"name": "Office desks (×8)",  "quantity": 8, "unit_price": 320, "tax_rate_id": TAX_DEFAULT},
        {"name": "Ergonomic chairs",   "quantity": 8, "unit_price": 180, "tax_rate_id": TAX_DEFAULT},
        {"name": "Cable management",   "quantity": 1, "unit_price":  90, "tax_rate_id": TAX_REDUCED},
    ],
})
PUT(f"/api/quotations/{q_sent['id']}", {
    "client_id": CL_ATLAS, "project_id": PRJ_OFFICE, "status": "Sent",
    "items": [
        {"name": "Office desks (×8)",  "quantity": 8, "unit_price": 320, "tax_rate_id": TAX_DEFAULT},
        {"name": "Ergonomic chairs",   "quantity": 8, "unit_price": 180, "tax_rate_id": TAX_DEFAULT},
        {"name": "Cable management",   "quantity": 1, "unit_price":  90, "tax_rate_id": TAX_REDUCED},
    ],
})

q_accept = POST("/api/quotations/", {
    "client_id": CL_SARA, "project_id": PRJ_DINING,
    "items": [{"name": "Dining set (table + 4 chairs)", "quantity": 1,
               "unit_price": 1400, "tax_rate_id": TAX_DEFAULT}],
})
PUT(f"/api/quotations/{q_accept['id']}", {
    "client_id": CL_SARA, "project_id": PRJ_DINING, "status": "Accepted",
    "items": [{"name": "Dining set (table + 4 chairs)", "quantity": 1,
               "unit_price": 1400, "tax_rate_id": TAX_DEFAULT}],
})
conv = POST(f"/api/quotations/{q_accept['id']}/convert-to-invoice")

q_rejected = POST("/api/quotations/", {
    "client_id": CL_WALID,
    "items": [{"name": "Custom shelving unit", "quantity": 1, "unit_price": 750,
               "tax_rate_id": TAX_DEFAULT}],
})
PUT(f"/api/quotations/{q_rejected['id']}", {
    "client_id": CL_WALID, "status": "Rejected",
    "items": [{"name": "Custom shelving unit", "quantity": 1, "unit_price": 750,
               "tax_rate_id": TAX_DEFAULT}],
})
print(f"  +4 quotations (Draft / Sent / Accepted → {conv.get('invoice_number')} / Rejected)")


# ════════════════════════════════════════════════════════════════════════════
# 7. Invoices — full payment-state matrix
# ════════════════════════════════════════════════════════════════════════════
header("Invoices")
# Fully paid
inv_paid = POST("/api/invoices/", {
    "client_id": CL_CEDAR_LOG,
    "items": [{"name": "Consulting hours", "quantity": 5, "unit_price": 80,
               "tax_rate_id": TAX_DEFAULT}],
    "notes": "April advisory",
})
amt = GET(f"/api/invoices/{inv_paid['id']}")["amount"]
POST(f"/api/invoices/{inv_paid['id']}/payments",
     {"amount": amt, "method": "Bank Transfer", "idempotency_key": str(uuid.uuid4())})

# Partially paid
inv_partial = POST("/api/invoices/", {
    "client_id": CL_BEIRUT_CAFE,
    "items": [{"name": "Maintenance retainer", "quantity": 1, "unit_price": 600,
               "tax_rate_id": TAX_DEFAULT}],
})
POST(f"/api/invoices/{inv_partial['id']}/payments",
     {"amount": 300, "method": "Cash", "idempotency_key": str(uuid.uuid4())})

# Unpaid (not yet overdue) — open invoice for someone we know
POST("/api/invoices/", {
    "client_id": CL_LAYLA,
    "items": [{"name": "Custom bookshelf",  "quantity": 1, "unit_price": 880,
               "tax_rate_id": TAX_DEFAULT}],
    "due_date": days_ahead(10),
})

# Overdue
POST("/api/invoices/", {
    "client_id": CL_JAD,
    "items": [{"name": "Delivery fees", "quantity": 1, "unit_price": 250,
               "tax_rate_id": TAX_DEFAULT}],
    "due_date": days_ago(20),
})

# Voided
inv_void = POST("/api/invoices/", {
    "client_id": CL_WALID,
    "items": [{"name": "Cancelled order", "quantity": 1, "unit_price": 410,
               "tax_rate_id": TAX_DEFAULT}],
})
PATCH(f"/api/invoices/{inv_void['id']}/void",
      {"reason": "Customer cancelled before delivery"})

# Multi-line invoice with mixed tax rates (so the VAT-by-rate report has variety)
POST("/api/invoices/", {
    "client_id": CL_PHOENICIA,
    "items": [
        {"name": "Standard services", "quantity": 2, "unit_price": 500, "tax_rate_id": TAX_DEFAULT},
        {"name": "Reduced rate goods", "quantity": 1, "unit_price": 300, "tax_rate_id": TAX_REDUCED},
        {"name": "Exempt postage",     "quantity": 1, "unit_price":  50, "tax_rate_id": TAX_ZERO},
    ],
})
print("  +6 invoices: Paid / Partial / Unpaid / Overdue / Voided / Mixed-rate")


# ════════════════════════════════════════════════════════════════════════════
# 8. Purchases — across every status with side-effects
# ════════════════════════════════════════════════════════════════════════════
header("Purchases")
purchases = [
    # Ordered (not yet received) — just opens stock pipeline
    {"supplier": "Cedar Wholesale", "product_name": "Pine Wood Plank",
     "inventory_id": inv["wood"]["id"], "quantity": 50, "unit_cost": 4,
     "additional_costs": 25, "tax_rate_id": TAX_DEFAULT, "status": "Ordered"},
    # Received → stock credited but no expense yet
    {"supplier": "Cedar Wholesale", "product_name": "Iron Nails 50mm",
     "inventory_id": inv["nails"]["id"], "quantity": 800, "unit_cost": 0.05,
     "additional_costs": 0, "tax_rate_id": TAX_DEFAULT, "status": "Received"},
    # Paid → expense + landed-cost update + input VAT in the report
    {"supplier": "ProTools Lebanon", "product_name": "Wood Varnish 1L",
     "inventory_id": inv["varnish"]["id"], "quantity": 20, "unit_cost": 11,
     "additional_costs": 5, "tax_rate_id": TAX_DEFAULT, "status": "Paid"},
    # Paid + tax (large) — bumps Finance input VAT and feeds the dashboard
    {"supplier": "Med Beverages", "product_name": "Coffee Beans 1kg",
     "inventory_id": inv["coffee"]["id"], "quantity": 100, "unit_cost": 7.50,
     "additional_costs": 30, "tax_rate_id": TAX_DEFAULT, "status": "Paid"},
    # Paid with reduced VAT
    {"supplier": "OfficeMax Lebanon", "product_name": "Printer Paper A4",
     "inventory_id": inv["printer_p"]["id"], "quantity": 50, "unit_cost": 2.80,
     "additional_costs": 8, "tax_rate_id": TAX_REDUCED, "status": "Paid"},
]
for po in purchases:
    POST("/api/purchases/", po)
print(f"  +{len(purchases)} purchases (1 Ordered, 1 Received, 3 Paid → expenses)")


# ════════════════════════════════════════════════════════════════════════════
# 9. Expenses — 10 across every realistic SME category
# ════════════════════════════════════════════════════════════════════════════
header("Expenses")
expense_seed = [
    {"category": "Utilities",     "amount": 222, "tax_rate_id": TAX_DEFAULT,
     "description": "Electricity – April",         "payment_method": "Bank Transfer"},
    {"category": "Subcontractor", "amount": 750, "project_id": PRJ_CAFE,
     "description": "Plumbing crew",               "payment_method": "Cash"},
    {"category": "Materials",     "amount": 520, "project_id": PRJ_DINING,
     "description": "Hardware for dining set",     "tax_rate_id": TAX_DEFAULT},
    {"category": "Transport",     "amount":  60,
     "description": "Fuel reimbursement"},
    {"category": "Subscription",  "amount": 199, "tax_rate_id": TAX_DEFAULT,
     "description": "Accounting software – annual","payment_method": "Card"},
    {"category": "Insurance",     "amount": 850,
     "description": "Workshop insurance — Q2",     "payment_method": "Bank Transfer"},
    {"category": "Permits",       "amount": 180,
     "description": "Trade permit renewal"},
    {"category": "Salary",        "amount": 1200,
     "description": "April payroll — Omar",        "payment_method": "Bank Transfer"},
    {"category": "Other",         "amount":  45,
     "description": "Office snacks",               "payment_method": "Cash"},
    # Large one — should TRIGGER the approval policy seeded below.
    {"category": "Materials",     "amount": 1800, "project_id": PRJ_PHOENICIA,
     "description": "Large hardware order",        "tax_rate_id": TAX_DEFAULT,
     "payment_method": "Bank Transfer"},
]
for e in expense_seed:
    POST("/api/finance/expenses", e)
print(f"  +{len(expense_seed)} expenses (1 large → triggers approval workflow)")


# ════════════════════════════════════════════════════════════════════════════
# 10. Recurring expense templates — 3 frequencies for variety
# ════════════════════════════════════════════════════════════════════════════
header("Recurring expenses")
recurring_seed = [
    {"name": "Office Rent",      "category": "Rent",         "amount": 1110,
     "frequency": "monthly",  "start_date": days_ago(120),
     "tax_rate_id": TAX_DEFAULT, "description": "HQ rent — Hamra"},
    {"name": "Internet & Phone", "category": "Utilities",    "amount":  333,
     "frequency": "quarterly","start_date": days_ago(120),
     "tax_rate_id": TAX_DEFAULT, "description": "Fibre + landlines"},
    {"name": "Accounting SaaS",  "category": "Subscription", "amount":  444,
     "frequency": "annual",   "start_date": days_ago(60),
     "tax_rate_id": TAX_DEFAULT, "description": "Bookkeeping software seat"},
]
for tpl_body in recurring_seed:
    tpl = POST("/api/recurring-expenses", tpl_body)
    POST(f"/api/recurring-expenses/{tpl['id']}/run")
print(f"  +{len(recurring_seed)} templates back-posted onto the P&L")


# ════════════════════════════════════════════════════════════════════════════
# 11. POS — open session + 5 sales + 1 returned sale
# ════════════════════════════════════════════════════════════════════════════
header("POS")
POST("/api/pos/session/open", json := {"opening_float": 100})

def _checkout(items, method="Cash", tendered=None, currency="USD"):
    body = {"items": items, "payment_method": method,
            "idempotency_key": str(uuid.uuid4())}
    if method.lower() == "cash":
        body["amount_tendered"] = tendered if tendered is not None else \
                                   sum(i["quantity"] * i["unit_price"] for i in items) + 5
    else:
        body["amount_tendered"] = 0
    return POST("/api/pos/checkout", body)

# Sale 1 — straightforward cash sale (2 lines)
_checkout([
    {"inventory_id": inv["coffee"]["id"],  "name": "Coffee Beans 1kg",
     "quantity": 2, "unit_price": 18, "tax_rate_id": TAX_DEFAULT},
    {"inventory_id": inv["napkins"]["id"], "name": "Paper Napkins",
     "quantity": 1, "unit_price":  4, "tax_rate_id": TAX_DEFAULT},
])
# Sale 2 — coffee + chair (mixed, decent ticket)
_checkout([
    {"inventory_id": inv["chair"]["id"],   "name": "Wooden Chair",
     "quantity": 1, "unit_price": 55, "tax_rate_id": TAX_DEFAULT},
    {"inventory_id": inv["coffee"]["id"],  "name": "Coffee Beans 1kg",
     "quantity": 3, "unit_price": 18, "tax_rate_id": TAX_DEFAULT},
])
# Sale 3 — card sale, single line
_checkout(
    [{"inventory_id": inv["chair"]["id"], "name": "Wooden Chair",
      "quantity": 2, "unit_price": 55, "tax_rate_id": TAX_DEFAULT}],
    method="Card",
)
# Sale 4 — service / custom line (no inventory id)
_checkout([
    {"inventory_id": None, "name": "Custom engraving service",
     "quantity": 1, "unit_price": 35, "tax_rate_id": TAX_DEFAULT},
])
# Sale 5 — to be RETURNED below
sale_to_return = _checkout([
    {"inventory_id": inv["coffee"]["id"], "name": "Coffee Beans 1kg",
     "quantity": 4, "unit_price": 18, "tax_rate_id": TAX_DEFAULT},
])
# Refund — voids invoice, restocks
POST(f"/api/pos/sales/{sale_to_return['id']}/return",
     {"reason": "customer changed their mind"})

print("  open session + 5 sales (1 card, 1 service) + 1 refunded sale")


# ════════════════════════════════════════════════════════════════════════════
# 12. Manufacturing — 2 BOMs (one versioned) + 3 production orders
# ════════════════════════════════════════════════════════════════════════════
header("Manufacturing")
bom_table_v1 = POST("/api/manufacturing/boms", {
    "name":                "Dining Table BOM",
    "output_inventory_id": inv["table"]["id"],
    "output_quantity":     1, "labor_cost": 30, "overhead_cost": 10,
    "components": [
        {"component_inventory_id": inv["wood"]["id"],     "quantity": 4, "scrap_pct": 5},
        {"component_inventory_id": inv["nails"]["id"],    "quantity": 20},
        {"component_inventory_id": inv["varnish"]["id"],  "quantity": 1},
    ],
})
# Bump to v2 — production manager refined the recipe
POST(f"/api/manufacturing/boms/{bom_table_v1['id']}/new-version", {
    "name":                "Dining Table BOM",
    "output_inventory_id": inv["table"]["id"],
    "output_quantity":     1, "labor_cost": 35, "overhead_cost": 10,
    "revision_note":       "Reduced varnish per table, added sub-frame component",
    "components": [
        {"component_inventory_id": inv["wood"]["id"],     "quantity": 4, "scrap_pct": 5},
        {"component_inventory_id": inv["nails"]["id"],    "quantity": 18},
        {"component_inventory_id": inv["varnish"]["id"],  "quantity": 1},
        {"component_inventory_id": inv["subframe"]["id"], "quantity": 1},
    ],
})

bom_chair = POST("/api/manufacturing/boms", {
    "name":                "Wooden Chair BOM",
    "output_inventory_id": inv["chair"]["id"],
    "output_quantity":     1, "labor_cost": 8, "overhead_cost": 3,
    "components": [
        {"component_inventory_id": inv["wood"]["id"],    "quantity": 2},
        {"component_inventory_id": inv["nails"]["id"],   "quantity": 12},
        {"component_inventory_id": inv["varnish"]["id"], "quantity": 1},
    ],
})

# MO 1 — completed table batch (drives stock + cost)
order_completed = POST("/api/manufacturing/orders",
                       {"bom_id": bom_table_v1["id"], "quantity": 3,
                        "notes": "First batch this quarter"})
POST(f"/api/manufacturing/orders/{order_completed['id']}/confirm")
POST(f"/api/manufacturing/orders/{order_completed['id']}/start")
POST(f"/api/manufacturing/orders/{order_completed['id']}/complete")

# MO 2 — chairs, in progress (materials reserved, not yet completed)
order_progress = POST("/api/manufacturing/orders",
                      {"bom_id": bom_chair["id"], "quantity": 6,
                       "notes": "Café restock"})
POST(f"/api/manufacturing/orders/{order_progress['id']}/confirm")
POST(f"/api/manufacturing/orders/{order_progress['id']}/start")

# MO 3 — draft (still being planned)
POST("/api/manufacturing/orders",
     {"bom_id": bom_chair["id"], "quantity": 12,
      "notes": "Q3 planning — to be confirmed once wood lands"})

print("  +2 BOMs (1 versioned) + 3 orders: Completed / In Progress / Draft")


# ════════════════════════════════════════════════════════════════════════════
# 13. Fixed Assets — varied register + run depreciation
# ════════════════════════════════════════════════════════════════════════════
header("Fixed Assets")
assets_seed = [
    {"name": "Delivery Van",        "category": "Vehicles",
     "supplier_id": SUP_PROTOOLS,   "acquisition_cost": 12000,
     "acquisition_date": days_ago(400), "in_service_date": days_ago(400),
     "depreciation_method": "straight_line", "useful_life_months": 60,
     "salvage_value": 1500},
    {"name": "Workstation PCs (×4)","category": "Computers",
     "supplier_id": SUP_OFFICEMAX,  "acquisition_cost": 4800,
     "acquisition_date": days_ago(200), "in_service_date": days_ago(200),
     "depreciation_method": "straight_line", "useful_life_months": 36,
     "salvage_value": 200},
    {"name": "Showroom Furniture",  "category": "Furniture",
     "acquisition_cost": 2200,
     "acquisition_date": days_ago(60), "in_service_date": days_ago(60),
     "depreciation_method": "straight_line", "useful_life_months": 60,
     "salvage_value": 100},
    # Land/building — depreciation_method=none means no monthly charge.
    {"name": "Workshop Building",   "category": "Buildings",
     "acquisition_cost": 80000,
     "acquisition_date": days_ago(900), "in_service_date": days_ago(900),
     "depreciation_method": "none", "useful_life_months": 0},
]
for a in assets_seed:
    POST("/api/assets", a)
# Catch-up depreciation runs every eligible asset for every un-booked month.
res = POST("/api/assets/depreciation/run", {"period": _month})
print(f"  +{len(assets_seed)} assets; ran depreciation → {res['total_periods']} period(s) posted")


# ════════════════════════════════════════════════════════════════════════════
# 14. Cash — second drawer + two closed reconciliations (one with variance)
# ════════════════════════════════════════════════════════════════════════════
header("Cash")
POST("/api/cash/drawers", {"name": "Workshop Petty Cash",
                            "is_active": True, "auto_capture": False})
drawers = GET("/api/cash/drawers")
main_till = next(d for d in drawers if d["auto_capture"])

# Yesterday — balanced close
rec_y = POST("/api/cash/reconciliations",
             {"drawer_id": main_till["id"],
              "business_date": days_ago(1), "opening_balance": 100})
POST(f"/api/cash/reconciliations/{rec_y['id']}/close",
     {"counted_cash": 100, "counted_cash_lbp": 0,
      "note": "Quiet day, no surprises"})

# Day before — closed WITH a deliberate variance so a cash_variance notification
# fires (threshold: ≥ $5 in absolute terms).
rec_v = POST("/api/cash/reconciliations",
             {"drawer_id": main_till["id"],
              "business_date": days_ago(2), "opening_balance": 100})
POST(f"/api/cash/reconciliations/{rec_v['id']}/close",
     {"counted_cash": 88, "counted_cash_lbp": 0,
      "note": "$12 short — investigating"})

print("  +1 secondary drawer; 2 reconciliations closed (1 balanced, 1 variance)")


# ════════════════════════════════════════════════════════════════════════════
# 15. CRM — leads at every stage + deals + contacts + activities
# ════════════════════════════════════════════════════════════════════════════
header("CRM")
leads_seed = [
    {"name": "Maya Aoun",     "company": "Aoun Catering",   "phone": "70 333 222",
     "email": "maya@aouncatering.lb",
     "source": "referral",  "status": "Qualified",  "score": 70,
     "estimated_value": 4500},
    {"name": "Karim Daher",   "company": "Daher & Sons",    "phone": "76 999 111",
     "source": "web",       "status": "New",        "score": 30,
     "estimated_value": 1200},
    {"name": "Nadia Geagea",  "company": "Geagea Imports",  "phone": "01 717 717",
     "source": "cold_call", "status": "Contacted",  "score": 45,
     "estimated_value": 3300},
    {"name": "Ramzi Mansour", "company": "Mansour Holdings","phone": "71 808 808",
     "source": "social",    "status": "Proposal",   "score": 80,
     "estimated_value": 9500},
    {"name": "Hala Saliba",   "company": "Saliba Studio",
     "source": "referral",  "status": "Won",        "score": 95,
     "estimated_value": 6000},
    {"name": "Bilal Tarabay", "company": "BT Logistics",
     "source": "web",       "status": "Lost",       "score": 15,
     "estimated_value": 800, "notes": "Went with competitor"},
]
lead_ids = [POST("/api/crm/leads", l)["id"] for l in leads_seed]

deals_seed = [
    {"title": "Café fit-out — phase 2", "client_id": CL_BEIRUT_CAFE,
     "stage": "Proposal",     "value": 6000, "probability": 60},
    {"title": "Office furniture full refresh", "client_id": CL_ATLAS,
     "stage": "Negotiation",  "value": 7500, "probability": 80},
    {"title": "Annual cleaning supply contract", "client_id": CL_CEDAR_LOG,
     "stage": "Qualification","value": 3200, "probability": 30},
    {"title": "Phoenicia branch — phase 2", "client_id": CL_PHOENICIA,
     "stage": "Won",          "value": 9000, "probability": 100},
]
for d in deals_seed:
    POST("/api/crm/deals", d)

contacts_seed = [
    {"client_id": CL_BEIRUT_CAFE, "name": "Rita Saad",     "title": "Operations Manager",
     "email": "rita@beirutcafe.lb",   "phone": "01 730 730", "is_primary": True},
    {"client_id": CL_CEDAR_LOG,   "name": "Antoine Khoury","title": "Logistics Lead",
     "email": "antoine@cedarlog.lb",  "phone": "01 555 201"},
    {"client_id": CL_ATLAS,       "name": "Joëlle Atlas",  "title": "Founding Partner",
     "email": "j.atlas@atlas-arch.com","phone": "01 332 801"},
    {"client_id": CL_PHOENICIA,   "name": "Tony Saad",     "title": "Purchasing Director",
     "email": "tony@phoenicia.com.lb", "phone": "01 700 901"},
    {"lead_id":   lead_ids[0],    "name": "Sami Aoun",     "title": "Operations",
     "email": "sami@aouncatering.lb"},
]
for c in contacts_seed:
    POST("/api/crm/contacts", c)

activities_seed = [
    {"type": "call",    "subject": "Follow-up call",        "lead_id": lead_ids[1],
     "due_date": days_ahead(2)},
    {"type": "meeting", "subject": "Site visit — Phoenicia","client_id": CL_PHOENICIA,
     "due_date": days_ahead(7)},
    {"type": "email",   "subject": "Send revised quote",    "client_id": CL_ATLAS,
     "due_date": days_ahead(1)},
]
for a in activities_seed:
    POST("/api/crm/activities", a)

print(f"  +{len(leads_seed)} leads, +{len(deals_seed)} deals, "
      f"+{len(contacts_seed)} contacts, +{len(activities_seed)} activities")


# ════════════════════════════════════════════════════════════════════════════
# 16. Planning — 2 projects + 8 tasks across statuses
# ════════════════════════════════════════════════════════════════════════════
header("Planning")
plan_cafe = POST("/api/planning/projects", {
    "name": "Café fit-out plan", "client_id": CL_BEIRUT_CAFE,
    "start_date": days_ago(30), "end_date": days_ahead(15), "status": "Active",
})
plan_office = POST("/api/planning/projects", {
    "name": "Office refresh schedule", "client_id": CL_ATLAS,
    "start_date": days_ahead(7), "end_date": days_ahead(60), "status": "Active",
})

task_seed = [
    (plan_cafe["id"],   "Site survey",          "Done",        "High",   days_ago(30), days_ago(25), 100),
    (plan_cafe["id"],   "Design sign-off",      "Done",        "High",   days_ago(24), days_ago(15), 100),
    (plan_cafe["id"],   "Install bar counter",  "In Progress", "Medium", days_ago(5),  days_today := days_ahead(2),  40),
    (plan_cafe["id"],   "Final paint + finish", "To Do",       "Medium", days_ahead(3), days_ahead(10),               0),
    (plan_cafe["id"],   "Client walkthrough",   "To Do",       "Low",    days_ahead(12),days_ahead(14),               0),
    (plan_office["id"], "Take measurements",    "To Do",       "Medium", days_ahead(7), days_ahead(9),                0),
    (plan_office["id"], "Order desks + chairs", "To Do",       "High",   days_ahead(10),days_ahead(14),               0),
    (plan_office["id"], "Installation week",    "To Do",       "High",   days_ahead(20),days_ahead(27),               0),
]
for pid, name, status, prio, sd, ed, prog in task_seed:
    POST("/api/planning/tasks", {
        "project_id": pid, "name": name, "status": status, "priority": prio,
        "start_date": sd, "end_date": ed, "progress": prog,
    })

print(f"  +2 plans + {len(task_seed)} tasks across To Do / In Progress / Done")


# ════════════════════════════════════════════════════════════════════════════
# 17. HR — 3 departments, 6 employees, leave history
# ════════════════════════════════════════════════════════════════════════════
header("HR")
dept_ops    = POST("/api/hr/departments", {"name": "Operations",  "description": "Shop floor + delivery"})
dept_sales  = POST("/api/hr/departments", {"name": "Sales & CRM", "description": "Customer-facing team"})
dept_admin  = POST("/api/hr/departments", {"name": "Admin & Finance","description": "Back office"})

employees_seed = [
    {"full_name": "Omar Haddad",   "job_title": "Carpenter",         "department_id": dept_ops["id"],
     "employment_type": "Full-time", "hire_date": days_ago(700), "salary": 1200,
     "email": "omar.h@workshop.lb"},
    {"full_name": "Layal Nasr",    "job_title": "Cashier",           "department_id": dept_ops["id"],
     "employment_type": "Part-time", "hire_date": days_ago(120), "salary": 700},
    {"full_name": "Tarek Aoun",    "job_title": "Sales Manager",     "department_id": dept_sales["id"],
     "employment_type": "Full-time", "hire_date": days_ago(450), "salary": 1800,
     "email": "tarek.a@workshop.lb"},
    {"full_name": "Rasha Khalil",  "job_title": "CRM Specialist",    "department_id": dept_sales["id"],
     "employment_type": "Full-time", "hire_date": days_ago(180), "salary": 1100},
    {"full_name": "Maher Tabet",   "job_title": "Bookkeeper",        "department_id": dept_admin["id"],
     "employment_type": "Full-time", "hire_date": days_ago(900), "salary": 1500,
     "email": "maher.t@workshop.lb"},
    {"full_name": "Yara Diab",     "job_title": "HR & Office Lead",  "department_id": dept_admin["id"],
     "employment_type": "Full-time", "hire_date": days_ago(540), "salary": 1400,
     "email": "yara.d@workshop.lb"},
]
emp_ids = [POST("/api/hr/employees", e)["id"] for e in employees_seed]

# An already-approved leave that ended last week (so the auto-revert flips the
# employee back to Active on first HR page load — covers the audit fix).
past_leave = POST("/api/hr/leave", {
    "employee_id": emp_ids[1], "leave_type": "Annual",
    "start_date": days_ago(14), "end_date": days_ago(8), "reason": "Family trip",
})
POST(f"/api/hr/leave/{past_leave['id']}/approve", {"note": ""})

# An approved leave that's CURRENTLY active — Layal should show as "On Leave".
active_leave = POST("/api/hr/leave", {
    "employee_id": emp_ids[3], "leave_type": "Sick",
    "start_date": days_ago(1), "end_date": days_ahead(4), "reason": "Flu",
})
POST(f"/api/hr/leave/{active_leave['id']}/approve", {"note": "Get well soon"})

# A pending leave — shows in the Pending Leave KPI on the HR dashboard.
POST("/api/hr/leave", {
    "employee_id": emp_ids[2], "leave_type": "Annual",
    "start_date": days_ahead(20), "end_date": days_ahead(27), "reason": "Summer holiday",
})

print(f"  +3 departments, +{len(employees_seed)} employees, "
      "3 leave records (1 past, 1 active, 1 pending)")


# ════════════════════════════════════════════════════════════════════════════
# 18. Approvals — 2 policies (one already triggered above by a $1,800 expense)
# ════════════════════════════════════════════════════════════════════════════
header("Approvals")
POST("/api/approval-policies/", {
    "name":            "Large expense review",
    "description":     "Any expense over $1,000 must be approved by Finance",
    "module":          "expense", "trigger_action": "create",
    "condition_logic": "AND",
    "conditions":      [{"field": "amount", "op": ">", "value": "1000"}],
    "approval_type":   "single",
    "approver_roles":  ["Finance Manager"],
    "priority":        10, "is_active": True,
})
POST("/api/approval-policies/", {
    "name":            "Capex over $5k",
    "description":     "Fixed asset purchases above $5k need Finance approval",
    "module":          "fixed_asset", "trigger_action": "create",
    "condition_logic": "AND",
    "conditions":      [{"field": "acquisition_cost", "op": ">", "value": "5000"}],
    "approval_type":   "single",
    "approver_roles":  ["Finance Manager"],
    "priority":        10, "is_active": True,
})
# Trigger one fresh approval request so the bell + Approvals page have something
# to show. (The $1,800 Materials expense seeded above pre-dated the policy.)
POST("/api/finance/expenses", {
    "category": "Materials", "amount": 2400, "project_id": PRJ_OFFICE,
    "description": "Bulk hardware — pending Finance review",
})
print("  +2 policies (expense + fixed_asset); +1 pending request")


# ════════════════════════════════════════════════════════════════════════════
# 19. More clients — scale the book of business up to ~16
# ════════════════════════════════════════════════════════════════════════════
header("More clients")
more_clients_seed = [
    {"name": "Mountain Roasters",  "company": "Mountain Roasters SAL",
     "phone": "03 121 314", "email": "buy@mountainroasters.lb",
     "address": "Broumana Main Rd", "type": "business"},
    {"name": "Levant Interiors",   "company": "Levant Interiors SARL",
     "phone": "01 488 277", "email": "projects@levantinteriors.com",
     "address": "Dbayeh Highway", "type": "business"},
    {"name": "Byblos Resort",      "company": "Byblos Resort & Spa",
     "phone": "09 540 540", "email": "procurement@byblosresort.lb",
     "address": "Jbeil Seafront", "type": "business"},
    {"name": "Tripoli Traders",    "company": "Tripoli Traders Co",
     "phone": "06 430 430", "email": "info@tripolitraders.lb",
     "address": "Tripoli Souks", "type": "business"},
    {"name": "Zahle Vineyards",    "company": "Zahle Vineyards SAL",
     "phone": "08 800 220", "email": "orders@zahlevineyards.lb",
     "address": "Bekaa Valley", "type": "business"},
    {"name": "Rami Fares",   "phone": "70 909 010",
     "email": "rami.fares@example.com", "type": "private"},
    {"name": "Nour Hamdan",  "phone": "76 313 414",
     "email": "nour.hamdan@example.com", "type": "private"},
    {"name": "Elie Karam",   "phone": "03 717 818",
     "email": "elie.karam@example.com", "type": "private"},
]
more_client_ids = [POST("/api/clients/", c)["id"] for c in more_clients_seed]
(CL_ROASTERS, CL_LEVANT, CL_BYBLOS, CL_TRIPOLI, CL_ZAHLE,
 CL_RAMI, CL_NOUR, CL_ELIE) = more_client_ids
print(f"  +{len(more_client_ids)} clients (5 business + 3 private) → 16 total")


# ════════════════════════════════════════════════════════════════════════════
# 20. More projects — push to ~12 across the full status spectrum
# ════════════════════════════════════════════════════════════════════════════
header("More projects")
more_projects_seed = [
    {"name": "Resort lobby refit", "client_id": CL_BYBLOS, "status": "Active",
     "start_date": days_ago(20), "estimated_cost": 9000, "expected_revenue": 14000,
     "description": "Reception desk + lounge seating"},
    {"name": "Roastery counter build", "client_id": CL_ROASTERS, "status": "Active",
     "start_date": days_ago(10), "estimated_cost": 3500, "expected_revenue": 5500},
    {"name": "Levant showroom shelving", "client_id": CL_LEVANT, "status": "Inquiry",
     "start_date": days_ahead(10), "estimated_cost": 6000, "expected_revenue": 9000},
    {"name": "Vineyard tasting room", "client_id": CL_ZAHLE, "status": "Completed",
     "start_date": days_ago(120), "end_date": days_ago(20),
     "estimated_cost": 7000, "expected_revenue": 11000},
    {"name": "Tripoli store fixtures", "client_id": CL_TRIPOLI, "status": "Active",
     "start_date": days_ago(35), "estimated_cost": 4200, "expected_revenue": 6800},
    {"name": "Private library — Karam", "client_id": CL_ELIE, "status": "On Hold",
     "start_date": days_ago(50), "estimated_cost": 2000, "expected_revenue": 3200,
     "description": "Awaiting client material choice"},
    {"name": "Home office — Fares", "client_id": CL_RAMI, "status": "Completed",
     "start_date": days_ago(80), "end_date": days_ago(30),
     "estimated_cost": 1300, "expected_revenue": 2100},
    {"name": "Cedar warehouse racking", "client_id": CL_CEDAR_LOG, "status": "Active",
     "start_date": days_ago(15), "estimated_cost": 5500, "expected_revenue": 8500},
]
more_projects = [POST("/api/projects/", p) for p in more_projects_seed]
(PRJ_RESORT, PRJ_ROASTERY, PRJ_LEVANT, PRJ_VINEYARD,
 PRJ_TRIPOLI, PRJ_LIBRARY, PRJ_HOMEOFFICE, PRJ_RACKING) = (p["id"] for p in more_projects)
print(f"  +{len(more_projects)} projects → 12 total")


# ════════════════════════════════════════════════════════════════════════════
# 21. More quotations — varied statuses, two converted to invoices
# ════════════════════════════════════════════════════════════════════════════
header("More quotations")
more_quotes_seed = [
    (CL_BYBLOS, PRJ_RESORT, "Sent", [
        {"name": "Reception desk", "quantity": 1, "unit_price": 2600, "tax_rate_id": TAX_DEFAULT},
        {"name": "Lounge sofas",   "quantity": 4, "unit_price": 480,  "tax_rate_id": TAX_DEFAULT}]),
    (CL_ROASTERS, PRJ_ROASTERY, "Accepted", [
        {"name": "Service counter", "quantity": 1, "unit_price": 1900, "tax_rate_id": TAX_DEFAULT},
        {"name": "Bar stools",      "quantity": 4, "unit_price": 130,  "tax_rate_id": TAX_DEFAULT}]),
    (CL_LEVANT, PRJ_LEVANT, "Draft", [
        {"name": "Display shelving (×10)", "quantity": 10, "unit_price": 220, "tax_rate_id": TAX_DEFAULT}]),
    (CL_TRIPOLI, PRJ_TRIPOLI, "Accepted", [
        {"name": "Store fixtures set", "quantity": 1, "unit_price": 3400, "tax_rate_id": TAX_DEFAULT}]),
    (CL_ZAHLE, None, "Sent", [
        {"name": "Tasting tables", "quantity": 3, "unit_price": 520, "tax_rate_id": TAX_REDUCED}]),
    (CL_NOUR, None, "Rejected", [
        {"name": "Custom wardrobe", "quantity": 1, "unit_price": 1250, "tax_rate_id": TAX_DEFAULT}]),
]
_converted = 0
for cid, pid, status, items in more_quotes_seed:
    body = {"client_id": cid, "items": items}
    if pid:
        body["project_id"] = pid
    q = POST("/api/quotations/", body)
    if status != "Draft":
        upd = {"client_id": cid, "status": status, "items": items}
        if pid:
            upd["project_id"] = pid
        PUT(f"/api/quotations/{q['id']}", upd)
    if status == "Accepted":
        POST(f"/api/quotations/{q['id']}/convert-to-invoice")
        _converted += 1
print(f"  +{len(more_quotes_seed)} quotations ({_converted} accepted → invoices)")


# ════════════════════════════════════════════════════════════════════════════
# 22. More invoices — broaden the AR ledger across payment states
# ════════════════════════════════════════════════════════════════════════════
header("More invoices")
# (client_id, item_name, qty, price, due_offset_days, pay) where pay in
# {"full","partial","none"} and due_offset<0 makes it overdue.
more_inv_specs = [
    (CL_BYBLOS,   "Lobby furniture deposit", 1, 4000, 15,  "partial"),
    (CL_ROASTERS, "Counter build — final",   1, 1900, 30,  "full"),
    (CL_LEVANT,   "Shelving advance",        1, 1100, 10,  "none"),
    (CL_TRIPOLI,  "Fixtures milestone 1",    1, 1700, -15, "partial"),
    (CL_ZAHLE,    "Tasting tables",          3, 520,  -25, "none"),
    (CL_RAMI,     "Home office build",       1, 2100, 20,  "full"),
    (CL_NOUR,     "Repair + refinish",       1, 340,  -10, "none"),
    (CL_ELIE,     "Bookshelf deposit",       1, 900,  25,  "partial"),
]
for cid, name, qty, price, due_off, pay in more_inv_specs:
    iv = POST("/api/invoices/", {
        "client_id": cid,
        "items": [{"name": name, "quantity": qty, "unit_price": price,
                   "tax_rate_id": TAX_DEFAULT}],
        "due_date": days_ahead(due_off) if due_off >= 0 else days_ago(-due_off),
    })
    amt = GET(f"/api/invoices/{iv['id']}")["amount"]
    if pay == "full":
        POST(f"/api/invoices/{iv['id']}/payments",
             {"amount": amt, "method": "Bank Transfer", "idempotency_key": str(uuid.uuid4())})
    elif pay == "partial":
        POST(f"/api/invoices/{iv['id']}/payments",
             {"amount": round(amt * 0.4, 2), "method": "Cash", "idempotency_key": str(uuid.uuid4())})
print(f"  +{len(more_inv_specs)} invoices (full / partial / unpaid / overdue mix)")


# ════════════════════════════════════════════════════════════════════════════
# 23. More POS sales — keep the open session busy (high-stock items only)
# ════════════════════════════════════════════════════════════════════════════
header("More POS sales")
_more_pos = [
    ([{"inventory_id": inv["coffee"]["id"], "name": "Coffee Beans 1kg",
       "quantity": 3, "unit_price": 18, "tax_rate_id": TAX_DEFAULT}], "Cash"),
    ([{"inventory_id": inv["cups"]["id"], "name": "Disposable Cups",
       "quantity": 10, "unit_price": 0.5, "tax_rate_id": TAX_DEFAULT}], "Cash"),
    ([{"inventory_id": inv["coffee"]["id"], "name": "Coffee Beans 1kg",
       "quantity": 2, "unit_price": 18, "tax_rate_id": TAX_DEFAULT},
      {"inventory_id": inv["chair"]["id"], "name": "Wooden Chair",
       "quantity": 1, "unit_price": 55, "tax_rate_id": TAX_DEFAULT}], "Card"),
    ([{"inventory_id": None, "name": "Gift wrapping",
       "quantity": 2, "unit_price": 5, "tax_rate_id": TAX_DEFAULT}], "Cash"),
    ([{"inventory_id": inv["coffee"]["id"], "name": "Coffee Beans 1kg",
       "quantity": 1, "unit_price": 18, "tax_rate_id": TAX_DEFAULT}], "Card"),
    ([{"inventory_id": inv["cups"]["id"], "name": "Disposable Cups",
       "quantity": 20, "unit_price": 0.5, "tax_rate_id": TAX_DEFAULT}], "Cash"),
]
for items, method in _more_pos:
    _checkout(items, method=method)
print(f"  +{len(_more_pos)} POS sales added to the open session")


# ════════════════════════════════════════════════════════════════════════════
# 24. More expenses — deepen the P&L
# ════════════════════════════════════════════════════════════════════════════
header("More expenses")
more_expense_seed = [
    {"category": "Utilities",    "amount": 198, "tax_rate_id": TAX_DEFAULT,
     "description": "Water + generator — May", "payment_method": "Bank Transfer"},
    {"category": "Transport",    "amount": 140,
     "description": "Delivery fuel — May",     "payment_method": "Cash"},
    {"category": "Materials",    "amount": 640, "project_id": PRJ_RESORT,
     "description": "Upholstery fabric",       "tax_rate_id": TAX_DEFAULT},
    {"category": "Subcontractor","amount": 900, "project_id": PRJ_TRIPOLI,
     "description": "Electrician — fixtures",  "payment_method": "Cash"},
    {"category": "Subscription", "amount": 320, "tax_rate_id": TAX_DEFAULT,
     "description": "Social media ads — Q2",   "payment_method": "Card"},
    {"category": "Equipment",    "amount": 210,
     "description": "Workshop tool servicing", "payment_method": "Cash"},
]
for e in more_expense_seed:
    POST("/api/finance/expenses", e)
print(f"  +{len(more_expense_seed)} expenses")


# ════════════════════════════════════════════════════════════════════════════
# 25. Recruitment — positions → applicants → interviews → offers → one hire
# ════════════════════════════════════════════════════════════════════════════
header("Recruitment")
pos_carpenter = POST("/api/recruitment/positions", {
    "title": "Junior Carpenter", "department_id": dept_ops["id"],
    "employment_type": "Full-time", "headcount": 2, "status": "Open",
    "location": "Workshop — Hamra", "salary_min": 800, "salary_max": 1200,
    "description": "Hands-on furniture build role.",
    "requirements": "1+ yr carpentry; reads cut lists."})
pos_sales = POST("/api/recruitment/positions", {
    "title": "Sales Associate", "department_id": dept_sales["id"],
    "employment_type": "Full-time", "headcount": 1, "status": "Open",
    "salary_min": 900, "salary_max": 1300})
pos_account = POST("/api/recruitment/positions", {
    "title": "Junior Accountant", "department_id": dept_admin["id"],
    "employment_type": "Full-time", "headcount": 1, "status": "On Hold",
    "salary_min": 1000, "salary_max": 1400})
POST("/api/recruitment/positions", {
    "title": "Seasonal Helper", "department_id": dept_ops["id"],
    "employment_type": "Contract", "headcount": 3, "status": "Open"})

# Applicants spread across the pipeline.
def _applicant(name, pos_id, stages, *, rating=None, salary=None, source="LinkedIn",
               email=None, phone=None):
    body = {"full_name": name, "position_id": pos_id, "source": source}
    if rating: body["rating"] = rating
    if salary: body["expected_salary"] = salary
    if email:  body["email"] = email
    if phone:  body["phone"] = phone
    app = POST("/api/recruitment/applicants", body)
    for st in stages:
        POST(f"/api/recruitment/applicants/{app['id']}/status", {"new_status": st})
    return app

# Full hire chain — interviewed, offered, accepted, converted to employee.
app_hire = _applicant("Ziad Murr", pos_carpenter["id"],
                      ["Screening", "Interview"], rating=5, salary=1050,
                      email="ziad.murr@example.com", phone="70 654 321")
POST(f"/api/recruitment/applicants/{app_hire['id']}/interviews", {
    "interview_type": "Phone", "scheduled_at": days_ago(10) + " 10:00",
    "duration_min": 45, "status": "Completed", "score": 8, "decision": "Hire",
    "notes": "Strong portfolio."})
POST(f"/api/recruitment/applicants/{app_hire['id']}/interviews", {
    "interview_type": "On-site", "scheduled_at": days_ago(6) + " 14:00",
    "duration_min": 90, "status": "Completed", "score": 9, "decision": "Strong hire",
    "notes": "Excellent bench test."})
offer_hire = POST(f"/api/recruitment/applicants/{app_hire['id']}/offers", {
    "contract_type": "Permanent", "job_title": "Junior Carpenter",
    "department_id": dept_ops["id"], "start_date": days_ahead(14),
    "salary": 1050, "salary_currency": "USD", "payment_schedule": "Monthly",
    "probation_months": 3, "weekly_hours": 45, "annual_leave_days": 15})
POST(f"/api/recruitment/offers/{offer_hire['id']}/status", {"status": "Sent"})
POST(f"/api/recruitment/offers/{offer_hire['id']}/status", {"status": "Accepted"})
POST(f"/api/recruitment/applicants/{app_hire['id']}/status",
     {"new_status": "Accepted", "reason": "Top candidate — accepted offer."})
hire = POST(f"/api/recruitment/applicants/{app_hire['id']}/convert", {
    "accepted_offer_id": offer_hire["id"], "department_id": dept_ops["id"],
    "job_title": "Junior Carpenter", "salary": 1050, "hire_date": days_ahead(14)})

# Other applicants in mid-pipeline + one rejected.
_applicant("Carla Rizk", pos_carpenter["id"], ["Screening"], rating=3,
           salary=950, email="carla.rizk@example.com")
_applicant("Hadi Salloum", pos_sales["id"], ["Screening", "Interview"],
           rating=4, salary=1100, source="Referral",
           email="hadi.salloum@example.com")
_applicant("Maya Trad", pos_sales["id"], ["Screening", "Interview", "Technical Test"],
           rating=4, salary=1200, source="Website")
_applicant("Fadi Obeid", pos_account["id"], ["Screening"], rating=2, salary=1000)
_applicant("Rita Daou", pos_carpenter["id"],
           ["Screening", "Rejected"], rating=2, source="Walk-in")
print("  +4 positions, 6 applicants (1 hired → employee), interviews + offers")


# ════════════════════════════════════════════════════════════════════════════
# 26. HR — contracts, a paid payroll run, and HR activities
# ════════════════════════════════════════════════════════════════════════════
header("HR contracts")
# Formal contracts for the founding staff; activating syncs the salary timeline.
contract_specs = [
    (emp_ids[0], "Permanent", "Carpenter",      days_ago(700), 1200),
    (emp_ids[2], "Permanent", "Sales Manager",  days_ago(450), 1800),
    (emp_ids[4], "Permanent", "Bookkeeper",     days_ago(900), 1500),
    (emp_ids[1], "Fixed-term", "Cashier",       days_ago(120), 700),
]
for eid, ctype, title, start, salary in contract_specs:
    c = POST("/api/hr/contracts/", {
        "employee_id": eid, "contract_type": ctype, "status": "Draft",
        "start_date": start, "job_title": title, "salary": salary,
        "weekly_hours": 48 if ctype == "Permanent" else 24,
        "work_schedule": "Mon–Fri 9:00–18:00"})
    POST(f"/api/hr/contracts/{c['id']}/status", {"status": "Active"})
print(f"  +{len(contract_specs)} contracts activated")

header("Payroll")
run = POST("/api/hr/payroll/runs", {
    "period_start": days_ago(31), "period_end": days_ago(1),
    "notes": "Monthly payroll — current period"})
POST(f"/api/hr/payroll/runs/{run['id']}/approve")
paid = POST(f"/api/hr/payroll/runs/{run['id']}/mark-paid")
# A second run left in Draft so the Payroll screen shows both states.
POST("/api/hr/payroll/runs", {
    "period_start": days_ago(61), "period_end": days_ago(32),
    "notes": "Prior period — draft"})
print(f"  1 paid run (expense {paid.get('expense_id')}) + 1 draft run")

header("HR activities")
hr_acts = [
    {"activity_type": "Meeting", "subject": "1:1 with Omar",
     "scheduled_at": days_ahead(2) + " 10:00", "duration_min": 30,
     "employee_id": emp_ids[0], "reminder_minutes_before": 30},
    {"activity_type": "Call", "subject": "Reference check — Ziad",
     "scheduled_at": days_ahead(1) + " 15:00", "duration_min": 20,
     "applicant_id": app_hire["id"], "reminder_minutes_before": 15},
    {"activity_type": "Interview", "subject": "Panel — Sales Associate",
     "scheduled_at": days_ahead(4) + " 11:00", "duration_min": 60,
     "reminder_minutes_before": 60},
    {"activity_type": "Note", "subject": "Update employee handbook",
     "scheduled_at": days_ahead(6) + " 09:00", "duration_min": 0,
     "reminder_minutes_before": 0},
]
for a in hr_acts:
    POST("/api/hr-activities", a)
print(f"  +{len(hr_acts)} HR activities (with reminders)")


# ════════════════════════════════════════════════════════════════════════════
# 27. Announcements — company-wide comms
# ════════════════════════════════════════════════════════════════════════════
header("Announcements")
POST("/api/announcements/", {
    "title": "Welcome to the new ERP",
    "body": "We've migrated to the new system. Please review your module access "
            "and report any issues to IT. Thanks for your patience during the rollout.",
    "priority": "high", "audience_type": "all",
    "requires_ack": True, "pinned": True})
POST("/api/announcements/", {
    "title": "Q2 inventory count — June 1",
    "body": "A full stock count is scheduled for June 1. Operations team please "
            "freeze non-urgent movements the evening before.",
    "priority": "medium", "audience_type": "all", "requires_ack": False})
POST("/api/announcements/", {
    "title": "Office closed — public holiday",
    "body": "The office will be closed for the upcoming public holiday. POS and "
            "online orders continue as normal.",
    "priority": "low", "audience_type": "all",
    "expires_at": days_ahead(30)})
print("  +3 announcements (1 pinned + ack-required)")


# ════════════════════════════════════════════════════════════════════════════
# 28. Planning — milestones + calendar events on the existing plans
# ════════════════════════════════════════════════════════════════════════════
header("Planning extras")
for mb in [
    {"project_id": plan_cafe["id"],   "name": "Design approved",   "due_date": days_ago(15)},
    {"project_id": plan_cafe["id"],   "name": "Bar counter installed", "due_date": days_ahead(2)},
    {"project_id": plan_cafe["id"],   "name": "Handover",          "due_date": days_ahead(14)},
    {"project_id": plan_office["id"], "name": "Measurements done", "due_date": days_ahead(9)},
    {"project_id": plan_office["id"], "name": "Install complete",  "due_date": days_ahead(27)},
]:
    POST("/api/planning/milestones", mb)

for eb in [
    {"title": "Weekly team standup", "start_date": days_ahead(1),
     "all_day": 0, "start_time": "09:00", "end_time": "09:30"},
    {"title": "Café site walkthrough", "start_date": days_ahead(3),
     "all_day": 0, "start_time": "14:00", "end_time": "15:30",
     "description": "Review bar install progress"},
    {"title": "Supplier review meeting", "start_date": days_ahead(8),
     "all_day": 1, "color": "#f5a623"},
]:
    POST("/api/planning/events", eb)
print("  +5 milestones + 3 calendar events")


# ════════════════════════════════════════════════════════════════════════════
# 29. Manufacturing resources + advanced production (resources / QC / lots /
#     partial completion) — the SME resource-based costing model
# ════════════════════════════════════════════════════════════════════════════
header("Manufacturing resources & advanced production")
# Reusable per-hour cost resources (drive overhead = Σ rates × actual hours).
res_labor = POST("/api/manufacturing/resources", {"name": "Labor",        "hourly_rate": 12})["id"]
res_elec  = POST("/api/manufacturing/resources", {"name": "Electricity",  "hourly_rate": 3})["id"]
res_cnc   = POST("/api/manufacturing/resources", {"name": "CNC Machine",  "hourly_rate": 20})["id"]
res_oven  = POST("/api/manufacturing/resources", {"name": "Oven",         "hourly_rate": 8})["id"]

# A lot-tracked raw input + a lot-tracked, QC-required finished product so the
# completion drives lots, expiry, traceability AND quality control.
raw_resin = POST("/api/inventory/", {
    "name": "Resin Compound", "category": "Chemicals", "product_type": "raw_material",
    "quantity": 500, "unit_cost": 2.0, "unit": "kg",
    "lot_tracked": True, "shelf_life_days": 365})["id"]
fg_widget = POST("/api/inventory/", {
    "name": "Molded Widget", "category": "Finished", "product_type": "finished",
    "quantity": 0, "sale_price": 40, "min_stock": 10, "unit": "pcs",
    "lot_tracked": True, "shelf_life_days": 730})["id"]

bom_widget = POST("/api/manufacturing/boms", {
    "name": "Molded Widget BOM", "output_inventory_id": fg_widget,
    "output_quantity": 10, "standard_hours": 2, "qc_required": True,
    "components": [{"component_inventory_id": raw_resin, "quantity": 5}],
    "resources": [{"resource_id": res_labor}, {"resource_id": res_elec},
                  {"resource_id": res_cnc}, {"name": "Quality check", "hourly_rate": 5}],
})

# MO A — full run → finished batch goes to QC quarantine → inspector resolves
# (7 pass to stock as a lot, 3 rejected, 2 of them spun into a rework order).
mo_qc = POST("/api/manufacturing/orders", {
    "bom_id": bom_widget["id"], "quantity": 10, "priority": "High",
    "due_date": days_ahead(7), "notes": "QC + lot-tracked batch"})
POST(f"/api/manufacturing/orders/{mo_qc['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_qc['id']}/start")
done = POST(f"/api/manufacturing/orders/{mo_qc['id']}/complete", {"production_hours": 2.5})
if done.get("qc_id"):
    POST(f"/api/manufacturing/qc/{done['qc_id']}/resolve", {
        "passed_qty": 7, "rejected_qty": 3, "rework_qty": 2,
        "defects": [{"reason": "Surface blemish", "quantity": 2},
                    {"reason": "Short fill", "quantity": 1}],
        "notes": "Two reworkable, one scrap."})

# MO B — resource-based BOM completed across TWO PARTIAL runs (auto-closes when
# the planned quantity is reached). No QC on this one.
fg_panel = POST("/api/inventory/", {
    "name": "Wood Panel", "category": "Furniture", "product_type": "finished",
    "quantity": 0, "sale_price": 25, "min_stock": 4, "unit": "pcs"})["id"]
bom_panel = POST("/api/manufacturing/boms", {
    "name": "Wood Panel BOM", "output_inventory_id": fg_panel,
    "output_quantity": 1, "standard_hours": 0.5,
    "components": [{"component_inventory_id": inv["wood"]["id"], "quantity": 1}],
    "resources": [{"resource_id": res_labor}, {"resource_id": res_oven}],
})
mo_partial = POST("/api/manufacturing/orders", {
    "bom_id": bom_panel["id"], "quantity": 10, "priority": "Normal",
    "planned_start_date": days_ago(2), "due_date": days_ahead(5)})
POST(f"/api/manufacturing/orders/{mo_partial['id']}/confirm")
POST(f"/api/manufacturing/orders/{mo_partial['id']}/complete",
     {"quantity_produced": 6, "production_hours": 3, "close": False})   # first run
POST(f"/api/manufacturing/orders/{mo_partial['id']}/complete",
     {"quantity_produced": 4, "production_hours": 2})                    # finishes + closes
print("  +4 resources, 2 resource BOMs; QC batch (pass/reject/rework + lots) "
      "+ partial completion across 2 runs")


# ════════════════════════════════════════════════════════════════════════════
# 30. Accounting — one manual journal entry (the rest of the ledger is already
#     auto-posted from invoice payments / expenses / payroll / depreciation /
#     purchases seeded above)
# ════════════════════════════════════════════════════════════════════════════
header("Accounting")
_acct = {a["code"]: a["id"] for a in GET("/api/accounting/accounts")}
POST("/api/accounting/journal-entries", {
    "entry_date": days_ago(90),
    "memo": "Opening owner capital injection",
    "lines": [
        {"account_id": _acct["1000"], "debit": 20000},   # Cash & Bank
        {"account_id": _acct["3000"], "credit": 20000},  # Owner's Equity
    ],
})
_je = GET("/api/accounting/journal-entries")
print(f"  +1 manual journal entry; ledger holds {len(_je)} posted entries "
      "(payments/expenses/payroll/depreciation/purchases auto-posted)")


# ════════════════════════════════════════════════════════════════════════════
# 31. Attachments — files on clients / projects / invoices / suppliers
# ════════════════════════════════════════════════════════════════════════════
header("Attachments")
def _attach(entity_type, entity_id, fname, content, ctype):
    r = client.post(f"/api/attachments/{entity_type}/{entity_id}",
                    files={"file": (fname, content, ctype)})
    return r.status_code in (200, 201)

_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF")
_att = 0
_att += _attach("clients",   CL_BEIRUT_CAFE, "onboarding-brief.txt",
                b"Beirut Cafe onboarding brief.\nPreferred contact: WhatsApp.\n", "text/plain")
_att += _attach("projects",  PRJ_CAFE, "site-measurements.csv",
                b"area,width,length\nbar,3.2,1.1\nseating,6.0,4.5\n", "text/csv")
_att += _attach("invoices",  inv_paid["id"], "signed-invoice.pdf", _PDF, "application/pdf")
_att += _attach("suppliers", SUP_CEDAR, "price-list.txt",
                b"Pine plank 4.00/pcs\nNails 0.05/pcs\nVarnish 12.00/L\n", "text/plain")
print(f"  +{_att} attachments across clients / projects / invoices / suppliers")


# ════════════════════════════════════════════════════════════════════════════
# 32. Historical financial backfill — 12 months of realistic, collected
#     revenue + operating costs so every trend chart (Dashboard, Finance,
#     Reports, Income Statement) reads like a real, modestly-growing SMB
#     instead of a single current-month spike.
#
# WHY a post-seed SQL date-shift is needed (and safe):
#   • Payments stamp `paid_at = now()` server-side (invoices.py) — the API
#     gives no way to back-date the cash-basis revenue that drives the
#     revenue trend. Expenses DO accept an explicit `date` (and auto-date
#     their own GL entry from it), so historical COSTS need no SQL at all.
#   • For revenue we therefore create the invoices+payments through the API
#     (so every ledger/stock/tax side-effect is real), then move three date
#     columns in lockstep per payment: invoice_payments.paid_at, the
#     invoice's created_at, and the payment's revenue journal entry
#     (source_type='invoice_payment', source_id=payment_id).
#   • Only DATES change — never amounts — so the Trial Balance stays balanced
#     and the accrual Income Statement (JE dates) matches the cash-basis
#     Finance view (paid_at) month by month.
#
# The model targets a healthy net margin (~12–22%, expanding with scale) so
# revenue exceeds cost every month: materials float as the balancing COGS
# line, payroll/rent/utilities are the fixed opex.
header("Historical backfill (12-month trend)")
import math       # noqa: E402
import random     # noqa: E402
from calendar import monthrange  # noqa: E402
random.seed(42)   # reproducible — re-running the seed yields the same history

ALL_CLIENTS = client_ids + more_client_ids
BUSINESS_CLIENTS = [CL_BEIRUT_CAFE, CL_CEDAR_LOG, CL_ATLAS, CL_PHOENICIA,
                    CL_ROASTERS, CL_LEVANT, CL_BYBLOS, CL_TRIPOLI, CL_ZAHLE]

# Sale line-items for a furniture workshop + café-supply business (name, lo, hi).
SALE_LINES = [
    ("Dining table — oak",        650, 1200),
    ("Chairs (set of 4)",         180,  340),
    ("Bar counter — custom",     1400, 2600),
    ("Office desk",               260,  520),
    ("Bookshelf unit",            300,  780),
    ("Reception desk",           1500, 2800),
    ("Display shelving",          900, 1800),
    ("Café furniture package",   1800, 3400),
    ("Coffee beans — bulk 25kg",  380,  520),
    ("Repair & refinish",         150,  480),
    ("Delivery & installation",    80,  260),
]

def _recent_months(n):
    """Oldest→current list of (year, month) for the trailing n months."""
    today = datetime.utcnow()
    out, y, m = [], today.year, today.month
    for i in range(n - 1, -1, -1):
        mm, yy = m - i, y
        while mm <= 0:
            mm += 12; yy -= 1
        out.append((yy, mm))
    return out

def _dstr(y, m, day):
    return f"{y:04d}-{m:02d}-{min(day, monthrange(y, m)[1]):02d}"

_now_ym = (datetime.utcnow().year, datetime.utcnow().month)
months  = _recent_months(12)
n_span  = len(months)
hist_payments = []   # (invoice_id, "YYYY-MM-DD") for the SQL shift — each
                     # historical invoice carries exactly one full payment

# The seeded "expense > $1,000 → Finance approval" policy would trap every
# historical Materials / Salary / Rent line (all > $1k) in pending-approval so
# it never posts to the ledger — leaving the Income Statement showing revenue
# with almost no cost. Suspend active policies for the backfill, then restore
# them (current-month pending-approval demo requests are unaffected).
_suspended_policies = [p["id"] for p in GET("/api/approval-policies/") if p.get("is_active")]
for _pid in _suspended_policies:
    PATCH(f"/api/approval-policies/{_pid}/toggle")

def _make_invoice(y, m, inv_target):
    """Create one fully-paid invoice worth ≈ inv_target (pre-tax) and return
    its (id, gross_amount_collected)."""
    items, remaining = [], inv_target
    n_lines = random.randint(1, 3)
    for li in range(n_lines):
        name, lo, hi = random.choice(SALE_LINES)
        if li == n_lines - 1:
            unit, qty = max(50, round(remaining)), 1
        else:
            unit = round(random.uniform(lo, hi)); qty = random.randint(1, 2)
            remaining -= unit * qty
        items.append({"name": name, "quantity": qty, "unit_price": unit,
                      "tax_rate_id": TAX_DEFAULT})
    cid = random.choice(BUSINESS_CLIENTS if random.random() < 0.7 else ALL_CLIENTS)
    iv  = POST("/api/invoices/", {"client_id": cid, "items": items})
    amt = GET(f"/api/invoices/{iv['id']}")["amount"]
    POST(f"/api/invoices/{iv['id']}/payments",
         {"amount": amt, "method": random.choice(["Bank Transfer", "Cash", "Card"]),
          "idempotency_key": str(uuid.uuid4())})
    return iv["id"], amt

_rev_total = _cost_total = 0.0
for idx, (y, m) in enumerate(months):
    is_current = (y, m) == _now_ym
    progress   = idx / max(1, n_span - 1)               # 0 … 1 across the window
    # Revenue: grows ~$21k → ~$32k, mild summer bump, small monthly noise. The
    # current month is deliberately PARTIAL (collections still coming in) so a
    # cash-basis dashboard shows the natural in-progress dip, not a full month.
    season     = 1.0 + 0.07 * math.sin((m / 12.0) * 2 * math.pi)
    target_rev = (21000 + 11000 * progress) * season * random.uniform(0.95, 1.05)
    if is_current:
        target_rev *= 0.55

    # ── Revenue: several fully-paid invoices summing ≈ target_rev ───────────
    n_inv   = random.randint(4, 6) if is_current else random.randint(6, 9)
    weights = [random.uniform(0.6, 1.6) for _ in range(n_inv)]
    wsum    = sum(weights)
    month_gross = 0.0
    for k in range(n_inv):
        inv_id, amt = _make_invoice(y, m, target_rev * weights[k] / wsum)
        month_gross += amt
        _rev_total  += amt
        if not is_current:      # current month is already "now" — no shift needed
            hist_payments.append((inv_id, _dstr(y, m, random.randint(3, 27))))

    # ── Costs: PAST months only (the current month's opex is already seeded as
    #    one-off state). Sized off the month's GROSS revenue so the charted net
    #    margin lands in a realistic 14–20% band; Materials is the balancing
    #    COGS line, payroll/rent/utilities the fixed opex. ────────────────────
    if is_current:
        continue
    margin = random.uniform(0.14, 0.18) + 0.02 * progress      # widens slightly with scale
    costs  = month_gross * (1 - margin)
    util, transport, subs = (random.uniform(360, 520),
                             random.uniform(150, 300),
                             random.uniform(200, 380))
    materials = max(month_gross * 0.32, costs - (7700 + 1100 + util + transport + subs))

    def _exp(cat, amount, desc, day, tax=False):
        POST("/api/finance/expenses", {
            "category": cat, "amount": round(amount, 2), "description": desc,
            "date": _dstr(y, m, day), "payment_method": "Bank Transfer",
            **({"tax_rate_id": TAX_DEFAULT} if tax else {})})

    _exp("Materials",  materials, "Timber, hardware & finishing supplies", 6, tax=True)
    _exp("Salary",     7700,      "Monthly payroll",                       28)
    _exp("Rent",       1100,      "Workshop + showroom rent",               1, tax=True)
    _exp("Utilities",  util,      "Electricity, water & generator fuel",    9, tax=True)
    _exp("Transport",  transport, "Delivery fuel & logistics",             12)
    _exp("Subscription", subs,    "Software & marketing",                  15, tax=True)
    _cost_total += materials + 7700 + 1100 + util + transport + subs

# ── The lockstep SQL date-shift (dates only — books stay balanced) ──────────
# Each historical invoice has exactly one full payment, so the payment and its
# revenue journal entry are located by invoice_id — no payment id needed.
with sqlite3.connect(DB_PATH) as _con:
    for inv_id, pay_date in hist_payments:
        issued = (datetime.strptime(pay_date, "%Y-%m-%d")
                  - timedelta(days=random.randint(2, 10))).strftime("%Y-%m-%d %H:%M:%S")
        _con.execute("UPDATE invoice_payments SET paid_at=? WHERE invoice_id=?",
                     (pay_date + " 12:00:00", inv_id))
        _con.execute("UPDATE invoices SET created_at=? WHERE id=?", (issued, inv_id))
        _con.execute(
            "UPDATE journal_entries SET entry_date=? "
            "WHERE source_type='invoice_payment' AND source_id IN "
            "(SELECT id FROM invoice_payments WHERE invoice_id=?)",
            (pay_date, inv_id))
    _con.commit()

# Restore the approval policies suspended for the backfill.
for _pid in _suspended_policies:
    PATCH(f"/api/approval-policies/{_pid}/toggle")

print(f"  +{len(hist_payments)} back-dated paid invoices + monthly costs across "
      f"{n_span - 1} prior months")
print(f"  ≈ ${_rev_total:,.0f} collected vs ${_cost_total:,.0f} historical costs "
      f"(net ≈ ${_rev_total - _cost_total:,.0f})")


# ════════════════════════════════════════════════════════════════════════════
print()
print(f"✓  Database seeded at {DB_PATH}")
print(f"   Admin login:     admin / {ADMIN_PASSWORD}  (superadmin)")
print(f"   Per-role logins: u_<role> / {ROLE_PASSWORD}  (e.g. u_finance_manager)")
print()
print("   Try the UI tour:")
print("   • Dashboard          — KPIs, revenue trend, recent activity")
print("   • Notifications bell — low-stock / sales / variance / approvals")
print("   • Invoices           — every payment state including the voided one")
print("   • Manufacturing      — orders in Draft / In Progress / Completed")
print("   • Reports → VAT      — per-rate breakdown across 11% / 5% / 0%")
print("   • Recruitment        — pipeline from Applied → hired employee")
print("   • HR → Payroll       — 1 paid run posted to Finance + 1 draft")
print("   • Announcements      — pinned company-wide notice (ack required)")
print("   • Approvals          — pending Finance review")
