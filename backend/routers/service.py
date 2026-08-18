"""
Service — maintenance, installation and repair jobs.

For businesses that do work ON a machine rather than only selling goods. Two
entities:

  * **equipment** — a customer-owned machine. A real record rather than a text
    field on the job, so it accumulates a service history you can read back.
  * **jobs** — one piece of work that HAS BEEN DONE, carrying lines that are
    either a stocked PART (consumes inventory, has a cost) or a flat CHARGE
    (labour, callout, fee).

A job is a record of completed work, not a plan. Recording one consumes its
parts, posts their cost and raises the invoice in a single step, because by the
time anyone types it in the technician has already fitted the parts and gone
home. There is no draft, no scheduling and no start/finish ladder: those states
existed to describe work in flight, and this module does not track work in
flight.

The correction for a mistake is CANCEL, which puts the parts back, reverses the
cost and voids the invoice. Editing is deliberately absent — the lines are the
record of what was consumed and billed, and rewriting them after the fact would
mean reconciling stock and the ledger against a moving target.

Deliberately absent: hours and timesheets (labour is flat-fee), maintenance
contracts, scheduling, and a printed work order. Each was considered and left
out to keep the module something a small business can actually use.

**Revenue is recognised on payment, not on completion** — the same cash basis
as the rest of the product. A completed but unpaid job therefore shows its parts
cost with no matching revenue until the invoice is paid. That timing gap is
pre-existing across POS and invoices; it is called out here so the first
accountant who notices gets an answer instead of raising a ticket.

Money flows out through the ledger in two places:
  * completing a job relieves inventory (DR 5000 COGS / CR 1200 Inventory)
  * paying its invoice recognises revenue, split across 4000 for parts and
    4100 for labour (see accounting.revenue_split)
"""
import sqlite3
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import branch_access
import warehouse_access
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify

router = APIRouter()

# ── Vocabulary ───────────────────────────────────────────────────────────────
# Job types are a validated tuple rather than a lookup table: four values that
# describe the shape of the work, not a taxonomy a customer needs to extend. The
# `categories` registry already exists if one ever does.
JOB_TYPES = ("Installation", "Maintenance", "Repair", "Inspection")

# Two states, because a job either happened or was entered by mistake. The
# values are unchanged from the longer ladder this replaced, so no stored row
# needs rewriting.
ST_COMPLETED = "Completed"
ST_CANCELLED = "Cancelled"

# There is no 'Invoiced' status: whether a job has been billed is derived from
# invoices.service_job_id, so it cannot drift when an invoice is voided.

LINE_PART   = "part"
LINE_CHARGE = "charge"


# ── Models ───────────────────────────────────────────────────────────────────

class EquipmentBody(BaseModel):
    client_id:     int
    name:          str
    manufacturer:  Optional[str] = None
    model:         Optional[str] = None
    serial_number: Optional[str] = None
    install_date:  Optional[str] = None
    location:      Optional[str] = None
    inventory_id:  Optional[int] = None
    notes:         Optional[str] = None
    branch_id:     Optional[int] = None


class JobLine(BaseModel):
    line_type:    str = LINE_CHARGE
    inventory_id: Optional[int] = None
    name:         str
    quantity:     float = 1
    unit_price:   float = 0
    discount:     float = 0
    discount_pct: Optional[float] = None
    tax_rate_id:  Optional[int] = None


class JobBody(BaseModel):
    client_id:      int
    equipment_id:   Optional[int] = None
    job_type:       str = "Repair"
    # When the work was done. Defaults to today, but is settable because a
    # technician often writes up yesterday's visit this morning.
    service_date:   Optional[str] = None
    assigned_to:    Optional[int] = None
    reported_fault: Optional[str] = None
    work_done:      Optional[str] = None
    warehouse_id:   Optional[int] = None
    branch_id:      Optional[int] = None
    items:          List[JobLine] = []


class CancelBody(BaseModel):
    reason: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _job_prefix(db) -> str:
    row = db.execute(
        "SELECT value FROM settings WHERE key='service_job_prefix'").fetchone()
    return (row["value"] if row and row["value"] else "SVC-")


