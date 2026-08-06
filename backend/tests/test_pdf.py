"""
Server-side PDF rendering for invoices and quotations.

These guard the thing that makes a PDF useful somewhere other than a desktop
browser: the mobile app opens this, and an email attaches it. The browser's
window.print() path cannot serve either.

The Arabic tests are the ones worth keeping honest about. A PDF that "renders"
can still be unreadable — Arabic drawn without contextual shaping comes out as
disconnected letters in the wrong order, and it looks fine to any check that
only asserts the bytes start with %PDF. So the assertion is on the presence of
Unicode presentation forms (U+FE70..U+FEFF) and the ABSENCE of unshaped base
letters, which is the difference between a correct invoice and a garbled one.
"""
import pytest

import pdf_render


COMPANY = {"company_name": "Quilit Demo Co", "company_address": "Beirut, Lebanon",
           "company_phone": "+961 1 000 000", "company_email": "billing@demo.test",
           "tax_number": "VAT-123456", "currency": "USD"}

INVOICE = {
    "invoice_number": "INV-2026-0042", "created_at": "2026-08-06 15:52:11",
    "due_date": "2026-08-21", "payment_status": "Partial",
    "quote_number": "QT-2026-0009", "client_name": "Acme Trading LLC",
    "client_email": "ap@acme.test", "client_phone": "+961 71 234 567",
    "items": [{"description": "Widget A", "quantity": 3, "unit_price": 300,
               "line_total": 900},
              {"description": "Service B", "quantity": 2, "unit_price": 300,
               "line_total": 600}],
    "subtotal": 1500, "tax_total": 165, "amount": 1665,
    "total_paid": 500, "remaining": 1165,
    "notes": "Payment by bank transfer within 15 days.",
}

QUOTATION = {
    "quote_number": "QT-2026-0009", "created_at": "2026-08-01",
    "valid_until": "2026-08-31", "status": "Sent",
    "client_name": "Acme Trading LLC", "items": INVOICE["items"],
    "subtotal": 1500, "tax_total": 0, "amount": 1500,
}

pytestmark = pytest.mark.skipif(not pdf_render.available()[0],
                                reason=f"PDF stack unavailable: {pdf_render.available()[1]}")


def _text(data: bytes) -> str:
    pypdf = pytest.importorskip("pypdf")
    import io
    r = pypdf.PdfReader(io.BytesIO(data))
    return "\n".join(p.extract_text() or "" for p in r.pages)


# ── rendering ────────────────────────────────────────────────────────────────

def test_invoice_renders_a_real_pdf():
    data = pdf_render.render_invoice(INVOICE, COMPANY, "en")
    assert data[:5] == b"%PDF-"
    assert len(data) > 2000


def test_invoice_carries_the_numbers_that_matter():
    """Every figure a customer would dispute has to actually be on the page."""
    txt = _text(pdf_render.render_invoice(INVOICE, COMPANY, "en"))
    for expected in ("INV-2026-0042", "Acme Trading LLC", "1,665.00",
                     "1,165.00", "500.00", "Widget A", "QT-2026-0009"):
        assert expected in txt, f"{expected!r} missing from the PDF"


def test_totals_come_from_the_payload_not_recomputed():
    """pdf_render formats money, it must never calculate it. Feeding a payload
    whose 'amount' disagrees with its line items must print the payload's
    value — the server is the single source of truth for what is owed."""
    odd = dict(INVOICE, amount=9999, subtotal=9999, remaining=9999,
               tax_total=0, total_paid=0)
    txt = _text(pdf_render.render_invoice(odd, COMPANY, "en"))
    assert "9,999.00" in txt
    assert "1,665.00" not in txt


def test_quotation_renders():
    data = pdf_render.render_quotation(QUOTATION, COMPANY, "en")
    assert data[:5] == b"%PDF-"
    assert "QT-2026-0009" in _text(data)


# ── Arabic ───────────────────────────────────────────────────────────────────

