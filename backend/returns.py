"""Returns: credit notes against invoices, debit notes against purchases.

A return is its own numbered document. It takes back part of a sale or a
purchase --- chosen lines, chosen quantities --- and never edits the original:
the invoice a customer holds and the purchase the supplier billed stay exactly
what they were, and the return sits beside them saying what came back.

## A sales return (credit note, CN-…)

Each returned line takes back its NET (after its own discount and its share of
any discount on the whole invoice) and its VAT, pro rata to the quantity. The
total G is then settled in two parts, in this order:

  a = the part that cancels what the customer still owes on the invoice
  b = the rest, from money the customer has already paid

`a` is applied to the invoice as a non-cash settlement row (method
'Credit note'), so the invoice's balance, status, aging and statement all read
it without knowing returns exist. `b` is either REFUNDED (cash, bank, card) or
kept as CUSTOMER CREDIT, which pays a later invoice.

The ledger follows how this system earns revenue --- on payment:

    a  (unearned; the invoice raised a claim)   DR Deferred revenue / CR Receivable
    b  (earned and taxed when it was paid)      DR Revenue (per line's account)
                                                DR VAT output
                                                   CR Cash/Bank  or  CR Customer credit
    goods back on the shelf                     DR Inventory / CR Cost of goods
    goods returned damaged                      DR Stock write-off / CR Cost of goods

Goods go back on the shelf only where the sale took them off it: a till sale
(its lines carry the cost they left at). An ordinary invoice never moved stock
--- `inventory_id` on its lines is a reference --- so returning it moves money
only; putting goods back would invent stock.

## A purchase return (debit note, DN-…)

The goods leave the shelf from THAT purchase's own cost layer, at the landed
cost they came in at. The supplier owes back the line's price and its VAT; any
landed cost they will not refund (freight, customs apportioned onto the line)
is a loss, posted to the stock write-off account rather than left in stock:

    DR Payable (a) / DR Cash·Bank or Supplier advance (b)   = price + VAT
    DR Stock write-off  (landed cost the supplier does not refund)
       CR Inventory   landed cost
       CR VAT input   the VAT on what went back

`a` is applied to the purchase as a 'Debit note' settlement row; `b` is a
refund received or SUPPLIER CREDIT (held in Advances to Suppliers), which pays
a later purchase.

## Voiding

A return can be voided: its entry is reversed, its settlement row removed, the
goods put back where they were. It is refused when that would invent or lose
something --- credit already spent, or restocked goods already sold on.
"""
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

import accounting
import costing
import denomination
import lots
import sale_reversal
import warehouse_access as wha
from utils import _now, money

# Settlement rows that are not money. Anything that sums payments as CASH
# RECEIVED (income, cash flow, collections) must leave these out; anything that
# sums them as WHAT HAS BEEN SETTLED (balance, status, aging) must keep them.
CREDIT_NOTE = "Credit note"
CUSTOMER_CREDIT = "Customer credit"
DEBIT_NOTE = "Debit note"
SUPPLIER_CREDIT = "Supplier credit"
NON_CASH_SALE_METHODS = (CREDIT_NOTE, CUSTOMER_CREDIT)

CONDITIONS = ("restock", "damaged", "none")
_EPS = 0.0005


# Money received against invoices, as a drop-in for `invoice_payments` in any
# query that reports CASH IN: the settlement rows that are not money are left
# out, and a refund on a credit note counts as money going back the other way,
# on the day it went. Same columns the income readers use, so swapping
# `FROM invoice_payments ip` for `FROM {CASH_RECEIPTS} ip` is the whole change.
CASH_RECEIPTS = (
    "(SELECT id, invoice_id, amount, paid_at, method, note, paid_currency, "
    "        cash_drawer_id, bank_account_id "
    "   FROM invoice_payments "
    f" WHERE COALESCE(method, '') NOT IN ('{CREDIT_NOTE}', '{CUSTOMER_CREDIT}') "
    " UNION ALL "
    " SELECT -id, invoice_id, -refunded, return_date, refund_method, return_number, "
    "        'USD', cash_drawer_id, bank_account_id "
    "   FROM sales_returns WHERE voided_at IS NULL AND refunded > 0)")


def cash_only(alias: str = "ip") -> str:
    """SQL to AND onto a query summing invoice payments as money received."""
    return (f" AND COALESCE({alias}.method, '') NOT IN "
            f"('{CREDIT_NOTE}', '{CUSTOMER_CREDIT}')")


def _col(row, key, default=None):
    try:
        v = row[key]
        return default if v is None else v
    except (KeyError, IndexError, TypeError):
        return default


class ReturnError(ValueError):
    """A return that cannot be made as asked. The message is for the user."""


# ════════════════════════════════════════════════════════════════════════════
# Credit balances
# ════════════════════════════════════════════════════════════════════════════
def customer_credit_balance(db, client_id) -> float:
    if not client_id:
        return 0.0
    row = db.execute("SELECT COALESCE(SUM(amount), 0) AS b FROM customer_credits "
                     "WHERE client_id = ?", (client_id,)).fetchone()
    return money(row["b"] or 0)


