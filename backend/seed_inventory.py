"""
Inventory dummy-data injector.

Drops ~30 varied rows into the live `inventory` table so the ERP has
realistic stock to drive POS, purchasing, manufacturing, reports and
low-stock alerts. Idempotent against name collisions — uses INSERT OR
IGNORE so re-running won't duplicate items.

Run from project root:
    python backend/seed_inventory.py
or with a specific DB path:
    DB_PATH=erp.db python backend/seed_inventory.py
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Run from project root so we hit the real erp.db, not backend/erp.db.
DB_PATH = os.environ.get("DB_PATH") or str(Path(__file__).resolve().parent.parent / "erp.db")

# (name, category, product_type, qty, min_stock, unit_cost, sale_price,
#  supplier, unit, barcode)
ITEMS = [
    # ─── Raw materials ────────────────────────────────────────────────────
    ("Pine Wood Plank 2.4m",   "Wood",         "raw_material", 120, 20, 14.50,  22.00, "Cedars Timber Co.",   "pcs", "RM-PINE-240"),
    ("Oak Wood Plank 2.4m",    "Wood",         "raw_material",  45, 15, 28.00,  42.00, "Cedars Timber Co.",   "pcs", "RM-OAK-240"),
    ("MDF Sheet 18mm",         "Wood",         "raw_material",  68, 25, 19.75,  31.00, "Cedars Timber Co.",   "sht", "RM-MDF-018"),
    ("Steel Tube 1\" x 6m",    "Metal",        "raw_material",  92, 30, 11.20,  17.50, "Atlas Steel",         "pcs", "RM-STL-100"),
    ("Steel Plate 3mm 1x2m",   "Metal",        "raw_material",  14, 10, 38.00,  58.00, "Atlas Steel",         "sht", "RM-STL-PLT3"),
    ("Aluminum Profile 6m",    "Metal",        "raw_material",  56, 20,  9.40,  14.50, "Atlas Steel",         "pcs", "RM-ALU-PRO"),
    ("Cotton Fabric Roll",     "Textile",      "raw_material",  18, 12, 65.00,  98.00, "Beirut Textile Mills","rl",  "RM-COT-ROL"),
    ("Leather Hide Black",     "Textile",      "raw_material",   7,  5, 145.00, 215.00,"Beirut Textile Mills","hide","RM-LTHR-BLK"),

    # ─── Consumables ──────────────────────────────────────────────────────
    ("Wood Screws 4x40 (100ct)","Hardware",    "consumable",   320, 100, 3.25,   5.50, "Phoenicia Hardware", "box", "C-SCR-4040"),
    ("Wood Glue 1L",           "Hardware",      "consumable",    42, 20, 5.80,   9.50, "Phoenicia Hardware", "btl", "C-GLU-1L"),
    ("Sandpaper 120g (10pk)",  "Hardware",      "consumable",   180, 50, 2.10,   4.00, "Phoenicia Hardware", "pk",  "C-SND-120"),
    ("Wood Stain Walnut 1L",   "Finishing",     "consumable",    34, 15, 12.50,  19.00, "Phoenicia Hardware", "btl", "C-STN-WAL"),
    ("Polyurethane Spray",     "Finishing",     "consumable",     8, 12, 8.75,   13.50, "Phoenicia Hardware", "can", "C-POLY-SPR"),  # below min
    ("Paint Roller Pack",      "Finishing",     "consumable",    24, 10, 4.50,   7.50, "Phoenicia Hardware", "pk",  "C-RLL-PK"),
    ("Masking Tape 25mm",      "Packaging",     "consumable",   145, 40, 1.85,   3.25, "Phoenicia Hardware", "rl",  "C-TPE-MSK"),
    ("Cardboard Box Large",    "Packaging",     "consumable",   210, 60, 1.20,   2.50, "Phoenicia Hardware", "pcs", "C-BOX-LG"),
    ("Bubble Wrap Roll 100m",  "Packaging",     "consumable",    16,  8, 18.00,  27.00, "Phoenicia Hardware", "rl",  "C-WRP-100"),

    # ─── Semi-finished ────────────────────────────────────────────────────
    ("Chair Frame Assembled",  "Sub-Assembly",  "semi_finished",  22, 10, 34.00, 0,     None,                  "pcs", "SF-CHR-FRM"),
    ("Table Leg Set (4)",      "Sub-Assembly",  "semi_finished",  18, 12, 28.50, 0,     None,                  "set", "SF-TBL-LGS"),
    ("Drawer Slide Kit",       "Sub-Assembly",  "semi_finished",  62, 20, 12.40, 0,     None,                  "kit", "SF-DRW-SLD"),
    ("Cabinet Door Blank",     "Sub-Assembly",  "semi_finished",   3, 15, 8.90,  0,     None,                  "pcs", "SF-CAB-DR"),  # critically low

    # ─── Finished goods (have sale_price set) ─────────────────────────────
    ("Dining Chair Walnut",    "Furniture",     "finished",       34, 10, 78.00, 145.00,None,                  "pcs", "FG-CHR-WAL"),
    ("Dining Chair Oak",       "Furniture",     "finished",       17,  8, 92.00, 175.00,None,                  "pcs", "FG-CHR-OAK"),
    ("4-Seat Dining Table",    "Furniture",     "finished",        6,  3, 285.00,495.00,None,                  "pcs", "FG-TBL-4ST"),
    ("6-Seat Dining Table",    "Furniture",     "finished",        4,  3, 365.00,625.00,None,                  "pcs", "FG-TBL-6ST"),
    ("Office Desk 140cm",      "Furniture",     "finished",       11,  5, 175.00,295.00,None,                  "pcs", "FG-DSK-140"),
    ("Bookshelf 5-tier",       "Furniture",     "finished",        9,  4, 142.00,235.00,None,                  "pcs", "FG-BKS-5T"),
    ("Bedside Cabinet",        "Furniture",     "finished",       21,  8, 95.00, 165.00,None,                  "pcs", "FG-BSD-CAB"),
    ("Coffee Table Round",     "Furniture",     "finished",        2,  6, 118.00,195.00,None,                  "pcs", "FG-CFE-RND"),  # critically low
    ("Wardrobe 2-Door",        "Furniture",     "finished",        5,  3, 320.00,545.00,None,                  "pcs", "FG-WRD-2D"),

    # ─── Retail / POS-friendly small items ────────────────────────────────
    ("Phone Charger USB-C",    "Electronics",   "finished",      150, 30, 4.20,   9.50, "Atlas Steel",         "pcs", "FG-CHG-USC"),
    ("Wireless Mouse",         "Electronics",   "finished",       62, 20, 8.50,  17.00, "Atlas Steel",         "pcs", "FG-MSE-WRL"),
    ("Notebook A4 Hardcover",  "Stationery",    "finished",      280, 80, 1.40,   3.50, "Phoenicia Hardware", "pcs", "FG-NBK-A4"),
    ("Ballpoint Pen Box (50)", "Stationery",    "finished",       95, 25, 6.80,  12.00, "Phoenicia Hardware", "box", "FG-PEN-BX50"),
]


def seed():
    if not os.path.exists(DB_PATH):
        sys.exit(f"DB not found at {DB_PATH}. Run the ERP once to initialise it first.")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Make sure the table exists and supports every column we write.
    existing_cols = {r["name"] for r in cur.execute("PRAGMA table_info(inventory)").fetchall()}
    required = {"name", "category", "product_type", "quantity", "min_stock",
                "unit_cost", "sale_price", "supplier", "unit", "barcode",
                "created_at"}
    missing = required - existing_cols
    if missing:
        sys.exit(f"Inventory table is missing columns: {missing}. "
                 f"Run database migrations first (start the ERP normally).")

    inserted = 0
    skipped = 0
    # Stagger created_at across the past 90 days so the items don't all
    # appear at the same instant — makes stock-movement and reports views
    # look more natural.
    base = datetime.now() - timedelta(days=90)

    for i, (name, category, ptype, qty, min_stock, cost, price,
            supplier, unit, barcode) in enumerate(ITEMS):
        # Skip if we already have a row with the same name (case-insensitive).
        existing = cur.execute(
            "SELECT id FROM inventory WHERE LOWER(name) = LOWER(?)",
            (name,),
        ).fetchone()
        if existing:
            skipped += 1
            continue

        created_at = (base + timedelta(days=i * 2.5)).strftime("%Y-%m-%d %H:%M:%S")
        cur.execute(
            """INSERT INTO inventory
                  (name, category, product_type, quantity, min_stock,
                   unit_cost, sale_price, supplier, unit, barcode, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, category, ptype, qty, min_stock, cost, price,
             supplier, unit, barcode, created_at),
        )
        inv_id = cur.lastrowid

        # Stamp an opening-stock movement so the inventory detail page has
        # an audit row to show — matches what the API would have logged if
        # the item had been created through the UI.
        cur.execute(
            """INSERT INTO stock_movements
                  (inventory_id, type, delta, qty_before, qty_after,
                   reference, note, created_at)
               VALUES (?, 'opening', ?, 0, ?, 'seed', 'Seeded opening stock', ?)""",
            (inv_id, qty, qty, created_at),
        )
        inserted += 1

    conn.commit()

    # Quick recap for the operator
    total = cur.execute("SELECT COUNT(*) FROM inventory").fetchone()[0]
    low   = cur.execute(
        "SELECT COUNT(*) FROM inventory WHERE quantity < min_stock AND archived_at IS NULL"
    ).fetchone()[0]
    value = cur.execute(
        "SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM inventory WHERE archived_at IS NULL"
    ).fetchone()[0]

    print(f"Inventory seeded into {DB_PATH}")
    print(f"  inserted: {inserted}")
    print(f"  skipped (already present): {skipped}")
    print(f"  total rows now: {total}")
    print(f"  low-stock items: {low}")
    print(f"  stock-on-hand value: ${value:,.2f}")
    conn.close()


if __name__ == "__main__":
    seed()
