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


# ── the single professional template ────────────────────────────────────────
#
# There used to be a second, richer template in the frontend rendered through
# window.print(). It was deleted, so everything it carried has to be here — and
# these assert that, because a silently thinner invoice is a document a business
# cannot legally or practically send.

FULL_SETTINGS = {
    "company_name": "Quilit Demo Trading SARL",
    "company_tagline": "Industrial supply since 2011",
    "company_address": "Sin El Fil", "company_city": "Beirut",
    "company_country": "Lebanon", "company_phone": "+961 1 490 000",
    "company_email": "billing@quilitdemo.com", "company_website": "quilitdemo.com",
    "company_tax_number": "VAT-1234567", "company_reg_number": "REG-88991",
    "bank_name": "Bank Audi", "bank_account": "0012-345678",
    "bank_iban": "LB62 0999 0000 0001", "bank_swift": "AUDBLBBX",
    "default_currency": "USD", "footer_text": "Goods remain our property until paid.",
    "payment_terms_days": "15", "show_tax_col": "1", "show_discount_col": "1",
}

RICH_INVOICE = dict(
    INVOICE,
    project_name="Warehouse fit-out",
    payments=[{"paid_at": "2026-08-10", "method": "Bank transfer",
               "note": "Partial on account", "amount": 500}],
    discount_total=125.00,
    items=[{"description": "Centrifugal pump", "quantity": 2, "unit_price": 1250,
            "discount_pct": 5, "tax_rate": 11, "line_total": 2636.25}],
)


def test_invoice_carries_every_professional_element():
    txt = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en"))
    required = {
        "company name": "Quilit Demo Trading SARL",
        "tagline": "Industrial supply since 2011",
        "address": "Beirut",
        "tax number": "VAT-1234567",
        "registration number": "REG-88991",
        "client": "Acme Trading LLC",
        "project": "Warehouse fit-out",
        "payment terms": "Net 15",
        "line item": "Centrifugal pump",
        "grand total": "1,665.00",
        "payment history": "PAYMENT HISTORY",
        "payment method": "Bank transfer",
        # Notes are a tinted band with a bold lead-in, as the old
        # template had them — not a section heading.
        "notes band": "Notes:",
        "notes content": "Payment by bank transfer",
        "footer": "Goods remain our property",
    }
    missing = [name for name, needle in required.items() if needle not in txt]
    assert not missing, f"the single template dropped: {missing}"


def test_the_bank_block_is_gone_from_the_document():
    """The four company bank lines were removed with the settings section that
    fed them: free text, no balance, connected to nothing. Leaving the printing
    behind would have frozen four uneditable lines onto every customer
    document.

    (What this replaces was a bidi regression: an Arabic label beside a Latin
    value is mixed-direction, and multi_cell dropped most of it — the IBAN and
    SWIFT a client needs in order to pay vanished from the Arabic invoice while
    the English one looked fine. There is no longer a block for it to happen
    to.)"""
    for lang in ("en", "ar"):
        txt = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, lang))
        for needle in ("Bank Audi", "LB62", "AUDBLBBX"):
            assert needle not in txt, f"{needle!r} is still printed ({lang})"


def test_arabic_document_is_mirrored_not_just_translated():
    """The Arabic layout must place the company block on the right and the
    totals on the left. Comparing the x of the company name against the English
    render is the cheapest proof the direction actually flipped."""
    import io
    pypdf = pytest.importorskip("pypdf")

    def first_x(data, needle):
        page = pypdf.PdfReader(io.BytesIO(data)).pages[0]
        found = []
        page.extract_text(visitor_text=lambda t, cm, tm, fd, fs:
                          found.append(tm[4]) if needle in t else None)
        return found[0] if found else None

    en = pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en")
    ar = pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "ar")
    # The invoice number sits on the opposite edge in each direction.
    x_en = first_x(en, "INV-2026-0042")
    x_ar = first_x(ar, "INV-2026-0042")
    assert x_en is not None and x_ar is not None
    assert x_ar < x_en, (
        f"Arabic document was not mirrored: number at x={x_ar} vs x={x_en}")