def supplier_credit_balance(db, supplier_id=None, supplier=None) -> float:
    if supplier_id:
        row = db.execute("SELECT COALESCE(SUM(amount), 0) AS b FROM supplier_credits "
                         "WHERE supplier_id = ?", (supplier_id,)).fetchone()
    elif supplier:
        row = db.execute("SELECT COALESCE(SUM(amount), 0) AS b FROM supplier_credits "
                         "WHERE supplier_id IS NULL AND supplier = ?", (supplier,)).fetchone()
    else:
        return 0.0
    return money(row["b"] or 0)


def _record_customer_credit(db, client_id, amount, source_type, source_id, note, user_id):
    db.execute("INSERT INTO customer_credits (client_id, amount, source_type, source_id, "
               "note, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
               (client_id, money(amount), source_type, source_id, note, user_id, _now()))


def _record_supplier_credit(db, supplier, supplier_id, amount, source_type, source_id,
                            note, user_id):
    db.execute("INSERT INTO supplier_credits (supplier, supplier_id, amount, source_type, "
               "source_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (supplier or "", supplier_id, money(amount), source_type, source_id,
                note, user_id, _now()))


def spend_customer_credit(db, client_id, amount, *, payment_id, note, user_id):
    """Take `amount` from a customer's credit to pay an invoice."""
    have = customer_credit_balance(db, client_id)
    if money(amount) > have + 0.005:
        raise ReturnError(f"This customer has {have:,.2f} of credit; "
                          f"{money(amount):,.2f} cannot be paid from it.")
    _record_customer_credit(db, client_id, -money(amount), "invoice_payment",
                            payment_id, note, user_id)


def restore_customer_credit(db, client_id, amount, *, payment_id, note, user_id):
    """Give back credit a removed payment had spent."""
    _record_customer_credit(db, client_id, money(amount), "invoice_payment_void",
                            payment_id, note, user_id)


def spend_supplier_credit(db, supplier, supplier_id, amount, *, payment_id, note, user_id):
    have = supplier_credit_balance(db, supplier_id, supplier)
    if money(amount) > have + 0.005:
        raise ReturnError(f"This supplier holds {have:,.2f} of your credit; "
                          f"{money(amount):,.2f} cannot be paid from it.")
    _record_supplier_credit(db, supplier, supplier_id, -money(amount),
                            "purchase_payment", payment_id, note, user_id)


def restore_supplier_credit(db, supplier, supplier_id, amount, *, payment_id, note, user_id):
    _record_supplier_credit(db, supplier, supplier_id, money(amount),
                            "purchase_payment_void", payment_id, note, user_id)


# ════════════════════════════════════════════════════════════════════════════
# Sales returns
# ════════════════════════════════════════════════════════════════════════════
def _invoice(db, invoice_id):
    inv = db.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not inv:
        raise ReturnError("Invoice not found.")
    return inv


def _paid_on(db, invoice_id) -> float:
    row = db.execute("SELECT COALESCE(SUM(amount), 0) AS p FROM invoice_payments "
                     "WHERE invoice_id = ?", (invoice_id,)).fetchone()
    return money(row["p"] or 0)


def _pos_lines(db, invoice_id) -> Tuple[Optional[Any], Dict[int, Any]]:
    """The till sale behind an invoice, and its lines by invoice line id."""
    sale = db.execute("SELECT * FROM pos_sales WHERE invoice_id = ?", (invoice_id,)).fetchone()
    if not sale:
        return None, {}
    by_item = {}
    for it in db.execute("SELECT * FROM pos_sale_items WHERE pos_sale_id = ?",
                         (sale["id"],)).fetchall():
        if _col(it, "invoice_item_id"):
            by_item[it["invoice_item_id"]] = it
    return sale, by_item


def _open_commitment(db, invoice_item_id) -> bool:
    try:
        row = db.execute("SELECT 1 FROM sale_commitments WHERE invoice_item_id = ? "
                         "AND status = 'awaiting' LIMIT 1", (invoice_item_id,)).fetchone()
    except sqlite3.Error:
        return False
    return bool(row)


def _returned_so_far(db, invoice_id) -> Dict[int, Dict[str, float]]:
    out: Dict[int, Dict[str, float]] = {}
    for r in db.execute(
            "SELECT ri.invoice_item_id AS iid, SUM(ri.quantity) AS q, SUM(ri.net) AS n, "
            "       SUM(ri.tax_amount) AS t, SUM(ri.stock_quantity) AS s "
            "  FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id "
            " WHERE r.invoice_id = ? AND r.voided_at IS NULL "
            " GROUP BY ri.invoice_item_id", (invoice_id,)).fetchall():
        out[r["iid"]] = {"q": float(r["q"] or 0), "n": float(r["n"] or 0),
                         "t": float(r["t"] or 0), "s": float(r["s"] or 0)}
    return out


