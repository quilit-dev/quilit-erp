"""
Documents — stores HTML snapshots of printed quotations and invoices,
linked to their associated client and/or project for easy retrieval.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()


class DocumentCreate(BaseModel):
    record_type:  str            # "quotation" | "invoice"
    record_id:    int
    client_id:    Optional[int] = None
    project_id:   Optional[int] = None
    title:        str
    html_content: str


# ── Save a document ───────────────────────────────────────────────────────
@router.post("/")
def save_document(
    data: DocumentCreate,
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        """INSERT INTO documents
           (record_type, record_id, client_id, project_id, title, html_content, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (data.record_type, data.record_id, data.client_id,
         data.project_id, data.title, data.html_content, now),
    )
    log_action(db, user, "create", "document", cur.lastrowid, data.title,
               {"record_type": data.record_type, "record_id": data.record_id})
    db.commit()
    return {"id": cur.lastrowid, "message": "Document saved"}


# ── List documents ────────────────────────────────────────────────────────
@router.get("/")
def list_documents(
    client_id:   Optional[int] = Query(None),
    project_id:  Optional[int] = Query(None),
    record_type: Optional[str] = Query(None),
    record_id:   Optional[int] = Query(None),
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query  = "SELECT id, record_type, record_id, client_id, project_id, title, created_at FROM documents WHERE 1=1"
    params = []
    if client_id is not None:
        query += " AND client_id = ?"
        params.append(client_id)
    if project_id is not None:
        query += " AND project_id = ?"
        params.append(project_id)
    if record_type:
        query += " AND record_type = ?"
        params.append(record_type)
    if record_id is not None:
        query += " AND record_id = ?"
        params.append(record_id)
    query += " ORDER BY created_at DESC"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]


# ── Get HTML content ──────────────────────────────────────────────────────
@router.get("/{doc_id}/content")
def get_document_content(
    doc_id: int,
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    return dict(row)


# ── Delete a document attachment ──────────────────────────────────────────
@router.delete("/{doc_id}")
def delete_document(
    doc_id: int,
    user=Depends(require_perm("quotations", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT id, title FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    db.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    log_action(db, user, "delete", "document", doc_id, row["title"] or "")
    db.commit()
    return {"message": "Document removed"}
