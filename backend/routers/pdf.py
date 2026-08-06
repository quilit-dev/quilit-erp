"""
PDF endpoints for invoices and quotations.

These exist because window.print() needs a human at a print dialog. A mobile app
cannot open or download that, and an email cannot attach it — so anything that
produces a PDF without a person clicking has to come from the server.

The payload is fetched by CALLING the existing get-one handlers rather than
re-querying. Their `Depends(...)` defaults are only resolved by FastAPI, so
passing `db` and `user` explicitly runs the same function bodies the API serves.
The PDF therefore cannot show different data from the screen — the failure mode
of a second SELECT is a document that disagrees with the record it represents.

Permission is enforced HERE, because calling a handler directly bypasses its own
dependency: require_perm on these routes is the only check that runs.
"""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

import pdf_render
from database import get_db
from permissions import require_perm
from routers.invoices import get_invoice
from routers.quotations import get_quotation
from routers.settings import get_settings

# No prefix here — main.py mounts this at /api/pdf. Declaring it in both
# places would serve the routes at /api/pdf/api/pdf.
router = APIRouter()


def _company(user, db) -> dict:
    try:
        return get_settings(user=user, db=db) or {}
    except Exception:
        return {}


def _pdf_response(data: bytes, filename: str, download: bool) -> Response:
    # inline → the app or browser opens it in a viewer.
    # attachment → it lands in the device's downloads.
    disp = "attachment" if download else "inline"
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'{disp}; filename="{filename}"',
            # Never cache: an invoice can be paid, edited or voided between two
            # opens, and a stale PDF of a financial document is a real problem.
            "Cache-Control": "no-store, must-revalidate",
        },
    )


def _guard():
    ok, why = pdf_render.available()
    if not ok:
        # 503 rather than 500 — the request was valid, the server simply cannot
        # render right now, and the reason is named so it is actionable.
        raise HTTPException(status_code=503,
                            detail=f"PDF rendering unavailable. {why}")


@router.get("/invoices/{invoice_id}.pdf")
def invoice_pdf(invoice_id: int,
                download: bool = Query(False),
                lang: str = Query(None),
                user=Depends(require_perm("invoices", "view")),
                db: sqlite3.Connection = Depends(get_db)):
    """One invoice as a PDF. `?download=1` forces a save rather than a preview;
    `?lang=ar` overrides the company's configured language."""
    _guard()
    inv = get_invoice(invoice_id, user=user, db=db)
    company = _company(user, db)
    try:
        data = pdf_render.render_invoice(
            inv, company, lang or company.get("language") or "en")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    number = str(inv.get("invoice_number") or invoice_id).replace("/", "-")
    return _pdf_response(data, f"Invoice-{number}.pdf", download)


@router.get("/quotations/{quote_id}.pdf")
def quotation_pdf(quote_id: int,
                  download: bool = Query(False),
                  lang: str = Query(None),
                  user=Depends(require_perm("quotations", "view")),
                  db: sqlite3.Connection = Depends(get_db)):
    _guard()
    q = get_quotation(quote_id, user=user, db=db)
    company = _company(user, db)
    try:
        data = pdf_render.render_quotation(
            q, company, lang or company.get("language") or "en")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    number = str(q.get("quote_number") or quote_id).replace("/", "-")
    return _pdf_response(data, f"Quotation-{number}.pdf", download)


@router.get("/status")
def pdf_status(user=Depends(require_perm("invoices", "view"))):
    """Whether server-side PDF works, so a client can hide the button instead of
    offering one that 503s."""
    ok, why = pdf_render.available()
    return {"enabled": ok, "reason": why or None}