def sales_returnable(db, invoice_id) -> Dict[str, Any]:
    """Everything a return screen needs about one invoice: each line with what
    was sold, what has come back, what can still come back, and whether it can
    go back on the shelf; and how the invoice stands for settlement."""
    inv = _invoice(db, invoice_id)
    sale, pos_by_item = _pos_lines(db, invoice_id)
    done = _returned_so_far(db, invoice_id)
    lines = []
    for it in db.execute("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id",
                         (invoice_id,)).fetchall():
        qty = float(it["quantity"] or 0)
        net = money(max(0.0, qty * float(it["unit_price"] or 0)
                        - float(_col(it, "discount", 0)) - float(_col(it, "doc_discount", 0))))
        tax = money(_col(it, "tax_amount", 0))
        back = done.get(it["id"], {"q": 0, "n": 0, "t": 0, "s": 0})
        pos_line = pos_by_item.get(it["id"])
        can_stock = bool(pos_line and _col(pos_line, "inventory_id"))
        physical_left = 0.0
        if can_stock:
            physical_left = max(0.0, sale_reversal.delivered_quantity(db, pos_line) - back["s"])
        blocked = None
        if pos_line is not None and _open_commitment(db, it["id"]):
            blocked = ("Part of this line is still to be handed over. Hand it over "
                       "or cancel the sale before returning it.")
        lines.append({
            "invoice_item_id": it["id"], "name": it["name"], "unit": _col(it, "unit"),
            "inventory_id": _col(it, "inventory_id"),
            "quantity": qty, "returned_quantity": round(back["q"], 6),
            "returnable_quantity": round(max(0.0, qty - back["q"]), 6),
            "unit_net": money(net / qty) if qty else 0.0,
            "unit_tax": money(tax / qty) if qty else 0.0,
            "net": net, "tax_amount": tax,
            "returned_net": money(back["n"]), "returned_tax": money(back["t"]),
            "can_restock": can_stock,
            "restockable_quantity": round(physical_left, 6),
            "unit_cost": float(_col(pos_line, "unit_cost", 0)) if can_stock else 0.0,
            "blocked": blocked,
        })
    paid = _paid_on(db, invoice_id)
    return {
        "invoice_id": inv["id"], "invoice_number": inv["invoice_number"],
        "client_id": inv["client_id"], "currency": _col(inv, "currency"),
        "amount": money(inv["amount"]), "paid": paid,
        "outstanding": money(max(0.0, float(inv["amount"]) - paid)),
        "is_pos": sale is not None,
        "customer_credit": customer_credit_balance(db, inv["client_id"]),
        "lines": lines,
    }


def _revenue_account(db, revenue_account, taxed: bool) -> str:
    """Where a line's revenue was earned --- the same routing revenue_split
    uses, so a return takes it back off the account it went to."""
    goods, labour = accounting.code(db, "revenue"), accounting.code(db, "service_revenue")
    acct = revenue_account or goods
    if not taxed:
        acct = {goods: accounting.code(db, "revenue_exempt"),
                labour: accounting.code(db, "service_revenue_exempt")}.get(acct, acct)
    return acct


