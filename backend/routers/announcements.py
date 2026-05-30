"""
Announcements — internal top-down comms.

Endpoints
---------
GET    /api/announcements                       List the current user's inbox.
GET    /api/announcements/sent                  List announcements the current user authored (for editors).
GET    /api/announcements/unread-count          Lightweight counter for the sidebar badge.
GET    /api/announcements/{id}                  Detail (marks recipient as read).
POST   /api/announcements                       Publish a new announcement (announcements.create).
PUT    /api/announcements/{id}                  Edit metadata (own author or superadmin).
DELETE /api/announcements/{id}                  Archive (own author or superadmin).
POST   /api/announcements/{id}/acknowledge      Acknowledge (recipient only).
GET    /api/announcements/{id}/comments         List active comments.
POST   /api/announcements/{id}/comments         Post a comment (recipient or author).
DELETE /api/announcements/{id}/comments/{cid}   Delete own comment (or any if superadmin).
GET    /api/announcements/{id}/audience         Recipient roster + ack progress (author/superadmin only).

Design notes
------------
* Recipients are materialised at publish time so per-user read/ack state is a
  simple row, and 'unread for user X' is a single COUNT(*) JOIN.
* `audience_type='all'` snapshots every active non-deleted user at publish
  time. Future joiners do not retroactively receive historical announcements.
* The list endpoint uses `require_auth` (not `require_perm`) because membership
  on the recipients roster is the authoritative gate — a user who is on the
  roster can always read their own announcement, regardless of RBAC.
"""
import json
import sqlite3
from typing import List, Optional, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from database import get_db
from permissions import require_auth, require_perm
from routers.audit import log_action
from utils import _now, notify

router = APIRouter()


# ── Constants ────────────────────────────────────────────────────────────────

VALID_PRIORITIES = ("low", "medium", "high", "critical")
VALID_AUDIENCE   = ("all", "roles", "users")


# ── Schemas ──────────────────────────────────────────────────────────────────

class AnnouncementCreate(BaseModel):
    title:         str
    body:          str
    priority:      Literal["low", "medium", "high", "critical"] = "medium"
    audience_type: Literal["all", "roles", "users"]
    audience_ids:  Optional[List[int]] = Field(default=None,
                       description="Required when audience_type='roles' or 'users'.")
    requires_ack:  Optional[bool] = False
    pinned:        Optional[bool] = False
    expires_at:    Optional[str]  = None       # 'YYYY-MM-DD' or full timestamp


class AnnouncementUpdate(BaseModel):
    title:         Optional[str] = None
    body:          Optional[str] = None
    priority:      Optional[Literal["low", "medium", "high", "critical"]] = None
    requires_ack:  Optional[bool] = None
    pinned:        Optional[bool] = None
    expires_at:    Optional[str]  = None


class CommentCreate(BaseModel):
    body: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row(r):
    return None if r is None else dict(r)


def _resolve_recipients(db: sqlite3.Connection, audience_type: str,
                       audience_ids: Optional[List[int]]) -> List[int]:
    """Expand audience → distinct list of active, non-deleted user IDs."""
    if audience_type == "all":
        rows = db.execute(
            "SELECT id FROM users WHERE is_active=1 AND deleted_at IS NULL"
        ).fetchall()
        return [r["id"] for r in rows]

    if not audience_ids:
        raise HTTPException(400, "audience_ids is required for this audience type")

    placeholders = ",".join("?" for _ in audience_ids)
    if audience_type == "users":
        rows = db.execute(
            f"SELECT id FROM users WHERE id IN ({placeholders}) "
            f"AND is_active=1 AND deleted_at IS NULL",
            audience_ids,
        ).fetchall()
        return [r["id"] for r in rows]

    # audience_type == "roles"
    rows = db.execute(
        f"SELECT id FROM users WHERE role_id IN ({placeholders}) "
        f"AND is_active=1 AND deleted_at IS NULL",
        audience_ids,
    ).fetchall()
    return list({r["id"] for r in rows})


def _is_author_or_superadmin(user: dict, announcement_author_id: int) -> bool:
    return user.get("is_superadmin") or user["id"] == announcement_author_id


