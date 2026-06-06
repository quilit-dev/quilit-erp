"""
HTML email bodies for documents (Feature #1).

Rendered server-side from the live record + company settings, so emailing works
whether or not a printed snapshot was saved. Inline CSS only (email clients
ignore <style>/external CSS). All user/data values are HTML-escaped.
"""
from html import escape

from utils import get_setting


def _company(db) -> dict:
    return {
        "name":     get_setting(db, "company_name", "") or "Your Company",
        "address":  get_setting(db, "company_address", "") or "",
        "phone":    get_setting(db, "company_phone", "") or "",
        "email":    get_setting(db, "company_email", "") or "",
        "currency": get_setting(db, "default_currency", "USD") or "USD",
        "footer":   get_setting(db, "footer_text", "") or "",
    }


def _money(cur, n) -> str:
    try:
        return f"{cur} {float(n or 0):,.2f}"
    except (TypeError, ValueError):
        return f"{cur} 0.00"


def _rows(items, cur) -> str:
    out = []
    for it in items:
        out.append(
            "<tr>"
            f'<td style="padding:6px 8px;border-bottom:1px solid #eee">{escape(str(it.get("name") or ""))}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">{escape(str(it.get("quantity") or 0))}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">{_money(cur, it.get("unit_price"))}</td>'
            f'<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">{_money(cur, it.get("total"))}</td>'
            "</tr>")
    return "".join(out)


def _shell(co, title, intro, meta_rows, items, cur, totals, message=None):
    note = (f'<p style="margin:0 0 14px;color:#444">{escape(message)}</p>' if message else "")
    meta = "".join(
        f'<tr><td style="padding:2px 0;color:#666">{escape(k)}</td>'
        f'<td style="padding:2px 0 2px 16px;text-align:right;font-weight:600">{escape(v)}</td></tr>'
        for k, v in meta_rows)
    tot = "".join(
        f'<tr><td style="padding:3px 8px;text-align:right;color:#666">{escape(k)}</td>'
        f'<td style="padding:3px 8px;text-align:right;font-weight:700;min-width:120px">{v}</td></tr>'
        for k, v in totals)
    contact = " · ".join(filter(None, [co["address"], co["phone"], co["email"]]))
    return f"""\
<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <div style="background:#fff;border:1px solid #e6e6ea;border-radius:10px;overflow:hidden">
    <div style="background:#714B67;color:#fff;padding:18px 24px">
      <div style="font-size:18px;font-weight:700">{escape(co['name'])}</div>
      <div style="font-size:13px;opacity:.85">{escape(title)}</div>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 14px">{escape(intro)}</p>
      {note}
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">{meta}</table>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#faf7f9">
          <th style="padding:8px;text-align:left">Item</th>
          <th style="padding:8px;text-align:right">Qty</th>
          <th style="padding:8px;text-align:right">Unit</th>
          <th style="padding:8px;text-align:right">Total</th>
        </tr></thead>
        <tbody>{_rows(items, cur)}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:6px">
        <tbody>{tot}</tbody>
      </table>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#888">
      {escape(co['footer'])}<br>{escape(contact)}
    </div>
  </div>
</div></body></html>"""


def render_invoice(db, inv: dict, items: list, message=None):
    co = _company(db); cur = co["currency"]
    num = inv.get("invoice_number") or f"#{inv.get('id')}"
    amount = float(inv.get("amount") or 0)
    paid = float(inv.get("total_paid") or 0)
    remaining = float(inv.get("remaining") if inv.get("remaining") is not None else amount - paid)
    meta = [("Invoice #", str(num))]
    if inv.get("created_at"):  meta.append(("Date", str(inv["created_at"])[:10]))
    if inv.get("due_date"):    meta.append(("Due date", str(inv["due_date"])[:10]))
    if inv.get("client_name"): meta.append(("Bill to", str(inv["client_name"])))
    totals = []
    if inv.get("subtotal") is not None: totals.append(("Subtotal", _money(cur, inv.get("subtotal"))))
    if float(inv.get("tax_total") or 0): totals.append(("Tax", _money(cur, inv.get("tax_total"))))
    totals.append(("Total", _money(cur, amount)))
    if paid > 0: totals.append(("Paid", _money(cur, paid)))
    totals.append(("Amount due", _money(cur, remaining)))
    subject = f"Invoice {num} from {co['name']}"
    html = _shell(co, f"Invoice {num}",
                  f"Please find your invoice {num} below.",
                  meta, items, cur, totals, message)
    return subject, html


def render_quotation(db, q: dict, items: list, message=None):
    co = _company(db); cur = co["currency"]
    num = q.get("quote_number") or f"#{q.get('id')}"
    total = float(q.get("total") or 0)
    meta = [("Quotation #", str(num))]
    if q.get("created_at"):  meta.append(("Date", str(q["created_at"])[:10]))
    if q.get("client_name"): meta.append(("Prepared for", str(q["client_name"])))
    totals = []
    if float(q.get("tax_total") or 0):
        totals.append(("Subtotal", _money(cur, total)))
        totals.append(("Tax", _money(cur, q.get("tax_total"))))
        totals.append(("Total", _money(cur, total + float(q.get("tax_total") or 0))))
    else:
        totals.append(("Total", _money(cur, total)))
    subject = f"Quotation {num} from {co['name']}"
    html = _shell(co, f"Quotation {num}",
                  f"Please find your quotation {num} below.",
                  meta, items, cur, totals, message)
    return subject, html