def create_sales_return(db, user, *, invoice_id: int, lines: List[Dict[str, Any]],
                        reason: str = "", return_date: Optional[str] = None,
                        settlement: Optional[str] = None, refund_method: Optional[str] = None,
                        bank_account_id: Optional[int] = None,
                        cash_drawer_id: Optional[int] = None) -> int:
    """Raise a credit note. Does not commit; the caller owns the transaction."""
    inv = _invoice(db, invoice_id)
    if inv["voided_at"]:
        raise ReturnError("This invoice is voided; there is nothing left to return.")
    if _col(inv, "approval_status") == "Pending Approval":
        raise ReturnError("This invoice is awaiting approval.")
    when = (return_date or _now())[:10]
    info = sales_returnable(db, invoice_id)
    by_id = {l["invoice_item_id"]: l for l in info["lines"]}
    items_rows = {r["id"]: r for r in db.execute(
        "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall()}

    chosen = []
    for req in lines or []:
        iid = int(req.get("invoice_item_id") or 0)
        q = round(float(req.get("quantity") or 0), 6)
        if q <= 0:
            continue
        line = by_id.get(iid)
        if not line:
            raise ReturnError("A returned line is not on this invoice.")
        if line["blocked"]:
            raise ReturnError(f"{line['name']}: {line['blocked']}")
        if q > line["returnable_quantity"] + _EPS:
            raise ReturnError(f"{line['name']}: only {line['returnable_quantity']:g} "
                              f"can still be returned.")
        cond = (req.get("condition") or ("restock" if line["can_restock"] else "none")).lower()
        if cond not in CONDITIONS:
            raise ReturnError(f"Unknown condition '{cond}'.")
        if cond != "none" and not line["can_restock"]:
            cond = "none"           # this sale never took the goods off the shelf
        exhausts = q >= line["returnable_quantity"] - _EPS
        if exhausts:
            net = money(line["net"] - line["returned_net"])
            tax = money(line["tax_amount"] - line["returned_tax"])
        else:
            net = money(line["net"] * q / line["quantity"]) if line["quantity"] else 0.0
            tax = money(line["tax_amount"] * q / line["quantity"]) if line["quantity"] else 0.0
        stock_q = round(min(q, line["restockable_quantity"]), 6) if cond != "none" else 0.0
        chosen.append({"line": line, "row": items_rows[iid], "q": q, "net": net,
                       "tax": tax, "cond": cond, "stock_q": stock_q})
    if not chosen:
        raise ReturnError("Choose at least one line and a quantity to return.")

    total_net = money(sum(c["net"] for c in chosen))
    total_tax = money(sum(c["tax"] for c in chosen))
    gross = money(total_net + total_tax)
    moved_stock = any(c["stock_q"] > 0 for c in chosen)
    if gross <= 0 and not moved_stock:
        raise ReturnError("Nothing of value is being returned.")

    outstanding = info["outstanding"]
    applied = money(min(gross, outstanding))
    rest = money(gross - applied)
    settlement = (settlement or "").lower() or None
    if rest > 0.005:
        if settlement not in ("refund", "credit"):
            raise ReturnError("The customer has already paid for these goods: choose "
                              "whether to refund them or keep it as credit.")
        if settlement == "credit" and not inv["client_id"]:
            raise ReturnError("A walk-in sale has no customer to hold credit for; refund it.")
        if settlement == "refund":
            refund_method = refund_method or "Cash"
            if not accounting.is_payment_method(refund_method):
                raise ReturnError(f"'{refund_method}' is not a way to refund.")
    else:
        settlement = None

    now = _now()
    cur = db.execute(
        "INSERT INTO sales_returns (invoice_id, client_id, branch_id, return_date, reason, "
        " subtotal, tax_total, total, applied_to_invoice, refunded, credited, refund_method, "
        " bank_account_id, cash_drawer_id, created_by, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (invoice_id, inv["client_id"], _col(inv, "branch_id"), when, (reason or None),
         total_net, total_tax, gross, applied,
         rest if settlement == "refund" else 0.0,
         rest if settlement == "credit" else 0.0,
         refund_method if settlement == "refund" else None,
         bank_account_id if settlement == "refund" else None,
         cash_drawer_id if (settlement == "refund" and (refund_method or "").lower() == "cash") else None,
         user["id"], now))
    rid = cur.lastrowid
    number = f"CN-{when[:4]}-{rid:05d}"
    db.execute("UPDATE sales_returns SET return_number = ? WHERE id = ?", (number, rid))

    # ── the lines, and the goods ──────────────────────────────────────────
    sale = db.execute("SELECT * FROM pos_sales WHERE invoice_id = ?", (invoice_id,)).fetchone()
    wid = sale_reversal._pos_warehouse(db, sale) if sale else None
    restock_value = writeoff_value = 0.0
    for c in chosen:
        line, row = c["line"], c["row"]
        unit_cost = float(line["unit_cost"] or 0)
        db.execute(
            "INSERT INTO sales_return_items (return_id, invoice_item_id, inventory_id, name, "
            " unit, quantity, unit_net, net, tax_amount, condition, stock_quantity, unit_cost) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, line["invoice_item_id"], line["inventory_id"], line["name"], line["unit"],
             c["q"], line["unit_net"], c["net"], c["tax"], c["cond"], c["stock_q"], unit_cost))
        if c["stock_q"] > 0:
            value = money(unit_cost * c["stock_q"])
            if c["cond"] == "restock":
                inv_id = _col(row, "inventory_id") or line["inventory_id"]
                pos_line = _pos_lines(db, invoice_id)[1].get(line["invoice_item_id"])
                inv_id = _col(pos_line, "inventory_id") or inv_id
                sale_reversal.put_back(db, inventory_id=inv_id, quantity=c["stock_q"],
                                       unit_cost=unit_cost, warehouse_id=wid,
                                       reference=number, note=f"Returned — {number}", now=now)
                restock_value += value
            else:
                writeoff_value += value
    restock_value, writeoff_value = money(restock_value), money(writeoff_value)

    # ── the ledger ─────────────────────────────────────────────────────────
    jl: List[Dict[str, Any]] = []
    if applied > 0 and accounting.has_receivable(db, invoice_id):
        jl += [{"code": accounting.code(db, "deferred_revenue"), "debit": applied,
                "memo": "Claim cancelled by the return"},
               {"code": accounting.code(db, "receivable"), "credit": applied,
                "memo": f"Credit note {number}"}]
    if rest > 0.005:
        share = rest / gross if gross else 0.0
        per_acct: Dict[str, float] = {}
        for c in chosen:
            acct = _revenue_account(db, _col(c["row"], "revenue_account"), c["tax"] > 0)
            per_acct[acct] = per_acct.get(acct, 0.0) + c["net"] * share
        rev = {a: money(v) for a, v in per_acct.items() if money(v) > 0}
        vat = money(total_tax * share)
        residue = money(rest - sum(rev.values()) - vat)
        if residue and rev:
            biggest = max(rev, key=rev.get)
            rev[biggest] = money(rev[biggest] + residue)
        elif residue:
            vat = money(vat + residue)
        for a, v in rev.items():
            jl.append({"code": a, "debit": v, "memo": f"Returned — {number}"})
        if vat > 0:
            jl.append({"code": accounting.code(db, "vat_output"), "debit": vat,
                       "memo": "VAT on returned goods"})
        if settlement == "refund":
            jl.append({"code": accounting.money_account_for(
                           db, method=refund_method, bank_account_id=bank_account_id),
                       "credit": rest, "memo": f"Refund — {refund_method}"})
        else:
            jl.append({"code": accounting.code(db, "customer_credit"), "credit": rest,
                       "memo": "Held as customer credit"})
    if restock_value > 0:
        jl += [{"code": accounting.code(db, "inventory"), "debit": restock_value,
                "memo": "Returned goods back in stock"},
               {"code": accounting.code(db, "cogs"), "credit": restock_value}]
    if writeoff_value > 0:
        jl += [{"code": accounting.code(db, "stock_loss"), "debit": writeoff_value,
                "memo": "Returned goods written off (damaged)"},
               {"code": accounting.code(db, "cogs"), "credit": writeoff_value}]
    if jl:
        accounting.post_entry(db, entry_date=when, memo=f"Credit note {number} — "
                              f"{inv['invoice_number']}" + (f": {reason}" if reason else ""),
                              lines=jl, source_type="sales_return", source_id=rid,
                              created_by=user["id"], branch_id=_col(inv, "branch_id"))

    # ── settlement ─────────────────────────────────────────────────────────
    payment_id = None
    if applied > 0:
        ccy = _col(inv, "currency")
        txn = (denomination.to_txn(applied, _col(inv, "exchange_rate"))
               if ccy and not denomination.is_base(ccy) else applied)
        pcur = db.execute(
            "INSERT INTO invoice_payments (invoice_id, amount, method, note, paid_at, "
            " idempotency_key, paid_currency, paid_amount, txn_amount) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (invoice_id, applied, CREDIT_NOTE, number, f"{when} 00:00:00",
             f"credit-note-{rid}", denomination.base_currency(), applied, txn))
        payment_id = pcur.lastrowid
    if settlement == "credit":
        _record_customer_credit(db, inv["client_id"], rest, "sales_return", rid,
                                number, user["id"])
    db.execute("UPDATE sales_returns SET invoice_payment_id = ?, restock_value = ?, "
               "writeoff_value = ? WHERE id = ?", (payment_id, restock_value, writeoff_value, rid))
    return rid


