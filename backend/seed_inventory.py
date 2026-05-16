"""
seed_inventory.py — creates the full schema and seeds only inventory items.

Usage:
    python seed_inventory.py              # uses erp.db in cwd
    DB_PATH=../erp.db python seed_inventory.py
"""

import sqlite3
import os
from datetime import datetime, timedelta

DB_PATH = os.environ.get("DB_PATH", "erp.db")


def ts(days_ago=0):
    dt = datetime.utcnow() - timedelta(days=days_ago)
    return dt.replace(hour=9, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def _init_schema(conn):
    """Create all tables (mirrors database.py) so every tab works."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT,
            role TEXT DEFAULT 'admin',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT,
            address TEXT, type TEXT DEFAULT 'private', notes TEXT,
            created_at TEXT, deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, client_id INTEGER REFERENCES clients(id),
            location TEXT, status TEXT DEFAULT 'Inquiry',
            start_date TEXT, end_date TEXT,
            estimated_cost REAL DEFAULT 0, actual_cost REAL DEFAULT 0,
            expected_revenue REAL DEFAULT 0,
            source_quotation_id INTEGER REFERENCES quotations(id),
            description TEXT, created_at TEXT, deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS quotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quote_number TEXT UNIQUE NOT NULL,
            project_id INTEGER REFERENCES projects(id),
            client_id  INTEGER REFERENCES clients(id),
            status TEXT DEFAULT 'Draft',
            notes TEXT, total REAL DEFAULT 0,
            created_at TEXT, deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS quotation_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            quantity REAL DEFAULT 1, unit_price REAL DEFAULT 0, total REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT UNIQUE NOT NULL,
            quotation_id INTEGER REFERENCES quotations(id),
            project_id   INTEGER REFERENCES projects(id),
            client_id    INTEGER REFERENCES clients(id),
            amount REAL DEFAULT 0, due_date TEXT, notes TEXT,
            created_at TEXT, deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS invoice_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            amount REAL NOT NULL, method TEXT DEFAULT 'Cash',
            note TEXT, paid_at TEXT
        );
        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, category TEXT,
            quantity REAL DEFAULT 0, min_stock REAL DEFAULT 0,
            unit_cost REAL DEFAULT 0, supplier TEXT,
            unit TEXT DEFAULT 'pcs', created_at TEXT,
            deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
            type TEXT NOT NULL, delta REAL NOT NULL,
            qty_before REAL NOT NULL, qty_after REAL NOT NULL,
            reference TEXT, note TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER REFERENCES projects(id),
            category TEXT NOT NULL, description TEXT,
            amount REAL DEFAULT 0, date TEXT,
            created_at TEXT, deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_number TEXT UNIQUE NOT NULL, supplier TEXT NOT NULL,
            inventory_id INTEGER REFERENCES inventory(id),
            product_name TEXT NOT NULL, quantity REAL NOT NULL,
            unit_cost REAL DEFAULT 0, additional_costs REAL DEFAULT 0,
            status TEXT DEFAULT 'Ordered',
            stock_updated INTEGER DEFAULT 0, expense_recorded INTEGER DEFAULT 0,
            notes TEXT, ordered_at TEXT, received_at TEXT, paid_at TEXT,
            deleted_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT
        );
    """)
    conn.commit()


def run():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    _init_schema(conn)
    c = conn.cursor()

    print("🌱  Seeding inventory …")

    # (name, category, qty, min_stock, unit_cost, supplier, unit)
    items = [
        ("Product A",   "Products",  100, 20,  15.00, "Supplier X", "pcs"),
        ("Product B",   "Products",   60, 15,  30.00, "Supplier X", "pcs"),
        ("Material A",  "Materials", 400, 50,   3.50, "Supplier Y", "kg"),
        ("Material B",  "Materials", 250, 40,   5.00, "Supplier Y", "kg"),
        ("Equipment A", "Equipment",   8,  2, 450.00, "Supplier Z", "pcs"),
        ("Equipment B", "Equipment",   3,  1, 800.00, "Supplier Z", "pcs"),
    ]

    for row in items:
        c.execute(
            "INSERT INTO inventory (name, category, quantity, min_stock, unit_cost, supplier, unit, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (*row, ts(30))
        )

    conn.commit()
    conn.close()

    print(f"  ✓ {len(items)} inventory items")
    print("\n✅  Done. Database:", DB_PATH)


if __name__ == "__main__":
    run()