def _audience_summary(db: sqlite3.Connection, ann: dict) -> dict:
    """Build a small display-friendly audience descriptor for the detail view."""
    total = db.execute(
        "SELECT COUNT(*) FROM announcement_recipients WHERE announcement_id=?",
        (ann["id"],),
    ).fetchone()[0]
    payload = json.loads(ann["audience_payload"]) if ann["audience_payload"] else None
    if ann["audience_type"] == "all":
        return {"type": "all", "label": f"All users ({total})", "total": total, "ids": None}
    if ann["audience_type"] == "roles":
        names = [r["name"] for r in db.execute(
            f"SELECT name FROM roles WHERE id IN ({','.join('?' for _ in payload)})",
            payload,
        ).fetchall()]
        return {"type": "roles", "label": ", ".join(names) or "—",
                "total": total, "ids": payload}
    # users
    names = [r["full_name"] or r["username"] for r in db.execute(
        f"SELECT full_name, username FROM users WHERE id IN ({','.join('?' for _ in payload)})",
        payload,
    ).fetchall()]
    return {"type": "users", "label": ", ".join(names) or "—",
            "total": total, "ids": payload}


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/")
def list_inbox(
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Inbox for the current user. Returns only announcements where the current
    user is a recipient AND the announcement is not archived. Membership is
    the authoritative gate; RBAC controls the *create/edit/delete* surface.
    Pinned + most recent first.
    """
    rows = db.execute(
        """
        SELECT a.id, a.title, a.body, a.priority, a.audience_type,
               a.requires_ack, a.pinned, a.author_id, a.author_name,
               a.published_at, a.expires_at,
               r.read_at, r.acknowledged_at,
               (SELECT COUNT(*) FROM announcement_comments c
                  WHERE c.announcement_id = a.id AND c.deleted_at IS NULL) AS comment_count
        FROM announcements a
        JOIN announcement_recipients r ON r.announcement_id = a.id
        WHERE r.user_id = ?
          AND a.archived_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at >= date('now'))
        ORDER BY a.pinned DESC, a.published_at DESC, a.id DESC
        """,
        (user["id"],),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/sent")
def list_sent(
    user: dict = Depends(require_perm("announcements", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """List announcements the current user authored. Includes acknowledgement progress."""
    rows = db.execute(
        """
        SELECT a.id, a.title, a.priority, a.audience_type, a.requires_ack,
               a.pinned, a.published_at, a.expires_at, a.archived_at,
               (SELECT COUNT(*) FROM announcement_recipients r
                  WHERE r.announcement_id = a.id) AS total_recipients,
               (SELECT COUNT(*) FROM announcement_recipients r
                  WHERE r.announcement_id = a.id AND r.read_at IS NOT NULL) AS total_read,
               (SELECT COUNT(*) FROM announcement_recipients r
                  WHERE r.announcement_id = a.id AND r.acknowledged_at IS NOT NULL) AS total_acked
        FROM announcements a
        WHERE a.author_id = ?
        ORDER BY a.published_at DESC, a.id DESC
        """,
        (user["id"],),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/unread-count")
def unread_count(
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Number of unread (active, non-expired) announcements for the current user."""
    n = db.execute(
        """
        SELECT COUNT(*) FROM announcement_recipients r
        JOIN announcements a ON a.id = r.announcement_id
        WHERE r.user_id = ?
          AND r.read_at IS NULL
          AND a.archived_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at >= date('now'))
        """,
        (user["id"],),
    ).fetchone()[0]
    pending = db.execute(
        """
        SELECT COUNT(*) FROM announcement_recipients r
        JOIN announcements a ON a.id = r.announcement_id
        WHERE r.user_id = ?
          AND a.requires_ack = 1
          AND r.acknowledged_at IS NULL
          AND a.archived_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at >= date('now'))
        """,
        (user["id"],),
    ).fetchone()[0]
    return {"unread": n, "pending_ack": pending}


