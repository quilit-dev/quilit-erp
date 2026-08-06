"""
The invoice and quotation document — one renderer, server-side, bilingual.

This is the ONLY place a printable invoice or quotation is laid out. There used
to be a second, richer template in the frontend (exportUtils.js) rendered through
window.print(); two templates meant a customer could receive a document that
looked nothing like the one their supplier saw on screen, and only one of them
could ever reach a mobile app, an email attachment or the client's share link.
So this one absorbed everything the browser template had and the browser path now
calls it.

Everything a professional invoice needs and the old HTML template carried:
logo, full company identity, tax and registration numbers, bill-to block,
document metadata, per-line discount and tax columns (honouring the Document
Settings toggles), totals with paid and balance, payment history, notes, bank
details for the transfer, a secondary-currency note, and the configurable footer.

Bilingual means MIRRORED, not merely translated. An Arabic invoice puts the
company block on the right, the totals on the left, and reverses the item
columns — a right-aligned string inside a left-to-right layout still reads as a
European document with Arabic words in it. `_D` carries the direction and every
placement asks it rather than hardcoding a side.

Arabic also needs contextual shaping and bidi reordering applied BEFORE the
glyphs reach the page (fpdf2 draws them in the order given), which is what
`shape()` does. Amiri is embedded because it is the one bundled font covering
both Arabic and Latin.

Money is formatted here, never calculated. The API already returns subtotal,
tax_total, total_paid and remaining; a second implementation of the arithmetic
that decides what a customer owes would eventually disagree with the first.
"""
import logging
import os
import unicodedata
from datetime import datetime, timedelta

# fpdf2 subsets the embedded font on every render and fontTools narrates all of
# it at INFO — around sixty lines per document, which buries real log events.
for _noisy in ("fontTools", "fontTools.subset", "fontTools.ttLib"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

_HERE = os.path.dirname(os.path.abspath(__file__))
_FONT_DIR = os.path.join(_HERE, "assets", "fonts")
_REGULAR = os.path.join(_FONT_DIR, "Amiri-Regular.ttf")
_BOLD = os.path.join(_FONT_DIR, "Amiri-Bold.ttf")
FONT = "Amiri"

MARGIN = 14.0
PAGE_W = 210.0
BODY_W = PAGE_W - 2 * MARGIN

INK = (17, 17, 17)
MUTED = (105, 100, 110)
RULE = (222, 218, 224)
ACCENT = (113, 75, 103)
GREEN = (21, 128, 61)
RED = (185, 28, 28)
AMBER = (180, 83, 9)
ZEBRA = (249, 247, 250)
# Band tints. Derived from the theme accent/semantic colours rather than the old
# template's slate palette, so a document looks like the rest of the product.
BAND_BG = (248, 245, 248)
BAND_SLATE = (247, 248, 250)
GREEN_BG = (240, 253, 244)
AMBER_BG = (255, 251, 235)


def available() -> tuple[bool, str]:
    """Whether rendering can run, and why not when it cannot. Reported rather
    than raised so a caller can fall back to the share link and say something
    true instead of returning a 500 that reads like a bug."""
    try:
        import fpdf  # noqa: F401
    except Exception:
        return False, "fpdf2 is not installed."
    if not os.path.exists(_REGULAR):
        return False, f"Font not found at {_REGULAR}."
    return True, ""


# ── text ─────────────────────────────────────────────────────────────────────

def _has_arabic(text: str) -> bool:
    return any("؀" <= ch <= "ۿ" or "ݐ" <= ch <= "ݿ"
               for ch in text)


def shape(text) -> str:
    """Make a string safe to draw: Arabic reshaped and bidi-reordered, the rest
    untouched."""
    s = "" if text is None else str(text)
    if not s or not _has_arabic(s):
        return s
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        return get_display(arabic_reshaper.reshape(s))
    except Exception:
        return s          # an unshaped string beats no document


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()


def _num(v, default=0.0) -> float:
    try:
        return float(v if v not in (None, "") else default)
    except (TypeError, ValueError):
        return default


def _money(value, code: str) -> str:
    return f"{_num(value):,.2f} {code}"


def _date(value) -> str:
    if not value:
        return "—"
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:len(fmt) + 2].strip(), fmt).strftime("%d %b %Y")
        except ValueError:
            continue
    return s[:10]