def void_sales_return(db, user, return_id: int, reason: str = "") -> None:
    ret = db.execute("SELECT * FROM sales_returns WHERE id = ?", (return_id,)).fetchone()
    if not ret:
        raise ReturnError("Credit note not found.")
    if ret["voided_at"]:
        raise ReturnError("This credit note is already voided.")
    credited = money(ret["credited"] or 0)
    if credited > 0 and customer_credit_balance(db, ret["client_id"]) < credited - 0.005:
        raise ReturnError("Some of the credit this note gave has been spent. Remove "
                          "that payment first, then void the credit note.")
    # The goods it put back must still be here to be taken out again.
    restocked = db.execute(
        "SELECT * FROM sales_return_items WHERE return_id = ? AND condition = 'restock' "
        "AND stock_quantity > 0", (return_id,)).fetchall()
    for it in restocked:
        on_hand = db.execute("SELECT quantity FROM inventory WHERE id = ?",
                             (it["inventory_id"],)).fetchone()
        if on_hand and float(on_hand["quantity"] or 0) < float(it["stock_quantity"]) - _EPS:
            raise ReturnError(f"{it['name']}: the returned units have been sold again, "
                              "so the return cannot be undone.")
    now = _now()
    sale = db.execute("SELECT * FROM pos_sales WHERE invoice_id = ?",
                      (ret["invoice_id"],)).fetchone()
    wid = sale_reversal._pos_warehouse(db, sale) if sale else None
    for it in restocked:
        _take_out(db, it["inventory_id"], float(it["stock_quantity"]), float(it["unit_cost"]),
                  source_type="return", source_ref=ret["return_number"], warehouse_id=wid,
                  movement="return_void", reference=ret["return_number"],
                  note="Credit note voided", now=now)
    accounting.reverse_source(db, "sales_return", return_id,
                              memo=f"Credit note {ret['return_number']} voided",
                              created_by=user["id"])
    if ret["invoice_payment_id"]:
        db.execute("DELETE FROM invoice_payments WHERE id = ?", (ret["invoice_payment_id"],))
    if credited > 0:
        _record_customer_credit(db, ret["client_id"], -credited, "sales_return_void",
                                return_id, ret["return_number"], user["id"])
    db.execute("UPDATE sales_returns SET voided_at = ?, void_reason = ? WHERE id = ?",
               (now, reason or "Voided", return_id))


def live_sales_returns(db, invoice_id) -> int:
    row = db.execute("SELECT COUNT(*) AS n FROM sales_returns WHERE invoice_id = ? "
                     "AND voided_at IS NULL", (invoice_id,)).fetchone()
    return int(row["n"] or 0)


# ════════════════════════════════════════════════════════════════════════════
# Stock out, shared by voiding a sales return and making a purchase return
# ════════════════════════════════════════════════════════════════════════════
def _take_out(db, inventory_id, qty, unit_cost, *, source_type, source_ref, warehouse_id,
              movement, reference, note, now):
    """Take `qty` back out of the layer one stock-in created, un-blending the
    average, the way voiding a purchase does."""
    inv = db.execute("SELECT * FROM inventory WHERE id = ?", (inventory_id,)).fetchone()
    if not inv or qty <= 0:
        return
    qty_before = float(inv["quantity"] or 0)
    qty_after = round(qty_before - qty, 6)
    tracked = lots.is_lot_tracked(db, inventory_id)
    lots.reverse_stock_in(db, inventory_id, qty, source_type=source_type, source_ref=source_ref)
    if not tracked:
        costing.reverse_stock_in(db, inventory_id, qty_before=qty_before,
                                 qty_out=qty, unit_cost_out=unit_cost)
    db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (qty_after, inventory_id))
    wha.credit_warehouse_stock(db, inventory_id=inventory_id, warehouse_id=warehouse_id,
                               delta=-qty)
    db.execute(
        "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, "
        " reference, note, warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (inventory_id, movement, -qty, qty_before, qty_after, reference, note,
         warehouse_id, now))


