"""
CRM — Leads, Contacts, Activities, Deals
Full integration with clients, quotations, and users.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify
import sqlite3

router = APIRouter()

# ─── Pydantic models ────────────────────────────────────────────────────────

class LeadCreate(BaseModel):
    name: str
    company: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    source: Optional[str] = None       # web, referral, cold_call, social, other
    status: Optional[str] = "New"      # New, Contacted, Qualified, Proposal, Negotiation, Won, Lost
    score: Optional[int] = 0
    estimated_value: Optional[float] = 0.0
    expected_close: Optional[str] = None
    assigned_to: Optional[int] = None
    notes: Optional[str] = None

class LeadUpdate(LeadCreate):
    name: Optional[str] = None

class ContactCreate(BaseModel):
    client_id: Optional[int] = None
    lead_id: Optional[int] = None
    name: str
    title: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    is_primary: Optional[bool] = False
    notes: Optional[str] = None

class ActivityCreate(BaseModel):
    type: str                          # call, email, meeting, task, note
    subject: str
    description: Optional[str] = None
    client_id: Optional[int] = None
    lead_id: Optional[int] = None
    contact_id: Optional[int] = None
    due_date: Optional[str] = None
    outcome: Optional[str] = None

class ActivityUpdate(ActivityCreate):
    type: Optional[str] = None
    subject: Optional[str] = None

class DealCreate(BaseModel):
    title: str
    client_id: Optional[int] = None
    lead_id: Optional[int] = None
    quotation_id: Optional[int] = None
    stage: Optional[str] = "Qualification"  # Qualification, Proposal, Negotiation, Won, Lost
    value: Optional[float] = 0.0
    probability: Optional[int] = 0
    expected_close: Optional[str] = None
    assigned_to: Optional[int] = None
    notes: Optional[str] = None

class DealUpdate(DealCreate):
    title: Optional[str] = None

class StageUpdate(BaseModel):
    stage: str
    lost_reason: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

class ConvertLeadRequest(BaseModel):
    client_name: Optional[str] = None   # override name; defaults to lead name
    company: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    type: Optional[str] = "private"

# ─── Dashboard ──────────────────────────────────────────────────────────────

@router.get("/dashboard")
def crm_dashboard(
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    total_leads   = db.execute("SELECT COUNT(*) FROM crm_leads WHERE archived_at IS NULL").fetchone()[0]
    open_leads    = db.execute("SELECT COUNT(*) FROM crm_leads WHERE archived_at IS NULL AND status NOT IN ('Won','Lost')").fetchone()[0]
    won_leads     = db.execute("SELECT COUNT(*) FROM crm_leads WHERE archived_at IS NULL AND status='Won'").fetchone()[0]
    pipeline_val  = db.execute(
        "SELECT COALESCE(SUM(value),0) FROM crm_deals WHERE archived_at IS NULL AND stage NOT IN ('Won','Lost')"
    ).fetchone()[0]
    open_deals    = db.execute("SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage NOT IN ('Won','Lost')").fetchone()[0]
    won_deals_val = db.execute("SELECT COALESCE(SUM(value),0) FROM crm_deals WHERE archived_at IS NULL AND stage='Won'").fetchone()[0]
    overdue_activities = db.execute(
        "SELECT COUNT(*) FROM crm_activities WHERE archived_at IS NULL AND done_at IS NULL "
        "AND due_date IS NOT NULL AND due_date < date('now')"
    ).fetchone()[0]
    activities_today = db.execute(
        "SELECT COUNT(*) FROM crm_activities WHERE archived_at IS NULL AND done_at IS NULL "
        "AND due_date = date('now')"
    ).fetchone()[0]

    total_won = db.execute("SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage='Won'").fetchone()[0]
    total_all_closed = db.execute("SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage IN ('Won','Lost')").fetchone()[0]
    conversion_rate = round(total_won / total_all_closed * 100, 1) if total_all_closed > 0 else 0.0

    recent_activities = db.execute(
        """SELECT a.id, a.type, a.subject, a.due_date, a.done_at,
                  c.name AS client_name, l.name AS lead_name
           FROM crm_activities a
           LEFT JOIN clients c ON c.id = a.client_id
           LEFT JOIN crm_leads l ON l.id = a.lead_id
           WHERE a.archived_at IS NULL
           ORDER BY a.created_at DESC LIMIT 10"""
    ).fetchall()

    pipeline_by_stage = db.execute(
        """SELECT stage, COUNT(*) as count, COALESCE(SUM(value),0) as total_value
           FROM crm_deals WHERE archived_at IS NULL
           GROUP BY stage"""
    ).fetchall()

    return {
        "total_leads": total_leads,
        "open_leads": open_leads,
        "won_leads": won_leads,
        "pipeline_value": pipeline_val,
        "open_deals": open_deals,
        "won_deals_value": won_deals_val,
        "overdue_activities": overdue_activities,
        "activities_today": activities_today,
        "conversion_rate": conversion_rate,
        "recent_activities": [dict(r) for r in recent_activities],
        "pipeline_by_stage": [dict(r) for r in pipeline_by_stage],
    }

# ─── Leads ──────────────────────────────────────────────────────────────────

@router.get("/leads")
def list_leads(
    search: Optional[str] = None,
    status: Optional[str] = None,
    source: Optional[str] = None,
    include_archived: bool = False,
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT l.*, u.full_name AS assigned_name, c.name AS client_name
           FROM crm_leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           LEFT JOIN clients c ON c.id = l.client_id
           WHERE 1=1"""
    params = []
    if not include_archived:
        q += " AND l.archived_at IS NULL"
    if search:
        q += " AND (l.name LIKE ? OR l.company LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)"
        s = f"%{search}%"; params.extend([s, s, s, s])
    if status:
        q += " AND l.status = ?"; params.append(status)
    if source:
        q += " AND l.source = ?"; params.append(source)
    q += " ORDER BY l.created_at DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]

