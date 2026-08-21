# Multi-currency receivables — a future project

**Status: deferred, deliberately. Not started. Do not implement piecemeal.**

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
