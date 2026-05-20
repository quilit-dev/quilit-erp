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
    _con.commit()


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
        {"component_inventory_id": inv["varnish"]["id"],  "quantity": 0.2},
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
        {"component_inventory_id": inv["varnish"]["id"],  "quantity": 0.15},
        {"component_inventory_id": inv["subframe"]["id"], "quantity": 1},
    ],
})

bom_chair = POST("/api/manufacturing/boms", {
    "name":                "Wooden Chair BOM",
    "output_inventory_id": inv["chair"]["id"],
    "output_quantity":     1, "labor_cost": 8, "overhead_cost": 3,
    "components": [
        {"component_inventory_id": inv["wood"]["id"],    "quantity": 1.5},
        {"component_inventory_id": inv["nails"]["id"],   "quantity": 12},
        {"component_inventory_id": inv["varnish"]["id"], "quantity": 0.05},
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
print()
print(f"✓  Database seeded at {DB_PATH}")
print(f"   Login: admin / {ADMIN_PASSWORD}")
print()
print("   Try the UI tour:")
print("   • Dashboard          — KPIs, revenue trend, recent activity")
print("   • Notifications bell — ~8 unread across low-stock / sales / variance")
print("   • Invoices           — every payment state including the voided one")
print("   • Manufacturing      — orders in Draft / In Progress / Completed")
print("   • Reports → VAT      — per-rate breakdown across 11% / 5% / 0%")
print("   • Approvals          — 1 pending Finance review")