# ════════════════════════════════════════════════════════════════════════════
# Purchase returns
# ════════════════════════════════════════════════════════════════════════════
def _purchase(db, purchase_id):
    row = db.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not row:
        raise ReturnError("Purchase not found.")
    return row


def _purchase_grand(row) -> float:
    from routers.purchases import _doc_grand_total
    return _doc_grand_total(row)


def _purchase_paid(db, purchase_id) -> float:
    from routers.purchases import _payments_of
    return money(sum(float(r["amount"] or 0) for r in _payments_of(db, purchase_id)))


def _layer_ref(po_number, line_id):
    # The same reference the receipt put on the line's cost layer.
    from routers.purchases import _layer_ref as ref
    return ref(po_number, line_id)


def purchase_returnable(db, purchase_id) -> Dict[str, Any]:
    row = _purchase(db, purchase_id)
    done: Dict[int, Dict[str, float]] = {}
    for r in db.execute(
            "SELECT ri.purchase_item_id AS pid, SUM(ri.quantity) AS q, SUM(ri.net) AS n, "
            "       SUM(ri.tax_amount) AS t "
            "  FROM purchase_return_items ri JOIN purchase_returns r ON r.id = ri.return_id "
            " WHERE r.purchase_id = ? AND r.voided_at IS NULL GROUP BY ri.purchase_item_id",
            (purchase_id,)).fetchall():
        done[r["pid"]] = {"q": float(r["q"] or 0), "n": float(r["n"] or 0),
                          "t": float(r["t"] or 0)}
    lines = []
    for it in db.execute("SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id",
                         (purchase_id,)).fetchall():
        qty = float(it["quantity"] or 0)
        net = money(max(0.0, qty * float(it["unit_cost"] or 0) - float(_col(it, "discount", 0))))
        tax = money(_col(it, "tax_amount", 0))
        back = done.get(it["id"], {"q": 0, "n": 0, "t": 0})
        on_hand = None
        if _col(it, "inventory_id"):
            r = db.execute("SELECT quantity FROM inventory WHERE id = ?",
                           (it["inventory_id"],)).fetchone()
            on_hand = float(r["quantity"] or 0) if r else 0.0
        stocked = bool(_col(it, "stock_updated")) and bool(_col(it, "inventory_id"))
        returnable = max(0.0, qty - back["q"])
        if stocked and on_hand is not None:
            returnable = min(returnable, on_hand)
        lines.append({
            "purchase_item_id": it["id"], "name": it["product_name"],
            "inventory_id": _col(it, "inventory_id"), "quantity": qty,
            "returned_quantity": round(back["q"], 6),
            "returnable_quantity": round(returnable, 6),
            "on_hand": on_hand, "stocked": stocked,
            "unit_price": money(net / qty) if qty else 0.0,
            "unit_tax": money(tax / qty) if qty else 0.0,
            "net": net, "tax_amount": tax,
            "returned_net": money(back["n"]), "returned_tax": money(back["t"]),
            "landed_unit_cost": float(_col(it, "landed_unit_cost", 0))
                                or (money(net / qty) if qty else 0.0),
            "tax_rate_id": _col(it, "tax_rate_id"), "tax_rate": money(_col(it, "tax_rate", 0)),
        })
    paid = _purchase_paid(db, purchase_id)
    grand = _purchase_grand(row)
    return {
        "purchase_id": row["id"], "po_number": row["po_number"],
        "supplier": row["supplier"], "supplier_id": _col(row, "supplier_id"),
        "received": bool(_col(row, "received_at")), "amount": grand, "paid": paid,
        "outstanding": money(max(0.0, grand - paid)),
        "supplier_credit": supplier_credit_balance(db, _col(row, "supplier_id"), row["supplier"]),
        "lines": lines,
    }


