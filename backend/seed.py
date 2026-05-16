"""
seed.py — Demo data for NovaTech Solutions ERP
Scenario: a mid-size IT consultancy that sells hardware, software licences,
and professional services to enterprise clients.

Modules seeded: users (with roles), suppliers, clients, inventory, projects,
                quotations, invoices, purchases, stock movements, expenses,
                CRM, planning, HR (departments, employees, leave),
                approval policies, approval requests

Tables preserved: roles, role_permissions, settings, schema_migrations,
                  audit_log, accounting_periods, period_snapshots,
                  user_sessions, login_attempts

Run AFTER the app has been launched at least once (init_db must have run):
    python seed.py
    DB_PATH=../erp.db python seed.py
"""

import sqlite3
import os
import sys
import json
from datetime import datetime, timedelta, timezone

DB_PATH = os.environ.get("DB_PATH", "erp.db")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ── Helpers ───────────────────────────────────────────────────────────────────

def ts(days_ago=0, hour=9):
    """UTC timestamp string, N days in the past."""
    dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return dt.replace(hour=hour, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")

def d(offset=0):
    """Date-only string. Positive offset = past, negative = future."""
    return (datetime.now(timezone.utc) - timedelta(days=offset)).strftime("%Y-%m-%d")


# ══════════════════════════════════════════════════════════════════════════════
#  ADDITIONAL USERS  (admin created by setup — these are staff accounts)
# ══════════════════════════════════════════════════════════════════════════════
# Inserted with role lookup at runtime; see SEED_USERS list below.
# All demo passwords: "Password123!" — must_change_password=1 so they're
# prompted to set their own on first login.
SEED_USERS = [
    # (username, full_name, role_name, email)
    ("sarah.chen",    "Sarah Chen",    "Finance Manager",    "sarah.chen@novatech.com"),
    ("james.wilson",  "James Wilson",  "Manager",            "james.wilson@novatech.com"),
    ("linda.owens",   "Linda Owens",   "HR Manager",         "linda.owens@novatech.com"),
    ("tom.porter",    "Tom Porter",    "Sales Manager",      "tom.porter@novatech.com"),
    ("raj.kumar",     "Raj Kumar",     "Project Manager",    "raj.kumar@novatech.com"),
    ("david.kim",     "David Kim",     "Accountant",         "david.kim@novatech.com"),
    ("emma.hayes",    "Emma Hayes",    "Sales",              "emma.hayes@novatech.com"),
    ("carlos.vega",   "Carlos Vega",   "Operations Manager", "carlos.vega@novatech.com"),
]


# ══════════════════════════════════════════════════════════════════════════════
#  SUPPLIERS  (6)
# ══════════════════════════════════════════════════════════════════════════════
SUPPLIERS = [
    (1, "TechDirect Ltd",        "Alan Porter",    "+1-555-2101", "alan@techdirect.com",      30, "Primary hardware distributor — laptops, servers",          ts(120)),
    (2, "CloudBase Solutions",   "Nina Ross",      "+1-555-2102", "nina@cloudbase.io",        45, "Software licences and SaaS subscriptions",                 ts(115)),
    (3, "NetCore Systems",       "Raj Patel",      "+1-555-2103", "raj@netcore.com",          30, "Networking equipment — switches, routers, firewalls",      ts(110)),
    (4, "OfficePro Supplies",    "Carla Mendez",   "+1-555-2104", "carla@officepro.com",      15, "Office consumables, furniture, UPS units",                 ts(108)),
    (5, "ProAV & Peripherals",   "Tom Nguyen",     "+1-555-2105", "tom@proav.com",            30, "Cameras, AV equipment, peripherals",                       ts(105)),
    (6, "SwiftCourier Logistics","Donna Blake",    "+1-555-2106", "donna@swiftcourier.com",   14, "Freight and last-mile delivery for hardware shipments",     ts(100)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  CLIENTS  (8)
# ══════════════════════════════════════════════════════════════════════════════
CLIENTS = [
    (1, "Horizon Financial Group", "Horizon Financial Group",    "+1-555-3101", "it@horizonfinancial.com",   "14 Finance Tower, City A",     "corporate", "Tier-1 account. Annual hardware refresh cycle.",           ts(100)),
    (2, "Meridian Properties",     "Meridian Properties LLC",    "+1-555-3102", "tech@meridianprops.com",    "8 Business Park, City B",      "corporate", "Cloud-first migration in progress.",                       ts(95)),
    (3, "Apex Medical Center",     "Apex Medical Group",         "+1-555-3103", "admin@apexmedical.com",     "22 Health Boulevard, City C",  "corporate", "Strict compliance requirements (HIPAA-adjacent).",         ts(90)),
    (4, "Crestline Hotels",        "Crestline Hospitality Ltd",  "+1-555-3104", "ops@crestlinehotels.com",   "1 Grand Plaza, City D",        "corporate", "25 properties — phased POS rollout across sites.",         ts(88)),
    (5, "Urban Transit Corp",      "Urban Transit Corporation",  "+1-555-3105", "fleet@urbantransit.com",    "55 Depot Road, City E",        "corporate", "Fleet telemetry project completed. Strong reference.",      ts(85)),
    (6, "Sterling Law Associates", None,                         "+1-555-3106", "info@sterlinglaw.com",      "7 Court Street, City B",       "private",   "Small firm. Interested in cybersecurity audit.",            ts(80)),
    (7, "BrightPath Academy",      "BrightPath Education Group", "+1-555-3107", "tech@brightpathacademy.com","30 Campus Drive, City C",      "corporate", "eLearning platform delivered. Potential expansion next year.", ts(78)),
    (8, "NexGen Retail Group",     "NexGen Retail Ltd",          "+1-555-3108", "systems@nexgenretail.com",  "100 Mall Avenue, City F",      "corporate", "Exploring annual IT support contract. Draft quote sent.",   ts(70)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  INVENTORY  (12 items — qty starts at 0, built through purchases)
# ══════════════════════════════════════════════════════════════════════════════
INVENTORY = [
    ( 1, "Dell Latitude 5540 Laptop",       "Devices",     0,  5,  750.00, "TechDirect Ltd",      "pcs", ts(120)),
    ( 2, "HP ProLiant Server DL380",        "Devices",     0,  2, 2200.00, "TechDirect Ltd",      "pcs", ts(120)),
    ( 3, "Cisco Catalyst 2960 Switch",      "Networking",  0,  3,  650.00, "NetCore Systems",     "pcs", ts(118)),
    ( 4, "Fortinet Firewall FG-60F",        "Networking",  0,  2, 1800.00, "NetCore Systems",     "pcs", ts(115)),
    ( 5, "APC Smart-UPS 1500VA",            "Power",       0,  3,  380.00, "OfficePro Supplies",  "pcs", ts(112)),
    ( 6, "Microsoft 365 Business (annual)", "Software",    0, 10,  130.00, "CloudBase Solutions", "lic", ts(110)),
    ( 7, "Kaspersky Endpoint Security",     "Software",    0,  5,   65.00, "CloudBase Solutions", "lic", ts(108)),
    ( 8, "CAT6e Network Cable",             "Materials",   0, 50,    1.20, "NetCore Systems",     "m",   ts(105)),
    ( 9, "USB-C Hub Docking Station",       "Accessories", 0,  5,   48.00, "ProAV & Peripherals", "pcs", ts(103)),
    (10, "Logitech 4K Webcam",              "Accessories", 0,  5,   90.00, "ProAV & Peripherals", "pcs", ts(102)),
    (11, "Wireless Access Point (WAP)",     "Networking",  0,  4,  210.00, "NetCore Systems",     "pcs", ts(100)),
    (12, "External SSD 2TB",               "Storage",     0,  3,  145.00, "TechDirect Ltd",      "pcs", ts(98)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  PROJECTS  (7)
# ══════════════════════════════════════════════════════════════════════════════
PROJECTS = [
    (1, "Network Infrastructure Upgrade",  1, "Horizon Financial HQ, City A",   "Invoiced",
     d(85), d(45),   38000.00, 27700.00, 45000.00,
     None, "Full network overhaul — switches, servers, firewalls, structured cabling.", ts(90)),

    (2, "Cloud Office Migration",          2, "Meridian Properties, City B",     "In Progress",
     d(50), d(-40),  24000.00,  9700.00, 28500.00,
     None, "Migrate 120 seats to Microsoft 365, SharePoint, and Azure AD.",             ts(55)),

    (3, "IT Infrastructure Setup",         3, "Apex Medical Center, City C",     "Approved",
     d(-5), d(-65),  28000.00,     0.00, 32000.00,
     None, "End-to-end IT setup: workstations, servers, UPS, and secure network.",     ts(20)),

    (4, "POS & WiFi Rollout",              4, "Crestline Hotels (Phase 1), City D", "Invoiced",
     d(70), d(35),   14000.00, 12000.00, 18500.00,
     None, "POS system installation and WiFi coverage across 8 hotel properties.",     ts(75)),

    (5, "Fleet Tracking System",           5, "Urban Transit Depot, City E",     "Invoiced",
     d(90), d(55),    9000.00,  7000.00, 12000.00,
     None, "GPS telematics and driver-facing dashcams for 40-vehicle fleet.",          ts(95)),

    (6, "Cybersecurity Audit",             6, "Sterling Law Offices, City B",    "Inquiry",
     None, None,      7500.00,     0.00,  8500.00,
     None, "Network penetration test, policy review, and remediation report.",         ts(15)),

    (7, "eLearning Platform",              7, "BrightPath Academy, City C",      "Invoiced",
     d(80), d(18),   16000.00, 13250.00, 22000.00,
     None, "Custom eLearning portal: course authoring, student dashboards, video CDN.",ts(85)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  QUOTATIONS  (8)
# ══════════════════════════════════════════════════════════════════════════════
QUOTATIONS = [
    (1, "Q-2026-001", 1, 1, "Network Infrastructure Upgrade",
     "Accepted", "Accepted by Horizon Financial — network hardware and installation.",   45000.00, ts(92)),
    (2, "Q-2026-002", 2, 2, "Cloud Office Migration",
     "Accepted", "Accepted by Meridian Properties — Microsoft 365 migration.",          28500.00, ts(58)),
    (3, "Q-2026-003", 3, 3, "IT Infrastructure Setup",
     "Sent",     "Awaiting sign-off from Apex Medical procurement.",                    32000.00, ts(22)),
    (4, "Q-2026-004", 4, 4, "POS & WiFi Rollout",
     "Accepted", "Accepted — Phase 1 covers 8 properties.",                            18500.00, ts(77)),
    (5, "Q-2026-005", 5, 5, "Fleet Tracking System",
     "Accepted", "Accepted by Urban Transit — 40 units with 12-month support.",         12000.00, ts(97)),
    (6, "Q-2026-006", 6, 6, "Cybersecurity Audit",
     "Draft",    "Draft — pending scope confirmation from Sterling Law.",                8500.00, ts(16)),
    (7, "Q-2026-007", 7, 7, "eLearning Platform",
     "Accepted", "Accepted by BrightPath — full platform build and go-live.",           22000.00, ts(87)),
    (8, "Q-2026-008", None, 8, "Annual IT Support Contract",
     "Draft",    "Draft proposal for NexGen Retail managed-services contract.",          9600.00, ts(10)),
]

QUOTATION_ITEMS = [
    ( 1, 1, "Cisco Catalyst 2960 Switch",       20,   800.00, 16000.00),
    ( 2, 1, "HP ProLiant Server DL380",          4,  3200.00, 12800.00),
    ( 3, 1, "Fortinet Firewall FG-60F",          2,  2100.00,  4200.00),
    ( 4, 1, "Structured Cabling & Installation", 1, 12000.00, 12000.00),

    ( 5, 2, "Microsoft 365 Business (60 seats)", 1, 20000.00, 20000.00),
    ( 6, 2, "Azure AD Configuration & Training", 1,  5000.00,  5000.00),
    ( 7, 2, "Data Migration Services",           1,  3500.00,  3500.00),

    ( 8, 3, "Dell Latitude 5540 Laptop",        30,   800.00, 24000.00),
    ( 9, 3, "APC Smart-UPS 1500VA",              8,   500.00,  4000.00),
    (10, 3, "Network Setup & Configuration",     1,  4000.00,  4000.00),

    (11, 4, "POS Terminal (all-in-one)",         15,   900.00, 13500.00),
    (12, 4, "WiFi Access Points",                8,   375.00,  3000.00),
    (13, 4, "POS Integration & Training",        1,  2000.00,  2000.00),

    (14, 5, "GPS Fleet Tracking Device",        40,   200.00,  8000.00),
    (15, 5, "Driver-Facing Dashcam",            20,   100.00,  2000.00),
    (16, 5, "Platform Setup & 12-mo Support",    1,  2000.00,  2000.00),

    (17, 6, "Network Penetration Test",          1,  4500.00,  4500.00),
    (18, 6, "Security Policy Review & Report",   1,  2000.00,  2000.00),
    (19, 6, "Fortinet Firewall FG-60F",          1,  2000.00,  2000.00),

    (20, 7, "eLearning Platform Development",    1, 16000.00, 16000.00),
    (21, 7, "Content Authoring Tools & Setup",   1,  4000.00,  4000.00),
    (22, 7, "Go-Live Support & Training",        1,  2000.00,  2000.00),

    (23, 8, "Managed IT Support — Annual",       1,  7200.00,  7200.00),
    (24, 8, "Helpdesk Software Licence",         1,  2400.00,  2400.00),
]


# ══════════════════════════════════════════════════════════════════════════════
#  INVOICES  (6)
# ══════════════════════════════════════════════════════════════════════════════
INVOICES = [
    (1, "INV-2026-001", 1, 1, 1,  45000.00, d(30),  "Network Infrastructure Upgrade — final invoice.",         1, None, None, ts(60)),
    (2, "INV-2026-002", 2, 2, 2,  14250.00, d(-15), "Cloud Migration — milestone 1 (50% of project value).",  1, None, None, ts(28)),
    (3, "INV-2026-003", 4, 4, 4,  18500.00, d(8),   "POS & WiFi Rollout — full project invoice.",             1, None, None, ts(40)),
    (4, "INV-2026-004", 5, 5, 5,  12000.00, d(28),  "Fleet Tracking System — project completion invoice.",    1, None, None, ts(58)),
    (5, "INV-2026-005", 7, 7, 7,  22000.00, d(20),  "eLearning Platform — delivery and go-live invoice.",     1, None, None, ts(25)),
    (6, "INV-2026-006", 3, 3, 3,  16000.00, d(-20), "IT Infrastructure Setup — mobilisation payment (50%).", 1, None, None, ts(12)),
]

INVOICE_ITEMS = [
    ( 1, 1, "Cisco Catalyst 2960 Switch",        20,   800.00),
    ( 2, 1, "HP ProLiant Server DL380",           4,  3200.00),
    ( 3, 1, "Fortinet Firewall FG-60F",           2,  2100.00),
    ( 4, 1, "Structured Cabling & Installation",  1, 12000.00),

    ( 5, 2, "Microsoft 365 Business (60 seats)",  1, 10000.00),
    ( 6, 2, "Azure AD & Migration Services M1",   1,  4250.00),

    ( 7, 3, "POS Terminal (all-in-one)",          15,   900.00),
    ( 8, 3, "WiFi Access Points",                  8,   375.00),
    ( 9, 3, "POS Integration & Training",          1,  2000.00),

    (10, 4, "GPS Fleet Tracking Device",          40,   200.00),
    (11, 4, "Driver-Facing Dashcam",              20,   100.00),
    (12, 4, "Platform Setup & 12-mo Support",      1,  2000.00),

    (13, 5, "eLearning Platform Development",      1, 16000.00),
    (14, 5, "Content Tools & Go-Live Support",     1,  6000.00),

    (15, 6, "IT Infrastructure Mobilisation",      1, 16000.00),
]

# INV-001: $45,000 paid → Paid
# INV-002: $7,000 paid  → Partial
# INV-003: $18,500 paid → Paid
# INV-004: $12,000 paid → Paid
# INV-005: $22,000 paid → Paid
# INV-006: $0 paid      → Unpaid
INVOICE_PAYMENTS = [
    (1, 1, 45000.00, "Bank Transfer", "Full settlement — Horizon Financial",          None, ts(28)),
    (2, 2,  7000.00, "Bank Transfer", "Milestone 1 partial payment — Meridian",       None, ts(14)),
    (3, 3, 10000.00, "Bank Transfer", "Initial payment — Crestline Hotels",           None, ts(38)),
    (4, 3,  8500.00, "Bank Transfer", "Final payment — Crestline Hotels",             None, ts(25)),
    (5, 4, 12000.00, "Bank Transfer", "Full settlement — Urban Transit Corp",         None, ts(45)),
    (6, 5, 22000.00, "Bank Transfer", "Full settlement — BrightPath Academy",         None, ts(12)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  PURCHASES  (8 POs)
# ══════════════════════════════════════════════════════════════════════════════
PURCHASES = [
    (1, "PO-2026-001", "TechDirect Ltd",      1,  1, "Dell Latitude 5540 Laptop",   50, 750.00,    0.0, "Paid",     1, 1, "Laptop stock for project deployments",       ts(110), ts(105), ts(100)),
    (2, "PO-2026-002", "NetCore Systems",      3,  3, "Cisco Catalyst 2960 Switch",  30, 650.00,  500.0, "Paid",     1, 1, "Switches for Horizon + general stock",       ts(100), ts(95),  ts(90)),
    (3, "PO-2026-003", "NetCore Systems",      3,  4, "Fortinet Firewall FG-60F",    5, 1800.00,   0.0, "Paid",     1, 1, "Firewalls — Horizon project + reserves",     ts(98),  ts(93),  ts(88)),
    (4, "PO-2026-004", "CloudBase Solutions",  2,  6, "Microsoft 365 (annual lic)", 100, 130.00,   0.0, "Paid",     1, 1, "MS365 licences — Meridian + future projects",ts(75),  ts(70),  ts(65)),
    (5, "PO-2026-005", "TechDirect Ltd",       1,  2, "HP ProLiant Server DL380",    8, 2200.00, 800.0, "Received", 1, 0, "Servers — received, awaiting payment",       ts(95),  ts(90),  None),
    (6, "PO-2026-006", "NetCore Systems",      3, 11, "Wireless Access Point",       25,  210.00,  0.0, "Ordered",  0, 0, "WAPs for upcoming Apex Medical deployment",   ts(18),  None,    None),
    (7, "PO-2026-007", "ProAV & Peripherals",  5, 10, "Logitech 4K Webcam",          40,   90.00,  0.0, "Paid",     1, 1, "Webcams for Urban Fleet dashcam system",     ts(108), ts(103), ts(98)),
    (8, "PO-2026-008", "OfficePro Supplies",   4,  5, "APC Smart-UPS 1500VA",        10,  380.00,  0.0, "Paid",     1, 1, "UPS units — office and server room",         ts(85),  ts(80),  ts(75)),
]

STOCK_MOVEMENTS = [
    ( 1,  1, "purchase",   +50,   0,  50, "PO-2026-001", "Dell Laptops received — PO-2026-001",       ts(105)),
    ( 2,  3, "purchase",   +30,   0,  30, "PO-2026-002", "Cisco Switches received — PO-2026-002",     ts(95)),
    ( 3,  4, "purchase",    +5,   0,   5, "PO-2026-003", "Fortinet Firewalls received — PO-2026-003", ts(93)),
    ( 4,  6, "purchase",  +100,   0, 100, "PO-2026-004", "MS365 licences received — PO-2026-004",     ts(70)),
    ( 5,  2, "purchase",    +8,   0,   8, "PO-2026-005", "HP Servers received — PO-2026-005",         ts(90)),
    ( 6, 10, "purchase",   +40,   0,  40, "PO-2026-007", "Logitech Webcams received — PO-2026-007",   ts(103)),
    ( 7,  5, "purchase",   +10,   0,  10, "PO-2026-008", "APC UPS units received — PO-2026-008",      ts(80)),

    ( 8,  2, "project_use", -2,   8,   6, "PRJ-1", "HP Servers deployed — Horizon Network Upgrade",  ts(78)),
    ( 9,  3, "project_use",-20,  30,  10, "PRJ-1", "Cisco Switches deployed — Horizon Network",      ts(78)),
    (10,  4, "project_use", -1,   5,   4, "PRJ-1", "Fortinet Firewall deployed — Horizon Network",   ts(77)),
    (11,  6, "project_use",-50, 100,  50, "PRJ-2", "MS365 licences issued — Meridian Cloud Mig.",    ts(45)),
    (12,  1, "project_use",-10,  50,  40, "PRJ-4", "Dell Laptops deployed — Crestline Hotels POS",   ts(58)),
    (13, 10, "project_use",-20,  40,  20, "PRJ-5", "Webcams installed — Urban Fleet Dashcam Sys.",   ts(72)),
    (14,  1, "project_use", -5,  40,  35, "PRJ-7", "Dell Laptops issued — BrightPath Academy",       ts(30)),
    (15,  5, "project_use", -2,  10,   8, "PRJ-3", "APC UPS units staged — Apex Medical setup",      ts(10)),
]

INVENTORY_QTY_UPDATE = [
    (35,  1),  # Dell Laptops
    ( 6,  2),  # HP Servers
    (10,  3),  # Cisco Switches
    ( 4,  4),  # Fortinet Firewalls
    ( 8,  5),  # APC UPS
    (50,  6),  # MS365 licences
    ( 0,  7),  # Kaspersky — no purchase
    ( 0,  8),  # CAT6e Cable — no purchase
    ( 0,  9),  # USB-C Hub — no purchase
    (20, 10),  # Logitech Webcams
    ( 0, 11),  # WAP — ordered, not received
    ( 0, 12),  # External SSD — no purchase
]


# ══════════════════════════════════════════════════════════════════════════════
#  EXPENSES  (23)
# ══════════════════════════════════════════════════════════════════════════════
# id, project_id, category, description, amount, date, created_at
EXPENSES = [
    # Purchase cost allocations
    ( 1, None, "Purchase", "Dell Laptops ×50 — PO-2026-001",                  37500.00, d(100), ts(100)),
    ( 2, None, "Purchase", "Cisco Switches ×30 — PO-2026-002 (incl. freight)", 20000.00, d(90),  ts(90)),
    ( 3, None, "Purchase", "Fortinet Firewalls ×5 — PO-2026-003",              9000.00, d(88),  ts(88)),
    ( 4, None, "Purchase", "Microsoft 365 ×100 — PO-2026-004",                13000.00, d(65),  ts(65)),
    ( 5, None, "Purchase", "Logitech Webcams ×40 — PO-2026-007",               3600.00, d(98),  ts(98)),
    ( 6, None, "Purchase", "APC UPS ×10 — PO-2026-008",                        3800.00, d(75),  ts(75)),

    # Project 1 — Horizon Network Upgrade  (actual: 27,700)
    ( 7, 1, "Materials", "Cisco Switches ×20 used — Horizon Network",         13000.00, d(78),  ts(78)),
    ( 8, 1, "Materials", "HP Servers ×2 deployed — Horizon Network",           4400.00, d(78),  ts(78)),
    ( 9, 1, "Materials", "Fortinet Firewall ×1 — Horizon Network",             1800.00, d(77),  ts(77)),
    (10, 1, "Labor",     "Network engineers (3 staff × 12 days) — Horizon",    8500.00, d(72),  ts(72)),

    # Project 2 — Meridian Cloud Migration (actual: 9,700)
    (11, 2, "Materials", "MS365 licences ×50 — Meridian Cloud",                6500.00, d(45),  ts(45)),
    (12, 2, "Labor",     "Cloud architects (2 staff × 10 days) — Meridian",    3200.00, d(30),  ts(30)),

    # Project 4 — Crestline Hotels POS (actual: 12,000)
    (13, 4, "Materials", "Dell Laptops ×10 deployed — Crestline POS",          7500.00, d(58),  ts(58)),
    (14, 4, "Labor",     "POS setup technicians (2 × 8 days) — Crestline",     4500.00, d(52),  ts(52)),

    # Project 5 — Urban Fleet Tracking (actual: 7,000)
    (15, 5, "Materials", "Webcams ×20 installed — Urban Fleet",                1800.00, d(72),  ts(72)),
    (16, 5, "Labor",     "Fleet systems engineers (2 × 15 days) — Urban",      5200.00, d(65),  ts(65)),

    # Project 7 — BrightPath eLearning (actual: 13,250)
    (17, 7, "Materials", "Dell Laptops ×5 — BrightPath Academy",               3750.00, d(30),  ts(30)),
    (18, 7, "Labor",     "eLearning developers (3 × 18 days) — BrightPath",    9500.00, d(22),  ts(22)),

    # General overhead
    (19, None, "Utilities", "Office electricity — Q1 2026",                      820.00, d(75),  ts(75)),
    (20, None, "Rent",      "Office rent — March 2026",                         2200.00, d(60),  ts(60)),
    (21, None, "Rent",      "Office rent — April 2026",                         2200.00, d(30),  ts(30)),
    (22, None, "Travel",    "Site assessment visit — Apex Medical Center",         450.00, d(14),  ts(14)),
    (23, None, "Travel",    "Conference — IT Infrastructure Summit 2026",        1250.00, d(20),  ts(20)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  CRM — LEADS  (5)
# ══════════════════════════════════════════════════════════════════════════════
CRM_LEADS = [
    (1, "Zara Ahmed",   "GlobalPrime Bank",        "z.ahmed@globalprime.com",   "+1-555-4101",
     "conference", "Qualified",   85,  65000.00, d(-30), 1, "Met at FinTech Expo. Full network refresh across 3 offices.", None, None, ts(45)),

    (2, "Jing Wei",     "SunMedia Group",           "jing.wei@sunmedia.com",    "+1-555-4102",
     "web",        "New",         25,   8000.00, d(-60), 1, "Web form enquiry — needs IT support contract quote.",        None, None, ts(12)),

    (3, "Sam Rivera",   "TechVenture Labs",         "srivera@techventure.io",   "+1-555-4103",
     "referral",   "Contacted",   55,  15000.00, d(-45), 1, "Referred by Horizon Financial. Dev environment setup.",      None, None, ts(30)),

    (4, "Omar Hassan",  "FreshMart Supermarkets",   "o.hassan@freshmart.com",   "+1-555-4104",
     "cold_call",  "Proposal",    70,  25000.00, d(-20), 1, "Interested in POS modernisation across 12 branches.",        None, None, ts(22)),

    (5, "Priya Nair",   "EduWorld Foundation",      "priya@eduworld.org",       "+1-555-4105",
     "social",     "Won",        100,  12000.00, d(10),  1, "Converted — signed contract for online learning portal.",    None, None, ts(50)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  CRM — CONTACTS  (6)
# ══════════════════════════════════════════════════════════════════════════════
CRM_CONTACTS = [
    (1, 1,    None, "James Wilson",   "CFO",             "j.wilson@horizonfinancial.com", "+1-555-5101", 1, "Primary decision-maker for IT spend at Horizon.", None, ts(85)),
    (2, 2,    None, "Sarah Chen",     "IT Director",     "s.chen@meridianprops.com",      "+1-555-5102", 1, "Leading the cloud migration internally.",          None, ts(50)),
    (3, 4,    None, "Marcus Scott",   "Operations Mgr",  "m.scott@crestlinehotels.com",   "+1-555-5103", 1, "Manages IT rollout across hotel properties.",      None, ts(70)),
    (4, None, 1,    "Zara Ahmed",     "Head of IT",      "z.ahmed@globalprime.com",       "+1-555-4101", 1, "Lead contact — GlobalPrime Bank.",                 None, ts(45)),
    (5, None, 4,    "Omar Hassan",    "IT Manager",      "o.hassan@freshmart.com",        "+1-555-4104", 1, "Lead contact — FreshMart Supermarkets.",           None, ts(22)),
    (6, 7,    None, "Linda Owens",    "Academy Director","l.owens@brightpathacademy.com", "+1-555-5104", 1, "Final sign-off authority for BrightPath.",         None, ts(80)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  CRM — ACTIVITIES  (8)
# ══════════════════════════════════════════════════════════════════════════════
CRM_ACTIVITIES = [
    (1, "call",    "Discovery call — GlobalPrime Bank",
     "Discussed current network pain-points and 3-office expansion plans.",
     None, 1, 4, 1, d(43), ts(43, 14), "Very positive. Requested detailed proposal by end of week.", None, ts(43)),

    (2, "meeting", "On-site demo — GlobalPrime Bank",
     "Presented network refresh solution to IT team and CFO.",
     None, 1, 4, 1, d(35), ts(35, 10), "Board approved budget. Moving to negotiation.", None, ts(35)),

    (3, "email",   "Proposal sent — FreshMart Supermarkets",
     "Sent POS modernisation proposal covering 12 branches.",
     None, 4, 5, 1, d(18), ts(18, 9), "Proposal delivered. Awaiting feedback.", None, ts(18)),

    (4, "call",    "Follow-up call — TechVenture Labs",
     "Checked in on dev environment requirements — need GPU servers.",
     None, 3, None, 1, d(25), ts(25, 11), "Needs revised quote with GPU server option.", None, ts(25)),

    (5, "meeting", "Project kick-off — Meridian Cloud Migration",
     "Kick-off meeting with Meridian IT team. Confirmed scope and timeline.",
     2, None, 2, 1, d(48), ts(48, 9), "Kick-off successful. Migration plan signed off.", None, ts(48)),

    (6, "call",    "Quarterly review — Horizon Financial",
     "Q1 review with James Wilson. Discussed potential WiFi upgrade in Q3.",
     1, None, 1, 1, d(10), ts(10, 11), "Wilson keen on WiFi expansion. Send brief proposal.", None, ts(10)),

    (7, "task",    "Prepare Apex Medical proposal — internal",
     "Compile final BOM and commercials for Apex Medical IT setup quote.",
     3, None, None, 1, d(-5), None, None, None, ts(8)),

    (8, "email",   "Follow-up — NexGen Retail managed services",
     "Sent follow-up email with updated SLA terms and pricing breakdown.",
     8, None, None, 1, d(5), ts(5, 10), "Client confirmed interest. Contract review underway.", None, ts(6)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  CRM — DEALS  (4)
# ══════════════════════════════════════════════════════════════════════════════
CRM_DEALS = [
    (1, "GlobalPrime Bank — Full IT Overhaul",
     None, 1, None, "Negotiation", 65000.00, 70, d(-25),
     None, None, None, 1, "3-office network refresh. Budget approved. Legal reviewing contract.", None, ts(35)),

    (2, "FreshMart — POS Modernisation",
     None, 4, None, "Proposal", 25000.00, 45, d(-20),
     None, None, None, 1, "12-branch rollout. Competing with one other vendor.", None, ts(20)),

    (3, "TechVenture Labs — Dev Environment Setup",
     None, 3, None, "Qualification", 15000.00, 30, d(-45),
     None, None, None, 1, "Needs GPU server option. Revised quote in progress.", None, ts(28)),

    (4, "NexGen Retail — Annual IT Support",
     8, None, 8, "Won", 9600.00, 100, d(10),
     ts(5), None, None, 1, "Contract signed. Service commences next month.", None, ts(10)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  PLANNING — PROJECTS  (3)
# ══════════════════════════════════════════════════════════════════════════════
PLANNING_PROJECTS = [
    (1, "Q3 Infrastructure Upgrades",
     "Internal quarterly upgrade: new server rack, network refresh, endpoint rollout.",
     None, "#4f8ef7", d(30), d(-60), "Active", 1, None, ts(32)),

    (2, "Meridian Cloud Migration",
     "Full Microsoft 365 and Azure AD migration for 120 Meridian Properties staff.",
     2, "#10b981", d(50), d(-40), "Active", 1, None, ts(55)),

    (3, "BrightPath eLearning Platform",
     "Custom LMS build: course authoring, student portal, video CDN, admin dashboard.",
     7, "#8b5cf6", d(80), d(18), "Completed", 1, None, ts(85)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  PLANNING — MILESTONES  (4)
# ══════════════════════════════════════════════════════════════════════════════
PLANNING_MILESTONES = [
    (1, 2, "Phase 1 Migration Complete",       d(18),  ts(16), ts(52)),
    (2, 2, "Full Go-Live & UAT Sign-off",      d(-25), None,   ts(52)),
    (3, 1, "New Server Rack Fully Operational",d(-40), None,   ts(32)),
    (4, 3, "Platform Go-Live",                 d(18),  ts(18), ts(85)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  PLANNING — TASKS  (14)
# ══════════════════════════════════════════════════════════════════════════════
PLANNING_TASKS = [
    # ── Q3 Internal Upgrades (project 1) ──
    ( 1, 1, "Audit existing hardware inventory",
      "Full inventory audit — servers, endpoints, network gear.",
      1, "Done", "High", d(30), d(25), 100, None, None, None, 1, None, ts(30)),

    ( 2, 1, "Procure server rack and network gear",
      "Raise POs for new HP servers, Cisco switches, and rack enclosure.",
      1, "Done", "High", d(24), d(12), 100, None, 1, None, 2, None, ts(30)),

    ( 3, 1, "Install and configure server rack",
      "Physical rack installation, cabling, OS provisioning, baseline config.",
      1, "In Progress", "Critical", d(11), d(-15), 55, 3, 2, None, 3, None, ts(30)),

    ( 4, 1, "Endpoint OS refresh — all staff laptops",
      "Re-image or upgrade 35 staff laptops to latest OS and security baseline.",
      1, "To Do", "Medium", d(-5), d(-35), 0, None, 3, None, 4, None, ts(30)),

    ( 5, 1, "Staff IT induction training",
      "Half-day training session on new tools and security policy.",
      1, "To Do", "Low", d(-30), d(-40), 0, 3, 4, None, 5, None, ts(30)),

    # ── Meridian Cloud Migration (project 2) ──
    ( 6, 2, "Discovery & current-state assessment",
      "Document existing email, file shares, AD structure, and licencing.",
      1, "Done", "High", d(50), d(44), 100, None, None, None, 1, None, ts(55)),

    ( 7, 2, "Azure AD and 365 tenant setup",
      "Provision tenant, configure domains, MFA, conditional access policies.",
      1, "Done", "High", d(43), d(36), 100, None, 6, None, 2, None, ts(55)),

    ( 8, 2, "Mailbox migration — Phase 1 (60 users)",
      "Migrate first cohort of 60 mailboxes using Mover; validate and test.",
      1, "Done", "High", d(35), d(20), 100, 1, 7, None, 3, None, ts(55)),

    ( 9, 2, "Mailbox migration — Phase 2 (60 users)",
      "Migrate remaining 60 mailboxes; decommission legacy mail server.",
      1, "In Progress", "High", d(19), d(-10), 70, 2, 8, None, 4, None, ts(55)),

    (10, 2, "SharePoint and Teams rollout",
      "Configure SharePoint sites, Teams structure, and staff training.",
      1, "To Do", "Medium", d(-8), d(-25), 0, 2, 9, None, 5, None, ts(55)),

    (11, 2, "UAT and go-live sign-off",
      "User acceptance testing with Meridian IT team; final sign-off.",
      1, "To Do", "Critical", d(-26), d(-38), 0, 2, 10, None, 6, None, ts(55)),

    # ── BrightPath eLearning (project 3 — Completed) ──
    (12, 3, "Requirements gathering and wireframes",
      "Workshop with BrightPath team; agree feature set and UI wireframes.",
      1, "Done", "High", d(80), d(72), 100, None, None, None, 1, None, ts(85)),

    (13, 3, "Platform development and content tools",
      "Build LMS core, course authoring module, video upload pipeline.",
      1, "Done", "High", d(70), d(30), 100, None, 12, None, 2, None, ts(85)),

    (14, 3, "Go-live and handover",
      "Production deployment, DNS cutover, client handover and training.",
      1, "Done", "High", d(25), d(18), 100, 4, 13, None, 3, None, ts(85)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  HR — DEPARTMENTS  (6)
# ══════════════════════════════════════════════════════════════════════════════
# id, name, description, archived_at, archive_reason, created_at
HR_DEPARTMENTS = [
    (1, "Engineering & IT",    "Software development, infrastructure, and technical support.", None, None, ts(180)),
    (2, "Finance & Accounting","Financial planning, reporting, payroll, and compliance.",       None, None, ts(180)),
    (3, "Sales & Marketing",   "Revenue generation, client acquisition, and brand.",            None, None, ts(180)),
    (4, "Operations",          "Delivery management, logistics, and service operations.",       None, None, ts(180)),
    (5, "Human Resources",     "Talent acquisition, employee relations, and HR strategy.",      None, None, ts(180)),
    (6, "Administration",      "Office management, legal, and executive support.",              None, None, ts(180)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  HR — EMPLOYEES  (14)
# ══════════════════════════════════════════════════════════════════════════════
# id, employee_code, full_name, job_title, department_id, employment_type, status,
# hire_date, end_date, email, phone, salary, manager_id, user_id,
# address, notes, archived_at, archive_reason, created_at
HR_EMPLOYEES = [
    # Engineering & IT (dept 1)
    (1,  "EMP-0001", "Raj Kumar",      "Head of Engineering",    1, "Full-time", "Active",
     d(730), None, "raj.kumar@novatech.com",    "+1-555-6101", 9500.00,  None, None,
     "45 Tech Avenue, City A", "Head of Engineering — oversees all technical delivery.", None, None, ts(730)),

    (2,  "EMP-0002", "Amara Osei",     "Senior Developer",       1, "Full-time", "Active",
     d(540), None, "amara.osei@novatech.com",   "+1-555-6102", 7200.00,  1,    None,
     "12 Oak Street, City A",  "Full-stack developer, team lead on eLearning platform.", None, None, ts(540)),

    (3,  "EMP-0003", "Felix Zhang",    "Network Engineer",       1, "Full-time", "Active",
     d(400), None, "felix.zhang@novatech.com",  "+1-555-6103", 6800.00,  1,    None,
     "88 Park Road, City A",   "Cisco-certified, led Horizon and Apex network projects.", None, None, ts(400)),

    (4,  "EMP-0004", "Nadia Brooks",   "IT Support Specialist",  1, "Full-time", "Active",
     d(300), None, "nadia.brooks@novatech.com", "+1-555-6104", 4500.00,  1,    None,
     "3 Elm Close, City B",    "Level-2 support, endpoint management.", None, None, ts(300)),

    # Finance & Accounting (dept 2)
    (5,  "EMP-0005", "Sarah Chen",     "Finance Manager",        2, "Full-time", "Active",
     d(900), None, "sarah.chen@novatech.com",   "+1-555-6105", 10000.00, None, None,
     "22 Finance Plaza, City A","Oversees all finance, invoicing, payroll, and reporting.", None, None, ts(900)),

    (6,  "EMP-0006", "David Kim",      "Accountant",             2, "Full-time", "Active",
     d(500), None, "david.kim@novatech.com",    "+1-555-6106", 6000.00,  5,    None,
     "17 Maple Drive, City A", "Day-to-day bookkeeping, AP/AR, expense processing.", None, None, ts(500)),

    # Sales & Marketing (dept 3)
    (7,  "EMP-0007", "Tom Porter",     "Sales Manager",          3, "Full-time", "Active",
     d(800), None, "tom.porter@novatech.com",   "+1-555-6107", 9000.00,  None, None,
     "5 Commercial Way, City B","Leads all sales — manages pipeline, key accounts, and CRM.", None, None, ts(800)),

    (8,  "EMP-0008", "Emma Hayes",     "Sales Executive",        3, "Full-time", "Active",
     d(360), None, "emma.hayes@novatech.com",   "+1-555-6108", 5500.00,  7,    None,
     "9 Market Street, City B", "Handles SMB clients, quotations, and follow-ups.", None, None, ts(360)),

    # Operations (dept 4)
    (9,  "EMP-0009", "Carlos Vega",    "Operations Manager",     4, "Full-time", "Active",
     d(700), None, "carlos.vega@novatech.com",  "+1-555-6109", 8500.00,  None, None,
     "33 Logistics Park, City C","Oversees project delivery, scheduling, and vendor relations.", None, None, ts(700)),

    (10, "EMP-0010", "James Wilson",   "Senior Project Manager", 4, "Full-time", "Active",
     d(600), None, "james.wilson@novatech.com", "+1-555-6110", 8000.00,  9,    None,
     "14 Bridge Road, City A",  "PMP-certified. Manages Meridian, Apex, and BrightPath.", None, None, ts(600)),

    (11, "EMP-0011", "Priya Singh",    "Procurement Officer",    4, "Full-time", "Active",
     d(420), None, "priya.singh@novatech.com",  "+1-555-6111", 5800.00,  9,    None,
     "6 Warehouse Road, City C","Handles all supplier POs, stock intake, and cost control.", None, None, ts(420)),

    # Human Resources (dept 5)
    (12, "EMP-0012", "Linda Owens",    "HR Manager",             5, "Full-time", "Active",
     d(850), None, "linda.owens@novatech.com",  "+1-555-6112", 9200.00,  None, None,
     "20 Corporate Drive, City A","Leads HR strategy, recruitment, and people development.", None, None, ts(850)),

    (13, "EMP-0013", "Kevin Park",     "HR Coordinator",         5, "Full-time", "Active",
     d(280), None, "kevin.park@novatech.com",   "+1-555-6113", 4800.00,  12,   None,
     "11 Greenfield Terrace, City B","Leave management, onboarding, and HR administration.", None, None, ts(280)),

    # Administration (dept 6)
    (14, "EMP-0014", "Diana Foster",   "Office Administrator",   6, "Full-time", "Active",
     d(650), None, "diana.foster@novatech.com", "+1-555-6114", 4200.00,  None, None,
     "2 Reception Lane, City A", "Front-office, facilities, and executive scheduling.", None, None, ts(650)),
]

# ══════════════════════════════════════════════════════════════════════════════
#  HR — LEAVE REQUESTS  (10)
# ══════════════════════════════════════════════════════════════════════════════
# id, employee_id, leave_type, start_date, end_date, days, reason, status,
# reviewed_by, reviewed_at, review_note, created_at
HR_LEAVE = [
    # Approved leaves (past)
    (1,  2,  "Annual",   d(50), d(44), 5,  "Annual family vacation.",              "Approved", None, ts(55, 10), None,                                  ts(58)),
    (2,  3,  "Annual",   d(40), d(36), 3,  "Personal travel — pre-booked.",        "Approved", None, ts(42, 9),  None,                                  ts(44)),
    (3,  8,  "Sick",     d(30), d(28), 3,  "Flu recovery — doctor's note.",        "Approved", None, ts(31, 8),  None,                                  ts(31)),
    (4,  6,  "Annual",   d(20), d(15), 4,  "Wedding attendance — abroad.",         "Approved", None, ts(22, 9),  None,                                  ts(24)),
    (5,  4,  "Annual",   d(10), d(8),  3,  "Short break — staycation.",            "Approved", None, ts(12, 10), None,                                  ts(13)),

    # Rejected
    (6,  11, "Annual",   d(5),  d(-5), 8,  "Long break during Apex project.",      "Rejected", None, ts(6, 14),  "Declined — critical delivery period.", ts(8)),

    # Pending (awaiting review)
    (7,  2,  "Annual",   d(-10), d(-5), 4, "Short break before project kick-off.", "Pending",  None, None,       None,                                  ts(2)),
    (8,  13, "Sick",     d(-1),  d(-1), 1, "Medical appointment — half day.",      "Pending",  None, None,       None,                                  ts(1)),
    (9,  8,  "Maternity",d(-30), d(-120),65,"Maternity leave — first child.",      "Pending",  None, None,       None,                                  ts(3)),
    (10, 10, "Annual",   d(-15), d(-10), 4,"Annual leave — family trip.",          "Pending",  None, None,       None,                                  ts(4)),
]


# ══════════════════════════════════════════════════════════════════════════════
#  APPROVAL POLICIES  (4)
# ══════════════════════════════════════════════════════════════════════════════
# id, name, description, module, trigger_action, condition_logic,
# conditions (JSON), approval_type, approver_roles (JSON), steps (JSON),
# is_active, priority, created_by, created_at, updated_at
APPROVAL_POLICIES = [
    (
        1,
        "High-Value Purchase Approval",
        "Any purchase order above $5,000 requires sign-off from Finance Manager then Manager.",
        "purchases", "create", "AND",
        json.dumps([{"field": "amount", "operator": "gt", "value": "5000"}]),
        "multi_step", "[]",
        json.dumps([{"step": 1, "role": "Finance Manager"}, {"step": 2, "role": "Manager"}]),
        1, 10, 1,
        ts(60), ts(60),
    ),
    (
        2,
        "Overhead Expense Review",
        "General overhead expenses above $1,000 require Finance Manager approval.",
        "expenses", "create", "AND",
        json.dumps([{"field": "amount", "operator": "gt", "value": "1000"}]),
        "single",
        json.dumps(["Finance Manager"]),
        "[]",
        1, 5, 1,
        ts(60), ts(60),
    ),
    (
        3,
        "Invoice Void Authorization",
        "Voiding any invoice requires Finance Manager and Manager sign-off.",
        "invoices", "void", "AND",
        json.dumps([]),
        "multi_step", "[]",
        json.dumps([{"step": 1, "role": "Finance Manager"}, {"step": 2, "role": "Manager"}]),
        1, 20, 1,
        ts(60), ts(60),
    ),
    (
        4,
        "Large Quotation Sign-off",
        "Quotations above $20,000 require Sales Manager and Manager approval.",
        "quotations", "create", "AND",
        json.dumps([{"field": "total", "operator": "gt", "value": "20000"}]),
        "multi_step", "[]",
        json.dumps([{"step": 1, "role": "Sales Manager"}, {"step": 2, "role": "Manager"}]),
        1, 8, 1,
        ts(60), ts(60),
    ),
]


# ══════════════════════════════════════════════════════════════════════════════
#  APPROVAL REQUESTS + STEPS  (5 requests)
# ══════════════════════════════════════════════════════════════════════════════
# Manually constructed to represent realistic approval states.
# User IDs: admin=1, sarah.chen=2, james.wilson=3, linda.owens=4,
#           tom.porter=5, raj.kumar=6, david.kim=7, emma.hayes=8, carlos.vega=9
# (IDs above assume the 8 SEED_USERS insert in order after admin.)

APPROVAL_REQUESTS = [
    # Columns: id, policy_id, policy_name, module, entity_id, entity_label,
    #          trigger_action, entity_snapshot, status, approval_type,
    #          current_step, total_steps, requested_by, requested_at,
    #          resolved_at, resolved_by, resolution_comment

    # 1 — PO-2026-005 ($19,400) → approved by Finance Mgr, then Manager
    (1, 1, "High-Value Purchase Approval", "purchases", 5,
     "PO-2026-005: HP ProLiant Server DL380 ×8 — $19,400",
     "create", None, "approved", "multi_step", 2, 2,
     1, ts(95), ts(88, 14), None, "All steps completed — approved."),

    # 2 — PO-2026-002 ($20,000 incl. freight) → approved by Finance Mgr, then Manager
    (2, 1, "High-Value Purchase Approval", "purchases", 2,
     "PO-2026-002: Cisco Catalyst 2960 Switch ×30 — $20,000",
     "create", None, "approved", "multi_step", 2, 2,
     1, ts(100), ts(93, 11), None, "Approved for Horizon project."),

    # 3 — Conference travel expense ($1,250) → pending Finance Manager
    (3, 2, "Overhead Expense Review", "expenses", 23,
     "Travel: IT Infrastructure Summit 2026 — $1,250",
     "create", None, "pending", "single", 1, 1,
     1, ts(20), None, None, None),

    # 4 — INV-2026-006 void request → step 1 approved, step 2 pending
    (4, 3, "Invoice Void Authorization", "invoices", 6,
     "INV-2026-006: IT Infrastructure Setup mobilisation — $16,000 void",
     "void", None, "pending", "multi_step", 2, 2,
     1, ts(10), None, None, None),

    # 5 — Q-2026-003 ($32,000) → Sales Manager approved, Manager still pending
    (5, 4, "Large Quotation Sign-off", "quotations", 3,
     "Q-2026-003: IT Infrastructure Setup — $32,000",
     "create", None, "pending", "multi_step", 2, 2,
     1, ts(22), None, None, None),
]

# (id, request_id, step_number, approver_role, approver_user_id, status, acted_at, comment)
APPROVAL_STEPS = [
    # (id, request_id, step_number, approver_role, approver_user_id_placeholder,
    #  status, acted_at, comment)
    # approver_user_id is resolved dynamically in run() via username lookup

    # Request 1 (fully approved — 2 steps)
    (1,  1, 1, "Finance Manager", None, "approved", ts(92, 10), "Budget within Q2 capex plan — approved."),
    (2,  1, 2, "Manager",         None, "approved", ts(91, 14), "Confirmed delivery schedule — approved."),

    # Request 2 (fully approved — 2 steps)
    (3,  2, 1, "Finance Manager", None, "approved", ts(98, 9),  "PO aligns with project budget — approved."),
    (4,  2, 2, "Manager",         None, "approved", ts(97, 11), "Critical for Horizon project — approved."),

    # Request 3 (pending — 1 step, still waiting)
    (5,  3, 1, "Finance Manager", None, "pending",  None,       None),

    # Request 4 (step 1 approved, step 2 pending)
    (6,  4, 1, "Finance Manager", None, "approved", ts(9, 15),  "Invoice disputed — void appropriate."),
    (7,  4, 2, "Manager",         None, "pending",  None,       None),

    # Request 5 (step 1 approved, step 2 pending)
    (8,  5, 1, "Sales Manager",   None, "approved", ts(21, 10), "Quote margins acceptable — approved."),
    (9,  5, 2, "Manager",         None, "pending",  None,       None),
]


# ══════════════════════════════════════════════════════════════════════════════
#  RUNNER
# ══════════════════════════════════════════════════════════════════════════════

def run():
    from database import init_db
    from auth_utils import hash_password
    init_db()

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = OFF")
    c = conn.cursor()

    # ── Clear existing business data (children first) ─────────────────────────
    print("Clearing existing business data ...")
    for tbl in [
        "approval_steps", "approval_requests", "approval_policies",
        "hr_leave_requests", "hr_employees", "hr_departments",
        "planning_tasks", "planning_milestones", "planning_projects",
        "crm_deals", "crm_activities", "crm_contacts", "crm_leads",
        "invoice_payments", "invoice_items", "invoices",
        "stock_movements", "purchases",
        "expenses",
        "quotation_items", "quotations",
        "projects",
        "clients",
        "inventory",
        "suppliers",
    ]:
        try:
            c.execute(f"DELETE FROM {tbl}")
            c.execute("DELETE FROM sqlite_sequence WHERE name=?", (tbl,))
        except sqlite3.OperationalError:
            pass

    conn.commit()

    # ── Suppliers ─────────────────────────────────────────────────────────────
    print("  suppliers ...")
    c.executemany(
        "INSERT INTO suppliers (id, name, contact_name, phone, email, payment_terms_days, notes, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)", SUPPLIERS)

    # ── Clients ───────────────────────────────────────────────────────────────
    print("  clients ...")
    c.executemany(
        "INSERT INTO clients (id, name, company, phone, email, address, type, notes, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)", CLIENTS)

    # ── Inventory (qty=0 — built through purchases) ───────────────────────────
    print("  inventory ...")
    c.executemany(
        "INSERT INTO inventory (id, name, category, quantity, min_stock, unit_cost, supplier, unit, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)", INVENTORY)

    # ── Projects ──────────────────────────────────────────────────────────────
    print("  projects ...")
    c.executemany(
        "INSERT INTO projects (id, name, client_id, location, status, start_date, end_date, "
        "estimated_cost, actual_cost, expected_revenue, source_quotation_id, description, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", PROJECTS)

    # ── Quotations ────────────────────────────────────────────────────────────
    print("  quotations ...")
    c.executemany(
        "INSERT INTO quotations (id, quote_number, project_id, client_id, project_name, "
        "status, notes, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)", QUOTATIONS)
    c.executemany(
        "INSERT INTO quotation_items (id, quotation_id, name, quantity, unit_price, total) "
        "VALUES (?,?,?,?,?,?)", QUOTATION_ITEMS)

    for proj_id, quot_id in [(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),(7,7)]:
        c.execute("UPDATE projects SET source_quotation_id=? WHERE id=?", (quot_id, proj_id))

    # ── Invoices ──────────────────────────────────────────────────────────────
    print("  invoices ...")
    c.executemany(
        "INSERT INTO invoices (id, invoice_number, quotation_id, project_id, client_id, "
        "amount, due_date, notes, version, voided_at, void_reason, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", INVOICES)
    c.executemany(
        "INSERT INTO invoice_items (id, invoice_id, name, quantity, unit_price) "
        "VALUES (?,?,?,?,?)", INVOICE_ITEMS)
    c.executemany(
        "INSERT INTO invoice_payments (id, invoice_id, amount, method, note, idempotency_key, paid_at) "
        "VALUES (?,?,?,?,?,?,?)", INVOICE_PAYMENTS)

    # ── Purchases ─────────────────────────────────────────────────────────────
    print("  purchases ...")
    c.executemany(
        "INSERT INTO purchases (id, po_number, supplier, supplier_id, inventory_id, product_name, "
        "quantity, unit_cost, additional_costs, status, stock_updated, expense_recorded, "
        "notes, ordered_at, received_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", PURCHASES)

    # ── Stock movements ───────────────────────────────────────────────────────
    print("  stock movements ...")
    c.executemany(
        "INSERT INTO stock_movements (id, inventory_id, type, delta, qty_before, qty_after, "
        "reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)", STOCK_MOVEMENTS)
    c.executemany("UPDATE inventory SET quantity=? WHERE id=?", INVENTORY_QTY_UPDATE)

    # ── Expenses ──────────────────────────────────────────────────────────────
    print("  expenses ...")
    c.executemany(
        "INSERT INTO expenses (id, project_id, category, description, amount, date, created_at) "
        "VALUES (?,?,?,?,?,?,?)", EXPENSES)

    # ── CRM ───────────────────────────────────────────────────────────────────
    print("  crm leads ...")
    c.executemany(
        "INSERT INTO crm_leads (id, name, company, email, phone, source, status, score, "
        "estimated_value, expected_close, assigned_to, notes, client_id, archived_at, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", CRM_LEADS)

    print("  crm contacts ...")
    c.executemany(
        "INSERT INTO crm_contacts (id, client_id, lead_id, name, title, email, phone, "
        "is_primary, notes, archived_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", CRM_CONTACTS)

    print("  crm activities ...")
    c.executemany(
        "INSERT INTO crm_activities (id, type, subject, description, client_id, lead_id, "
        "contact_id, user_id, due_date, done_at, outcome, archived_at, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", CRM_ACTIVITIES)

    print("  crm deals ...")
    c.executemany(
        "INSERT INTO crm_deals (id, title, client_id, lead_id, quotation_id, stage, value, "
        "probability, expected_close, won_at, lost_at, lost_reason, assigned_to, notes, "
        "archived_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", CRM_DEALS)

    # ── Planning ──────────────────────────────────────────────────────────────
    print("  planning projects ...")
    c.executemany(
        "INSERT INTO planning_projects (id, name, description, client_id, color, "
        "start_date, end_date, status, created_by, archived_at, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)", PLANNING_PROJECTS)

    print("  planning milestones ...")
    c.executemany(
        "INSERT INTO planning_milestones (id, project_id, name, due_date, reached_at, created_at) "
        "VALUES (?,?,?,?,?,?)", PLANNING_MILESTONES)

    print("  planning tasks ...")
    c.executemany(
        "INSERT INTO planning_tasks (id, project_id, name, description, assigned_to, status, "
        "priority, start_date, end_date, progress, milestone_id, depends_on, color, "
        "sort_order, archived_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", PLANNING_TASKS)

    # ── HR ────────────────────────────────────────────────────────────────────
    print("  hr departments ...")
    c.executemany(
        "INSERT INTO hr_departments (id, name, description, archived_at, archive_reason, created_at) "
        "VALUES (?,?,?,?,?,?)", HR_DEPARTMENTS)

    print("  hr employees ...")
    c.executemany(
        "INSERT INTO hr_employees (id, employee_code, full_name, job_title, department_id, "
        "employment_type, status, hire_date, end_date, email, phone, salary, manager_id, "
        "user_id, address, notes, archived_at, archive_reason, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", HR_EMPLOYEES)

    print("  hr leave requests ...")
    c.executemany(
        "INSERT INTO hr_leave_requests (id, employee_id, leave_type, start_date, end_date, "
        "days, reason, status, reviewed_by, reviewed_at, review_note, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", HR_LEAVE)

    # ── Additional users ──────────────────────────────────────────────────────
    # Insert staff accounts (skip if username already exists)
    print("  users ...")
    demo_pw = hash_password("Password123!")
    for username, full_name, role_name, email in SEED_USERS:
        existing = c.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if existing:
            continue
        role_row = c.execute("SELECT id FROM roles WHERE name=?", (role_name,)).fetchone()
        role_id  = role_row[0] if role_row else None
        c.execute(
            "INSERT INTO users (username, password_hash, full_name, role, role_id, email, "
            "is_active, is_superadmin, must_change_password, created_at) "
            "VALUES (?,?,?,?,?,?,1,0,1,?)",
            (username, demo_pw, full_name, role_name, role_id, email, ts(60))
        )

    conn.commit()

    # Link HR employees to their system user accounts
    print("  linking employees to users ...")
    user_links = [
        ("sarah.chen",   5),   # EMP-0005
        ("james.wilson", 10),  # EMP-0010
        ("linda.owens",  12),  # EMP-0012
        ("tom.porter",   7),   # EMP-0007
        ("raj.kumar",    1),   # EMP-0001
        ("david.kim",    6),   # EMP-0006
        ("emma.hayes",   8),   # EMP-0008
        ("carlos.vega",  9),   # EMP-0009
    ]
    for username, emp_id in user_links:
        user_row = c.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if user_row:
            c.execute("UPDATE hr_employees SET user_id=? WHERE id=?", (user_row[0], emp_id))

    # ── Approval Policies ─────────────────────────────────────────────────────
    print("  approval policies ...")
    c.executemany(
        "INSERT INTO approval_policies (id, name, description, module, trigger_action, "
        "condition_logic, conditions, approval_type, approver_roles, steps, is_active, "
        "priority, created_by, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", APPROVAL_POLICIES)

    # ── Approval Requests ─────────────────────────────────────────────────────
    print("  approval requests ...")
    # admin user is always id=1; use it as requested_by for all demo requests
    c.executemany(
        "INSERT INTO approval_requests (id, policy_id, policy_name, module, entity_id, "
        "entity_label, trigger_action, entity_snapshot, status, approval_type, current_step, "
        "total_steps, requested_by, requested_at, resolved_at, resolved_by, resolution_comment) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", APPROVAL_REQUESTS)

    # Resolve acting user IDs dynamically so steps reference correct users
    print("  approval steps ...")
    u_finance = c.execute("SELECT id FROM users WHERE username='sarah.chen'").fetchone()
    u_manager = c.execute("SELECT id FROM users WHERE username='james.wilson'").fetchone()
    u_sales   = c.execute("SELECT id FROM users WHERE username='tom.porter'").fetchone()
    uid_finance = u_finance[0] if u_finance else None
    uid_manager = u_manager[0] if u_manager else None
    uid_sales   = u_sales[0]   if u_sales   else None

    # APPROVAL_STEPS placeholders: (id, request_id, step_number, approver_role,
    #                               approver_user_id, status, acted_at, comment)
    resolved_steps = []
    for row in APPROVAL_STEPS:
        sid, req_id, step_num, role, _uid, status, acted_at, comment = row
        if role == "Finance Manager":
            uid = uid_finance
        elif role == "Manager":
            uid = uid_manager
        elif role == "Sales Manager":
            uid = uid_sales
        else:
            uid = None
        # Only set user_id when step was actually acted on
        resolved_steps.append((sid, req_id, step_num, role,
                                uid if status == "approved" else None,
                                status, acted_at, comment))

    c.executemany(
        "INSERT INTO approval_steps (id, request_id, step_number, approver_role, "
        "approver_user_id, status, acted_at, comment) "
        "VALUES (?,?,?,?,?,?,?,?)", resolved_steps)

    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    conn.close()

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\nDone. NovaTech Solutions demo data loaded.\n")
    print(f"  {len(SEED_USERS)}  staff users          Finance Mgr, Manager, HR Mgr, Sales Mgr, Proj Mgr, Accountant, Sales, Ops Mgr")
    print(f"  {len(SUPPLIERS)}  suppliers            TechDirect, CloudBase, NetCore, OfficePro, ProAV, SwiftCourier")
    print(f"  {len(CLIENTS)}  clients              Horizon Financial, Meridian, Apex Medical, Crestline, + 4 more")
    print(f"  {len(INVENTORY)} inventory items      Laptops, servers, switches, firewalls, licences, webcams …")
    print(f"  {len(PROJECTS)}  projects             Invoiced ×3 | In Progress ×1 | Approved ×1 | Inquiry ×1")
    print(f"  {len(QUOTATIONS)}  quotations           Accepted ×4 | Sent ×1 | Draft ×2")
    print(f"  {len(INVOICES)}  invoices             Paid ×4 | Partial ×1 | Unpaid ×1")
    print(f"  {len(PURCHASES)}  purchases            Paid ×5 | Received ×1 | Ordered ×1")
    print(f"  {len(STOCK_MOVEMENTS)} stock movements      7 purchase receipts + 8 project deployments")
    print(f"  {len(EXPENSES)} expenses             Purchases, labor, materials, overhead, travel")
    print(f"  {len(CRM_LEADS)}  CRM leads            Won ×1 | Proposal ×1 | Qualified ×1 | Contacted ×1 | New ×1")
    print(f"  {len(CRM_CONTACTS)}  CRM contacts         Linked to clients and leads")
    print(f"  {len(CRM_ACTIVITIES)}  CRM activities       Calls, meetings, emails, tasks")
    print(f"  {len(CRM_DEALS)}  CRM deals            Won ×1 | Negotiation ×1 | Proposal ×1 | Qualification ×1")
    print(f"  {len(PLANNING_PROJECTS)}  planning projects    Active ×2 | Completed ×1")
    print(f"  {len(PLANNING_MILESTONES)}  planning milestones  Past ×2 | Future ×2")
    print(f"  {len(PLANNING_TASKS)} planning tasks       Done ×8 | In Progress ×2 | To Do ×4")
    print(f"  {len(HR_DEPARTMENTS)}  HR departments       Eng&IT, Finance, Sales, Ops, HR, Admin")
    print(f"  {len(HR_EMPLOYEES)} HR employees         Active ×14 across 6 departments")
    print(f"  {len(HR_LEAVE)} HR leave requests    Approved ×5 | Rejected ×1 | Pending ×4")
    print(f"  {len(APPROVAL_POLICIES)}  approval policies    Purchase, Expense, Invoice Void, Quotation")
    print(f"  {len(APPROVAL_REQUESTS)}  approval requests    Approved ×2 | Pending ×3")
    print(f"\n  Database: {DB_PATH}")
    print(f"\n  Demo user password: Password123! (all staff accounts, must change on first login)")


if __name__ == "__main__":
    run()
