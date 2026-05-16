"""
Planning — Projects, Tasks, Milestones
Interactive project planning with Gantt, Board, List, and Calendar views.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
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
    project_id: int
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
    user=Depends(require_perm("planning", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    sql = """
        SELECT p.*, c.name as client_name,
               (SELECT COUNT(*) FROM planning_tasks t WHERE t.project_id=p.id AND t.archived_at IS NULL) as task_count,
               (SELECT COUNT(*) FROM planning_tasks t WHERE t.project_id=p.id AND t.archived_at IS NULL AND t.status='Done') as done_count
        FROM planning_projects p
        LEFT JOIN clients c ON p.client_id = c.id
        WHERE p.archived_at IS NULL
    """
    params = []
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
    _ALLOWED_PROJECT = {'name','description','client_id','color','start_date','end_date','status'}
    row = db.execute("SELECT id FROM planning_projects WHERE id=? AND archived_at IS NULL", (pid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    fields = {k: v for k, v in body.dict().items() if v is not None and k in _ALLOWED_PROJECT}
    if not fields:
        return {"message": "Nothing to update"}
    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE planning_projects SET {set_clause} WHERE id=?", list(fields.values()) + [pid])
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


# ─── Planning Tasks ──────────────────────────────────────────────────────────

@router.get("/tasks")
def list_tasks(
    project_id: Optional[int] = Query(None),
    status: str = Query(""),
    assigned_to: Optional[int] = Query(None),
    search: str = Query(""),
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
        WHERE t.archived_at IS NULL
    """
    params = []
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


@router.post("/tasks")
def create_task(
    body: TaskCreate,
    user=Depends(require_perm("planning", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    proj = db.execute("SELECT id FROM planning_projects WHERE id=? AND archived_at IS NULL", (body.project_id,)).fetchone()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    now = _now()
    cur = db.execute(
        """INSERT INTO planning_tasks
           (project_id, name, description, assigned_to, status, priority,
            start_date, end_date, progress, milestone_id, depends_on, color, sort_order, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (body.project_id, body.name, body.description, body.assigned_to,
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
    _ALLOWED_TASK = {'name','description','assigned_to','status','priority','start_date','end_date','progress','milestone_id','depends_on','color','sort_order'}
    row = db.execute("SELECT id FROM planning_tasks WHERE id=? AND archived_at IS NULL", (tid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    fields = {k: v for k, v in body.dict().items() if v is not None and k in _ALLOWED_TASK}
    if not fields:
        return {"message": "Nothing to update"}
    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE planning_tasks SET {set_clause} WHERE id=?", list(fields.values()) + [tid])
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
    db.commit()
    return {"id": cur.lastrowid, "message": "Milestone created"}


@router.put("/milestones/{mid}")
def update_milestone(
    mid: int,
    body: MilestoneUpdate,
    user=Depends(require_perm("planning", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    _ALLOWED_MILESTONE = {'name','due_date','reached_at'}
    fields = {k: v for k, v in body.dict().items() if v is not None and k in _ALLOWED_MILESTONE}
    if not fields:
        return {"message": "Nothing to update"}
    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE planning_milestones SET {set_clause} WHERE id=?", list(fields.values()) + [mid])
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