def _placeholder_number() -> str:
    """A unique stand-in so the row can be inserted before its number is known.

    Same trick as invoices: the real number is derived from the row's own id, so
    two concurrent creates cannot collide the way MAX(id)+1 does.
    """
    import uuid
    return f"__pending__{uuid.uuid4().hex}"


def _finalize_number(db, job_id: int, prefix: str) -> str:
    number = f"{prefix}{datetime.utcnow().year}-{job_id:04d}"
    db.execute("UPDATE service_jobs SET job_number=? WHERE id=?", (number, job_id))
    return number


def _get_job(db, job_id: int, user):
    job = db.execute("SELECT * FROM service_jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise HTTPException(404, "Service job not found")
    # Branch scoping: the list is filtered, but an id in the URL was not — 404
    # rather than 403 so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, job["branch_id"])
    return job


def _get_equipment(db, eq_id: int, user):
    eq = db.execute("SELECT * FROM service_equipment WHERE id=?", (eq_id,)).fetchone()
    if not eq:
        raise HTTPException(404, "Equipment not found")
    branch_access.assert_can_view_branch(user, db, eq["branch_id"])
    return eq


def _validate_lines(db, items) -> None:
    """A part line must name a stock item; a charge line must not.

    Enforced here rather than by a CHECK constraint: the two dialects disagree
    on CHECK syntax enough that the constraint would be more trouble than the
    single call site it guards.
    """
    for it in items:
        if it.line_type not in (LINE_PART, LINE_CHARGE):
            raise HTTPException(400, f"Unknown line type '{it.line_type}'.")
        if it.line_type == LINE_PART:
            if not it.inventory_id:
                raise HTTPException(400, f"'{it.name}' is a part line and needs a stock item.")
            if not db.execute("SELECT 1 FROM inventory WHERE id=?",
                              (it.inventory_id,)).fetchone():
                raise HTTPException(400, f"Stock item for '{it.name}' not found.")
            if float(it.quantity or 0) <= 0:
                raise HTTPException(400, f"'{it.name}' needs a quantity greater than zero.")
        elif it.inventory_id:
            raise HTTPException(
                400, f"'{it.name}' is a charge, so it cannot point at a stock item.")


def _replace_lines(db, job_id: int, items) -> None:
    db.execute("DELETE FROM service_job_lines WHERE job_id=?", (job_id,))
    for n, it in enumerate(items):
        db.execute(
            "INSERT INTO service_job_lines "
            "(job_id, line_type, inventory_id, name, quantity, unit_price, discount, "
            " discount_pct, tax_rate_id, line_no) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (job_id, it.line_type, it.inventory_id, it.name, it.quantity,
             it.unit_price, it.discount or 0, it.discount_pct, it.tax_rate_id, n),
        )


def _reprice(db, job_id: int) -> dict:
    """Roll the job's lines up into its header totals.

    Uses the invoice pricing helper, so a job and the invoice raised from it can
    never disagree about what the customer owes: same discount handling, same
    tax-on-the-discounted-net rule, same cent rounding.
    """
    from types import SimpleNamespace
    from routers.invoices import _price_items

    rows = db.execute(
        "SELECT id, line_type, inventory_id, name, quantity, unit_price, discount, "
        "       discount_pct, tax_rate_id FROM service_job_lines "
        "WHERE job_id=? ORDER BY line_no, id", (job_id,)).fetchall()
    items = [SimpleNamespace(**dict(r)) for r in rows]
    subtotal, tax_total, total, line_tax = _price_items(db, items, 0)

    # Snapshot the resolved tax back onto each line, keyed by id so the write
    # cannot land on the wrong row.
    for row, (rid, rate, tax_amt) in zip(rows, line_tax):
        db.execute(
            "UPDATE service_job_lines SET tax_rate_id=?, tax_rate=?, tax_amount=? "
            "WHERE id=?", (rid, rate, tax_amt, row["id"]))

    db.execute(
        "UPDATE service_jobs SET subtotal=?, tax_total=?, total=?, updated_at=? "
        "WHERE id=?", (subtotal, tax_total, total, _now(), job_id))
    return {"subtotal": subtotal, "tax_total": tax_total, "total": total}