def create_purchase_return(db, user, *, purchase_id: int, lines: List[Dict[str, Any]],
                           reason: str = "", return_date: Optional[str] = None,
                           settlement: Optional[str] = None,
                           refund_method: Optional[str] = None,
                           bank_account_id: Optional[int] = None) -> int:
    """Raise a debit note. Does not commit."""
    row = _purchase(db, purchase_id)
    if _col(row, "voided_at"):
        raise ReturnError("This purchase is voided.")
    if not _col(row, "received_at"):
        raise ReturnError("These goods have not been received; edit or cancel the "
                          "purchase instead of returning it.")
    when = (return_date or _now())[:10]
    info = purchase_returnable(db, purchase_id)
    by_id = {l["purchase_item_id"]: l for l in info["lines"]}
    chosen = []
    for req in lines or []:
        pid = int(req.get("purchase_item_id") or 0)
        q = round(float(req.get("quantity") or 0), 6)
        if q <= 0:
            continue
        line = by_id.get(pid)
        if not line:
            raise ReturnError("A returned line is not on this purchase.")
        if q > line["returnable_quantity"] + _EPS:
            more = (f" ({line['on_hand']:g} left in stock)" if line["stocked"] else "")
            raise ReturnError(f"{line['name']}: only {line['returnable_quantity']:g} can be "
                              f"returned{more}.")
        exhausts = q >= (line["quantity"] - line["returned_quantity"]) - _EPS
        if exhausts:
            net = money(line["net"] - line["returned_net"])
            tax = money(line["tax_amount"] - line["returned_tax"])
        else:
            net = money(line["net"] * q / line["quantity"]) if line["quantity"] else 0.0
            tax = money(line["tax_amount"] * q / line["quantity"]) if line["quantity"] else 0.0
        landed = money(line["landed_unit_cost"] * q)
        chosen.append({"line": line, "q": q, "net": net, "tax": tax, "landed": landed,
                       "rate_id": line["tax_rate_id"], "rate": line["tax_rate"]})
    if not chosen:
        raise ReturnError("Choose at least one line and a quantity to return.")

    total_net = money(sum(c["net"] for c in chosen))
    total_tax = money(sum(c["tax"] for c in chosen))
    gross = money(total_net + total_tax)
    landed_total = money(sum(c["landed"] for c in chosen))
    unrecovered = money(landed_total - total_net)
    if gross <= 0:
        raise ReturnError("Nothing of value is being returned.")
    applied = money(min(gross, info["outstanding"]))
    rest = money(gross - applied)
    settlement = (settlement or "").lower() or None
    if rest > 0.005:
        if settlement not in ("refund", "credit"):
            raise ReturnError("These goods are already paid for: choose whether the "
                              "supplier refunds you or holds it as credit.")
        if settlement == "refund":
            refund_method = refund_method or "Cash"
            if not accounting.is_payment_method(refund_method):
                raise ReturnError(f"'{refund_method}' is not a way to be refunded.")
    else:
        settlement = None

    now = _now()
    cur = db.execute(
        "INSERT INTO purchase_returns (purchase_id, supplier, supplier_id, warehouse_id, "
        " return_date, reason, subtotal, tax_total, total, applied_to_purchase, refunded, "
        " credited, refund_method, bank_account_id, inventory_value, unrecovered_cost, "
        " created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (purchase_id, row["supplier"], _col(row, "supplier_id"), _col(row, "warehouse_id"),
         when, (reason or None), total_net, total_tax, gross, applied,
         rest if settlement == "refund" else 0.0, rest if settlement == "credit" else 0.0,
         refund_method if settlement == "refund" else None,
         bank_account_id if settlement == "refund" else None,
         landed_total, unrecovered, user["id"], now))
    rid = cur.lastrowid
    number = f"DN-{when[:4]}-{rid:05d}"
    db.execute("UPDATE purchase_returns SET return_number = ? WHERE id = ?", (number, rid))

    wid = wha.default_warehouse_id_for_row(db, _col(row, "warehouse_id"))
    for c in chosen:
        line = c["line"]
        db.execute(
            "INSERT INTO purchase_return_items (return_id, purchase_item_id, inventory_id, "
            " name, quantity, unit_price, net, tax_amount, landed_unit_cost) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (rid, line["purchase_item_id"], line["inventory_id"], line["name"], c["q"],
             line["unit_price"], c["net"], c["tax"], line["landed_unit_cost"]))
        if line["stocked"]:
            _take_out(db, line["inventory_id"], c["q"], line["landed_unit_cost"],
                      source_type="purchase",
                      source_ref=_layer_ref(row["po_number"], line["purchase_item_id"]),
                      warehouse_id=wid, movement="purchase_return", reference=number,
                      note=f"Returned to supplier — {number}", now=now)

    jl: List[Dict[str, Any]] = [
        {"code": accounting.code(db, "inventory"), "credit": landed_total,
         "memo": "Goods returned to the supplier"}]
    if total_tax > 0:
        jl.append({"code": accounting.code(db, "vat_input"), "credit": total_tax,
                   "memo": "Input VAT on returned goods"})
    if applied > 0:
        jl.append({"code": accounting.code(db, "payable"), "debit": applied,
                   "memo": f"Debit note {number}"})
    if rest > 0.005:
        if settlement == "refund":
            jl.append({"code": accounting.money_account_for(
                           db, method=refund_method, bank_account_id=bank_account_id),
                       "debit": rest, "memo": f"Refund from {row['supplier']}"})
        else:
            jl.append({"code": accounting.code(db, "supplier_advance"), "debit": rest,
                       "memo": "Held as credit with the supplier"})
    if unrecovered > 0:
        jl.append({"code": accounting.code(db, "stock_loss"), "debit": unrecovered,
                   "memo": "Landed cost the supplier does not refund"})
    elif unrecovered < 0:
        jl.append({"code": accounting.code(db, "stock_loss"), "credit": -unrecovered,
                   "memo": "Refund above the landed cost"})
    accounting.post_entry(db, entry_date=when,
                          memo=f"Debit note {number} — {row['po_number']}"
                               + (f": {reason}" if reason else ""),
                          lines=jl, source_type="purchase_return", source_id=rid,
                          created_by=user["id"], branch_id=_col(row, "warehouse_id"))

    payment_id = None
    if applied > 0:
        pcur = db.execute(
            "INSERT INTO purchase_payments (purchase_id, amount, paid_currency, method, "
            " note, paid_at, created_at, created_by, applied_as) VALUES (?,?,?,?,?,?,?,?,?)",
            (purchase_id, applied, "USD", DEBIT_NOTE, number, f"{when} 00:00:00", now,
             user["id"], "payable"))
        payment_id = pcur.lastrowid
    if settlement == "credit":
        _record_supplier_credit(db, row["supplier"], _col(row, "supplier_id"), rest,
                                "purchase_return", rid, number, user["id"])
    # The purchase wrote expense rows (one per VAT rate) that the finance pages
    # and the VAT return's input side read. The debit note writes the same
    # rows negated, on its own date, so both see what went back without
    # knowing returns exist. The description opens with the note's number,
    # never the PO's, so voiding the purchase cannot sweep them up.
    groups: Dict[Tuple[Any, float], Dict[str, float]] = {}
    for c in chosen:
        g = groups.setdefault((c["rate_id"], c["rate"]), {"net": 0.0, "tax": 0.0})
        g["net"] += c["net"]
        g["tax"] += c["tax"]
    for (t_rid, t_rate), g in groups.items():
        amount = money(g["net"] + g["tax"])
        if amount <= 0 or not _col(row, "expense_recorded"):
            continue
        db.execute(
            "INSERT INTO expenses (category, description, amount, date, created_at, "
            " tax_rate_id, tax_rate, tax_amount) VALUES (?,?,?,?,?,?,?,?)",
            ("Purchase", f"{number} – returned to {row['supplier']} ({row['po_number']})",
             -amount, when, now, t_rid, t_rate, -money(g["tax"])))
    db.execute("UPDATE purchase_returns SET purchase_payment_id = ? WHERE id = ?",
               (payment_id, rid))
    from routers.purchases import _recalc_settlement
    _recalc_settlement(db, purchase_id)
    return rid