def _add_days(value, days: int) -> str:
    try:
        base = datetime.strptime(str(value)[:10], "%Y-%m-%d")
        return (base + timedelta(days=int(days))).strftime("%Y-%m-%d")
    except Exception:
        return ""


# ── labels ───────────────────────────────────────────────────────────────────

_L = {
    "en": {
        "paidLabel": "Paid in full.",
        "paidBody": "Settled — thank you for your prompt payment.",
        "overdueLabel": "Overdue.",
        "overdueBody": "{amount} was due on {date}. Please arrange payment.",
        "dueLabel": "Payment due.",
        "dueBody": "{amount} by {date} (net {d} days).",
        "notesLabel": "Notes:",
        "fxLabel": "Currency note:",
        "noteLabel": "Note:",
        "invoice": "INVOICE", "quotation": "QUOTATION",
        "billTo": "BILL TO", "quoteFor": "QUOTATION FOR",
        "details": "DETAILS", "issued": "Issued", "due": "Due",
        "valid": "Valid until", "project": "Project", "terms": "Terms",
        "netDays": "Net {d} days", "ref": "Quote ref", "status": "Status",
        "no": "#", "desc": "Description", "qty": "Qty", "price": "Unit price",
        "disc": "Disc.", "tax": "Tax", "amount": "Amount",
        "subtotal": "Subtotal", "discount": "Discount", "taxTotal": "Tax",
        "grand": "Grand Total", "paid": "Paid", "balance": "Balance due",
        "payments": "PAYMENT HISTORY", "date": "Date", "method": "Method",
        "note": "Note", "notes": "NOTES", "bank": "BANK DETAILS",
        "bankName": "Bank", "account": "Account", "iban": "IBAN",
        "swift": "SWIFT", "noItems": "No line items on this document.",
        "page": "Page {n} of {t}", "fxNote":
            "Amounts shown in {code}, converted from {base} at 1 {base} = {rate} {code}.",
        "taxNo": "Tax No.", "regNo": "Reg. No.",
    },
    "ar": {
        "paidLabel": "مدفوعة بالكامل.",
        "paidBody": "تم السداد — شكراً لالتزامكم بالدفع.",
        "overdueLabel": "متأخرة.",
        "overdueBody": "كان مبلغ {amount} مستحقاً في {date}. نرجو ترتيب الدفع.",
        "dueLabel": "مستحقة الدفع.",
        "dueBody": "{amount} بحلول {date} (صافي {d} يوماً).",
        "notesLabel": "ملاحظات:",
        "fxLabel": "ملاحظة العملة:",
        "noteLabel": "ملاحظة:",
        "invoice": "فاتورة", "quotation": "عرض سعر",
        "billTo": "الفاتورة إلى", "quoteFor": "عرض سعر إلى",
        "details": "التفاصيل", "issued": "تاريخ الإصدار", "due": "تاريخ الاستحقاق",
        "valid": "صالح حتى", "project": "المشروع", "terms": "الشروط",
        "netDays": "صافي {d} يوماً", "ref": "مرجع العرض", "status": "الحالة",
        "no": "#", "desc": "الوصف", "qty": "الكمية", "price": "سعر الوحدة",
        "disc": "الخصم", "tax": "الضريبة", "amount": "المبلغ",
        "subtotal": "المجموع", "discount": "الخصم", "taxTotal": "الضريبة",
        "grand": "الإجمالي العام", "paid": "المدفوع", "balance": "الرصيد المستحق",
        "payments": "سجل الدفعات", "date": "التاريخ", "method": "الطريقة",
        "note": "ملاحظة", "notes": "ملاحظات", "bank": "التفاصيل البنكية",
        "bankName": "المصرف", "account": "الحساب", "iban": "IBAN",
        "swift": "SWIFT", "noItems": "لا توجد بنود في هذا المستند.",
        "page": "صفحة {n} من {t}", "fxNote":
            "المبالغ معروضة بـ {code}، محوّلة من {base} بسعر 1 {base} = {rate} {code}.",
        "taxNo": "الرقم الضريبي", "regNo": "رقم السجل",
    },
}


