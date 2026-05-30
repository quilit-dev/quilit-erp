"""
Attachments — generic file uploads on any business entity.

One table (`attachments`) and one router serve every module: invoices,
purchases, projects, expenses, assets, suppliers, clients, quotations and
inventory items. Files are stored as BLOBs in the database (no filesystem
path → no path-traversal surface), exactly like the HR / recruitment file
endpoints.

Security model
--------------
* Access is gated by the HOST entity's existing RBAC module: you need that
  module's `view` to list/download and `edit` to upload/delete. The module is
  resolved at runtime from the entity type via ENTITY_REGISTRY, so the check is
  imperative (`permissions.check_perm`) rather than a static dependency.
* The stored `content_type` is always a CANONICAL value from a fixed allowlist,
  never the raw client-supplied header — otherwise a caller could smuggle e.g.
  `text/html` and have the download endpoint serve it inline (stored-XSS).
* Downloads are served inline only for a safe set (PDF + images); everything
  else is forced as an attachment. `X-Content-Type-Options: nosniff` blocks
  MIME sniffing either way.
"""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from typing import Optional
from database import get_db
from permissions import require_auth, check_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

# entity_type → (table, primary-key column, RBAC module). The table and module
# are hard-coded here, never taken from the request, so the value can be safely
# interpolated into the existence-check SQL.
ENTITY_REGISTRY = {
    "invoices":   ("invoices",     "id", "invoices"),
    "purchases":  ("purchases",    "id", "purchases"),
    "projects":   ("projects",     "id", "projects"),
    "expenses":   ("expenses",     "id", "expenses"),
    "assets":     ("fixed_assets", "id", "assets"),
    "suppliers":  ("suppliers",    "id", "suppliers"),
    "clients":    ("clients",      "id", "clients"),
    "quotations": ("quotations",   "id", "quotations"),
    "inventory":  ("inventory",    "id", "inventory"),
}

MAX_FILE_BYTES = 15 * 1024 * 1024   # 15 MB per file

# Canonical content-type → default extension. The KEY is what we store and
# later serve back; anything outside this set is rejected.
_ALLOWED = {
    "application/pdf":                                                            ".pdf",
    "image/png":                                                                 ".png",
    "image/jpeg":                                                                ".jpg",
    "image/gif":                                                                 ".gif",
    "image/webp":                                                                ".webp",
    "application/msword":                                                        ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":   ".docx",
    "application/vnd.ms-excel":                                                  ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         ".xlsx",
    "text/csv":                                                                  ".csv",
    "text/plain":                                                                ".txt",
}
# Extension → canonical type, for when the browser sends an empty or generic
# 'application/octet-stream' content-type (common for Office files).
_EXT_TO_TYPE = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv", ".txt": "text/plain",
}
# Types it is safe to render inline in a browser tab. SVG/HTML are deliberately
# excluded (script execution); they'd be forced to download even if allowed.
_INLINE_OK = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"}

_ALLOWED_HINT = "PDF, image (PNG/JPG/GIF/WEBP), Word, Excel, CSV or text"


def _resolve_type(file: UploadFile) -> str:
    """Return the canonical, allow-listed content-type for an upload, else 400."""
    ct = (file.content_type or "").split(";")[0].strip().lower()
    if ct in _ALLOWED:
        return ct
    name = (file.filename or "").lower()
    for ext, canonical in _EXT_TO_TYPE.items():
        if name.endswith(ext):
            return canonical
    raise HTTPException(400, f"Unsupported file type. Allowed: {_ALLOWED_HINT}.")


def _entity_or_404(db: sqlite3.Connection, entity_type: str):
    """Validate the entity type and that the host row exists. Returns (table,
    module). The table/module come from the hard-coded registry."""
    reg = ENTITY_REGISTRY.get(entity_type)
    if not reg:
        raise HTTPException(404, f"Attachments are not supported for '{entity_type}'.")
    return reg