def test_arabic_is_shaped_not_garbled():
    ar_company = dict(COMPANY, company_name="شركة كويلت للتجارة",
                      company_address="بيروت، لبنان")
    ar_invoice = dict(INVOICE, client_name="مؤسسة النور التجارية",
                      notes="الدفع بحوالة بنكية خلال ١٥ يوماً.",
                      items=[{"description": "جهاز تكييف", "quantity": 2,
                              "unit_price": 450, "line_total": 900}])
    txt = _text(pdf_render.render_invoice(ar_invoice, ar_company, "ar"))

    presentation = [c for c in txt if 0xFE70 <= ord(c) <= 0xFEFF]
    unshaped = [c for c in txt if 0x0620 <= ord(c) <= 0x064A]
    assert presentation, "no contextual forms — Arabic was not shaped"
    assert not unshaped, f"unshaped Arabic letters leaked through: {unshaped[:10]}"


def test_arabic_keeps_latin_and_numbers():
    """Amiri is embedded precisely because an Arabic-only font renders Latin as
    blanks — a bilingual invoice needs both scripts from one font."""
    ar = dict(INVOICE, client_name="مؤسسة النور")
    txt = _text(pdf_render.render_invoice(ar, dict(COMPANY, currency="USD"), "ar"))
    assert "USD" in txt
    assert "1,665.00" in txt


def test_shape_leaves_non_arabic_untouched():
    for s in ("Acme Trading LLC", "1,665.00 USD", "", "INV-2026-0042"):
        assert pdf_render.shape(s) == s


# ── robustness ───────────────────────────────────────────────────────────────

def test_empty_invoice_does_not_crash():
    """A draft with no lines and no client still has to produce a document —
    a 500 here would break the send flow for a legitimate record."""
    data = pdf_render.render_invoice({"invoice_number": "INV-EMPTY"}, COMPANY, "en")
    assert data[:5] == b"%PDF-"


def test_missing_company_settings_does_not_crash():
    data = pdf_render.render_invoice(INVOICE, {}, "en")
    assert data[:5] == b"%PDF-"


def test_long_description_is_truncated_not_reflowed():
    """A pathological description must not push the totals onto another page."""
    long_item = [{"description": "X" * 400, "quantity": 1, "unit_price": 10,
                  "line_total": 10}]
    data = pdf_render.render_invoice(dict(INVOICE, items=long_item), COMPANY, "en")
    import io
    pypdf = pytest.importorskip("pypdf")
    assert len(pypdf.PdfReader(io.BytesIO(data)).pages) == 1


def test_many_items_paginate():
    items = [{"description": f"Line {i}", "quantity": 1, "unit_price": 10,
              "line_total": 10} for i in range(80)]
    data = pdf_render.render_invoice(dict(INVOICE, items=items), COMPANY, "en")
    import io
    pypdf = pytest.importorskip("pypdf")
    pages = pypdf.PdfReader(io.BytesIO(data)).pages
    assert len(pages) > 1, "80 line items should span more than one page"


def test_none_values_are_tolerated():
    messy = dict(INVOICE, client_email=None, client_phone=None, notes=None,
                 due_date=None, quote_number=None, tax_total=None,
                 total_paid=None, remaining=None)
    assert pdf_render.render_invoice(messy, COMPANY, "en")[:5] == b"%PDF-"


# ── endpoints ────────────────────────────────────────────────────────────────

def test_pdf_endpoints(make_client):
    """Content type, disposition and caching all matter to a mobile client:
    inline decides whether it previews or downloads, and no-store stops a proxy
    serving a stale copy of a document whose balance has changed."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme Trading"}).json()
    inv = c.post("/api/invoices/", json={"client_id": cl["id"], "amount": 1500}).json()

    r = c.get(f"/api/pdf/invoices/{inv['id']}.pdf")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    assert r.headers["content-disposition"].startswith("inline")
    assert "no-store" in r.headers["cache-control"]

    r2 = c.get(f"/api/pdf/invoices/{inv['id']}.pdf?download=1")
    assert r2.headers["content-disposition"].startswith("attachment")

    assert c.get("/api/pdf/invoices/999999.pdf").status_code == 404
    assert c.get("/api/pdf/status").json()["enabled"] is True


def test_pdf_requires_authentication(make_client):
    """The PDF is business data — it must not be reachable without a session."""
    anon = make_client()
    assert anon.get("/api/pdf/invoices/1.pdf").status_code in (401, 403)