def _job_dict(db, job) -> dict:
    d = dict(job)
    d["lines"] = [dict(r) for r in db.execute(
        "SELECT * FROM service_job_lines WHERE job_id=? ORDER BY line_no, id",
        (job["id"],)).fetchall()]
    client = db.execute("SELECT name FROM clients WHERE id=?", (job["client_id"],)).fetchone()
    d["client_name"] = client["name"] if client else None
    if job["equipment_id"]:
        eq = db.execute("SELECT name, model, serial_number FROM service_equipment "
                        "WHERE id=?", (job["equipment_id"],)).fetchone()
        d["equipment"] = dict(eq) if eq else None
    else:
        d["equipment"] = None
    # Billing state is derived, never stored — see the module note.
    inv = db.execute(
        "SELECT id, invoice_number, voided_at FROM invoices WHERE service_job_id=?",
        (job["id"],)).fetchone()
    d["invoice"] = dict(inv) if inv else None
    return d


# ── Equipment ────────────────────────────────────────────────────────────────

def _wants_invoice(db) -> bool:
    row = db.execute(
        "SELECT value FROM settings WHERE key='service_auto_invoice'").fetchone()
    return (row["value"] if row else "1") not in ("0", "", "false")


def _part_totals(db, job_id: int) -> dict:
    """{inventory_id: total quantity} across the job's part lines.

    Summed per ITEM, not per line: two lines of three against five on hand must
    fail the stock check together, or the item is oversold.
    """
    rows = db.execute(
        "SELECT inventory_id, quantity FROM service_job_lines "
        "WHERE job_id=? AND line_type=?", (job_id, LINE_PART)).fetchall()
    totals: dict = {}
    for r in rows:
        totals[r["inventory_id"]] = totals.get(r["inventory_id"], 0) + float(r["quantity"] or 0)
    return totals


def _consume_parts(db, job, user, now: str) -> float:
    """Take the job's parts out of stock and recognise their cost.

    Every part is checked before a single write, so a service that cannot be
    stocked is refused whole rather than half-recorded. Valuation goes through
    `lots.value_stock_out`, the helper POS and manufacturing already use, so
    FIFO/LIFO/weighted-average and lot tracking behave identically here — a
    second cost calculation is how two modules come to disagree about what the
    same item cost.
    """
    import accounting
    import lots
    import warehouse_access as wha
    from utils import money

    job_id = job["id"]
    needed = _part_totals(db, job_id)
    if not needed:
        return 0.0

    rows = {r["id"]: r for r in db.execute(
        "SELECT id, name, quantity, unit, min_stock FROM inventory "
        f"WHERE id IN ({','.join('?' * len(needed))})", tuple(needed)).fetchall()}
    short = [f"{rows[i]['name']} (need {q}, have {rows[i]['quantity']})"
             for i, q in needed.items()
             if i in rows and float(rows[i]["quantity"] or 0) < q]
    if short:
        raise HTTPException(400, "Not enough stock for this service: " + "; ".join(short))

    wid = wha.default_warehouse_id_for_row(db, job["warehouse_id"])
    cogs_total = 0.0
    for inv_id, qty in needed.items():
        row = rows[inv_id]
        qty_before = float(row["quantity"])
        qty_after = round(qty_before - qty, 6)
        cogs_total += lots.value_stock_out(db, inv_id, qty, source_type="service",
                                           source_ref=job["job_number"], now=now)
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id, warehouse_id=wid, delta=-qty)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
            " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, "service", -qty, qty_before, qty_after, job["job_number"],
             "Service job parts", wid, now))
        min_stock = float(row["min_stock"] or 0)
        if min_stock > 0 and qty_after <= min_stock:
            notify(db, type="low_stock",
                   title=f"Low stock alert: {row['name']}",
                   body=f"Only {qty_after} {row['unit'] or 'units'} remaining "
                        f"(minimum: {min_stock})",
                   link="/inventory", entity_type="inventory", entity_id=inv_id,
                   dedup_hours=24)

    cogs_total = money(cogs_total)
    if cogs_total > 0:
        accounting.post_entry(
            db,
            entry_date=now[:10],
            memo=f"Service parts — {job['job_number']}",
            lines=[
                {"code": accounting.COGS,      "debit":  cogs_total},
                {"code": accounting.INVENTORY, "credit": cogs_total},
            ],
            source_type="service_cogs", source_id=job_id,
            created_by=user["id"], branch_id=job["branch_id"],
        )
    db.execute("UPDATE service_jobs SET parts_cost=?, updated_at=? WHERE id=?",
               (cogs_total, now, job_id))
    return cogs_total