def _labels(lang: str) -> dict:
    return _L.get((lang or "en").lower()[:2], _L["en"])


class _Company:
    """The tenant's identity, read from settings with the same fallbacks the
    browser template used so a document does not change when the renderer did."""

    def __init__(self, s: dict):
        s = s or {}
        self.name = s.get("company_name") or "My Company"
        self.tagline = s.get("company_tagline") or ""
        self.address = ", ".join(
            x for x in (s.get("company_address"), s.get("company_city"),
                        s.get("company_country")) if x)
        self.phone = s.get("company_phone") or ""
        self.email = s.get("company_email") or ""
        self.website = s.get("company_website") or ""
        self.tax_no = s.get("company_tax_number") or ""
        self.reg_no = s.get("company_reg_number") or ""
        self.bank_name = s.get("bank_name") or ""
        self.bank_account = s.get("bank_account") or ""
        self.bank_iban = s.get("bank_iban") or ""
        self.bank_swift = s.get("bank_swift") or ""
        self.currency = s.get("default_currency") or s.get("currency") or "USD"
        self.footer = s.get("footer_text") or ""
        self.payment_days = int(_num(s.get("payment_terms_days"), 15))
        self.show_tax_col = str(s.get("show_tax_col") or "") == "1"
        self.show_disc_col = str(s.get("show_discount_col") or "") == "1"

    def contact_line(self, L) -> str:
        bits = [self.phone, self.email, self.website]
        return "  ·  ".join(b for b in bits if b)

    def ids_line(self, L) -> str:
        bits = []
        if self.tax_no:
            bits.append(f"{L['taxNo']}: {self.tax_no}")
        if self.reg_no:
            bits.append(f"{L['regNo']}: {self.reg_no}")
        return "  ·  ".join(bits)


class _D:
    """Direction. Every horizontal decision asks this rather than assuming
    left-to-right, which is what makes the Arabic document mirrored instead of
    merely translated."""

    def __init__(self, rtl: bool):
        self.rtl = rtl

    @property
    def start(self):                 # where a block's text begins
        return "R" if self.rtl else "L"

    @property
    def end(self):                   # the opposite edge
        return "L" if self.rtl else "R"

    def x_start(self, width):        # left coord of a block hugging the start edge
        return PAGE_W - MARGIN - width if self.rtl else MARGIN

    def x_end(self, width):          # left coord of a block hugging the end edge
        return MARGIN if self.rtl else PAGE_W - MARGIN - width

    def cols(self, cols):            # column order follows reading direction
        return list(reversed(cols)) if self.rtl else cols