@router.get("/{aid}")
def get_announcement(
    aid: int,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Fetch one announcement. The current user must be either a recipient or the
    author. Marks the recipient row as read on first access — done in the same
    transaction so it never silently fails.
    """
    a = db.execute(
        "SELECT * FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")

    rec = db.execute(
        "SELECT * FROM announcement_recipients WHERE announcement_id=? AND user_id=?",
        (aid, user["id"]),
    ).fetchone()
    if not rec and not _is_author_or_superadmin(user, a["author_id"]):
        raise HTTPException(404, "Announcement not found")

    # Mark read on first view by a recipient.
    if rec and rec["read_at"] is None:
        db.execute(
            "UPDATE announcement_recipients SET read_at=? WHERE id=?",
            (_now(), rec["id"]),
        )
        db.commit()
        rec = db.execute(
            "SELECT * FROM announcement_recipients WHERE id=?", (rec["id"],),
        ).fetchone()

    ann = dict(a)
    ann["audience"] = _audience_summary(db, ann)
    ann["read_at"]         = rec["read_at"] if rec else None
    ann["acknowledged_at"] = rec["acknowledged_at"] if rec else None
    ann["is_author"]       = (user["id"] == a["author_id"])
    return ann


@router.post("/")
def create_announcement(
    body: AnnouncementCreate,
    user: dict = Depends(require_perm("announcements", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not body.title.strip():
        raise HTTPException(400, "Title is required")
    if not body.body.strip():
        raise HTTPException(400, "Body is required")

    recipients = _resolve_recipients(db, body.audience_type, body.audience_ids)
    if not recipients:
        raise HTTPException(400, "Audience is empty — no active users match")

    payload = None
    if body.audience_type in ("roles", "users"):
        payload = json.dumps(body.audience_ids)

    now = _now()
    cur = db.execute(
        """INSERT INTO announcements
           (title, body, priority, audience_type, audience_payload,
            requires_ack, pinned, author_id, author_name,
            published_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            body.title.strip(), body.body.strip(), body.priority,
            body.audience_type, payload,
            1 if body.requires_ack else 0,
            1 if body.pinned else 0,
            user["id"], user.get("full_name") or user.get("username"),
            now, body.expires_at,
        ),
    )
    aid = cur.lastrowid

    # Materialise recipients
    db.executemany(
        "INSERT INTO announcement_recipients (announcement_id, user_id) VALUES (?, ?)",
        [(aid, uid) for uid in recipients],
    )

    # Fire a notification per recipient (skip the author when self-recipient).
    title = f"📣 {body.title.strip()}"
    snippet = (body.body[:120] + "…") if len(body.body) > 120 else body.body
    link = f"/announcements?open={aid}"
    for uid in recipients:
        if uid == user["id"]:
            continue
        notify(
            db,
            user_id=uid,
            type="announcement",
            title=title,
            body=snippet,
            link=link,
            entity_type="announcement",
            entity_id=aid,
        )

    db.commit()
    log_action(db, user, "create", "announcement", aid, body.title)
    return {"id": aid, "recipients": len(recipients), "message": "Published"}