def test_optional_columns_follow_settings():
    """A company that does not use per-line tax must not get an empty Tax
    column, and one that does must get it."""
    off = dict(FULL_SETTINGS, show_tax_col="0", show_discount_col="0")
    txt_off = _text(pdf_render.render_invoice(RICH_INVOICE, off, "en"))
    txt_on = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en"))
    # The COLUMN header is "Disc." with a full stop; the totals row says
    # "Discount" and is driven by the amount, not by the toggle. Matching on a
    # bare "Disc" cannot tell them apart.
    assert "Disc." not in txt_off, "per-line discount column rendered while disabled"
    assert "Disc." in txt_on, "per-line discount column missing while enabled"
    # The totals line is independent of the column toggle.
    assert "Discount" in txt_off


def test_quotation_has_no_payment_or_balance_language():
    """A quotation is not owed. Showing "Balance due" on one is wrong and
    invites a client to pay against a document that is not a bill."""
    txt = _text(pdf_render.render_quotation(QUOTATION, FULL_SETTINGS, "en"))
    assert "Balance due" not in txt
    assert "PAYMENT HISTORY" not in txt


# ── structure carried over from the old HTML template ───────────────────────

def test_payment_state_band_reflects_the_state():
    """The old template led with a coloured callout for the payment state, and
    it is the line a client is meant to act on. Three states, three messages."""
    paid = dict(RICH_INVOICE, payment_status="Paid", remaining=0, total_paid=1665)
    assert "Paid in full" in _text(pdf_render.render_invoice(paid, FULL_SETTINGS, "en"))

    overdue = dict(RICH_INVOICE, payment_status="Unpaid", due_date="2020-01-01",
                   remaining=1665, total_paid=0)
    t = _text(pdf_render.render_invoice(overdue, FULL_SETTINGS, "en"))
    assert "Overdue" in t and "2020" in t

    upcoming = dict(RICH_INVOICE, payment_status="Unpaid", due_date="2099-01-01",
                    remaining=1665, total_paid=0)
    t2 = _text(pdf_render.render_invoice(upcoming, FULL_SETTINGS, "en"))
    assert "Payment due" in t2 and "Overdue" not in t2


def test_deduction_is_parenthesised_not_negative():
    """A minus sign in a totals column reads as a credit. The old box used
    "(125.00)"."""
    txt = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en"))
    assert "(125.00 USD)" in txt
    assert "-125.00" not in txt


def test_grand_total_is_labelled_as_such():
    txt = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en"))
    assert "Grand Total" in txt


def test_document_footer_identifies_the_page():
    """A printed page filed away has to say who issued it and which document it
    is, without the covering email."""
    txt = _text(pdf_render.render_invoice(RICH_INVOICE, FULL_SETTINGS, "en"))
    assert "INV-2026-0042" in txt
    assert "billing@quilitdemo.com" in txt


def test_item_description_is_not_lost_behind_the_name():
    """Rows carry a name AND a longer description; collapsing them lost the
    specification the client actually agreed to."""
    inv = dict(RICH_INVOICE, items=[{
        "name": "Centrifugal pump", "description": "3in cast iron, 400V motor",
        "quantity": 1, "unit_price": 100, "line_total": 100}])
    txt = _text(pdf_render.render_invoice(inv, FULL_SETTINGS, "en"))
    assert "Centrifugal pump" in txt
    assert "3in cast iron" in txt


def test_state_band_is_translated_in_arabic():
    paid = dict(RICH_INVOICE, payment_status="Paid", remaining=0)
    txt = _text(pdf_render.render_invoice(paid, FULL_SETTINGS, "ar"))
    # Shaped Arabic, and no English state text leaking through.
    assert "Paid in full" not in txt
    assert any(0xFE70 <= ord(c) <= 0xFEFF for c in txt)