class _Doc:
    def __init__(self, title: str, rtl: bool, L: dict):
        from fpdf import FPDF
        self.d = _D(rtl)
        self.L = L
        self.pdf = FPDF(orientation="P", unit="mm", format="A4")
        self.pdf.set_auto_page_break(auto=True, margin=20)
        self.pdf.set_margins(MARGIN, MARGIN, MARGIN)
        self.pdf.add_font(FONT, "", _REGULAR)
        if os.path.exists(_BOLD):
            self.pdf.add_font(FONT, "B", _BOLD)
        self.pdf.set_title(title)
        self.pdf.add_page()

    # ── primitives ──────────────────────────────────────────────────────────
    def font(self, size=9.5, bold=False, color=INK):
        self.pdf.set_font(FONT, "B" if (bold and os.path.exists(_BOLD)) else "", size)
        self.pdf.set_text_color(*color)

    def cell(self, w, h, text, align=None, bold=False, size=9.5, color=INK,
             fill=False, ln=False):
        self.font(size, bold, color)
        try:
            self.pdf.cell(w, h, shape(text), align=align or self.d.start, fill=fill,
                          new_x="LMARGIN" if ln else "RIGHT",
                          new_y="NEXT" if ln else "TOP")
        except Exception:
            self.pdf.cell(w, h, _fold(text), align=align or self.d.start, fill=fill,
                          new_x="LMARGIN" if ln else "RIGHT",
                          new_y="NEXT" if ln else "TOP")

    def line(self, text, size=9.5, bold=False, color=INK, h=4.8, align=None,
             w=None):
        self.pdf.set_x(MARGIN)
        self.cell(w or BODY_W, h, text, align=align, bold=bold, size=size,
                  color=color, ln=True)

    def para(self, text, size=9, color=INK, w=None):
        self.font(size, False, color)
        self.pdf.set_x(MARGIN)
        try:
            self.pdf.multi_cell(w or BODY_W, 4.6, shape(text), align=self.d.start)
        except Exception:
            self.pdf.multi_cell(w or BODY_W, 4.6, _fold(text), align=self.d.start)

    def rule(self, before=1.5, after=2.5, color=RULE):
        self.pdf.ln(before)
        self.pdf.set_draw_color(*color)
        y = self.pdf.get_y()
        self.pdf.line(MARGIN, y, PAGE_W - MARGIN, y)
        self.pdf.ln(after)

    def heading(self, text):
        self.line(text, size=7.8, bold=True, color=ACCENT, h=4.2)

    def band(self, label: str, text: str, bg=BAND_BG, fg=ACCENT):
        """A tinted full-width callout with a bold lead-in.

        The old HTML template used these for the payment state, notes, bank
        details and the currency note, and they are the reason that document
        read as a statement rather than a table dump — the one line a client
        must not miss is the one in colour.
        """
        pdf, d = self.pdf, self.d
        if pdf.get_y() > 248:
            pdf.add_page()
        pdf.set_fill_color(*bg)
        y0 = pdf.get_y()
        pdf.set_x(MARGIN)
        # Measure first so the fill matches the wrapped height exactly.
        self.font(8.6, False, INK)
        body = f"{label}  {text}" if label else str(text)
        pdf.multi_cell(BODY_W, 4.6, shape(body), align=d.start, fill=True,
                       new_x="LMARGIN", new_y="NEXT")
        # Re-draw just the label in colour, over the tinted background.
        if label:
            pdf.set_xy(MARGIN + (0 if not d.rtl else 0), y0)
            self.font(8.6, True, fg)
            w = pdf.get_string_width(shape(label)) + 1
            if d.rtl:
                pdf.set_x(PAGE_W - MARGIN - w)
            pdf.cell(w, 4.6, shape(label), align=d.start)
            pdf.set_y(max(pdf.get_y(), y0))
            pdf.set_x(MARGIN)
            pdf.ln(0)
        pdf.ln(1.2)

    def doc_footer(self, co, number: str):
        """Three columns pinned under the content: who issued it, what it is,
        how to reach them. Carried over from the old template — a page that can
        be printed and filed needs to identify itself without its covering
        email."""
        pdf, d = self.pdf, self.d
        pdf.ln(2)
        pdf.set_draw_color(*RULE)
        y = pdf.get_y()
        pdf.line(MARGIN, y, PAGE_W - MARGIN, y)
        pdf.ln(1.5)
        third = BODY_W / 3.0
        left = co.name
        if co.address:
            left += "\n" + co.address
        if co.phone:
            left += f"  ·  {co.phone}"
        mid = f"{number}  ·  {datetime.utcnow().strftime('%d %b %Y')}"
        right = co.email or ""
        if co.tax_no:
            right += (" · " if right else "") + f"{self.L['taxNo']}: {co.tax_no}"
        cols = [(left, "L"), (mid, "C"), (right, "R")]
        if d.rtl:
            cols = list(reversed(cols))
        top = pdf.get_y()
        for i, (text, align) in enumerate(cols):
            pdf.set_xy(MARGIN + i * third, top)
            self.font(6.8, False, MUTED)
            try:
                pdf.multi_cell(third, 3.4, shape(text), align=align)
            except Exception:
                pdf.multi_cell(third, 3.4, _fold(text), align=align)

    def out(self) -> bytes:
        return bytes(self.pdf.output())


# ── sections ─────────────────────────────────────────────────────────────────

