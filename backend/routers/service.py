"""
Service — maintenance, installation and repair jobs.

For businesses that do work ON a machine rather than only selling goods. Two
entities:

  * **equipment** — a customer-owned machine. A real record rather than a text
    field on the job, so it accumulates a service history you can read back.
  * **jobs** — a visit or piece of work against that machine, carrying lines
    that are either a stocked PART (consumes inventory, has a cost) or a flat
    CHARGE (labour, callout, fee).

The workflow is two steps, and the sheet is what joins them:

  1. A customer reports a problem. The office creates the job with the client,
     the machine and the fault, and it is **Open**. The work order prints from
     there — client, equipment and reported fault, with ruled space for the
     work carried out and the parts used, because those are written on site.
  2. The technician comes back with the sheet filled in. The office types the
     work done, the parts and any extra charges onto the job and **closes** it.
     That is the moment stock moves and the cost posts. The job is **Done**, and
     the invoice can be raised.

Deliberately absent: hours and timesheets (labour is flat-fee), maintenance
contracts, and any scheduling board beyond a date and an assignee. Each was
considered and left out to keep the module something a small business can
actually use.

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
from utils import _now, notify, ArchiveMode, archive_clause

router = APIRouter()

# ── Vocabulary ───────────────────────────────────────────────────────────────
# Job types are a validated tuple rather than a lookup table: four values that
# describe the shape of the work, not a taxonomy a customer needs to extend. The
# `categories` registry already exists if one ever does.
JOB_TYPES = ("Installation", "Maintenance", "Repair", "Inspection")
PRIORITIES = ("Low", "Normal", "High")

# Two states, because a service job is in one of two conditions: the work has
# not been done yet, or it has. Draft / Scheduled / In Progress were three names
# for the first of those — nothing behaved differently across them, so they
# were three clicks that changed a word and nothing else. A job is OPEN from the
# moment the call is taken until the sheet comes back from site and is typed up.
ST_OPEN      = "Open"
ST_DONE      = "Done"
ST_CANCELLED = "Cancelled"

# States in which the job sheet may still be edited. Kept as a tuple rather than
# collapsed to `status == ST_OPEN`, because it is also what the equipment-archive
# check counts against — one place to change if a third open state ever exists.
_OPEN_STATES = (ST_OPEN,)
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
    priority:       str = "Normal"
    scheduled_date: Optional[str] = None
    assigned_to:    Optional[int] = None
    reported_fault: Optional[str] = None
    work_done:      Optional[str] = None
    warehouse_id:   Optional[int] = None
    branch_id:      Optional[int] = None
    # `None` and `[]` mean different things on an update: the first is "this
    # request is not about the lines", the second is "remove them all". The
    # job's header and its write-up are edited from different places now, and
    # a header save that posted an empty list would wipe every part and charge
    # the technician had entered.
    items:          Optional[List[JobLine]] = None


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

@router.get("/equipment")
def list_equipment(
    client_id: Optional[int] = None,
    search: Optional[str] = None,
    archived: ArchiveMode = "exclude",
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    where, params = ["1=1"], []
    where.append(archive_clause(archived, "e.archived_at"))
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
        "SELECT id, job_number, job_type, status, scheduled_date, completed_at, total "
        "FROM service_jobs WHERE equipment_id=? ORDER BY COALESCE(completed_at, "
        "  scheduled_date, created_at) DESC", (eq_id,)).fetchall()]
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
    # Refuse while work is outstanding: archiving the machine would strand the
    # job that is about to be done on it.
    open_jobs = db.execute(
        "SELECT COUNT(*) AS n FROM service_jobs WHERE equipment_id=? AND status IN "
        f"({','.join('?' * len(_OPEN_STATES))})", (eq_id, *_OPEN_STATES)).fetchone()["n"]
    if open_jobs:
        raise HTTPException(
            400, f"{open_jobs} open job(s) reference this equipment. Close them first.")
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
    sort: str = "desc",
    uninvoiced: bool = False,
    archived: ArchiveMode = "exclude",
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    where, params = ["1=1"], []
    where.append(archive_clause(archived, "j.archived_at"))
    for col, val in (("j.status", status), ("j.client_id", client_id),
                     ("j.equipment_id", equipment_id), ("j.assigned_to", assigned_to)):
        if val:
            where.append(f"{col} = ?")
            params.append(val)
    if date_from:
        where.append("COALESCE(j.scheduled_date, j.created_at) >= ?")
        params.append(date_from)
    if date_to:
        where.append("COALESCE(j.scheduled_date, j.created_at) <= ?")
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
        params.append(ST_DONE)
    bf, bp = branch_access.branch_filter(user, db, column="j.branch_id")
    if bf:
        # branch_filter returns a fragment with a leading " AND "; this list
        # joins with its own, so the prefix has to come off.
        where.append(bf[len(" AND "):])
        params += bp

    direction = "ASC" if str(sort).lower() in ("asc", "oldest") else "DESC"

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
        # Newest or oldest first, by the date the list already shows. The
        # direction is mapped from a fixed pair, never interpolated from the
        # request — it reaches ORDER BY, which takes no bind parameter.
        f"ORDER BY COALESCE(j.scheduled_date, j.created_at) {direction}, "
        f"j.id {direction}",
        params).fetchall()
    return [dict(r) for r in rows]


@router.post("/jobs")
def create_job(
    data: JobBody,
    user=Depends(require_perm("service", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute("SELECT 1 FROM clients WHERE id=?", (data.client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    if data.job_type not in JOB_TYPES:
        raise HTTPException(400, f"Job type must be one of: {', '.join(JOB_TYPES)}")
    if data.priority not in PRIORITIES:
        raise HTTPException(400, f"Priority must be one of: {', '.join(PRIORITIES)}")
    if data.equipment_id:
        eq = _get_equipment(db, data.equipment_id, user)
        # Equipment belongs to a client; a job against someone else's machine is
        # a data-entry mistake worth catching at the door.
        if eq["client_id"] != data.client_id:
            raise HTTPException(400, "That equipment belongs to a different client.")
    if data.assigned_to and not db.execute(
            "SELECT 1 FROM users WHERE id=?", (data.assigned_to,)).fetchone():
        raise HTTPException(400, "Assigned user not found")
    _validate_lines(db, data.items or [])

    # One warehouse for the whole job: every part comes out of the van stock or
    # the branch store the technician actually drew from.
    warehouse_id = warehouse_access.resolve_warehouse_id(user, db, data.warehouse_id)
    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    now = _now()
    cur = db.execute(
        "INSERT INTO service_jobs "
        "(job_number, client_id, equipment_id, job_type, status, priority, "
        " scheduled_date, assigned_to, reported_fault, work_done, warehouse_id, "
        " branch_id, created_by, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (_placeholder_number(), data.client_id, data.equipment_id, data.job_type,
         ST_OPEN, data.priority,
         data.scheduled_date, data.assigned_to, data.reported_fault, data.work_done,
         warehouse_id, branch_id, user["id"], now, now),
    )
    job_id = cur.lastrowid
    number = _finalize_number(db, job_id, _job_prefix(db))
    _replace_lines(db, job_id, data.items or [])
    _reprice(db, job_id)

    if data.assigned_to:
        notify(db, user_id=data.assigned_to, type="service_job_scheduled",
               title=f"Service job assigned: {number}",
               body=data.reported_fault or None,
               link="/service", entity_type="service_job", entity_id=job_id)
    log_action(db, user, "create", "service_job", job_id, number,
               {"client_id": data.client_id, "type": data.job_type})
    db.commit()
    return {"id": job_id, "job_number": number, "message": "Service job created"}


@router.get("/jobs/{job_id}")
def get_job(
    job_id: int,
    user=Depends(require_perm("service", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return _job_dict(db, _get_job(db, job_id, user))


@router.put("/jobs/{job_id}")
def update_job(
    job_id: int,
    data: JobBody,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    job = _get_job(db, job_id, user)
    # A completed job's lines are the record of what was consumed and billed.
    # Editing them after the fact would rewrite history the ledger already has.
    if job["status"] not in _OPEN_STATES:
        raise HTTPException(
            409, f"A {job['status'].lower()} job can no longer be edited.")
    if data.job_type not in JOB_TYPES:
        raise HTTPException(400, f"Job type must be one of: {', '.join(JOB_TYPES)}")
    if data.equipment_id:
        eq = _get_equipment(db, data.equipment_id, user)
        if eq["client_id"] != data.client_id:
            raise HTTPException(400, "That equipment belongs to a different client.")
    _validate_lines(db, data.items or [])

    warehouse_id = warehouse_access.resolve_warehouse_id(user, db, data.warehouse_id)
    db.execute(
        "UPDATE service_jobs SET client_id=?, equipment_id=?, job_type=?, priority=?, "
        "scheduled_date=?, assigned_to=?, reported_fault=?, work_done=?, "
        "warehouse_id=?, updated_at=? WHERE id=?",
        (data.client_id, data.equipment_id, data.job_type, data.priority,
         data.scheduled_date, data.assigned_to, data.reported_fault, data.work_done,
         warehouse_id, _now(), job_id),
    )
    # Omitted entirely: the caller is editing the header and has said nothing
    # about the lines, so they stand.
    if data.items is not None:
        _replace_lines(db, job_id, data.items)
    totals = _reprice(db, job_id)
    log_action(db, user, "update", "service_job", job_id, job["job_number"], totals)
    db.commit()
    return {"message": "Service job updated", **totals}


# ── Status transitions ───────────────────────────────────────────────────────
# One endpoint per transition, each validating the state it is coming FROM.
# A single PATCH taking any status would let the UI walk a job straight to Done
# and skip the consumption that closing is supposed to perform.
#
# One transition each way. `schedule` and `start` used to sit here; both only
# moved a job between names for "not done yet", and the date and the assignee
# they set are ordinary fields on the sheet, editable like any other.

@router.post("/jobs/{job_id}/complete")
def complete_job(
    job_id: int,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Close the job: record the work, consume its parts, recognise the cost.

    The second half of the workflow. The sheet came back from site, the office
    typed the work carried out, the parts used and any extra charges onto the
    job, and closing it is what turns that into stock and ledger movement.
    Nothing before this point moves anything.

    This is where a service job first touches the ledger. Two things happen and
    they must not come apart:

      * the parts physically leave the warehouse (inventory, per-warehouse
        stock, and a stock_movements row so the history explains itself)
      * their cost is recognised: DR 5000 Cost of Goods Sold / CR 1200 Inventory

    Stock for EVERY part line is checked before anything is written. A job that
    ran out of stock on its third line, having already consumed the first two,
    would leave the ledger describing a job that never completed — so the whole
    thing is refused up front instead.

    Valuation goes through `lots.value_stock_out`, the same helper POS and
    manufacturing use, so FIFO/LIFO/weighted-average and lot tracking behave
    identically here. Writing a second cost calculation is how two modules come
    to disagree about what the same item cost.

    Revenue is NOT recognised here — see the module docstring. Completion is a
    cost event; the revenue follows when the invoice is paid.
    """
    import accounting
    import lots
    import warehouse_access as wha
    from utils import money

    job = _get_job(db, job_id, user)
    if job["status"] == ST_DONE:
        raise HTTPException(409, "Job is already closed.")
    if job["status"] == ST_CANCELLED:
        raise HTTPException(400, "A cancelled job cannot be closed.")

    now = _now()
    wid = wha.default_warehouse_id_for_row(db, job["warehouse_id"])

    # ── Pre-flight: every part line, before a single write ───────────────────
    parts = db.execute(
        "SELECT l.id, l.inventory_id, l.quantity, i.name, i.quantity AS on_hand, "
        "       i.unit, i.min_stock "
        "FROM service_job_lines l JOIN inventory i ON i.id = l.inventory_id "
        "WHERE l.job_id = ? AND l.line_type = ?", (job_id, LINE_PART)).fetchall()

    # Several lines can draw the same item; the check has to be on the TOTAL, or
    # two lines of 3 against 5 on hand would both pass and oversell the item.
    needed = {}
    for p in parts:
        needed[p["inventory_id"]] = needed.get(p["inventory_id"], 0) + float(p["quantity"] or 0)
    by_id = {p["inventory_id"]: p for p in parts}
    short = [f"{by_id[i]['name']} (need {q}, have {by_id[i]['on_hand']})"
             for i, q in needed.items() if float(by_id[i]["on_hand"] or 0) < q]
    if short:
        raise HTTPException(400, "Not enough stock to complete this job: "
                                 + "; ".join(short))

    # ── Consume ─────────────────────────────────────────────────────────────
    cogs_total = 0.0
    for inv_id, qty in needed.items():
        row = by_id[inv_id]
        qty_before = float(row["on_hand"])
        qty_after = round(qty_before - qty, 6)
        line_cogs = lots.value_stock_out(db, inv_id, qty, source_type="service",
                                         source_ref=job["job_number"], now=now)
        cogs_total += line_cogs
        # What this part actually cost, per unit, recorded on the line itself.
        # A reopen gives the parts back and has to value each one at what it
        # left at; with nothing on the line it could only spread the job's total
        # across everything returned, which prices a $500 component and a $1
        # washer identically and mis-states both items' stock.
        db.execute(
            "UPDATE service_job_lines SET unit_cost=?, consumed_at=? "
            "WHERE job_id=? AND line_type=? AND inventory_id=?",
            (round(line_cogs / qty, 6) if qty else 0.0, now,
             job_id, LINE_PART, inv_id))
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id, warehouse_id=wid,
                                   delta=-qty)
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

    # ── Recognise the cost ──────────────────────────────────────────────────
    # A labour-only job consumes nothing and has no cost to post; post_entry
    # rejects an all-zero entry, so skip it rather than hand it one.
    if cogs_total > 0:
        accounting.post_entry(
            db,
            entry_date=now[:10],
            memo=f"Service parts — {job['job_number']}",
            lines=[
                {"code": accounting.code(db, "cogs"),      "debit":  cogs_total},
                {"code": accounting.code(db, "inventory"), "credit": cogs_total},
            ],
            source_type="service_cogs", source_id=job_id,
            created_by=user["id"], branch_id=job["branch_id"],
        )

    db.execute(
        "UPDATE service_jobs SET status=?, completed_at=?, parts_cost=?, updated_at=? "
        "WHERE id=?", (ST_DONE, now, cogs_total, now, job_id))

    if job["created_by"] and job["created_by"] != user["id"]:
        notify(db, user_id=job["created_by"], type="service_job_completed",
               title=f"Service job closed: {job['job_number']}",
               body=job["work_done"] or None,
               link="/service", entity_type="service_job", entity_id=job_id)
    # Raise the invoice in the SAME transaction, if the company wants it. The
    # work is done and priced, and the alternative is a completed job sitting
    # unbilled because nobody pressed a second button. It is an ordinary draft
    # invoice: editable afterwards, and voidable if the job was completed by
    # mistake — voiding then makes the job billable again.
    #
    # A job with no lines has nothing to bill, so it is skipped rather than
    # failing the completion: the work still happened.
    invoice = None
    auto = db.execute(
        "SELECT value FROM settings WHERE key='service_auto_invoice'").fetchone()
    wants_invoice = (auto["value"] if auto else "1") not in ("0", "", "false")
    if wants_invoice and db.execute(
            "SELECT 1 FROM service_job_lines WHERE job_id=?", (job_id,)).fetchone():
        job = db.execute("SELECT * FROM service_jobs WHERE id=?", (job_id,)).fetchone()
        try:
            inv = _raise_invoice(db, job, user)
            invoice = {"invoice_id": inv["invoice_id"],
                       "invoice_number": inv["invoice_number"],
                       "amount": inv["amount"],
                       "pending_approval": inv["pending_approval"]}
            log_action(db, user, "invoice", "service_job", job_id,
                       job["job_number"], {"invoice_id": inv["invoice_id"],
                                           "auto": True})
        except HTTPException:
            # Billing can legitimately refuse (an approval policy, a credit
            # limit). The parts have already left the warehouse and the cost is
            # posted, so the completion stands and the invoice can be raised by
            # hand — failing the whole call would roll back a physical event.
            invoice = None

    log_action(db, user, "complete", "service_job", job_id, job["job_number"],
               {"cogs": cogs_total, "parts": len(needed)})
    db.commit()
    return {"message": "Job closed", "status": ST_DONE,
            "parts_cost": cogs_total, "invoice": invoice}