def void_purchase_return(db, user, return_id: int, reason: str = "") -> None:
    ret = db.execute("SELECT * FROM purchase_returns WHERE id = ?", (return_id,)).fetchone()
    if not ret:
        raise ReturnError("Debit note not found.")
    if ret["voided_at"]:
        raise ReturnError("This debit note is already voided.")
    credited = money(ret["credited"] or 0)
    if credited > 0 and supplier_credit_balance(db, ret["supplier_id"], ret["supplier"]) \
            < credited - 0.005:
        raise ReturnError("Some of the credit this note gave has been used on another "
                          "purchase. Remove that payment first.")
    row = _purchase(db, ret["purchase_id"])
    now = _now()
    wid = wha.default_warehouse_id_for_row(db, _col(row, "warehouse_id"))
    for it in db.execute("SELECT * FROM purchase_return_items WHERE return_id = ?",
                         (return_id,)).fetchall():
        line = db.execute("SELECT * FROM purchase_items WHERE id = ?",
                          (it["purchase_item_id"],)).fetchone()
        if not (line and _col(line, "stock_updated") and it["inventory_id"]):
            continue
        q, cost = float(it["quantity"]), float(it["landed_unit_cost"])
        inv = db.execute("SELECT quantity FROM inventory WHERE id = ?",
                         (it["inventory_id"],)).fetchone()
        qty_before = float(inv["quantity"] or 0) if inv else 0.0
        db.execute("UPDATE inventory SET quantity = ? WHERE id = ?",
                   (round(qty_before + q, 6), it["inventory_id"]))
        wha.credit_warehouse_stock(db, inventory_id=it["inventory_id"],
                                   warehouse_id=wid, delta=q)
        costing.blend_stock_in(db, it["inventory_id"], qty_before=qty_before,
                               qty_in=q, unit_cost_in=cost)
        lots.record_stock_in(db, it["inventory_id"], q, cost, source_type="purchase",
                             source_ref=_layer_ref(row["po_number"], it["purchase_item_id"]),
                             now=now)
        db.execute(
            "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, "
            " reference, note, warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (it["inventory_id"], "purchase_return_void", q, qty_before,
             round(qty_before + q, 6), ret["return_number"], "Debit note voided", wid, now))
    accounting.reverse_source(db, "purchase_return", return_id,
                              memo=f"Debit note {ret['return_number']} voided",
                              created_by=user["id"])
    if ret["purchase_payment_id"]:
        db.execute("DELETE FROM purchase_payments WHERE id = ?", (ret["purchase_payment_id"],))
    if credited > 0:
        _record_supplier_credit(db, ret["supplier"], ret["supplier_id"], -credited,
                                "purchase_return_void", return_id, ret["return_number"],
                                user["id"])
    db.execute("UPDATE expenses SET voided_at = ?, void_reason = ? "
               "WHERE category = 'Purchase' AND description LIKE ? AND voided_at IS NULL",
               (now, "Debit note voided", f"{ret['return_number']} %"))
    db.execute("UPDATE purchase_returns SET voided_at = ?, void_reason = ? WHERE id = ?",
               (now, reason or "Voided", return_id))
    from routers.purchases import _recalc_settlement
    _recalc_settlement(db, ret["purchase_id"])


def live_purchase_returns(db, purchase_id) -> int:
    row = db.execute("SELECT COUNT(*) AS n FROM purchase_returns WHERE purchase_id = ? "
                     "AND voided_at IS NULL", (purchase_id,)).fetchone()
    return int(row["n"] or 0)
