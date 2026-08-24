"""The cross-module scan behind the insight panel.

One request instead of the six the Finance page used to fire at whatever
endpoints happened to be near, and it reaches modules that page never touched.
Read-only, permission-gated per block, and it returns figures rather than
sentences — the wording is rendered from the message catalogue on the client so
English and Arabic stay one translation of one sentence.
"""
import sqlite3
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query

import insights
from database import get_db
from permissions import require_auth

router = APIRouter()


@router.get("/")
def business_signals(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Aggregates for every module the caller may see.

    `require_auth` rather than a module permission: the response is assembled
    per block from what this user can view, so there is no single module that
    would be the right gate. A user who can see nothing gets the scan header
    and no blocks, which is the honest answer.
    """
    if not start:
        start = (date.today() - timedelta(days=90)).isoformat()
    return insights.build(db, user, start[:10], (end or str(date.today()))[:10])
