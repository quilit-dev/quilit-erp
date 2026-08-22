# Multi-currency receivables

**Status: BUILT.** Activated and delivered 2026-08-22. The commercial lifecycle
carries a transaction currency end to end and the company reports in its own.
See "Where it stands" for what is done and the two things deliberately left.

This records the agreed direction so whoever picks it up does not have to
re-derive it, and so nobody bolts half of it onto the invoice table in passing.

## Why it is not built

The system is USD-functional: every amount is stored in USD, and a foreign
currency is a *tender* method rather than a denomination. A customer handing
over LBP is paying "$X worth of notes", and the USD applied to the invoice is
whatever that converted to.

So there is **no realised FX exposure to recognise**. The difference between
what was invoiced and what was settled is zero by construction, because the
settlement defines its own USD value.

What already exists and works — and must be left alone — is the **IAS 21
revaluation** of foreign cash: count the notes, compare against the book value
of the foreign cash account, post the difference to FX gain or loss
(`routers/accounting.py`, `fx_revaluation`). That is a real and correct piece of
multi-currency accounting. It is not what this project is about.

Realised FX only becomes meaningful once an invoice can be *denominated* in a
currency — the customer owes 5,000,000 LBP, not $56 — so that settling it later
at a different rate produces a genuine gain or loss.

## The agreed direction

Currency flows through the whole commercial lifecycle, not just the invoice:

```
Quotation → Sale / POS / Service / Project → Invoice → Payment
```

- **Quotations and POS carry a transaction currency too.** Not invoices only —
  a quote given in EUR should become an invoice in EUR.
- **The invoice stores its transaction currency and the rate used at
  recognition.** That rate is the anchor everything later is measured against.
- **The payment stores its actual settlement currency and settlement rate** —
  what was really handed over, and at what.
- **Realised FX is invoice-recognition value versus actual settlement value.**
  Not a period-end estimate; the difference on the day the money arrives.
- **A negotiated rate is stored explicitly and appears in the audit trail.**
  When a cashier keys in a rate the street agreed rather than the table's, that
  is a decision someone made and the books should say so.

## What this touches

Worth knowing before anyone estimates it: invoices, quotations, POS, service,
projects, payments, receipts, statements, every printed document (totals become
dual-presented), reports, and the tax engine. It is an architectural project,
not a feature.

## What is already in place for it

- `account_roles` and `accounting.code()` — postings resolve accounts by role,
  so the FX accounts are already reachable on either chart (`675`/`775` on the
  Lebanese plan, `6920`/`4910` on the default).
- `currency.rate_on(db, currency, on_date)` — effective-dated rates, so "the
  rate at recognition" and "the rate at settlement" are both answerable.
- `currency.SUPPORTED` — USD, LBP, EUR.
- `bank_accounts.currency` — an account already knows what it holds.

The foundations are there. The denomination is not, and adding it halfway is
worse than not adding it at all.


---

## The storage decision

Every money column that exists today keeps its meaning: **the base (functional)
currency**, which is what the ledger, every report, every balance and every
posting already read. Not one of those readers changes.

Beside them sit the transaction figures:

| Table | Added |
|---|---|
| `invoices` | `currency`, `exchange_rate`, `txn_amount`, `txn_subtotal`, `txn_tax_total` |
| `invoice_items` | `txn_unit_price`, `txn_tax_amount` |
| `quotations` | `currency`, `exchange_rate`, `txn_total`, `txn_tax_total` |
| `quotation_items` | `txn_unit_price`, `txn_tax_amount` |
| `service_jobs` | `currency`, `exchange_rate`, `txn_total`, `txn_subtotal`, `txn_tax_total` |

`invoice_payments` and `purchases` already worked this way — `amount` in base,
`paid_currency`/`paid_amount`/`exchange_rate` alongside. This extends a
convention the codebase already proved rather than inventing one.

**A NULL `txn_` column means the document is denominated in the base currency
and the base figure is the original.** That is true of every row written before
this existed, so no historical row is touched at all — not even to backfill.

**The rate is stored on the document and never looked up again.** A rate
entered next month cannot restate an invoice issued today. A receivable that
changes value whenever somebody edits a rate table is not a receivable.

**Pricing runs twice, once per side.** Converting the totals afterwards leaves
the base lines not summing to the base total, and `revenue_split` reads the
lines. Each side is priced from its own prices, so each is internally
consistent; for a base-currency document the second pass is the first.