def _return_parts(db, job, user, now: str) -> float:
    """Put the parts back and reverse the cost. The inverse of _consume_parts.

    The reversal goes through accounting.reverse_source rather than an opposite
    entry posted by hand: that helper also marks the original `reversed`, and
    post_entry is idempotent against the LIVE entry — a hand-rolled opposite
    leaves the original posted, so a later service on the same id would silently
    post nothing.
    """
    import accounting
    import lots
    import warehouse_access as wha
    from utils import money

    job_id = job["id"]
    returned = _part_totals(db, job_id)
    wid = wha.default_warehouse_id_for_row(db, job["warehouse_id"])
    cost = money(job["parts_cost"] or 0)
    total_qty = sum(returned.values())

    for inv_id, qty in returned.items():
        row = db.execute("SELECT quantity FROM inventory WHERE id=?", (inv_id,)).fetchone()
        if not row:
            continue
        qty_before = float(row["quantity"])
        qty_after = round(qty_before + qty, 6)
        # Back in at the cost it left at, so returning a part cannot invent
        # margin.
        unit_cost = (cost / total_qty) if total_qty else 0
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id, warehouse_id=wid, delta=qty)
        lots.record_stock_in(db, inv_id, qty, unit_cost,
                             source_type="service_cancel",
                             source_ref=job["job_number"], now=now)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
            " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, "service_return", qty, qty_before, qty_after,
             job["job_number"], "Service cancelled", wid, now))

    accounting.reverse_source(
        db, "service_cogs", job_id,
        entry_date=now[:10],
        memo=f"Service parts returned — {job['job_number']}",
        created_by=user["id"],
    )
    return cost