@router.put("/{aid}")
def update_announcement(
    aid: int,
    body: AnnouncementUpdate,
    user: dict = Depends(require_perm("announcements", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    a = db.execute(
        "SELECT id, author_id FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")
    if not _is_author_or_superadmin(user, a["author_id"]):
        raise HTTPException(403, "You can only edit your own announcements")

    db.execute(
        """UPDATE announcements SET
              title        = COALESCE(?, title),
              body         = COALESCE(?, body),
              priority     = COALESCE(?, priority),
              requires_ack = COALESCE(?, requires_ack),
              pinned       = COALESCE(?, pinned),
              expires_at   = COALESCE(?, expires_at)
           WHERE id=?""",
        (
            body.title, body.body, body.priority,
            None if body.requires_ack is None else (1 if body.requires_ack else 0),
            None if body.pinned       is None else (1 if body.pinned       else 0),
            body.expires_at, aid,
        ),
    )
    db.commit()
    log_action(db, user, "edit", "announcement", aid, body.title or str(aid))
    return {"message": "Updated"}


@router.delete("/{aid}")
def archive_announcement(
    aid: int,
    user: dict = Depends(require_perm("announcements", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    a = db.execute(
        "SELECT id, author_id, title FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")
    if not _is_author_or_superadmin(user, a["author_id"]):
        raise HTTPException(403, "You can only archive your own announcements")
    db.execute("UPDATE announcements SET archived_at=? WHERE id=?", (_now(), aid))
    db.commit()
    log_action(db, user, "delete", "announcement", aid, a["title"])
    return {"message": "Archived"}


# ── Acknowledgement ─────────────────────────────────────────────────────────

@router.post("/{aid}/acknowledge")
def acknowledge(
    aid: int,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    a = db.execute(
        "SELECT id, requires_ack FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")
    rec = db.execute(
        "SELECT id, acknowledged_at FROM announcement_recipients "
        "WHERE announcement_id=? AND user_id=?",
        (aid, user["id"]),
    ).fetchone()
    if not rec:
        raise HTTPException(403, "You are not a recipient of this announcement")
    if rec["acknowledged_at"]:
        return {"message": "Already acknowledged", "acknowledged_at": rec["acknowledged_at"]}
    now = _now()
    db.execute(
        "UPDATE announcement_recipients SET acknowledged_at=?, "
        "read_at=COALESCE(read_at, ?) WHERE id=?",
        (now, now, rec["id"]),
    )
    db.commit()
    return {"message": "Acknowledged", "acknowledged_at": now}


# ── Comments ────────────────────────────────────────────────────────────────

@router.get("/{aid}/comments")
def list_comments(
    aid: int,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    # Sanity-check the announcement exists and the user is a recipient or author.
    a = db.execute(
        "SELECT author_id FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")
    if not _is_author_or_superadmin(user, a["author_id"]):
        rec = db.execute(
            "SELECT id FROM announcement_recipients WHERE announcement_id=? AND user_id=?",
            (aid, user["id"]),
        ).fetchone()
        if not rec:
            raise HTTPException(404, "Announcement not found")
    rows = db.execute(
        "SELECT id, author_id, author_name, body, created_at "
        "FROM announcement_comments "
        "WHERE announcement_id=? AND deleted_at IS NULL "
        "ORDER BY created_at ASC, id ASC",
        (aid,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/{aid}/comments")
def create_comment(
    aid: int,
    body: CommentCreate,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(400, "Comment cannot be empty")

    a = db.execute(
        "SELECT author_id FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")

    is_author = _is_author_or_superadmin(user, a["author_id"])
    if not is_author:
        rec = db.execute(
            "SELECT id FROM announcement_recipients WHERE announcement_id=? AND user_id=?",
            (aid, user["id"]),
        ).fetchone()
        if not rec:
            raise HTTPException(403, "Only recipients can comment")

    cur = db.execute(
        """INSERT INTO announcement_comments
           (announcement_id, author_id, author_name, body, created_at)
           VALUES (?,?,?,?,?)""",
        (aid, user["id"], user.get("full_name") or user.get("username"),
         text, _now()),
    )

    # Ping the announcement author when someone else comments — silent for
    # self-comments to avoid notification noise.
    if user["id"] != a["author_id"]:
        notify(
            db,
            user_id=a["author_id"],
            type="announcement_comment",
            title="💬 New comment on your announcement",
            body=text[:120],
            link=f"/announcements?open={aid}",
            entity_type="announcement",
            entity_id=aid,
        )

    db.commit()
    return {"id": cur.lastrowid, "message": "Posted"}


@router.delete("/{aid}/comments/{cid}")
def delete_comment(
    aid: int,
    cid: int,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT author_id FROM announcement_comments "
        "WHERE id=? AND announcement_id=? AND deleted_at IS NULL",
        (cid, aid),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Comment not found")
    if not (user.get("is_superadmin") or user["id"] == row["author_id"]):
        raise HTTPException(403, "You can only delete your own comments")
    db.execute("UPDATE announcement_comments SET deleted_at=? WHERE id=?", (_now(), cid))
    db.commit()
    return {"message": "Deleted"}


# ── Audience roster (for the author) ─────────────────────────────────────────

@router.get("/{aid}/audience")
def audience_roster(
    aid: int,
    user: dict = Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Return the recipient roster + per-user read/ack state. Author or superadmin only."""
    a = db.execute(
        "SELECT author_id FROM announcements WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not a:
        raise HTTPException(404, "Announcement not found")
    if not _is_author_or_superadmin(user, a["author_id"]):
        raise HTTPException(403, "Author only")
    rows = db.execute(
        """SELECT r.user_id, u.full_name, u.username, u.role,
                  r.read_at, r.acknowledged_at
           FROM announcement_recipients r
           JOIN users u ON u.id = r.user_id
           WHERE r.announcement_id = ?
           ORDER BY (r.acknowledged_at IS NULL), (r.read_at IS NULL),
                    COALESCE(u.full_name, u.username)""",
        (aid,),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Dropdowns used by the compose form ──────────────────────────────────────

@router.get("/meta/roles")
def list_roles(
    user: dict = Depends(require_perm("announcements", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, name, color FROM roles ORDER BY name"
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/meta/users")
def list_users(
    user: dict = Depends(require_perm("announcements", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, username, full_name, role FROM users "
        "WHERE is_active=1 AND deleted_at IS NULL "
        "ORDER BY COALESCE(full_name, username)"
    ).fetchall()
    return [dict(r) for r in rows]
