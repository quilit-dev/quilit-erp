"""
Planning — Projects, Tasks, Milestones
Interactive project planning with Gantt, Board, List, and Calendar views.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify
import sqlite3

router = APIRouter()

# ─── Pydantic models ────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    client_id: Optional[int] = None
    color: Optional[str] = "#4f8ef7"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = "Active"

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    client_id: Optional[int] = None
    color: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = None

class TaskCreate(BaseModel):
    # project_id is optional — tasks without a specific project are bucketed
    # under a shared "(General)" project that's auto-created on first need.
    # Pre-existing rows that always had a project keep working unchanged.
    project_id: Optional[int] = None
    name: str
    description: Optional[str] = None
    assigned_to: Optional[int] = None
    status: Optional[str] = "To Do"
    priority: Optional[str] = "Medium"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    progress: Optional[int] = 0
    milestone_id: Optional[int] = None
    depends_on: Optional[int] = None
    color: Optional[str] = None
    sort_order: Optional[int] = 0

class TaskUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    assigned_to: Optional[int] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    progress: Optional[int] = None
    milestone_id: Optional[int] = None
    depends_on: Optional[int] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None

class TaskDates(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None

class TaskStatus(BaseModel):
    status: str

class TaskProgress(BaseModel):
    progress: int

class MilestoneCreate(BaseModel):
    project_id: int
    name: str
    due_date: Optional[str] = None

class MilestoneUpdate(BaseModel):
    name: Optional[str] = None
    due_date: Optional[str] = None
    reached_at: Optional[str] = None

# Standalone planning events — shown in the Planning > Calendar view. These
# are independent of projects/tasks: meetings, reminders, deadlines, etc.
class EventCreate(BaseModel):
    title:        str
    description:  Optional[str] = None
    start_date:   str                          # required, 'YYYY-MM-DD'
    end_date:     Optional[str] = None         # nullable; defaults to start_date
    start_time:   Optional[str] = None         # 'HH:MM'
    end_time:     Optional[str] = None         # 'HH:MM'
    all_day:      Optional[int] = 1
    color:        Optional[str] = None
    # Optional attendee list. Active user IDs; the creator is implicit and
    # need not be included. When non-empty, each non-self attendee receives
    # a notification on create / on being added in an update.
    attendees:    Optional[list[int]] = None

class EventUpdate(BaseModel):
    title:        Optional[str] = None
    description:  Optional[str] = None
    start_date:   Optional[str] = None
    end_date:     Optional[str] = None
    start_time:   Optional[str] = None
    end_time:     Optional[str] = None
    all_day:      Optional[int] = None
    color:        Optional[str] = None
    # Full replacement of the attendee list — pass [] to clear it. Only the
    # newly added attendees are notified to avoid resending invites.
    attendees:    Optional[list[int]] = None

# ─── Helper ─────────────────────────────────────────────────────────────────

def row_to_dict(row):
    if row is None:
        return None
    return dict(row)

# ─── Planning Projects ───────────────────────────────────────────────────────

@router.get("/projects")
def list_projects(
    search: str = Query(""),
    status: str = Query(""),
    include_archived: bool = False,
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    sql = """
        SELECT p.*, c.name as client_name,
               (SELECT COUNT(*) FROM planning_tasks t WHERE t.project_id=p.id AND t.archived_at IS NULL) as task_count,
               (SELECT COUNT(*) FROM planning_tasks t WHERE t.project_id=p.id AND t.archived_at IS NULL AND t.status='Done') as done_count
        FROM planning_projects p
        LEFT JOIN clients c ON p.client_id = c.id
        WHERE 1=1
    """
    params = []
    if not include_archived:
        sql += " AND p.archived_at IS NULL"
    if search:
        sql += " AND (p.name LIKE ? OR p.description LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    if status:
        sql += " AND p.status = ?"
        params.append(status)
    sql += " ORDER BY p.created_at DESC"
    rows = db.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


@router.post("/projects")
def create_project(
    body: ProjectCreate,
    user=Depends(require_perm("planning", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO planning_projects (name, description, client_id, color, start_date, end_date, status, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (body.name, body.description, body.client_id, body.color or "#4f8ef7",
         body.start_date, body.end_date, body.status or "Active", user["id"], now)
    )
    db.commit()
    pid = cur.lastrowid
    log_action(db, user, "create", "planning", pid, body.name)
    return {"id": pid, "message": "Project created"}


@router.get("/projects/{pid}")
def get_project(
    pid: int,
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT p.*, c.name as client_name
           FROM planning_projects p
           LEFT JOIN clients c ON p.client_id = c.id
           WHERE p.id=? AND p.archived_at IS NULL""",
        (pid,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return dict(row)


@router.put("/projects/{pid}")
def update_project(
    pid: int,
    body: ProjectUpdate,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM planning_projects WHERE id=? AND archived_at IS NULL", (pid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    # Fixed column list; COALESCE keeps the existing value when a field is None,
    # so the statement is a constant literal with no interpolated identifiers.
    data   = body.dict()
    cols   = ('name', 'description', 'client_id', 'color', 'start_date', 'end_date', 'status')
    values = [data.get(c) for c in cols]
    if all(v is None for v in values):
        return {"message": "Nothing to update"}
    db.execute(
        "UPDATE planning_projects SET "
        "name=COALESCE(?,name), description=COALESCE(?,description), "
        "client_id=COALESCE(?,client_id), color=COALESCE(?,color), "
        "start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date), "
        "status=COALESCE(?,status) WHERE id=?",
        values + [pid],
    )
    db.commit()
    log_action(db, user, "edit", "planning", pid, body.name or str(pid))
    return {"message": "Project updated"}


@router.patch("/projects/{pid}/archive")
def archive_project(
    pid: int,
    user=Depends(require_perm("planning", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute("UPDATE planning_projects SET archived_at=? WHERE id=?", (_now(), pid))
    db.commit()
    log_action(db, user, "archive", "planning", pid, str(pid))
    return {"message": "Project archived"}


@router.patch("/projects/{pid}/unarchive")
def unarchive_project(
    pid: int,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM planning_projects WHERE id=? AND archived_at IS NOT NULL", (pid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found in archives")
    db.execute("UPDATE planning_projects SET archived_at=NULL WHERE id=?", (pid,))
    db.commit()
    log_action(db, user, "unarchive", "planning", pid, str(pid))
    return {"message": "Project restored"}


# ─── Planning Tasks ──────────────────────────────────────────────────────────

@router.get("/tasks")
def list_tasks(
    project_id: Optional[int] = Query(None),
    status: str = Query(""),
    assigned_to: Optional[int] = Query(None),
    search: str = Query(""),
    include_archived: bool = False,
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    sql = """
        SELECT t.*,
               u.full_name as assignee_name,
               p.name as project_name,
               p.color as project_color,
               m.name as milestone_name
        FROM planning_tasks t
        LEFT JOIN users u ON t.assigned_to = u.id
        LEFT JOIN planning_projects p ON t.project_id = p.id
        LEFT JOIN planning_milestones m ON t.milestone_id = m.id
        WHERE 1=1
    """
    params = []
    if not include_archived:
        sql += " AND t.archived_at IS NULL"
    if project_id:
        sql += " AND t.project_id=?"
        params.append(project_id)
    if status:
        sql += " AND t.status=?"
        params.append(status)
    if assigned_to:
        sql += " AND t.assigned_to=?"
        params.append(assigned_to)
    if search:
        sql += " AND (t.name LIKE ? OR t.description LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    sql += " ORDER BY t.sort_order ASC, t.created_at ASC"
    rows = db.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def _ensure_general_project(db: sqlite3.Connection) -> int:
    """
    Return the id of the shared "(General)" project — a single bucket that
    holds tasks not tied to any specific project. Auto-created on first
    need. The leading parenthesis sorts it ahead of normal project names
    alphabetically and makes it visually clear in dropdowns that it's a
    catch-all, not a real project.
    """
    row = db.execute(
        "SELECT id FROM planning_projects WHERE name='(General)' AND archived_at IS NULL"
    ).fetchone()
    if row:
        return row["id"]
    cur = db.execute(
        """INSERT INTO planning_projects (name, description, color, status, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        ("(General)", "Tasks not tied to a specific project.",
         "#6B7280", "Active", _now()),
    )
    return cur.lastrowid


@router.post("/tasks")
def create_task(
    body: TaskCreate,
    user=Depends(require_perm("planning", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    # When the caller didn't pick a project, route the task into the shared
    # "(General)" bucket. The bucket is created lazily so installs that
    # never use the feature don't accumulate an empty placeholder project.
    project_id = body.project_id
    if not project_id:
        project_id = _ensure_general_project(db)
    else:
        proj = db.execute(
            "SELECT id FROM planning_projects WHERE id=? AND archived_at IS NULL",
            (project_id,),
        ).fetchone()
        if not proj:
            raise HTTPException(status_code=404, detail="Project not found")
    now = _now()
    cur = db.execute(
        """INSERT INTO planning_tasks
           (project_id, name, description, assigned_to, status, priority,
            start_date, end_date, progress, milestone_id, depends_on, color, sort_order, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (project_id, body.name, body.description, body.assigned_to,
         body.status or "To Do", body.priority or "Medium",
         body.start_date, body.end_date, body.progress or 0,
         body.milestone_id, body.depends_on, body.color, body.sort_order or 0, now)
    )
    db.commit()
    tid = cur.lastrowid
    log_action(db, user, "create", "planning", tid, body.name)
    return {"id": tid, "message": "Task created"}


@router.get("/tasks/{tid}")
def get_task(
    tid: int,
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT t.*, u.full_name as assignee_name, p.name as project_name
           FROM planning_tasks t
           LEFT JOIN users u ON t.assigned_to = u.id
           LEFT JOIN planning_projects p ON t.project_id = p.id
           WHERE t.id=? AND t.archived_at IS NULL""",
        (tid,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    return dict(row)


@router.put("/tasks/{tid}")
def update_task(
    tid: int,
    body: TaskUpdate,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM planning_tasks WHERE id=? AND archived_at IS NULL", (tid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    data   = body.dict()
    cols   = ('name', 'description', 'assigned_to', 'status', 'priority', 'start_date',
              'end_date', 'progress', 'milestone_id', 'depends_on', 'color', 'sort_order')
    values = [data.get(c) for c in cols]
    if all(v is None for v in values):
        return {"message": "Nothing to update"}
    db.execute(
        "UPDATE planning_tasks SET "
        "name=COALESCE(?,name), description=COALESCE(?,description), "
        "assigned_to=COALESCE(?,assigned_to), status=COALESCE(?,status), "
        "priority=COALESCE(?,priority), start_date=COALESCE(?,start_date), "
        "end_date=COALESCE(?,end_date), progress=COALESCE(?,progress), "
        "milestone_id=COALESCE(?,milestone_id), depends_on=COALESCE(?,depends_on), "
        "color=COALESCE(?,color), sort_order=COALESCE(?,sort_order) WHERE id=?",
        values + [tid],
    )
    db.commit()
    log_action(db, user, "edit", "planning", tid, body.name or str(tid))
    return {"message": "Task updated"}


@router.patch("/tasks/{tid}/dates")
def update_task_dates(
    tid: int,
    body: TaskDates,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Called by Gantt drag operations — lightweight date-only update."""
    row = db.execute("SELECT id FROM planning_tasks WHERE id=? AND archived_at IS NULL", (tid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    db.execute(
        "UPDATE planning_tasks SET start_date=?, end_date=? WHERE id=?",
        (body.start_date, body.end_date, tid)
    )
    log_action(db, user, "update", "planning", tid, f"Task #{tid} dates",
               {"start_date": body.start_date, "end_date": body.end_date})
    db.commit()
    return {"message": "Dates updated"}


@router.patch("/tasks/{tid}/status")
def update_task_status(
    tid: int,
    body: TaskStatus,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Called by Board drag drop — status-only update."""
    row = db.execute("SELECT id FROM planning_tasks WHERE id=? AND archived_at IS NULL", (tid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    progress_map = {"To Do": 0, "In Progress": 20, "Review": 80, "Done": 100, "Blocked": None}
    prog = progress_map.get(body.status)
    if prog is not None:
        db.execute("UPDATE planning_tasks SET status=?, progress=? WHERE id=?", (body.status, prog, tid))
    else:
        db.execute("UPDATE planning_tasks SET status=? WHERE id=?", (body.status, tid))
    log_action(db, user, "status_change", "planning", tid, f"Task #{tid}",
               {"status": body.status})
    db.commit()
    return {"message": "Status updated"}


@router.patch("/tasks/{tid}/progress")
def update_task_progress(
    tid: int,
    body: TaskProgress,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    p = max(0, min(100, body.progress))
    db.execute("UPDATE planning_tasks SET progress=? WHERE id=?", (p, tid))
    log_action(db, user, "update", "planning", tid, f"Task #{tid} progress",
               {"progress": p})
    db.commit()
    return {"message": "Progress updated"}


@router.patch("/tasks/{tid}/archive")
def archive_task(
    tid: int,
    user=Depends(require_perm("planning", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute("UPDATE planning_tasks SET archived_at=? WHERE id=?", (_now(), tid))
    db.commit()
    log_action(db, user, "archive", "planning", tid, str(tid))
    return {"message": "Task archived"}


@router.patch("/tasks/{tid}/unarchive")
def unarchive_task(
    tid: int,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM planning_tasks WHERE id=? AND archived_at IS NOT NULL", (tid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found in archives")
    db.execute("UPDATE planning_tasks SET archived_at=NULL WHERE id=?", (tid,))
    db.commit()
    log_action(db, user, "unarchive", "planning", tid, str(tid))
    return {"message": "Task restored"}


# ─── Planning Milestones ─────────────────────────────────────────────────────

@router.get("/milestones")
def list_milestones(
    project_id: Optional[int] = Query(None),
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    sql = "SELECT * FROM planning_milestones WHERE 1=1"
    params = []
    if project_id:
        sql += " AND project_id=?"
        params.append(project_id)
    sql += " ORDER BY due_date ASC"
    return [dict(r) for r in db.execute(sql, params).fetchall()]


@router.post("/milestones")
def create_milestone(
    body: MilestoneCreate,
    user=Depends(require_perm("planning", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    proj = db.execute(
        "SELECT id FROM planning_projects WHERE id=? AND archived_at IS NULL", (body.project_id,)
    ).fetchone()
    if not proj:
        raise HTTPException(404, "Project not found")
    now = _now()
    cur = db.execute(
        "INSERT INTO planning_milestones (project_id, name, due_date, created_at) VALUES (?,?,?,?)",
        (body.project_id, body.name, body.due_date, now)
    )
    log_action(db, user, "create", "planning_milestone", cur.lastrowid, body.name)
    db.commit()
    return {"id": cur.lastrowid, "message": "Milestone created"}


@router.put("/milestones/{mid}")
def update_milestone(
    mid: int,
    body: MilestoneUpdate,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    data   = body.dict()
    cols   = ('name', 'due_date', 'reached_at')
    values = [data.get(c) for c in cols]
    if all(v is None for v in values):
        return {"message": "Nothing to update"}
    db.execute(
        "UPDATE planning_milestones SET "
        "name=COALESCE(?,name), due_date=COALESCE(?,due_date), "
        "reached_at=COALESCE(?,reached_at) WHERE id=?",
        values + [mid],
    )
    log_action(db, user, "update", "planning_milestone", mid, data.get("name") or str(mid))
    db.commit()
    return {"message": "Milestone updated"}


@router.delete("/milestones/{mid}")
def delete_milestone(
    mid: int,
    user=Depends(require_perm("planning", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id FROM planning_milestones WHERE id=? AND archived_at IS NULL", (mid,)).fetchone()
    if not row:
        raise HTTPException(404, "Milestone not found")
    db.execute("UPDATE planning_milestones SET archived_at=? WHERE id=?", (_now(), mid))
    db.commit()
    log_action(db, user, "archive", "planning_milestone", mid, str(mid))
    return {"message": "Milestone deleted"}


# ─── Dropdowns ───────────────────────────────────────────────────────────────

@router.get("/dropdown/clients")
def dropdown_clients(
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, name FROM clients WHERE deleted_at IS NULL ORDER BY name"
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/dropdown/users")
def dropdown_users(
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, full_name, username FROM users WHERE is_active=1 AND deleted_at IS NULL ORDER BY full_name"
    ).fetchall()
    return [{"id": r["id"], "name": r["full_name"] or r["username"]} for r in rows]


# ─── Dashboard summary ───────────────────────────────────────────────────────

@router.get("/summary")
def planning_summary(
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    total_projects  = db.execute("SELECT COUNT(*) FROM planning_projects WHERE archived_at IS NULL").fetchone()[0]
    active_projects = db.execute("SELECT COUNT(*) FROM planning_projects WHERE archived_at IS NULL AND status='Active'").fetchone()[0]
    total_tasks     = db.execute("SELECT COUNT(*) FROM planning_tasks WHERE archived_at IS NULL").fetchone()[0]
    done_tasks      = db.execute("SELECT COUNT(*) FROM planning_tasks WHERE archived_at IS NULL AND status='Done'").fetchone()[0]
    overdue_tasks   = db.execute(
        "SELECT COUNT(*) FROM planning_tasks WHERE archived_at IS NULL AND status != 'Done' AND end_date < date('now')"
    ).fetchone()[0]
    in_progress     = db.execute("SELECT COUNT(*) FROM planning_tasks WHERE archived_at IS NULL AND status='In Progress'").fetchone()[0]
    return {
        "total_projects":  total_projects,
        "active_projects": active_projects,
        "total_tasks":     total_tasks,
        "done_tasks":      done_tasks,
        "overdue_tasks":   overdue_tasks,
        "in_progress":     in_progress,
    }


# ─── Calendar events ────────────────────────────────────────────────────────
# Standalone events shown only in the Planning > Calendar view. Decoupled
# from projects/tasks on purpose — the calendar is for meetings, reminders
# and deadlines a user wants to plan, not for re-rendering Gantt content.

@router.get("/events")
def list_events(
    start: Optional[str] = Query(None, description="Window start (YYYY-MM-DD)"),
    end:   Optional[str] = Query(None, description="Window end (YYYY-MM-DD)"),
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Return active (non-archived) events visible to the calling user.
    An event is visible when the user is its owner OR is listed in its
    `attendees` CSV — so HR's applicant calls, a manager's 1:1s and other
    personal/private meetings stay scoped to the people involved instead of
    leaking to every teammate with planning-view permission.

    If start/end are provided the result is also filtered to events that
    *overlap* the window (effective end ≥ start AND start_date ≤ end).
    """
    # Attendees is a CSV like "3,5,7" — wrapping with commas on both sides
    # lets a single LIKE pattern match the user-id whether it's the first,
    # middle or last token without false-positives on substrings (e.g. user
    # id 3 should NOT match attendees "13,30").
    uid = int(user["id"])
    attendee_like = f"%,{uid},%"

    sql  = ("SELECT id, title, description, start_date, end_date, "
            "start_time, end_time, all_day, color, owner_id, owner_name, "
            "attendees, created_at, updated_at "
            "FROM planning_events "
            "WHERE archived_at IS NULL "
            "  AND (owner_id = ? "
            "       OR (',' || COALESCE(attendees, '') || ',') LIKE ?)")
    args = [uid, attendee_like]
    if start and end:
        sql += " AND COALESCE(end_date, start_date) >= ? AND start_date <= ?"
        args += [start, end]
    sql += " ORDER BY start_date, COALESCE(start_time, '00:00'), id"
    rows = db.execute(sql, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["attendees"] = _parse_attendees(d.get("attendees"))
        out.append(d)
    return out


# ── Attendee helpers ────────────────────────────────────────────────────────
# Stored as a CSV of integer user IDs. The CSV layout is easy to query
# ("contains user X"), survives migration cleanly (TEXT column), and avoids
# pulling in JSON1 in case an older SQLite is in the field.

def _parse_attendees(raw):
    """'3,5,7' → [3, 5, 7]. Empty / None → []. Bad tokens skipped."""
    if not raw:
        return []
    out = []
    for tok in str(raw).split(","):
        tok = tok.strip()
        if tok.isdigit():
            out.append(int(tok))
    return out


def _normalise_attendees(db, user_id_self, attendee_ids):
    """
    Validate and dedupe a list of attendee IDs.
    - Strips the creator (no point notifying the owner).
    - Filters to active, non-deleted users.
    - Preserves order; returns the cleaned list.
    Raises 400 if any of the supplied IDs do not match a real active user.
    """
    if not attendee_ids:
        return []
    cleaned = []
    seen = set()
    for uid in attendee_ids:
        if not isinstance(uid, int) or uid in seen or uid == user_id_self:
            continue
        seen.add(uid)
        cleaned.append(uid)
    if not cleaned:
        return []
    rows = db.execute(
        f"SELECT id FROM users WHERE is_active=1 AND deleted_at IS NULL "
        f"AND id IN ({','.join('?' for _ in cleaned)})",
        cleaned,
    ).fetchall()
    valid = {r["id"] for r in rows}
    missing = set(cleaned) - valid
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown or inactive user IDs: {sorted(missing)}",
        )
    return [uid for uid in cleaned if uid in valid]


def _notify_invitees(db, *, event_id, title, date, owner_name, invitee_ids):
    """Fire one notification per newly-invited user."""
    if not invitee_ids:
        return
    snippet = f"{owner_name} invited you to '{title}' on {date}."
    for uid in invitee_ids:
        notify(
            db,
            user_id=uid,
            type="planning_event",
            title=f"📅 {title}",
            body=snippet,
            msg="planning_event", params={"title": title},
            link="/planning",
            entity_type="planning_event",
            entity_id=event_id,
        )


@router.post("/events")
def create_event(
    body: EventCreate,
    user=Depends(require_perm("planning", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not body.title or not body.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")
    if not body.start_date:
        raise HTTPException(status_code=400, detail="Start date is required")
    if body.end_date and body.end_date < body.start_date:
        raise HTTPException(status_code=400, detail="End date cannot be earlier than start date")

    now = _now()
    all_day = 1 if (body.all_day is None or body.all_day) else 0
    # When all_day, ignore any time values so we never store stale times that
    # are hidden in the UI.
    start_time = None if all_day else body.start_time
    end_time   = None if all_day else body.end_time

    attendees_clean = _normalise_attendees(db, user["id"], body.attendees or [])
    attendees_csv = ",".join(str(i) for i in attendees_clean) or None

    cur = db.execute(
        """INSERT INTO planning_events
           (title, description, start_date, end_date, start_time, end_time,
            all_day, color, owner_id, owner_name, attendees, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (body.title.strip(), body.description, body.start_date, body.end_date,
         start_time, end_time, all_day, body.color,
         user["id"], user.get("full_name") or user.get("username"),
         attendees_csv, now),
    )
    eid = cur.lastrowid
    # Notify each attendee before committing — keeps the side-effect in the
    # same transaction so we never end up with an event and a missing batch
    # of notifications (or vice versa).
    _notify_invitees(
        db,
        event_id=eid,
        title=body.title.strip(),
        date=body.start_date,
        owner_name=user.get("full_name") or user.get("username") or "Someone",
        invitee_ids=attendees_clean,
    )
    db.commit()
    log_action(db, user, "create", "planning_event", eid, body.title)
    return {"id": eid, "message": "Event created",
            "attendees_notified": len(attendees_clean)}


@router.put("/events/{eid}")
def update_event(
    eid: int,
    body: EventUpdate,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT id, title, start_date, end_date, all_day, attendees, owner_id, owner_name "
        "FROM planning_events WHERE id=? AND archived_at IS NULL", (eid,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    # Only the owner can mutate an event — attendees see it but can't edit.
    # Mirrors how every common calendar tool (Google, Outlook) behaves and
    # keeps the visibility rule and the mutation rule in sync.
    if row["owner_id"] != user["id"] and not user.get("is_superadmin"):
        raise HTTPException(status_code=403, detail="Only the event owner can edit this event")

    # Resolve end vs start consistency on the merged values.
    merged_start = body.start_date if body.start_date is not None else row["start_date"]
    merged_end   = body.end_date   if body.end_date   is not None else row["end_date"]
    if merged_end and merged_end < merged_start:
        raise HTTPException(status_code=400, detail="End date cannot be earlier than start date")

    # If switching to all-day, blank out the time fields.
    if body.all_day is not None and body.all_day:
        body.start_time = ""
        body.end_time   = ""

    # Attendee handling — only touched when the caller explicitly passes the
    # field. Diff against the existing CSV so we notify ONLY users newly
    # added, never re-notifying everyone on every edit.
    new_attendees_csv = None     # Sentinel: don't update the column
    new_invitee_ids   = []
    if body.attendees is not None:
        cleaned = _normalise_attendees(db, user["id"], body.attendees)
        existing = set(_parse_attendees(row["attendees"]))
        new_invitee_ids = [uid for uid in cleaned if uid not in existing]
        new_attendees_csv = ",".join(str(i) for i in cleaned) or ""

    db.execute(
        """UPDATE planning_events SET
              title       = COALESCE(?, title),
              description = COALESCE(?, description),
              start_date  = COALESCE(?, start_date),
              end_date    = COALESCE(?, end_date),
              start_time  = CASE WHEN ? IS NULL THEN start_time
                                 WHEN ? = '' THEN NULL ELSE ? END,
              end_time    = CASE WHEN ? IS NULL THEN end_time
                                 WHEN ? = '' THEN NULL ELSE ? END,
              all_day     = COALESCE(?, all_day),
              color       = COALESCE(?, color),
              attendees   = CASE WHEN ? IS NULL THEN attendees
                                 WHEN ? = '' THEN NULL ELSE ? END,
              updated_at  = ?
           WHERE id = ?""",
        (
            body.title, body.description, body.start_date, body.end_date,
            body.start_time, body.start_time, body.start_time,
            body.end_time,   body.end_time,   body.end_time,
            body.all_day, body.color,
            new_attendees_csv, new_attendees_csv, new_attendees_csv,
            _now(), eid,
        ),
    )

    # Only ping users that weren't already on the invite list.
    _notify_invitees(
        db,
        event_id=eid,
        title=body.title or row["title"],
        date=body.start_date or row["start_date"],
        owner_name=row["owner_name"] or "Someone",
        invitee_ids=new_invitee_ids,
    )
    db.commit()
    log_action(db, user, "edit", "planning_event", eid, body.title or str(eid))
    return {"message": "Event updated",
            "attendees_notified": len(new_invitee_ids)}


@router.delete("/events/{eid}")
def delete_event(
    eid: int,
    user=Depends(require_perm("planning", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Soft-delete (sets archived_at). The list endpoint already filters those out."""
    row = db.execute(
        "SELECT id, title, owner_id FROM planning_events WHERE id=? AND archived_at IS NULL", (eid,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    if row["owner_id"] != user["id"] and not user.get("is_superadmin"):
        raise HTTPException(status_code=403, detail="Only the event owner can delete this event")
    db.execute("UPDATE planning_events SET archived_at = ? WHERE id = ?", (_now(), eid))
    db.commit()
    log_action(db, user, "delete", "planning_event", eid, row["title"])
    return {"message": "Event deleted"}
