"""
Server-side PDF for invoices and quotations.

Why this exists: the browser templates in exportUtils.js render through
window.print(), which needs a human at a print dialog. That is fine on a desktop
and useless everywhere else — a mobile app cannot open or download such a
"PDF", and an email cannot attach one. Anything that produces a PDF without a
person clicking has to render it here.

Money is NOT recomputed. The API already returns subtotal, tax_total,
total_paid and remaining; deriving them again here would create a second
implementation of the arithmetic that decides what a customer owes, and the two
would eventually disagree. This module formats numbers, it does not calculate
them.

Arabic: fpdf2 draws glyphs in the order given, so Arabic needs contextual
shaping (isolated letters joined into their medial/final forms) and bidi
reordering applied BEFORE it reaches the page, or the output is disconnected
letters running the wrong way. arabic_reshaper + python-bidi do that, and Amiri
is embedded because it is the one font here covering both Arabic and Latin — a
bilingual invoice with an Arabic-only font renders Latin as blanks.

Chosen over WeasyPrint deliberately: this stack is pure Python, so it needs no
system libraries, adds nothing to the image, and can be tested on any developer
machine and in CI. The cost is that layout is written by hand instead of in
CSS.
"""
import logging
import os
import unicodedata
from datetime import datetime

# fpdf2 subsets the embedded font on every render and fontTools narrates all of
# it at INFO — around sixty lines per document. On a structured-logging
# deployment that buries real events under font-table chatter and costs money in
# log ingestion, so it is capped once at import.
for _noisy in ("fontTools", "fontTools.subset", "fontTools.ttLib"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "fonts")
_REGULAR = os.path.join(_FONT_DIR, "Amiri-Regular.ttf")
_BOLD = os.path.join(_FONT_DIR, "Amiri-Bold.ttf")
FONT = "Amiri"

# Page geometry (mm, A4 portrait).
MARGIN = 15.0
PAGE_W = 210.0
BODY_W = PAGE_W - 2 * MARGIN

INK = (17, 17, 17)
MUTED = (110, 110, 110)
RULE = (215, 215, 215)
ACCENT = (113, 75, 103)          # --accent, keeps PDFs recognisably Quilit-built
GREEN = (21, 128, 61)
RED = (220, 38, 38)


def available() -> tuple[bool, str]:
    """Whether PDF rendering can run, and why not when it cannot.

    Reported rather than raised so callers can degrade to the share link and
    say something true, instead of returning a 500 that reads like a bug.
    """
    try:
        import fpdf  # noqa: F401
    except Exception:
        return False, "fpdf2 is not installed."
    if not os.path.exists(_REGULAR):
        return False, f"Font not found at {_REGULAR}."
    return True, ""


def _has_arabic(text: str) -> bool:
    return any("؀" <= ch <= "ۿ" or "ݐ" <= ch <= "ݿ"
               for ch in text)


def shape(text) -> str:
    """Make a string safe to draw. Arabic is reshaped and bidi-reordered;
    everything else passes through untouched."""
    s = "" if text is None else str(text)
    if not s or not _has_arabic(s):
        return s
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        return get_display(arabic_reshaper.reshape(s))
    except Exception:
        # Better an unshaped string than no document at all.
        return s


def _money(value, code: str) -> str:
    try:
        n = float(value or 0)
    except (TypeError, ValueError):
        n = 0.0
    return f"{n:,.2f} {code}"


def _date(value) -> str:
    if not value:
        return "—"
    s = str(value)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:len(fmt) + 2].strip(), fmt).strftime("%d %b %Y")
        except ValueError:
            continue
    return s[:10]