def _meta_row(r: sqlite3.Row) -> dict:
    return {
        "id":               r["id"],
        "entity_type":      r["entity_type"],
        "entity_id":        r["entity_id"],
        "filename":         r["filename"],
        "content_type":     r["content_type"],
        "size_bytes":       r["size_bytes"],
        "uploaded_by_name": r["uploaded_by_name"],
        "created_at":       r["created_at"],
    }


# NOTE ON ROUTE ORDER: the `/file/{id}` routes are declared BEFORE the generic
# `/{entity_type}/{entity_id}` routes. Starlette matches in declaration order,
# and both shapes are two segments — so `/file/5` must be registered first or it
# would be captured as entity_type="file", entity_id=5.

# ── Download (literal `file` segment keeps this off the {entity_type} route) ──
@router.get("/file/{attachment_id}")
def download_attachment(
    attachment_id: int,
    download: bool = False,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT entity_type, filename, content_type, data FROM attachments WHERE id=?",
        (attachment_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Attachment not found")
    _, _, module = _entity_or_404(db, row["entity_type"])
    check_perm(user, db, module, "view")

    ctype = row["content_type"] or "application/octet-stream"
    inline = (ctype in _INLINE_OK) and not download
    disposition = "inline" if inline else "attachment"
    # Quote the filename to survive spaces/special chars in the header.
    safe_name = (row["filename"] or "file").replace('"', "")
    return Response(
        content=row["data"],
        media_type=ctype,
        headers={
            "Content-Disposition": f'{disposition}; filename="{safe_name}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=0, must-revalidate",
        },
    )


# ── Delete ───────────────────────────────────────────────────────────────────
@router.delete("/file/{attachment_id}")
def delete_attachment(
    attachment_id: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT entity_type, entity_id, filename FROM attachments WHERE id=?",
        (attachment_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Attachment not found")
    _, _, module = _entity_or_404(db, row["entity_type"])
    check_perm(user, db, module, "edit")
    db.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
    log_action(db, user, "delete", "attachment", attachment_id,
               f"{row['entity_type']} #{row['entity_id']} — {row['filename']}")
    db.commit()
    return {"message": "Attachment deleted"}


# ── List ───────────────────────────────────────────────────────────────────
@router.get("/{entity_type}/{entity_id}")
def list_attachments(
    entity_type: str,
    entity_id: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    table, pk, module = _entity_or_404(db, entity_type)
    check_perm(user, db, module, "view")
    rows = db.execute(
        "SELECT id, entity_type, entity_id, filename, content_type, size_bytes, "
        "       uploaded_by_name, created_at "
        "FROM attachments WHERE entity_type=? AND entity_id=? "
        "ORDER BY created_at DESC, id DESC",
        (entity_type, entity_id),
    ).fetchall()
    return [_meta_row(r) for r in rows]


# ── Upload ───────────────────────────────────────────────────────────────────
@router.post("/{entity_type}/{entity_id}")
async def upload_attachment(
    entity_type: str,
    entity_id: int,
    file: UploadFile = File(...),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    table, pk, module = _entity_or_404(db, entity_type)
    check_perm(user, db, module, "edit")

    # `table`/`pk` are from the hard-coded registry — safe to interpolate.
    if not db.execute(f"SELECT 1 FROM {table} WHERE {pk}=?", (entity_id,)).fetchone():
        raise HTTPException(404, "The record you're attaching to does not exist.")

    content_type = _resolve_type(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            400,
            f"File too large ({len(data) // 1024} KB). "
            f"Maximum is {MAX_FILE_BYTES // (1024 * 1024)} MB.",
        )

    now = _now()
    cur = db.execute(
        "INSERT INTO attachments "
        "(entity_type, entity_id, filename, content_type, size_bytes, data, "
        " uploaded_by, uploaded_by_name, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (entity_type, entity_id, (file.filename or "file")[:255], content_type,
         len(data), data, user["id"],
         user.get("full_name") or user.get("username"), now),
    )
    log_action(db, user, "upload", "attachment", cur.lastrowid,
               f"{entity_type} #{entity_id} — {file.filename}")
    db.commit()
    return {
        "id":           cur.lastrowid,
        "filename":     file.filename,
        "content_type": content_type,
        "size_bytes":   len(data),
        "message":      "File attached",
    }