def _header(doc: _Doc, co: _Company, title: str, number: str, meta: list,
            status: tuple = None):
    """Company identity on the start edge, document identity on the end edge."""
    pdf, d, L = doc.pdf, doc.d, doc.L
    top = pdf.get_y()
    half = BODY_W * 0.55

    # Logo, if the tenant uploaded one. Failure is silent: a broken image must
    # never cost the customer their invoice.
    logo_h = 0
    try:
        from routers.settings import _logo_path
        p = _logo_path()
        if p and os.path.exists(p) and os.path.getsize(p) > 0:
            logo_w = 26
            pdf.image(p, x=d.x_start(logo_w), y=top, w=logo_w)
            logo_h = 12
    except Exception:
        logo_h = 0

    pdf.set_y(top + logo_h)
    pdf.set_x(d.x_start(half))
    doc.cell(half, 6, co.name, bold=True, size=15, ln=True)
    for text, size in ((co.tagline, 8.5), (co.address, 8.5),
                       (co.contact_line(L), 8.5), (co.ids_line(L), 8.5)):
        if text:
            pdf.set_x(d.x_start(half))
            doc.cell(half, 4.2, text, size=size, color=MUTED, ln=True)
    left_bottom = pdf.get_y()

    # Document identity, mirrored to the other edge.
    pdf.set_y(top)
    pdf.set_x(d.x_end(half))
    doc.cell(half, 8, title, align=d.end, bold=True, size=19, color=ACCENT, ln=True)
    pdf.set_x(d.x_end(half))
    doc.cell(half, 5, number, align=d.end, bold=True, size=11, ln=True)
    for row in meta:
        pdf.set_x(d.x_end(half))
        doc.cell(half, 4.2, row, align=d.end, size=8.5, color=MUTED, ln=True)
    if status:
        text, color = status
        pdf.set_x(d.x_end(half))
        doc.cell(half, 5, text, align=d.end, bold=True, size=9.5, color=color, ln=True)

    pdf.set_y(max(left_bottom, pdf.get_y()))
    doc.rule()


def _parties(doc: _Doc, party_label: str, client: dict, detail_rows: list):
    """Bill-to and document details, side by side and direction-aware."""
    pdf, d = doc.pdf, doc.d
    top = pdf.get_y()
    col = BODY_W * 0.48

    pdf.set_x(d.x_start(col))
    doc.cell(col, 4.4, party_label, bold=True, size=7.8, color=ACCENT, ln=True)
    pdf.set_x(d.x_start(col))
    doc.cell(col, 5.2, client.get("name") or "—", bold=True, size=11, ln=True)
    for extra in [client.get("email"), client.get("phone"), client.get("address")]:
        if extra:
            pdf.set_x(d.x_start(col))
            doc.cell(col, 4.2, extra, size=8.8, color=MUTED, ln=True)
    left_bottom = pdf.get_y()

    pdf.set_y(top)
    for label, value in detail_rows:
        if not value:
            continue
        pdf.set_x(d.x_end(col))
        doc.font(8.8, False, MUTED)
        doc.pdf.cell(col * 0.45, 4.4, shape(label), align=d.start)
        doc.font(8.8, True, INK)
        doc.pdf.cell(col * 0.55, 4.4, shape(str(value)), align=d.end)
        pdf.ln(4.4)
    pdf.set_y(max(left_bottom, pdf.get_y()) + 2)