def _ascii_fold(s: str) -> str:
    """Last-resort fallback if the embedded font is missing a glyph."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


class _Doc:
    """Thin wrapper over FPDF holding the shared invoice/quotation layout."""

    def __init__(self, title: str, rtl: bool):
        from fpdf import FPDF
        self.rtl = rtl
        self.pdf = FPDF(orientation="P", unit="mm", format="A4")
        self.pdf.set_auto_page_break(auto=True, margin=18)
        self.pdf.set_margins(MARGIN, MARGIN, MARGIN)
        self.pdf.add_font(FONT, "", _REGULAR)
        if os.path.exists(_BOLD):
            self.pdf.add_font(FONT, "B", _BOLD)
        self.pdf.set_title(title)
        self.pdf.add_page()
        self.font()

    def font(self, size: float = 10, bold: bool = False, color=INK):
        style = "B" if (bold and os.path.exists(_BOLD)) else ""
        self.pdf.set_font(FONT, style, size)
        self.pdf.set_text_color(*color)

    def text(self, s, w=0, h=5, align=None, ln=1, size=10, bold=False, color=INK):
        self.font(size, bold, color)
        if align is None:
            align = "R" if self.rtl else "L"
        try:
            self.pdf.cell(w or BODY_W, h, shape(s), align=align, new_x="LMARGIN",
                          new_y="NEXT" if ln else "TOP")
        except Exception:
            self.pdf.cell(w or BODY_W, h, _ascii_fold(str(s)), align=align,
                          new_x="LMARGIN", new_y="NEXT" if ln else "TOP")

    def rule(self, gap_before=1.5, gap_after=2.5):
        self.pdf.ln(gap_before)
        self.pdf.set_draw_color(*RULE)
        y = self.pdf.get_y()
        self.pdf.line(MARGIN, y, PAGE_W - MARGIN, y)
        self.pdf.ln(gap_after)

    def out(self) -> bytes:
        return bytes(self.pdf.output())


def _company_block(d: _Doc, company: dict):
    d.text(company.get("company_name") or company.get("name") or "", size=15, bold=True)
    meta = [company.get(k) for k in
            ("company_address", "company_phone", "company_email", "tax_number")]
    line = "  ·  ".join(str(m) for m in meta if m)
    if line:
        d.text(line, size=8.5, color=MUTED)


def _party_block(d: _Doc, label: str, name, extra: list):
    d.text(label, size=8, bold=True, color=ACCENT)
    d.text(name or "—", size=11, bold=True)
    for line in [x for x in extra if x]:
        d.text(line, size=9, color=MUTED)


def _items_table(d: _Doc, items: list, code: str, labels: dict):
    """Line items. Columns are fixed-width so the table cannot reflow into an
    unreadable shape on a long description; descriptions are truncated instead,
    because a wrapped cell that pushes totals onto page 3 is worse than a
    shortened name."""
    pdf = d.pdf
    cols = [(labels["desc"], BODY_W - 95, "L"), (labels["qty"], 20, "R"),
            (labels["price"], 35, "R"), (labels["total"], 40, "R")]

    def header():
        d.font(8.5, True, (255, 255, 255))
        pdf.set_fill_color(*ACCENT)
        for title, w, align in cols:
            pdf.cell(w, 7, shape(title), align=align, fill=True)
        pdf.ln(7)

    header()
    d.font(9.5)
    pdf.set_text_color(*INK)
    fill = False
    for it in (items or []):
        if pdf.get_y() > 250:                 # keep the table off the footer
            pdf.add_page()
            header()
            d.font(9.5)
        qty = float(it.get("quantity") or 0)
        price = float(it.get("unit_price") or 0)
        line_total = it.get("line_total")
        if line_total is None:
            line_total = qty * price          # display-only; server owns the real total
        desc = str(it.get("description") or it.get("name") or "—")
        if len(desc) > 58:
            desc = desc[:57] + "…"
        pdf.set_fill_color(248, 247, 248)
        vals = [(desc, cols[0][1], "L"),
                (f"{qty:g}", cols[1][1], "R"),
                (_money(price, code), cols[2][1], "R"),
                (_money(line_total, code), cols[3][1], "R")]
        for text, w, align in vals:
            pdf.cell(w, 6.5, shape(text), align=align, fill=fill)
        pdf.ln(6.5)
        fill = not fill
    if not items:
        d.text(labels["noItems"], size=9.5, color=MUTED, align="C")


def _totals(d: _Doc, rows: list, code: str):
    """Right-aligned totals stack. Each row is (label, value, emphasis, color)."""
    pdf = d.pdf
    label_w, value_w = 45.0, 45.0
    x = PAGE_W - MARGIN - label_w - value_w
    pdf.ln(2)
    for label, value, strong, color in rows:
        pdf.set_x(x)
        d.font(10.5 if strong else 9.5, strong, MUTED if not strong else INK)
        pdf.cell(label_w, 6.5, shape(label), align="L")
        d.font(10.5 if strong else 9.5, strong, color or INK)
        pdf.cell(value_w, 6.5, shape(_money(value, code)), align="R")
        pdf.ln(6.5)


def _footer_note(d: _Doc, notes, terms):
    if notes:
        d.rule()
        d.text(terms, size=8, bold=True, color=ACCENT)
        d.font(9)
        try:
            d.pdf.multi_cell(BODY_W, 5, shape(str(notes)))
        except Exception:
            d.pdf.multi_cell(BODY_W, 5, _ascii_fold(str(notes)))


_L = {
    "en": {"invoice": "INVOICE", "quotation": "QUOTATION", "billTo": "BILL TO",
           "quoteFor": "QUOTATION FOR", "from": "FROM", "date": "Date",
           "due": "Due", "valid": "Valid until", "number": "No.",
           "desc": "Description", "qty": "Qty", "price": "Unit price",
           "total": "Total", "subtotal": "Subtotal", "tax": "Tax",
           "grand": "Total", "paid": "Paid", "balance": "Balance due",
           "notes": "NOTES", "noItems": "No line items on this document.",
           "status": "Status", "ref": "Quote ref"},
    "ar": {"invoice": "فاتورة", "quotation": "عرض سعر", "billTo": "الفاتورة إلى",
           "quoteFor": "عرض سعر إلى", "from": "من", "date": "التاريخ",
           "due": "تاريخ الاستحقاق", "valid": "صالح حتى", "number": "الرقم",
           "desc": "الوصف", "qty": "الكمية", "price": "سعر الوحدة",
           "total": "الإجمالي", "subtotal": "المجموع", "tax": "الضريبة",
           "grand": "الإجمالي", "paid": "المدفوع", "balance": "الرصيد المستحق",
           "notes": "ملاحظات", "noItems": "لا توجد بنود في هذا المستند.",
           "status": "الحالة", "ref": "مرجع العرض"},
}


def _labels(lang: str) -> dict:
    return _L.get((lang or "en").lower()[:2], _L["en"])


def _head(d: _Doc, company: dict, title: str, number: str, meta_rows: list,
          status: str = None, status_color=None):
    _company_block(d, company)
    d.pdf.ln(1)
    d.text(title, size=20, bold=True, color=ACCENT,
           align="R" if not d.rtl else "L")
    d.text(number, size=11, bold=True, align="R" if not d.rtl else "L")
    for row in meta_rows:
        d.text(row, size=9, color=MUTED, align="R" if not d.rtl else "L")
    if status:
        d.text(status, size=10, bold=True, color=status_color or INK,
               align="R" if not d.rtl else "L")
    d.rule()


def render_invoice(inv: dict, company: dict, lang: str = "en") -> bytes:
    """PDF for one invoice. `inv` is the /api/invoices/{id} payload."""
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    L = _labels(lang)
    rtl = (lang or "en").lower().startswith("ar")
    code = company.get("currency") or "USD"
    d = _Doc(f"Invoice {inv.get('invoice_number') or inv.get('id')}", rtl)

    status = str(inv.get("payment_status") or "Unpaid")
    color = {"Paid": GREEN, "Unpaid": RED}.get(status, (217, 119, 6))
    meta = [f"{L['date']}: {_date(inv.get('created_at'))}",
            f"{L['due']}: {_date(inv.get('due_date'))}"]
    if inv.get("quote_number"):
        meta.append(f"{L['ref']}: {inv['quote_number']}")

    _head(d, company, L["invoice"], inv.get("invoice_number") or "—", meta,
          f"{L['status']}: {status}", color)

    _party_block(d, L["billTo"], inv.get("client_name"),
                 [inv.get("client_email"), inv.get("client_phone"),
                  inv.get("project_name")])
    d.pdf.ln(3)

    _items_table(d, inv.get("items"), code, L)

    rows = [(L["subtotal"], inv.get("subtotal"), False, None)]
    if float(inv.get("tax_total") or 0) > 0.005:
        rows.append((L["tax"], inv.get("tax_total"), False, None))
    rows.append((L["grand"], inv.get("amount"), True, None))
    if float(inv.get("total_paid") or 0) > 0.005:
        rows.append((L["paid"], inv.get("total_paid"), False, GREEN))
    remaining = float(inv.get("remaining") or 0)
    rows.append((L["balance"], remaining, True, GREEN if remaining < 0.01 else RED))
    _totals(d, rows, code)

    _footer_note(d, inv.get("notes"), L["notes"])
    return d.out()


def render_quotation(q: dict, company: dict, lang: str = "en") -> bytes:
    """PDF for one quotation. `q` is the /api/quotations/{id} payload."""
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    L = _labels(lang)
    rtl = (lang or "en").lower().startswith("ar")
    code = company.get("currency") or "USD"
    d = _Doc(f"Quotation {q.get('quote_number') or q.get('id')}", rtl)

    meta = [f"{L['date']}: {_date(q.get('created_at'))}"]
    if q.get("valid_until"):
        meta.append(f"{L['valid']}: {_date(q.get('valid_until'))}")
    status = q.get("status")

    _head(d, company, L["quotation"], q.get("quote_number") or "—", meta,
          f"{L['status']}: {status}" if status else None)

    _party_block(d, L["quoteFor"], q.get("client_name"),
                 [q.get("client_email"), q.get("client_phone"),
                  q.get("project_name")])
    d.pdf.ln(3)

    _items_table(d, q.get("items"), code, L)

    rows = [(L["subtotal"], q.get("subtotal"), False, None)]
    if float(q.get("tax_total") or 0) > 0.005:
        rows.append((L["tax"], q.get("tax_total"), False, None))
    rows.append((L["grand"], q.get("amount") or q.get("total"), True, None))
    _totals(d, rows, code)

    _footer_note(d, q.get("notes"), L["notes"])
    return d.out()