@router.post("/jobs/{job_id}/invoice")
def invoice_job(
    job_id: int,
    user=Depends(require_perm("service", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Raise the invoice for a job that is done.

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
    if job["status"] != ST_DONE:
        raise HTTPException(
            400, "Only a job that is done can be invoiced. Close it first.")

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
        d["revenue_account"] = (accounting.code(db, "revenue") if kind == LINE_PART
                                else accounting.code(db, "service_revenue"))
        items.append(SimpleNamespace(**d))

    return build_invoice(
        db, user=user,
        client_id=job["client_id"],
        items=items,
        notes=f"Service job {job['job_number']}"
              + (f" — {job['work_done']}" if job["work_done"] else ""),
        service_job_id=job_id,
        branch_id=job["branch_id"],
        # A job's parts come off the company's own price list and its labour is
        # charged at the company's own rates, both in the company's currency.
        # Billing a customer in euro converts that at the day's rate; it does
        # not mean the technician was typing euro.
        prices_in_base=True,
    )


@router.post("/jobs/{job_id}/reopen")
def reopen_job(
    job_id: int,
    user=Depends(require_perm("service", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Reopen a closed job: give the parts back and reverse the cost.

    A technician marks a job done, then finds the fault was something else. The
    alternative to this endpoint is editing stock by hand, which leaves the
    ledger describing parts that were never used.

    Refused once the job is invoiced. Un-consuming parts a customer has been
    billed for would leave an invoice for goods the warehouse still holds; the
    invoice has to be voided first, which is a decision with its own audit
    trail.
    """
    import accounting
    import costing
    import lots
    import warehouse_access as wha
    from utils import money

    job = _get_job(db, job_id, user)
    if job["status"] != ST_DONE:
        raise HTTPException(400, "Only a job that is done can be reopened.")

    billed = db.execute(
        "SELECT invoice_number FROM invoices "
        "WHERE service_job_id=? AND voided_at IS NULL", (job_id,)).fetchone()
    if billed:
        raise HTTPException(
            409, f"Void invoice {billed['invoice_number']} before reopening this job.")

    now = _now()
    wid = wha.default_warehouse_id_for_row(db, job["warehouse_id"])
    parts = db.execute(
        "SELECT l.inventory_id, l.quantity, l.unit_cost, i.name, i.quantity AS on_hand "
        "FROM service_job_lines l JOIN inventory i ON i.id = l.inventory_id "
        "WHERE l.job_id=? AND l.line_type=?", (job_id, LINE_PART)).fetchall()

    # Each part goes back at the cost IT was consumed at, snapshotted on the
    # line when the job closed. `costed` accumulates that value, and `qty_costed`
    # tracks how much of the item the snapshots actually cover — a job closed
    # before the snapshot existed has none, and a partial cover cannot be
    # averaged into a trustworthy figure, so both fall back below.
    returned, costed, qty_costed = {}, {}, {}
    for p in parts:
        iid = p["inventory_id"]
        q = float(p["quantity"] or 0)
        returned[iid] = returned.get(iid, 0) + q
        if p["unit_cost"] is not None:
            costed[iid] = costed.get(iid, 0) + q * float(p["unit_cost"])
            qty_costed[iid] = qty_costed.get(iid, 0) + q
    total_returned = sum(returned.values())

    for inv_id, qty in returned.items():
        row = db.execute("SELECT name, quantity FROM inventory WHERE id=?",
                         (inv_id,)).fetchone()
        qty_before = float(row["quantity"])
        qty_after = round(qty_before + qty, 6)
        # Back in at the cost it left at, so returning a part cannot invent
        # margin. record_stock_in values the stock-IN for fifo/lifo and lots.
        if qty > 0 and abs(qty_costed.get(inv_id, 0) - qty) < 1e-9:
            unit_cost = round(costed[inv_id] / qty, 6)
        else:
            # Jobs closed before the per-line snapshot existed: the job's whole
            # parts cost spread evenly over everything returned. That is what
            # this always did, and it is wrong whenever the parts differ in
            # price — which is why the snapshot above now exists.
            unit_cost = (job["parts_cost"] / total_returned
                         if job["parts_cost"] and total_returned else 0)
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id, warehouse_id=wid,
                                   delta=qty)
        costing.blend_stock_in(db, inv_id, qty_before=qty_before, qty_in=qty,
                               unit_cost_in=unit_cost)
        lots.record_stock_in(db, inv_id, qty, unit_cost,
                             source_type="service_reopen",
                             source_ref=job["job_number"], now=now)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
            " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, "service_return", qty, qty_before, qty_after,
             job["job_number"], "Service job reopened", wid, now))

    # The parts are back on the shelf, so the lines are no longer consumed.
    # Leaving the marker set would be worse than never having written it: the
    # next reader would trust a flag that says stock and the ledger were touched
    # for a line whose goods are sitting in the warehouse. Closing the job again
    # rewrites both.
    db.execute("UPDATE service_job_lines SET unit_cost=NULL, consumed_at=NULL "
               "WHERE job_id=? AND line_type=?", (job_id, LINE_PART))

    # Reverse through accounting.reverse_source rather than posting an opposite
    # entry by hand. It mirrors the original and, crucially, marks it
    # status='reversed'. post_entry is idempotent on (source_type, source_id)
    # against the LIVE entry, so a hand-rolled opposite leaves the original
    # posted — and completing the job again then silently posts nothing at all,
    # leaving consumed parts with no cost against them. Found by the
    # reopen-then-complete test.
    cost = money(job["parts_cost"] or 0)
    accounting.reverse_source(
        db, "service_cogs", job_id,
        entry_date=now[:10],
        memo=f"Service parts returned — {job['job_number']}",
        created_by=user["id"],
    )

    db.execute(
        "UPDATE service_jobs SET status=?, completed_at=NULL, parts_cost=0, "
        "updated_at=? WHERE id=?", (ST_OPEN, now, job_id))
    log_action(db, user, "reopen", "service_job", job_id, job["job_number"],
               {"reversed_cost": cost})
    db.commit()
    return {"message": "Job reopened", "status": ST_OPEN, "reversed_cost": cost}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(
    job_id: int,
    data: CancelBody,
    user=Depends(require_perm("service", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Cancel a job that is still open.

    Cancelling a job that is DONE is a different operation: it has to give back
    the stock and reverse the cost that closing posted. Reopening does exactly
    that, so a job closed by mistake is reopened first and cancelled after.
    """
    job = _get_job(db, job_id, user)
    if job["status"] == ST_CANCELLED:
        raise HTTPException(400, "Job is already cancelled.")
    if job["status"] == ST_DONE:
        raise HTTPException(
            400, "Reopen the job first: closing it consumed stock and posted "
                 "its cost, and cancelling would leave both standing.")
    db.execute("UPDATE service_jobs SET status=?, cancel_reason=?, updated_at=? "
               "WHERE id=?", (ST_CANCELLED, data.reason or "Cancelled", _now(), job_id))
    log_action(db, user, "cancel", "service_job", job_id, job["job_number"],
               {"reason": data.reason})
    db.commit()
    return {"message": "Job cancelled", "status": ST_CANCELLED}


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