def _items(doc: _Doc, items: list, code: str, co: _Company, doc_disc_pct: float):
    """Line items. Column set follows the Document Settings toggles so a company
    that does not use per-line tax never sees an empty Tax column."""
    pdf, d, L = doc.pdf, doc.d, doc.L
    show_disc = co.show_disc_col
    show_tax = co.show_tax_col

    cols = [(L["no"], 8, "L"), (L["desc"], 0, "L"), (L["qty"], 16, "R"),
            (L["price"], 26, "R")]
    if show_disc:
        cols.append((L["disc"], 20, "R"))
    if show_tax:
        cols.append((L["tax"], 20, "R"))
    cols.append((L["amount"], 28, "R"))
    fixed = sum(c[1] for c in cols)
    cols = [(t, (BODY_W - fixed) if w == 0 else w, a) for t, w, a in cols]
    ordered = d.cols(cols)

    def header():
        pdf.set_x(MARGIN)
        doc.font(8, True, (255, 255, 255))
        pdf.set_fill_color(*ACCENT)
        for title, w, align in ordered:
            pdf.cell(w, 6.6, shape(title),
                     align=(d.end if align == "R" else d.start), fill=True)
        pdf.ln(6.6)

    header()
    fill = False
    for i, it in enumerate(items or [], start=1):
        if pdf.get_y() > 235:
            pdf.add_page()
            header()
        qty = _num(it.get("quantity"))
        price = _num(it.get("unit_price"))
        gross = qty * price
        disc_pct = _num(it.get("discount_pct"), doc_disc_pct)
        disc = gross * disc_pct / 100.0
        net = gross - disc
        tax_rate = _num(it.get("tax_rate"), co.payment_days * 0)  # 0 default
        tax = net * tax_rate / 100.0
        total = it.get("line_total")
        total = _num(total) if total not in (None, "") else net + tax

        # Two lines per row, as the old template did: the item NAME in normal
        # weight, its longer description beneath in muted small text. Collapsing
        # both into one cell was losing the description entirely on invoices that
        # carry both, which is where the specification a client agreed to lives.
        primary = str(it.get("name") or it.get("description") or "—")
        secondary = str(it.get("description") or "") if it.get("name") else ""
        if secondary.strip() == primary.strip():
            secondary = ""
        limit = 52 if (show_disc and show_tax) else 62
        desc = primary if len(primary) <= limit else primary[:limit - 1] + "…"

        values = [(str(i), 8, "L"), (desc, 0, "L"), (f"{qty:g}", 16, "R"),
                  (_money(price, code), 26, "R")]
        if show_disc:
            values.append((f"{disc_pct:g}%" if disc_pct else "—", 20, "R"))
        if show_tax:
            values.append((f"{tax_rate:g}%" if tax_rate else "—", 20, "R"))
        values.append((_money(total, code), 28, "R"))
        widths = {t: w for t, w, _ in cols}
        values = [(v, cols[j][1], a) for j, (v, _w, a) in enumerate(values)]

        pdf.set_x(MARGIN)
        pdf.set_fill_color(*ZEBRA)
        doc.font(8.8, False, INK)
        for text, w, align in d.cols(values):
            pdf.cell(w, 6.2, shape(text),
                     align=(d.end if align == "R" else d.start), fill=fill)
        pdf.ln(6.2)
        if secondary:
            # Second line, under the description column only, tinted to match.
            desc_w = cols[1][1]
            x = MARGIN + (BODY_W - cols[0][1] - desc_w if d.rtl else cols[0][1])
            pdf.set_x(x)
            doc.font(7.6, False, MUTED)
            sec = secondary if len(secondary) <= limit + 14 else secondary[:limit + 13] + "…"
            pdf.cell(desc_w, 4.4, shape(sec), align=d.start, fill=fill)
            pdf.ln(4.4)
        fill = not fill

    if not items:
        doc.line(L["noItems"], size=9, color=MUTED, align="C")


def _totals(doc: _Doc, rows: list, code: str):
    """Totals stack, hugging the reading-direction end edge."""
    pdf, d = doc.pdf, doc.d
    lw, vw = 42.0, 42.0
    x = d.x_end(lw + vw)
    pdf.ln(1.5)
    for label, value, strong, color in rows:
        if value is None:
            continue
        pdf.set_x(x)
        doc.font(10.5 if strong else 9, strong, INK if strong else MUTED)
        pdf.cell(lw, 6, shape(label), align=d.start)
        # A deduction reads as "(125.00 USD)" in amber rather than a minus sign:
        # a negative number in a totals column is easy to misread as a credit.
        neg = _num(value) < 0
        text = f"({_money(abs(_num(value)), code)})" if neg else _money(value, code)
        doc.font(10.5 if strong else 9, strong,
                 AMBER if neg else (color or INK))
        pdf.cell(vw, 6, shape(text), align=d.end)
        pdf.ln(6)
        if strong:
            pdf.set_draw_color(*RULE)
            y = pdf.get_y()
            pdf.line(x, y, x + lw + vw, y)
            pdf.ln(1)


