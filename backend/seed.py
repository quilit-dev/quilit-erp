#!/usr/bin/env python3
"""
seed.py — populate a fresh ERP database with just enough data to
demonstrate every module end-to-end.

What you get
------------
    Login          admin / Admin123!  (superadmin)
    Tax            VAT 11% on; one zero-rated rate retained
    Clients (3)    1 company + 2 private, each with a phone number so the
                   WhatsApp share button is exercisable on every doc
    Suppliers (2)
    Inventory (5)  raw / finished / consumable mix, one below min_stock
    Projects (2)   one Active linked to a quotation, one Completed
    Quotations (2) one Draft, one Accepted (already converted)
    Invoices (3)   Paid, Partially Paid, Overdue (so all payment states render)
    Purchases (2)  one Ordered, one Paid (auto-creates expense + stock movement)
    Expenses (3)   includes one tax-tagged + one project-linked
    Recurring (1)  monthly rent template
    POS            open session + one completed cash sale
    Manufacturing  1 BOM + 1 completed production order (drives stock + cost)
    Fixed Asset    1 active asset, depreciated to the current month
    Cash           Main Till seeded by init_db; one closed reconciliation
    CRM            2 leads, 1 deal, 1 contact
    Planning       1 project + 2 tasks
    HR             1 department + 2 employees
    Approvals      1 policy (expense > $1,000 → Finance Manager review)

Design notes
------------
The script drives the **real HTTP routers** via FastAPI's TestClient — no
direct SQL except for the one-line admin-password reset. Going through
the API guarantees every seeded row carries the same side-effects a real
user would produce (audit log entries, notifications, tax snapshots,
stock movements, approval workflow triggers), so the seeded DB is a
faithful preview of normal operation rather than a hand-crafted shape
that drifts from reality.

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


def GET(path: str) -> dict:
    r = client.get(path)
    if r.status_code != 200:
        raise RuntimeError(f"GET {path} → {r.status_code}: {r.text}")
    return r.json()


def header(title: str):
    print(f"\n── {title} {'─' * max(2, 62 - len(title))}")


_today           = datetime.utcnow().strftime("%Y-%m-%d")
_thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d")
_five_days_ago   = (datetime.utcnow() - timedelta(days=5)).strftime("%Y-%m-%d")
_overdue_due     = (datetime.utcnow() - timedelta(days=20)).strftime("%Y-%m-%d")
_year_ago        = (datetime.utcnow() - timedelta(days=400)).strftime("%Y-%m-%d")


# ════════════════════════════════════════════════════════════════════════════
# 1. Tax — enable the engine (rates were seeded by init_db)
# ════════════════════════════════════════════════════════════════════════════
header("Tax engine")
PUT("/api/settings/", {"tax_enabled": "1"})
_rates       = GET("/api/tax-rates/")
default_rate = next(r for r in _rates if r["is_default"])
zero_rate    = next(r for r in _rates if r["rate"] == 0 and r["tax_type"] == "zero")
TAX_DEFAULT  = default_rate["id"]
TAX_ZERO     = zero_rate["id"]
print(f"  default rate: {default_rate['name']} ({default_rate['rate']}%)")


# ════════════════════════════════════════════════════════════════════════════
# 2. Clients
# ════════════════════════════════════════════════════════════════════════════
header("Clients")
_clients = [
    POST("/api/clients/", {"name": "Beirut Café", "company": "Beirut Café SAL",
                           "phone": "70 123 456", "email": "hello@beirutcafe.lb",
                           "address": "Hamra, Beirut", "type": "business"}),
    POST("/api/clients/", {"name": "Sara Khoury", "phone": "03 555 777",
                           "email": "sara.k@example.com", "type": "private"}),
    POST("/api/clients/", {"name": "Jad Saliba", "phone": "76 222 888",
                           "email": "jad@example.com", "type": "private"}),
]
CL_BUSINESS, CL_PRIVATE_1, CL_PRIVATE_2 = (c["id"] for c in _clients)
print("  +3 clients")


# ════════════════════════════════════════════════════════════════════════════
# 3. Suppliers
# ════════════════════════════════════════════════════════════════════════════
header("Suppliers")
_suppliers = [
    POST("/api/suppliers/", {"name": "Cedar Wholesale", "contact_name": "Rami",
                             "phone": "01 200 300", "email": "sales@cedarwh.lb",
                             "payment_terms_days": 30}),
    POST("/api/suppliers/", {"name": "ProTools Lebanon", "contact_name": "Lina",
                             "phone": "01 444 555", "payment_terms_days": 15}),
]
SUP_CEDAR, SUP_PROTOOLS = (s["id"] for s in _suppliers)
print("  +2 suppliers")


# ════════════════════════════════════════════════════════════════════════════
# 4. Inventory — raw / finished / consumable mix, one item below min_stock
# ════════════════════════════════════════════════════════════════════════════
header("Inventory")
inv = {}
inv["wood"] = POST("/api/inventory/", {
    "name": "Pine Wood Plank", "category": "Wood",
    "product_type": "raw_material", "quantity": 200, "unit_cost": 4,
    "sale_price": 0, "supplier": "Cedar Wholesale", "unit": "pcs"})
inv["nails"] = POST("/api/inventory/", {
    "name": "Iron Nails 50mm", "category": "Hardware",
    "product_type": "raw_material", "quantity": 1000, "unit_cost": 0.05,
    "sale_price": 0, "supplier": "Cedar Wholesale", "unit": "pcs"})
inv["table"] = POST("/api/inventory/", {
    "name": "Dining Table", "category": "Furniture",
    "product_type": "finished", "quantity": 0, "unit_cost": 0,
    "sale_price": 220, "min_stock": 2})
inv["coffee"] = POST("/api/inventory/", {
    "name": "Coffee Beans 1kg", "category": "Beverage",
    "product_type": "finished", "quantity": 50, "unit_cost": 8,
    "sale_price": 18, "min_stock": 10, "barcode": "5901234123457"})
inv["napkins"] = POST("/api/inventory/", {
    "name": "Paper Napkins", "category": "Consumables",
    "product_type": "consumable", "quantity": 3, "unit_cost": 2,
    "sale_price": 4, "min_stock": 20})    # ← below min_stock → triggers low-stock notif
print("  +5 inventory items (1 already low-stock)")


# ════════════════════════════════════════════════════════════════════════════
# 5. Operational projects
# ════════════════════════════════════════════════════════════════════════════
header("Projects")
_projects = [
    POST("/api/projects/", {
        "name": "Café fit-out", "client_id": CL_BUSINESS,
        "location": "Hamra", "status": "Active",
        "start_date": _thirty_days_ago, "estimated_cost": 5000,
        "expected_revenue": 8000, "description": "New seating + bar refit"}),
    POST("/api/projects/", {
        "name": "Custom furniture set", "client_id": CL_PRIVATE_1,
        "status": "Completed", "start_date": _thirty_days_ago,
        "end_date": _five_days_ago, "estimated_cost": 1500,
        "expected_revenue": 2400}),
]
PRJ_CAFE, PRJ_FURNITURE = (p["id"] for p in _projects)
print("  +2 operational projects (1 active, 1 completed)")


# ════════════════════════════════════════════════════════════════════════════
# 6. Quotations — Draft + Accepted-and-converted (drives an invoice)
# ════════════════════════════════════════════════════════════════════════════
header("Quotations")
POST("/api/quotations/", {
    "client_id": CL_BUSINESS, "project_id": PRJ_CAFE,
    "items": [
        {"name": "Bar counter (custom)", "quantity": 1, "unit_price": 1800,
         "tax_rate_id": TAX_DEFAULT},
        {"name": "Bar stools",           "quantity": 6, "unit_price":  120,
         "tax_rate_id": TAX_DEFAULT},
    ],
    "notes": "Includes delivery and installation",
})
q_accept = POST("/api/quotations/", {
    "client_id": CL_PRIVATE_1, "project_id": PRJ_FURNITURE,
    "items": [{"name": "Dining set (table + 4 chairs)", "quantity": 1,
               "unit_price": 1400, "tax_rate_id": TAX_DEFAULT}],
})
PUT(f"/api/quotations/{q_accept['id']}", {
    "client_id": CL_PRIVATE_1, "project_id": PRJ_FURNITURE, "status": "Accepted",
    "items": [{"name": "Dining set (table + 4 chairs)", "quantity": 1,
               "unit_price": 1400, "tax_rate_id": TAX_DEFAULT}],
})
conv = POST(f"/api/quotations/{q_accept['id']}/convert-to-invoice")
print(f"  +2 quotations (1 converted to {conv.get('invoice_number')})")


# ════════════════════════════════════════════════════════════════════════════
# 7. Invoices — Paid, Partial, Overdue (every payment state on screen)
# ════════════════════════════════════════════════════════════════════════════
header("Invoices")
inv_paid = POST("/api/invoices/", {
    "client_id": CL_PRIVATE_2,
    "items": [{"name": "Consulting hours", "quantity": 5, "unit_price": 80,
               "tax_rate_id": TAX_DEFAULT}],
    "notes": "April advisory",
})
POST(f"/api/invoices/{inv_paid['id']}/payments",
     {"amount":          GET(f"/api/invoices/{inv_paid['id']}")["amount"],
      "method":          "Bank Transfer",
      "idempotency_key": str(uuid.uuid4())})

inv_partial = POST("/api/invoices/", {
    "client_id": CL_BUSINESS,
    "items": [{"name": "Maintenance retainer", "quantity": 1, "unit_price": 600,
               "tax_rate_id": TAX_DEFAULT}],
})
POST(f"/api/invoices/{inv_partial['id']}/payments",
     {"amount": 300, "method": "Cash", "idempotency_key": str(uuid.uuid4())})

POST("/api/invoices/", {
    "client_id": CL_PRIVATE_2,
    "items": [{"name": "Delivery fees", "quantity": 1, "unit_price": 250,
               "tax_rate_id": TAX_DEFAULT}],
    "due_date": _overdue_due,
})
print("  +3 invoices (paid / partial / overdue)")


# ════════════════════════════════════════════════════════════════════════════
# 8. Purchases — one Ordered, one Paid (Paid auto-creates expense + stock)
# ════════════════════════════════════════════════════════════════════════════
header("Purchases")
POST("/api/purchases/", {
    "supplier": "Cedar Wholesale", "product_name": "Pine Wood Plank",
    "inventory_id": inv["wood"]["id"], "quantity": 50, "unit_cost": 4,
    "additional_costs": 25, "tax_rate_id": TAX_DEFAULT, "status": "Ordered",
})
POST("/api/purchases/", {
    "supplier": "ProTools Lebanon", "product_name": "Iron Nails 50mm",
    "inventory_id": inv["nails"]["id"], "quantity": 500, "unit_cost": 0.06,
    "additional_costs": 5, "tax_rate_id": TAX_DEFAULT, "status": "Paid",
})
print("  +2 purchases (1 paid → expense + stock movement created)")


# ════════════════════════════════════════════════════════════════════════════
# 9. Expenses — manual entries plus a tax-tagged one
# ════════════════════════════════════════════════════════════════════════════
header("Expenses")
POST("/api/finance/expenses", {
    "category": "Utilities", "amount": 222, "tax_rate_id": TAX_DEFAULT,
    "description": "Electricity – April", "payment_method": "Bank Transfer",
})
POST("/api/finance/expenses", {
    "category": "Subcontractor", "amount": 750, "project_id": PRJ_CAFE,
    "description": "Plumbing crew", "payment_method": "Cash",
})
POST("/api/finance/expenses", {
    "category": "Transport", "amount": 60, "description": "Fuel reimbursement",
})
print("  +3 expenses (1 project-linked, 1 with VAT)")


# ════════════════════════════════════════════════════════════════════════════
# 10. Recurring expense — monthly rent template
# ════════════════════════════════════════════════════════════════════════════
header("Recurring expenses")
tpl = POST("/api/recurring-expenses", {
    "name": "Office Rent", "category": "Rent", "amount": 1110,
    "frequency": "monthly",
    "start_date": (datetime.utcnow() - timedelta(days=90)).strftime("%Y-%m-%d"),
    "tax_rate_id": TAX_DEFAULT, "description": "HQ rent — Hamra"})
POST(f"/api/recurring-expenses/{tpl['id']}/run")
print("  +1 recurring template (back-posted a few months)")


# ════════════════════════════════════════════════════════════════════════════
# 11. POS — open session + a cash sale
# ════════════════════════════════════════════════════════════════════════════
header("POS")
POST("/api/pos/session/open", {"opening_float": 100})
sale = POST("/api/pos/checkout", {
    "items": [
        {"inventory_id": inv["coffee"]["id"],  "name": "Coffee Beans 1kg",
         "quantity": 2, "unit_price": 18, "tax_rate_id": TAX_DEFAULT},
        {"inventory_id": inv["napkins"]["id"], "name": "Paper Napkins",
         "quantity": 1, "unit_price":  4, "tax_rate_id": TAX_DEFAULT},
    ],
    "payment_method": "Cash", "amount_tendered": 50,
    "idempotency_key": str(uuid.uuid4()),
})
print(f"  open session + 1 sale ({sale['invoice_number']}, ${sale['total']:.2f})")


# ════════════════════════════════════════════════════════════════════════════
# 12. Manufacturing — BOM + completed production order (drives stock + cost)
# ════════════════════════════════════════════════════════════════════════════
header("Manufacturing")
bom = POST("/api/manufacturing/boms", {
    "name":                "Dining Table BOM",
    "output_inventory_id": inv["table"]["id"],
    "output_quantity":     1, "labor_cost": 30, "overhead_cost": 10,
    "components": [
        {"component_inventory_id": inv["wood"]["id"],  "quantity": 4, "scrap_pct": 5},
        {"component_inventory_id": inv["nails"]["id"], "quantity": 20},
    ],
})
order = POST("/api/manufacturing/orders",
             {"bom_id": bom["id"], "quantity": 3, "notes": "First batch"})
# Walk the strict lifecycle so the seeded data exercises every state.
POST(f"/api/manufacturing/orders/{order['id']}/confirm")
POST(f"/api/manufacturing/orders/{order['id']}/start")
res = POST(f"/api/manufacturing/orders/{order['id']}/complete")
print(f"  +1 BOM + 1 production order ({order['order_number']}, "
      f"3 × Dining Table, total ${res['total_cost']:.2f})")


# ════════════════════════════════════════════════════════════════════════════
# 13. Fixed Assets — one active asset, caught up to current month
# ════════════════════════════════════════════════════════════════════════════
header("Fixed Assets")
POST("/api/assets", {
    "name": "Delivery Van", "category": "Vehicles",
    "supplier_id": SUP_PROTOOLS,
    "acquisition_cost": 12000,
    "acquisition_date": _year_ago, "in_service_date": _year_ago,
    "depreciation_method": "straight_line",
    "useful_life_months":  60, "salvage_value": 1500,
})
POST("/api/assets/depreciation/run",
     {"period": datetime.utcnow().strftime("%Y-%m")})
print("  +1 asset depreciated to current period")


# ════════════════════════════════════════════════════════════════════════════
# 14. Cash — close yesterday's reconciliation on the Main Till
# ════════════════════════════════════════════════════════════════════════════
header("Cash")
drawers   = GET("/api/cash/drawers")
main_till = next(d for d in drawers if d["auto_capture"])
yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
recon = POST("/api/cash/reconciliations",
             {"drawer_id": main_till["id"], "business_date": yesterday,
              "opening_balance": 100})
POST(f"/api/cash/reconciliations/{recon['id']}/close",
     {"counted_cash": 100, "counted_cash_lbp": 0,
      "note": "Day closed — no movements"})
print(f"  Main Till — 1 reconciliation closed for {yesterday}")


# ════════════════════════════════════════════════════════════════════════════
# 15. CRM — leads, a deal, a contact
# ════════════════════════════════════════════════════════════════════════════
header("CRM")
POST("/api/crm/leads", {
    "name": "Maya Aoun", "company": "Aoun Catering", "phone": "70 333 222",
    "email": "maya@aouncatering.lb", "source": "referral", "status": "Qualified",
    "estimated_value": 4500, "score": 70,
})
POST("/api/crm/leads", {
    "name": "Karim Daher", "company": "Daher & Sons", "phone": "76 999 111",
    "source": "web", "status": "New", "estimated_value": 1200, "score": 30,
})
POST("/api/crm/deals", {
    "title": "Café fit-out — phase 2", "client_id": CL_BUSINESS,
    "stage": "Proposal", "value": 6000, "probability": 60,
})
POST("/api/crm/contacts", {
    "client_id": CL_BUSINESS, "name": "Rita Saad",
    "title": "Operations Manager", "email": "rita@beirutcafe.lb",
    "phone": "01 730 730", "is_primary": True,
})
print("  +2 leads, +1 deal, +1 contact")


# ════════════════════════════════════════════════════════════════════════════
# 16. Planning board — project + a couple of tasks
# ════════════════════════════════════════════════════════════════════════════
header("Planning")
plan = POST("/api/planning/projects", {
    "name": "Cafe fit-out plan", "client_id": CL_BUSINESS,
    "start_date": _thirty_days_ago, "end_date": _today, "status": "Active",
})
POST("/api/planning/tasks", {
    "project_id": plan["id"], "name": "Site survey",
    "status": "Done", "priority": "High",
    "start_date": _thirty_days_ago, "end_date": _five_days_ago, "progress": 100,
})
POST("/api/planning/tasks", {
    "project_id": plan["id"], "name": "Install bar counter",
    "status": "In Progress", "priority": "Medium",
    "start_date": _five_days_ago, "end_date": _today, "progress": 40,
})
print("  +1 plan + 2 tasks")


# ════════════════════════════════════════════════════════════════════════════
# 17. HR — one department + two employees
# ════════════════════════════════════════════════════════════════════════════
header("HR")
dept = POST("/api/hr/departments",
            {"name": "Operations", "description": "Shop floor + delivery"})
POST("/api/hr/employees", {
    "full_name": "Omar Haddad", "job_title": "Carpenter",
    "department_id": dept["id"], "employment_type": "Full-time",
    "hire_date": (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d"),
    "salary": 1200, "email": "omar.h@workshop.lb",
})
POST("/api/hr/employees", {
    "full_name": "Layal Nasr", "job_title": "Cashier",
    "department_id": dept["id"], "employment_type": "Part-time",
    "hire_date": _thirty_days_ago, "salary": 700,
})
print("  +1 department, +2 employees")


# ════════════════════════════════════════════════════════════════════════════
# 18. Approvals — one realistic policy
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
print("  +1 approval policy active")


# ════════════════════════════════════════════════════════════════════════════
print()
print(f"✓  Database seeded at {DB_PATH}")
print(f"   Login: admin / {ADMIN_PASSWORD}")