## Rate direction

Rates are stored as **units of the currency per one unit of base** — LBP
89,000, EUR 0.909091. Written the other way ("1 EUR = 1.10 USD") the same rate
reads as 1.10, and entering that where 0.909091 is meant is a 21% error. The
convention is not negotiable — inverting it would restate every LBP rate on the
books — so the UI must label the direction on the field.

## Where it stands

Done:

- The storage architecture, in both backends, with the parity guard extended.
- `denomination.py` — one place that resolves a currency and locks a rate.
- Invoices: raised in the customer's currency, both figures stored, the rate
  written down, the ledger posting in base. A customer set to a currency with
  no rate is refused, by name.

- Realised FX on settlement. `denomination.settle()` works out what a payment
  clears of the debt and what it cost in exchange; `payment_lines` posts the
  difference to FX gain or loss. The architecture closes: a euro invoice paid
  in full in euro leaves nothing outstanding, in either currency.

### How a payment is recorded

Three figures, and confusing them is how this goes wrong:

| Column | Means |
|---|---|
| `paid_amount` + `paid_currency` | what the customer physically handed over |
| `txn_amount` | how much of the debt that cleared, in the invoice's currency |
| `amount` | that obligation valued at the rate the invoice was RECOGNISED at |
| `fx_difference` | cash received in base, minus `amount` |

`amount` is the obligation and not the cash, deliberately. "Remaining" is
`invoices.amount - SUM(invoice_payments.amount)` in forty places, and a foreign
invoice paid in full has to reach zero in every one of them without any of them
being touched.

The receivable is relieved at the **recognition** rate for the same reason.
Relieve it at the settlement rate and the claim carries a balance, for ever,
for a debt the customer has paid.

For an invoice in the company's own currency all three figures are the same
number, which is why nothing already on the books changes.

- The statement, in the customer's currency. Both readings travel on every
  movement. Where a customer has been billed in more than one currency it
  falls back to base and says so, rather than inventing a rate to merge them.
- The invoice form: a currency picker defaulting to the customer's own, and a
  rate field that names its own direction and reads the number back the other
  way as it is typed.
- Quotation → invoice. The quoted figure survives; the RATE does not. A
  quotation is not a transaction, so the sale is valued at the rate on the day
  it is invoiced, not the day it was offered.

### Two kinds of foreign-currency sale

They run in opposite directions and confusing them misprices everything.

**Negotiated** — an operator types "€5,000" on an invoice or a quotation. The
customer's figure is the ORIGINAL; the base value is derived from it.

**Off the price list** — a service job's parts, a till sale. Nobody types euro:
the price auto-fills from the company's own list, in the company's own
currency. The BASE figure is the original and the customer's is derived, at the
day's rate — which is what any business with a dollar price list does when it
bills a European customer.

`build_invoice(prices_in_base=...)` says which. Getting it backwards on service
jobs would have labelled dollar price-list figures as euro: a ten per cent
overcharge on every euro job, invisible, because the printed number looks
perfectly plausible.

## Where it stands

Built and tested end to end:

- Storage on invoices, quotations, service jobs and their lines, in both
  backends, covered by the migration parity guard.
- `denomination.py` — resolving a currency, locking a rate, and settling.
- Invoices, quotations, service jobs, POS sales and project billing all raised
  in the customer's currency.
- Realised FX on settlement, relieving the receivable at the recognition rate.
- The statement of account, the printed invoice, the printed quotation and the
  receipt voucher, all in the customer's currency.
- Reports, aging and the trial balance aggregating in base — with tests, not
  assertions.

Deliberately not done:

- **Foreign tender at the till.** The register counts dollars and pounds at
  close, so accepting euro notes would create a drawer balance nobody counts.
  Billing a euro customer at the till works; they pay in dollars or pounds.
- **A configurable base currency.** `default_currency` in settings is a
  PRESENTATION setting. The books are in `currency.FUNCTIONAL`, and changing
  that means re-denominating every posting ever made — a different project.

## The rate direction, again

Units per one unit of base: LBP 89,000, EUR 0.909091. The invoice form labels
the field "Rate — EUR per 1 USD" and reads the number back the other way as it
is typed, because the same rate written the other way is 1.10 and entering one
for the other is a twenty per cent error on the whole document.