def _payments(doc: _Doc, payments: list, code: str):
    if not payments:
        return
    L, d, pdf = doc.L, doc.d, doc.pdf
    doc.rule()
    doc.heading(L["payments"])
    cols = [(L["date"], 30, "L"), (L["method"], 34, "L"),
            (L["note"], BODY_W - 30 - 34 - 32, "L"), (L["amount"], 32, "R")]
    pdf.set_x(MARGIN)
    doc.font(8, True, MUTED)
    for t, w, a in d.cols(cols):
        pdf.cell(w, 5.4, shape(t), align=(d.end if a == "R" else d.start))
    pdf.ln(5.4)
    for p in payments:
        if pdf.get_y() > 250:
            pdf.add_page()
        vals = [(_date(p.get("paid_at")), 30, "L"),
                (str(p.get("method") or "—"), 34, "L"),
                (str(p.get("note") or "—")[:48], cols[2][1], "L"),
                (_money(p.get("amount"), code), 32, "R")]
        pdf.set_x(MARGIN)
        doc.font(8.8, False, INK)
        for t, w, a in d.cols(vals):
            pdf.cell(w, 5.4, shape(t), align=(d.end if a == "R" else d.start))
        pdf.ln(5.4)


def _state_band(doc: _Doc, L: dict, status: str, balance: float, due: str,
                days: int, code: str):
    """The payment-state callout. This is the line a client is meant to act on,
    so it gets colour and its own band rather than sitting in a totals column."""
    if status == "Paid" or balance < 0.01:
        doc.band(L["paidLabel"], L["paidBody"], GREEN_BG, GREEN)
        return
    overdue = False
    try:
        overdue = bool(due) and datetime.strptime(str(due)[:10], "%Y-%m-%d") < datetime.utcnow()
    except Exception:
        overdue = False
    if overdue:
        doc.band(L["overdueLabel"],
                 L["overdueBody"].format(amount=_money(balance, code),
                                         date=_date(due)), AMBER_BG, AMBER)
    else:
        doc.band(L["dueLabel"],
                 L["dueBody"].format(amount=_money(balance, code),
                                     date=_date(due), d=days))


def _footer_blocks(doc: _Doc, co: _Company, notes, fx_note: str = None):
    L = doc.L
    if notes:
        doc.band(L["notesLabel"], str(notes))
    if fx_note:
        doc.band(L["fxLabel"], fx_note, BAND_SLATE, MUTED)
    bank = [(L["bankName"], co.bank_name), (L["account"], co.bank_account),
            (L["iban"], co.bank_iban), (L["swift"], co.bank_swift)]
    bank = [(k, v) for k, v in bank if v]
    if bank:
        doc.rule()
        doc.heading(L["bank"])
        # One row per field, label and value in separate cells.
        #
        # These were joined into a single line, which broke in Arabic: an
        # Arabic label with a Latin value is a mixed-direction string, bidi
        # reorders it so the visual line starts Latin and ends Arabic, and
        # multi_cell then dropped most of it — the IBAN and SWIFT a client needs
        # to actually pay silently disappeared from the Arabic invoice while the
        # English one looked fine. Separate cells keep each run in one direction.
        d, pdf = doc.d, doc.pdf
        lw = 26.0
        for k, v in bank:
            pdf.set_x(MARGIN)
            doc.font(8.8, False, MUTED)
            pdf.cell(lw, 4.8, shape(k), align=d.start)
            doc.font(8.8, True, INK)
            pdf.cell(BODY_W - lw, 4.8, shape(v), align=d.start)
            pdf.ln(4.8)
    if co.footer:
        doc.band(L["noteLabel"], co.footer, BAND_SLATE, MUTED)


def _fx_note(company_settings: dict, co: _Company, L: dict, code: str):
    """Secondary-currency note, carried over from the browser template: a
    Lebanese invoice priced in USD is commonly settled in LBP at a stated rate,
    and omitting the rate makes the document unusable for the client."""
    sec = (company_settings or {}).get("secondary_currency")
    rate = _num((company_settings or {}).get("secondary_currency_rate"))
    if not sec or sec == co.currency or rate <= 0 or code != sec:
        return None
    return L["fxNote"].format(code=sec, base=co.currency, rate=f"{rate:,.0f}")


# ── public API ───────────────────────────────────────────────────────────────