@router.post("/leads", status_code=201)
def create_lead(
    data: LeadCreate,
    user=Depends(require_perm("crm", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO crm_leads
           (name,company,email,phone,source,status,score,estimated_value,
            expected_close,assigned_to,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.name, data.company, data.email, data.phone, data.source,
         data.status or "New", data.score or 0, data.estimated_value or 0,
         data.expected_close, data.assigned_to, data.notes, now)
    )
    db.commit()
    log_action(db, user, "create", "crm_leads", cur.lastrowid, data.name)
    return {"id": cur.lastrowid}

@router.get("/leads/{lead_id}")
def get_lead(
    lead_id: int,
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT l.*, u.full_name AS assigned_name, c.name AS client_name
           FROM crm_leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           LEFT JOIN clients c ON c.id = l.client_id
           WHERE l.id = ? AND l.archived_at IS NULL""",
        (lead_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Lead not found")
    lead = dict(row)

    contacts = db.execute(
        "SELECT * FROM crm_contacts WHERE lead_id = ? AND archived_at IS NULL ORDER BY is_primary DESC",
        (lead_id,)
    ).fetchall()
    activities = db.execute(
        "SELECT * FROM crm_activities WHERE lead_id = ? AND archived_at IS NULL ORDER BY due_date DESC, created_at DESC",
        (lead_id,)
    ).fetchall()
    deals = db.execute(
        "SELECT * FROM crm_deals WHERE lead_id = ? AND archived_at IS NULL ORDER BY created_at DESC",
        (lead_id,)
    ).fetchall()

    lead["contacts"]   = [dict(r) for r in contacts]
    lead["activities"] = [dict(r) for r in activities]
    lead["deals"]      = [dict(r) for r in deals]
    return lead

@router.put("/leads/{lead_id}")
def update_lead(
    lead_id: int,
    data: LeadUpdate,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM crm_leads WHERE id=? AND archived_at IS NULL", (lead_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Lead not found")
    db.execute(
        """UPDATE crm_leads SET name=?,company=?,email=?,phone=?,source=?,status=?,
           score=?,estimated_value=?,expected_close=?,assigned_to=?,notes=?
           WHERE id=?""",
        (data.name, data.company, data.email, data.phone, data.source,
         data.status, data.score, data.estimated_value, data.expected_close,
         data.assigned_to, data.notes, lead_id)
    )
    db.commit()
    log_action(db, user, "update", "crm_leads", lead_id, data.name or "")
    return {"ok": True}

@router.patch("/leads/{lead_id}/archive")
def archive_lead(
    lead_id: int,
    body: ArchiveRequest = ArchiveRequest(),
    user=Depends(require_perm("crm", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM crm_leads WHERE id=? AND archived_at IS NULL", (lead_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Lead not found")
    db.execute("UPDATE crm_leads SET archived_at=? WHERE id=?", (_now(), lead_id))
    db.commit()
    log_action(db, user, "archive", "crm_leads", lead_id, row["name"])
    return {"ok": True}


@router.patch("/leads/{lead_id}/unarchive")
def unarchive_lead(
    lead_id: int,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM crm_leads WHERE id=? AND archived_at IS NOT NULL", (lead_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Lead not found in archives")
    db.execute("UPDATE crm_leads SET archived_at=NULL WHERE id=?", (lead_id,))
    db.commit()
    log_action(db, user, "unarchive", "crm_leads", lead_id, row["name"])
    return {"ok": True}

@router.post("/leads/{lead_id}/convert")
def convert_lead(
    lead_id: int,
    body: ConvertLeadRequest = ConvertLeadRequest(),
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    lead = db.execute(
        "SELECT * FROM crm_leads WHERE id=? AND archived_at IS NULL", (lead_id,)
    ).fetchone()
    if not lead:
        raise HTTPException(404, "Lead not found")
    if lead["client_id"]:
        raise HTTPException(400, "Lead already converted to a client")

    now = _now()
    cur = db.execute(
        """INSERT INTO clients (name,company,phone,email,address,type,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (body.client_name or lead["name"], body.company or lead["company"],
         body.phone or lead["phone"], body.email or lead["email"],
         body.address, body.type or "private", lead["notes"], now)
    )
    client_id = cur.lastrowid
    db.execute(
        "UPDATE crm_leads SET client_id=?, status='Won' WHERE id=?",
        (client_id, lead_id)
    )
    notify(db, type="lead_converted",
           title=f"Lead converted: {lead['name']}",
           body=f"Successfully converted to client #{client_id}",
           msg="lead_converted", params={"name": lead["name"], "client_id": client_id},
           link=f"/clients/{client_id}", entity_type="client", entity_id=client_id)
    db.commit()
    log_action(db, user, "convert", "crm_leads", lead_id, f"{lead['name']} → client #{client_id}")
    return {"client_id": client_id}

# ─── Contacts ───────────────────────────────────────────────────────────────

@router.get("/contacts")
def list_contacts(
    search: Optional[str] = None,
    client_id: Optional[int] = None,
    lead_id: Optional[int] = None,
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT ct.*, c.name AS client_name, l.name AS lead_name
           FROM crm_contacts ct
           LEFT JOIN clients c ON c.id = ct.client_id
           LEFT JOIN crm_leads l ON l.id = ct.lead_id
           WHERE ct.archived_at IS NULL"""
    params = []
    if search:
        q += " AND (ct.name LIKE ? OR ct.email LIKE ? OR ct.phone LIKE ? OR ct.title LIKE ?)"
        s = f"%{search}%"; params.extend([s, s, s, s])
    if client_id:
        q += " AND ct.client_id = ?"; params.append(client_id)
    if lead_id:
        q += " AND ct.lead_id = ?"; params.append(lead_id)
    q += " ORDER BY ct.is_primary DESC, ct.name ASC"
    return [dict(r) for r in db.execute(q, params).fetchall()]

@router.post("/contacts", status_code=201)
def create_contact(
    data: ContactCreate,
    user=Depends(require_perm("crm", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO crm_contacts
           (client_id,lead_id,name,title,email,phone,is_primary,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (data.client_id, data.lead_id, data.name, data.title,
         data.email, data.phone, 1 if data.is_primary else 0, data.notes, now)
    )
    db.commit()
    log_action(db, user, "create", "crm_contacts", cur.lastrowid, data.name)
    return {"id": cur.lastrowid}

@router.put("/contacts/{contact_id}")
def update_contact(
    contact_id: int,
    data: ContactCreate,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM crm_contacts WHERE id=? AND archived_at IS NULL", (contact_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Contact not found")
    db.execute(
        """UPDATE crm_contacts SET client_id=?,lead_id=?,name=?,title=?,email=?,phone=?,is_primary=?,notes=?
           WHERE id=?""",
        (data.client_id, data.lead_id, data.name, data.title,
         data.email, data.phone, 1 if data.is_primary else 0, data.notes, contact_id)
    )
    db.commit()
    log_action(db, user, "update", "crm_contacts", contact_id, data.name)
    return {"ok": True}

@router.delete("/contacts/{contact_id}")
def delete_contact(
    contact_id: int,
    user=Depends(require_perm("crm", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM crm_contacts WHERE id=? AND archived_at IS NULL", (contact_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Contact not found")
    db.execute("UPDATE crm_contacts SET archived_at=? WHERE id=?", (_now(), contact_id))
    db.commit()
    log_action(db, user, "delete", "crm_contacts", contact_id, row["name"])
    return {"ok": True}

# ─── Activities ─────────────────────────────────────────────────────────────

@router.get("/activities")
def list_activities(
    search: Optional[str] = None,
    type: Optional[str] = None,
    done: Optional[str] = None,
    client_id: Optional[int] = None,
    lead_id: Optional[int] = None,
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT a.*, c.name AS client_name, l.name AS lead_name,
                  u.full_name AS user_name
           FROM crm_activities a
           LEFT JOIN clients c ON c.id = a.client_id
           LEFT JOIN crm_leads l ON l.id = a.lead_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.archived_at IS NULL"""
    params = []
    if search:
        q += " AND (a.subject LIKE ? OR a.description LIKE ?)"
        s = f"%{search}%"; params.extend([s, s])
    if type:
        q += " AND a.type = ?"; params.append(type)
    if done == "true":
        q += " AND a.done_at IS NOT NULL"
    elif done == "false":
        q += " AND a.done_at IS NULL"
    if client_id:
        q += " AND a.client_id = ?"; params.append(client_id)
    if lead_id:
        q += " AND a.lead_id = ?"; params.append(lead_id)
    q += " ORDER BY CASE WHEN a.done_at IS NULL THEN 0 ELSE 1 END, a.due_date ASC, a.created_at DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]

@router.post("/activities", status_code=201)
def create_activity(
    data: ActivityCreate,
    user=Depends(require_perm("crm", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO crm_activities
           (type,subject,description,client_id,lead_id,contact_id,user_id,due_date,outcome,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (data.type, data.subject, data.description, data.client_id,
         data.lead_id, data.contact_id, user["id"], data.due_date, data.outcome, now)
    )
    db.commit()
    log_action(db, user, "create", "crm_activities", cur.lastrowid, data.subject)
    return {"id": cur.lastrowid}

@router.put("/activities/{activity_id}")
def update_activity(
    activity_id: int,
    data: ActivityUpdate,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM crm_activities WHERE id=? AND archived_at IS NULL", (activity_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Activity not found")
    db.execute(
        """UPDATE crm_activities
           SET type=?,subject=?,description=?,client_id=?,lead_id=?,contact_id=?,due_date=?,outcome=?
           WHERE id=?""",
        (data.type, data.subject, data.description, data.client_id,
         data.lead_id, data.contact_id, data.due_date, data.outcome, activity_id)
    )
    db.commit()
    log_action(db, user, "update", "crm_activities", activity_id, data.subject or "")
    return {"ok": True}

@router.patch("/activities/{activity_id}/done")
def toggle_activity_done(
    activity_id: int,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT subject, done_at FROM crm_activities WHERE id=? AND archived_at IS NULL", (activity_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Activity not found")
    new_done = None if row["done_at"] else _now()
    db.execute("UPDATE crm_activities SET done_at=? WHERE id=?", (new_done, activity_id))
    db.commit()
    log_action(db, user, "done" if new_done else "undone", "crm_activities", activity_id, row["subject"])
    return {"done_at": new_done}

@router.delete("/activities/{activity_id}")
def delete_activity(
    activity_id: int,
    user=Depends(require_perm("crm", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT subject FROM crm_activities WHERE id=? AND archived_at IS NULL", (activity_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Activity not found")
    db.execute("UPDATE crm_activities SET archived_at=? WHERE id=?", (_now(), activity_id))
    db.commit()
    log_action(db, user, "delete", "crm_activities", activity_id, row["subject"])
    return {"ok": True}

# ─── Deals ───────────────────────────────────────────────────────────────────

@router.get("/deals")
def list_deals(
    stage: Optional[str] = None,
    client_id: Optional[int] = None,
    include_archived: bool = False,
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT d.*, c.name AS client_name, l.name AS lead_name,
                  q.quote_number, u.full_name AS assigned_name
           FROM crm_deals d
           LEFT JOIN clients c ON c.id = d.client_id
           LEFT JOIN crm_leads l ON l.id = d.lead_id
           LEFT JOIN quotations q ON q.id = d.quotation_id
           LEFT JOIN users u ON u.id = d.assigned_to
           WHERE 1=1"""
    params = []
    if not include_archived:
        q += " AND d.archived_at IS NULL"
    if stage:
        q += " AND d.stage = ?"; params.append(stage)
    if client_id:
        q += " AND d.client_id = ?"; params.append(client_id)
    q += " ORDER BY d.created_at DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]

@router.post("/deals", status_code=201)
def create_deal(
    data: DealCreate,
    user=Depends(require_perm("crm", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO crm_deals
           (title,client_id,lead_id,quotation_id,stage,value,probability,
            expected_close,assigned_to,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (data.title, data.client_id, data.lead_id, data.quotation_id,
         data.stage or "Qualification", data.value or 0, data.probability or 0,
         data.expected_close, data.assigned_to, data.notes, now)
    )
    db.commit()
    log_action(db, user, "create", "crm_deals", cur.lastrowid, data.title)
    return {"id": cur.lastrowid}

@router.put("/deals/{deal_id}")
def update_deal(
    deal_id: int,
    data: DealUpdate,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM crm_deals WHERE id=? AND archived_at IS NULL", (deal_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Deal not found")
    db.execute(
        """UPDATE crm_deals SET title=?,client_id=?,lead_id=?,quotation_id=?,stage=?,
           value=?,probability=?,expected_close=?,assigned_to=?,notes=?
           WHERE id=?""",
        (data.title, data.client_id, data.lead_id, data.quotation_id, data.stage,
         data.value, data.probability, data.expected_close, data.assigned_to, data.notes, deal_id)
    )
    db.commit()
    log_action(db, user, "update", "crm_deals", deal_id, data.title or "")
    return {"ok": True}

@router.patch("/deals/{deal_id}/stage")
def update_deal_stage(
    deal_id: int,
    body: StageUpdate,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT title FROM crm_deals WHERE id=? AND archived_at IS NULL", (deal_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Deal not found")
    now = _now()
    won_at = now if body.stage == "Won" else None
    lost_at = now if body.stage == "Lost" else None
    db.execute(
        "UPDATE crm_deals SET stage=?,won_at=?,lost_at=?,lost_reason=? WHERE id=?",
        (body.stage, won_at, lost_at, body.lost_reason, deal_id)
    )
    if body.stage == "Won":
        notify(db, type="deal_won",
               title=f"Deal won: {row['title']}",
               body="Congratulations! The deal has been marked as won.",
               msg="deal_won", params={"title": row["title"]},
               link="/crm", entity_type="deal", entity_id=deal_id)
    elif body.stage == "Lost":
        notify(db, type="deal_lost",
               title=f"Deal lost: {row['title']}",
               body=f"Reason: {body.lost_reason or 'Not specified'}",
               msg="deal_lost", params={"title": row["title"], "reason": body.lost_reason or "Not specified"},
               link="/crm", entity_type="deal", entity_id=deal_id)
    db.commit()
    log_action(db, user, f"stage:{body.stage}", "crm_deals", deal_id, row["title"])
    return {"ok": True}

@router.patch("/deals/{deal_id}/archive")
def archive_deal(
    deal_id: int,
    body: ArchiveRequest = ArchiveRequest(),
    user=Depends(require_perm("crm", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT title FROM crm_deals WHERE id=? AND archived_at IS NULL", (deal_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Deal not found")
    db.execute("UPDATE crm_deals SET archived_at=? WHERE id=?", (_now(), deal_id))
    db.commit()
    log_action(db, user, "archive", "crm_deals", deal_id, row["title"])
    return {"ok": True}


@router.patch("/deals/{deal_id}/unarchive")
def unarchive_deal(
    deal_id: int,
    user=Depends(require_perm("crm", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT title FROM crm_deals WHERE id=? AND archived_at IS NOT NULL", (deal_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Deal not found in archives")
    db.execute("UPDATE crm_deals SET archived_at=NULL WHERE id=?", (deal_id,))
    db.commit()
    log_action(db, user, "unarchive", "crm_deals", deal_id, row["title"])
    return {"ok": True}

# ─── Dropdowns ───────────────────────────────────────────────────────────────

@router.get("/dropdown/clients")
def dropdown_clients(
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, name, company FROM clients WHERE archived_at IS NULL ORDER BY name"
    ).fetchall()
    return [dict(r) for r in rows]

@router.get("/dropdown/quotations")
def dropdown_quotations(
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        """SELECT q.id, q.quote_number, q.total, c.name AS client_name
           FROM quotations q LEFT JOIN clients c ON c.id = q.client_id
           WHERE q.archived_at IS NULL ORDER BY q.created_at DESC LIMIT 200"""
    ).fetchall()
    return [dict(r) for r in rows]

@router.get("/dropdown/users")
def dropdown_users(
    user=Depends(require_perm("crm", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, full_name, username FROM users WHERE is_active=1 AND deleted_at IS NULL ORDER BY full_name"
    ).fetchall()
    return [dict(r) for r in rows]