@router.get("/equipment")
def list_equipment(
    client_id: Optional[int] = None,
    search: Optional[str] = None,
    include_archived: bool = False,
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    where, params = ["1=1"], []
    if not include_archived:
        where.append("e.archived_at IS NULL")
    if client_id:
        where.append("e.client_id = ?")
        params.append(client_id)
    if search:
        like = f"%{search.strip()}%"
        where.append("(e.name LIKE ? OR e.model LIKE ? OR e.serial_number LIKE ? "
                     "OR e.manufacturer LIKE ?)")
        params += [like, like, like, like]
    bf, bp = branch_access.branch_filter(user, db, column="e.branch_id")
    if bf:
        # branch_filter returns a fragment with a leading " AND "; this list
        # joins with its own, so the prefix has to come off.
        where.append(bf[len(" AND "):])
        params += bp

    rows = db.execute(
        "SELECT e.*, c.name AS client_name, "
        "  (SELECT COUNT(*) FROM service_jobs j WHERE j.equipment_id = e.id) AS job_count "
        "FROM service_equipment e LEFT JOIN clients c ON c.id = e.client_id "
        f"WHERE {' AND '.join(where)} ORDER BY e.name",
        params).fetchall()
    return [dict(r) for r in rows]


@router.post("/equipment")
def create_equipment(
    data: EquipmentBody,
    user=Depends(require_perm("service", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute("SELECT 1 FROM clients WHERE id=?", (data.client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    if not (data.name or "").strip():
        raise HTTPException(400, "Equipment needs a name.")
    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    now = _now()
    cur = db.execute(
        "INSERT INTO service_equipment "
        "(client_id, name, manufacturer, model, serial_number, install_date, location, "
        " inventory_id, notes, branch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (data.client_id, data.name.strip(), data.manufacturer, data.model,
         data.serial_number, data.install_date, data.location, data.inventory_id,
         data.notes, branch_id, now),
    )
    eq_id = cur.lastrowid
    log_action(db, user, "create", "service_equipment", eq_id, data.name)
    db.commit()
    return {"id": eq_id, "message": "Equipment added"}


@router.get("/equipment/{eq_id}")
def get_equipment(
    eq_id: int,
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    eq = _get_equipment(db, eq_id, user)
    d = dict(eq)
    client = db.execute("SELECT name FROM clients WHERE id=?", (eq["client_id"],)).fetchone()
    d["client_name"] = client["name"] if client else None
    # The service history — the whole reason equipment is a record rather than
    # a text field on the job.
    d["jobs"] = [dict(r) for r in db.execute(
        "SELECT id, job_number, job_type, status, completed_at, total "
        "FROM service_jobs WHERE equipment_id=? "
        "ORDER BY COALESCE(completed_at, created_at) DESC", (eq_id,)).fetchall()]
    return d


@router.put("/equipment/{eq_id}")
def update_equipment(
    eq_id: int,
    data: EquipmentBody,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    _get_equipment(db, eq_id, user)
    if not db.execute("SELECT 1 FROM clients WHERE id=?", (data.client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    db.execute(
        "UPDATE service_equipment SET client_id=?, name=?, manufacturer=?, model=?, "
        "serial_number=?, install_date=?, location=?, inventory_id=?, notes=? WHERE id=?",
        (data.client_id, data.name.strip(), data.manufacturer, data.model,
         data.serial_number, data.install_date, data.location, data.inventory_id,
         data.notes, eq_id),
    )
    log_action(db, user, "update", "service_equipment", eq_id, data.name)
    db.commit()
    return {"message": "Equipment updated"}


@router.patch("/equipment/{eq_id}/archive")
def archive_equipment(
    eq_id: int,
    user=Depends(require_perm("service", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    eq = _get_equipment(db, eq_id, user)
    # Refuse while services still reference it: archiving the machine would
    # orphan the history that is the reason for registering it at all. A
    # cancelled service does not count — it was a mistake, not a visit.
    live = db.execute(
        "SELECT COUNT(*) AS n FROM service_jobs "
        "WHERE equipment_id=? AND status <> ? AND archived_at IS NULL",
        (eq_id, ST_CANCELLED)).fetchone()["n"]
    if live:
        raise HTTPException(
            400, f"{live} service record(s) reference this equipment. "
                 f"Archive them first.")
    db.execute("UPDATE service_equipment SET archived_at=? WHERE id=?", (_now(), eq_id))
    log_action(db, user, "archive", "service_equipment", eq_id, eq["name"])
    db.commit()
    return {"message": "Equipment archived"}


@router.patch("/equipment/{eq_id}/unarchive")
def unarchive_equipment(
    eq_id: int,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    eq = _get_equipment(db, eq_id, user)
    db.execute("UPDATE service_equipment SET archived_at=NULL WHERE id=?", (eq_id,))
    log_action(db, user, "unarchive", "service_equipment", eq_id, eq["name"])
    db.commit()
    return {"message": "Equipment restored"}


# ── Jobs ─────────────────────────────────────────────────────────────────────

@router.get("/jobs")
def list_jobs(
    status: Optional[str] = None,
    client_id: Optional[int] = None,
    equipment_id: Optional[int] = None,
    assigned_to: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    search: Optional[str] = None,
    uninvoiced: bool = False,
    include_archived: bool = False,
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    where, params = ["1=1"], []
    if not include_archived:
        where.append("j.archived_at IS NULL")
    for col, val in (("j.status", status), ("j.client_id", client_id),
                     ("j.equipment_id", equipment_id), ("j.assigned_to", assigned_to)):
        if val:
            where.append(f"{col} = ?")
            params.append(val)
    if date_from:
        where.append("COALESCE(j.completed_at, j.created_at) >= ?")
        params.append(date_from)
    if date_to:
        where.append("COALESCE(j.completed_at, j.created_at) <= ?")
        params.append(date_to)
    if search:
        like = f"%{search.strip()}%"
        where.append("(j.job_number LIKE ? OR j.reported_fault LIKE ? "
                     "OR j.work_done LIKE ? OR c.name LIKE ?)")
        params += [like, like, like, like]
    if uninvoiced:
        # The work is done and nobody has billed it — the list a manager
        # actually wants on a Friday afternoon.
        where.append("j.status = ? AND NOT EXISTS (SELECT 1 FROM invoices i "
                     "WHERE i.service_job_id = j.id AND i.voided_at IS NULL)")
        params.append(ST_COMPLETED)
    bf, bp = branch_access.branch_filter(user, db, column="j.branch_id")
    if bf:
        # branch_filter returns a fragment with a leading " AND "; this list
        # joins with its own, so the prefix has to come off.
        where.append(bf[len(" AND "):])
        params += bp

    rows = db.execute(
        "SELECT j.*, c.name AS client_name, e.name AS equipment_name, "
        # The person's name, not their login: a job list read by a
        # dispatcher should say "Sami Khoury", not "u_operations_manager".
        "       COALESCE(NULLIF(u.full_name, ''), u.username) AS assigned_name, "
        "       (SELECT i.id FROM invoices i WHERE i.service_job_id = j.id "
        "        AND i.voided_at IS NULL) AS invoice_id "
        "FROM service_jobs j "
        "LEFT JOIN clients c ON c.id = j.client_id "
        "LEFT JOIN service_equipment e ON e.id = j.equipment_id "
        "LEFT JOIN users u ON u.id = j.assigned_to "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY COALESCE(j.completed_at, j.created_at) DESC, j.id DESC",
        params).fetchall()
    return [dict(r) for r in rows]


@router.post("/jobs")
def create_job(
    data: JobBody,
    user=Depends(require_perm("service", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Record a completed service, in one step.

    Everything happens together and in one transaction, because they describe a
    single real event — the technician fitted the parts, so the stock is gone,
    the cost is real and the customer owes for it:

      * the job is written with its parts and charges
      * the parts leave the warehouse and their cost is recognised
        (DR 5000 Cost of Goods Sold / CR 1200 Inventory)
      * the invoice is raised

    Stock for every part is checked BEFORE anything is written, so a service
    that cannot be stocked is refused whole rather than half-recorded.

    Getting it wrong is corrected by cancelling, which reverses all three.
    """
    if not db.execute("SELECT 1 FROM clients WHERE id=?", (data.client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    if data.job_type not in JOB_TYPES:
        raise HTTPException(400, f"Job type must be one of: {', '.join(JOB_TYPES)}")
    if data.equipment_id:
        eq = _get_equipment(db, data.equipment_id, user)
        # Equipment belongs to a client; a job against someone else's machine is
        # a data-entry mistake worth catching at the door.
        if eq["client_id"] != data.client_id:
            raise HTTPException(400, "That equipment belongs to a different client.")
    if data.assigned_to and not db.execute(
            "SELECT 1 FROM users WHERE id=?", (data.assigned_to,)).fetchone():
        raise HTTPException(400, "Assigned user not found")
    _validate_lines(db, data.items)

    # One warehouse for the whole job: every part comes out of the van stock or
    # the branch store the technician actually drew from.
    warehouse_id = warehouse_access.resolve_warehouse_id(user, db, data.warehouse_id)
    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    now = _now()
    service_date = (data.service_date or now[:10])

    cur = db.execute(
        "INSERT INTO service_jobs "
        "(job_number, client_id, equipment_id, job_type, status, "
        " completed_at, assigned_to, reported_fault, work_done, warehouse_id, "
        " branch_id, created_by, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (_placeholder_number(), data.client_id, data.equipment_id, data.job_type,
         ST_COMPLETED, service_date, data.assigned_to, data.reported_fault,
         data.work_done, warehouse_id, branch_id, user["id"], now, now),
    )
    job_id = cur.lastrowid
    number = _finalize_number(db, job_id, _job_prefix(db))
    _replace_lines(db, job_id, data.items)
    _reprice(db, job_id)

    job = db.execute("SELECT * FROM service_jobs WHERE id=?", (job_id,)).fetchone()
    parts_cost = _consume_parts(db, job, user, now)

    invoice = None
    if _wants_invoice(db) and data.items:
        try:
            inv = _raise_invoice(db, job, user)
            invoice = {"invoice_id": inv["invoice_id"],
                       "invoice_number": inv["invoice_number"],
                       "amount": inv["amount"],
                       "pending_approval": inv["pending_approval"]}
            # Logged as its own action, not folded into the create entry.
            # Raising an invoice is a distinct financial event, and an auditor
            # scanning for "who billed this customer" looks for exactly that.
            log_action(db, user, "invoice", "service_job", job_id, number,
                       {"invoice_id": inv["invoice_id"],
                        "invoice_number": inv["invoice_number"], "auto": True})
        except HTTPException:
            # Billing can legitimately refuse (an approval policy, a credit
            # limit). The parts have already left the warehouse, so the service
            # stands and the invoice can be raised by hand — failing the whole
            # call would roll back a physical event.
            invoice = None

    if data.assigned_to and data.assigned_to != user["id"]:
        notify(db, user_id=data.assigned_to, type="service_job_completed",
               title=f"Service recorded: {number}",
               body=data.work_done or data.reported_fault or None,
               link="/service", entity_type="service_job", entity_id=job_id)
    log_action(db, user, "create", "service_job", job_id, number,
               {"client_id": data.client_id, "type": data.job_type,
                "parts_cost": parts_cost,
                "invoice_id": (invoice or {}).get("invoice_id")})
    db.commit()
    return {"id": job_id, "job_number": number, "parts_cost": parts_cost,
            "invoice": invoice, "message": "Service recorded"}


@router.get("/jobs/{job_id}")
def get_job(
    job_id: int,
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return _job_dict(db, _get_job(db, job_id, user))


@router.post("/jobs/{job_id}/invoice")
def invoice_job(
    job_id: int,
    user=Depends(require_perm("service", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Raise the invoice for a completed job.

    Goes through `invoices.build_invoice` rather than assembling rows here. That
    is the only correct constructor: it applies the approval gate, the branch
    tag, promotions, and the discount and tax columns. `quotations` once
    hand-rolled its own copy and drifted away from all five, which is why the
    constructor was extracted before this module was written.

    Each line carries the revenue account its KIND belongs in — parts to 4000
    Sales Revenue, labour and fees to 4100 Service Revenue — so when the invoice
    is paid the split falls out of the line data instead of being guessed at.
    Without it a repair shop's parts turnover and its labour income would land
    in one undifferentiated total, which is the first thing they need to see
    separately.

    One live invoice per job, enforced by asking for it rather than trusting a
    status flag: a voided invoice must leave the job billable again.

    Invoicing does not touch stock, so the parts consumed at completion are not
    decremented twice. That is `build_invoice`'s existing behaviour and not
    something arranged here: an invoice can be drafted, edited and voided, so it
    deliberately owns no stock movement.
    """
    job = _get_job(db, job_id, user)
    if job["status"] == ST_CANCELLED:
        raise HTTPException(400, "A cancelled service cannot be invoiced.")

    existing = db.execute(
        "SELECT id, invoice_number FROM invoices "
        "WHERE service_job_id=? AND voided_at IS NULL", (job_id,)).fetchone()
    if existing:
        raise HTTPException(
            409, f"Job is already invoiced as {existing['invoice_number']}.")

    inv = _raise_invoice(db, job, user)
    log_action(db, user, "invoice", "service_job", job_id, job["job_number"],
               {"invoice_id": inv["invoice_id"],
                "invoice_number": inv["invoice_number"]})
    db.commit()
    return {"invoice_id": inv["invoice_id"],
            "invoice_number": inv["invoice_number"],
            "amount": inv["amount"],
            "pending_approval": inv["pending_approval"],
            "message": "Invoice raised"}


def _raise_invoice(db, job, user):
    """Build the invoice for a completed job. Does not commit — the caller owns
    the transaction, so completing-and-invoicing is one atomic step.

    Shared by the explicit endpoint and by automatic invoicing on completion:
    two copies would be two places for the revenue-account mapping to drift.
    """
    from routers.invoices import build_invoice
    import accounting

    job_id = job["id"]
    lines = db.execute(
        "SELECT line_type, inventory_id, name, quantity, unit_price, discount, "
        "       discount_pct, tax_rate_id FROM service_job_lines "
        "WHERE job_id=? ORDER BY line_no, id", (job_id,)).fetchall()
    if not lines:
        raise HTTPException(400, "This job has nothing to invoice.")

    from types import SimpleNamespace
    items = []
    for r in lines:
        d = dict(r)
        kind = d.pop("line_type")
        d["revenue_account"] = (accounting.REVENUE if kind == LINE_PART
                                else accounting.SERVICE_REVENUE)
        items.append(SimpleNamespace(**d))

    return build_invoice(
        db, user=user,
        client_id=job["client_id"],
        items=items,
        notes=f"Service job {job['job_number']}"
              + (f" — {job['work_done']}" if job["work_done"] else ""),
        service_job_id=job_id,
        branch_id=job["branch_id"],
    )


@router.post("/jobs/{job_id}/cancel")
def cancel_job(
    job_id: int,
    data: CancelBody,
    user=Depends(require_perm("service", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Undo a service recorded by mistake, completely.

    The only correction this module offers, and it reverses all three things
    recording did: the parts go back into stock, their cost is reversed, and the
    invoice is voided. Anything less would leave two records disagreeing — an
    invoice for goods still on the shelf, or a cost with no work behind it.

    Editing is deliberately not offered instead. The lines are the record of
    what was consumed and billed, so changing them would mean reconciling stock
    and the ledger against a moving target; cancelling and re-recording is one
    step longer and always correct.
    """
    job = _get_job(db, job_id, user)
    if job["status"] == ST_CANCELLED:
        raise HTTPException(400, "This service is already cancelled.")

    now = _now()
    invoice = db.execute(
        "SELECT id, invoice_number, "
        "  (SELECT COALESCE(SUM(amount), 0) FROM invoice_payments p "
        "   WHERE p.invoice_id = i.id) AS paid "
        "FROM invoices i WHERE service_job_id=? AND voided_at IS NULL",
        (job_id,)).fetchone()

    # A paid invoice is a refund conversation, not a data-entry correction. The
    # money has moved and voiding would leave a payment against nothing.
    if invoice and float(invoice["paid"] or 0) > 0:
        raise HTTPException(
            409, f"Invoice {invoice['invoice_number']} has payments against it. "
                 f"Refund or void it first, then cancel this service.")

    returned_cost = _return_parts(db, job, user, now)
    db.execute("UPDATE service_jobs SET status=?, cancel_reason=?, parts_cost=0, "
               "updated_at=? WHERE id=?",
               (ST_CANCELLED, data.reason or "Cancelled", now, job_id))

    # Voided LAST, because void_invoice commits. Doing it first would mean a
    # failure in the stock return left an invoice already voided against parts
    # still consumed; this way the whole correction lands in one commit.
    if invoice:
        from routers.invoices import void_invoice, VoidRequest
        void_invoice(invoice["id"],
                     VoidRequest(reason=f"Service {job['job_number']} cancelled"),
                     user=user, db=db)
    log_action(db, user, "cancel", "service_job", job_id, job["job_number"],
               {"reason": data.reason, "reversed_cost": returned_cost,
                "voided_invoice": invoice["invoice_number"] if invoice else None})
    db.commit()
    return {"message": "Service cancelled", "status": ST_CANCELLED,
            "reversed_cost": returned_cost,
            "voided_invoice": invoice["invoice_number"] if invoice else None}


@router.patch("/jobs/{job_id}/archive")
def archive_job(
    job_id: int,
    user=Depends(require_perm("service", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    job = _get_job(db, job_id, user)
    db.execute("UPDATE service_jobs SET archived_at=? WHERE id=?", (_now(), job_id))
    log_action(db, user, "archive", "service_job", job_id, job["job_number"])
    db.commit()
    return {"message": "Job archived"}


@router.patch("/jobs/{job_id}/unarchive")
def unarchive_job(
    job_id: int,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    job = _get_job(db, job_id, user)
    db.execute("UPDATE service_jobs SET archived_at=NULL WHERE id=?", (job_id,))
    log_action(db, user, "unarchive", "service_job", job_id, job["job_number"])
    db.commit()
    return {"message": "Job restored"}