def render_invoice(inv: dict, settings: dict, lang: str = "en") -> bytes:
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    L = _labels(lang)
    co = _Company(settings)
    code = co.currency
    doc = _Doc(f"Invoice {inv.get('invoice_number') or inv.get('id')}",
               (lang or "en").lower().startswith("ar"), L)

    status = str(inv.get("payment_status") or "Unpaid")
    color = {"Paid": GREEN, "Unpaid": RED}.get(status, AMBER)
    issued = inv.get("created_at")
    due = inv.get("due_date") or _add_days(issued, co.payment_days)

    meta = [f"{L['issued']}: {_date(issued)}", f"{L['due']}: {_date(due)}"]
    if inv.get("quote_number"):
        meta.append(f"{L['ref']}: {inv['quote_number']}")

    _header(doc, co, L["invoice"], inv.get("invoice_number") or "—", meta,
            (f"{L['status']}: {status}", color))

    _parties(doc, L["billTo"],
             {"name": inv.get("client_name"), "email": inv.get("client_email"),
              "phone": inv.get("client_phone")},
             [(L["issued"], _date(issued)), (L["due"], _date(due)),
              (L["project"], inv.get("project_name")),
              (L["terms"], L["netDays"].format(d=co.payment_days)),
              ("", code)])

    _items(doc, inv.get("items"), code, co, _num(inv.get("discount_pct")))

    remaining = _num(inv.get("remaining"))
    rows = [(L["subtotal"], inv.get("subtotal"), False, None)]
    if _num(inv.get("discount_total")) > 0.005:
        rows.append((L["discount"], -_num(inv.get("discount_total")), False, None))
    if _num(inv.get("tax_total")) > 0.005:
        rows.append((L["taxTotal"], inv.get("tax_total"), False, None))
    rows.append((L["grand"], inv.get("amount"), True, None))
    if _num(inv.get("total_paid")) > 0.005:
        rows.append((L["paid"], inv.get("total_paid"), False, GREEN))
    rows.append((L["balance"], remaining, True,
                 GREEN if remaining < 0.01 else RED))
    _totals(doc, rows, code)

    # The payment state, as a coloured band directly under the totals — this is
    # the line the client is meant to act on.
    _state_band(doc, L, status, remaining, due, co.payment_days, code)

    _payments(doc, inv.get("payments"), code)
    _footer_blocks(doc, co, inv.get("notes"), _fx_note(settings, co, L, code))
    doc.doc_footer(co, inv.get("invoice_number") or "—")
    return doc.out()


def render_quotation(q: dict, settings: dict, lang: str = "en") -> bytes:
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    L = _labels(lang)
    co = _Company(settings)
    code = co.currency
    doc = _Doc(f"Quotation {q.get('quote_number') or q.get('id')}",
               (lang or "en").lower().startswith("ar"), L)

    issued = q.get("created_at")
    meta = [f"{L['issued']}: {_date(issued)}"]
    if q.get("valid_until"):
        meta.append(f"{L['valid']}: {_date(q.get('valid_until'))}")

    status = q.get("status")
    _header(doc, co, L["quotation"], q.get("quote_number") or "—", meta,
            (f"{L['status']}: {status}", ACCENT) if status else None)

    _parties(doc, L["quoteFor"],
             {"name": q.get("client_name"), "email": q.get("client_email"),
              "phone": q.get("client_phone")},
             [(L["issued"], _date(issued)),
              (L["valid"], _date(q.get("valid_until")) if q.get("valid_until") else None),
              (L["project"], q.get("project_name")),
              ("", code)])

    _items(doc, q.get("items"), code, co, _num(q.get("discount_pct")))

    rows = [(L["subtotal"], q.get("subtotal"), False, None)]
    if _num(q.get("discount_total")) > 0.005:
        rows.append((L["discount"], -_num(q.get("discount_total")), False, None))
    if _num(q.get("tax_total")) > 0.005:
        rows.append((L["taxTotal"], q.get("tax_total"), False, None))
    rows.append((L["grand"], q.get("amount") or q.get("total"), True, None))
    _totals(doc, rows, code)

    _footer_blocks(doc, co, q.get("notes"), _fx_note(settings, co, L, code))
    doc.doc_footer(co, q.get("quote_number") or "—")
    return doc.out()
