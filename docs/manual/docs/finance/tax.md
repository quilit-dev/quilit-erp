# Tax Rates

The VAT engine. Admin-defined named rates, applied per line, snapshotted on
the document at the time of write — so a tax rate change next year doesn't
retroactively alter old documents.

## Purpose

The tax engine is **rate-based** (not formula-based). Each rate has.

- A name (`"Standard 11%"`, `"Zero"`, `"Exempt"`)
- A rate value (`11`, `0`, ...)
- A type (`standard`, `zero`, `exempt`)
- A default flag

Documents (invoices, quotations, purchases, expenses) reference a rate by
**ID + snapshot** — tax rate, tax rate (the value at write time),
tax amount (computed).

## Personas

| Persona | What they do here |
|---|---|
| **Administrator** | Defines rates, sets the default |
| **Accountant** | Picks the rate when entering a document |
| **Finance Manager** | Reviews rate usage in VAT report |
| **Auditor** | Verifies the per-line snapshot survives rate changes |

## Quick reference

- **Three types**: `standard`, `zero`, `exempt`
- **One rate has marked as the default** — used when no rate is specified
- **Per-line snapshot** — invoices, quotations, expenses, purchases all
  carry tax rate, tax rate, tax amount
- **Output VAT** goes to `2100 VAT Payable` (credit)
- **Input VAT** also tracks against `2100 VAT Payable` (debit) for
  net-VAT computation

---

=== "Operator's view"

    ### Picking a rate on a document

    Every line item form (invoice, quote, purchase, expense) has an
    optional "Tax rate" dropdown. Options.

    - The default rate (auto-selected)
    - Other active rates
    - `(none)` — no tax

    The displayed dropdown shows `name (rate%)` — e.g. "Standard (11%)".

    When you save, the system snapshots tax rate, tax rate, and
    computes quantity × price × rate ÷ 100.

    ### Subtotal vs. amount

    Every taxed document carries.

    | Field | Computed |
    |---|---|
    | Subtotal | Sum of (qty × price) per line, BEFORE tax |
    | Tax total | Sum of tax amount per line |
    | Amount | Subtotal + Tax total |

    The customer pays `Amount`; the VAT report nets out the tax portion.

=== "Administrator's view"

    ### Permissions

    Tax rates are limited to administrators (Business Owner) —
    not via the regular Tax Rates permission. That's because
    changing tax rates affects the books.

    ### Creating a rate

    Settings → **Tax Rates** → **+ Add rate**.

    | Field | Notes |
    |---|---|
    | Name | "Standard 11%", "Reduced 5%", "Zero", "Exempt" |
    | Rate (%) | 0-100 |
    | Type | `standard`, `zero`, `exempt` |
    | Is default | Exactly one rate is the default |
    | Is active | Inactive rates don't show in dropdowns |

    ### What the default rate means

    The default rate is auto-selected on every new line item. To enforce
    "always uses Standard 11%", make that rate the default.

    Setting a new rate as default clears the flag on the old one
    automatically.

    ### Changing a rate's value

    Editing a rate's `rate` value does **NOT** retroactively change
    existing documents — they hold their snapshotted tax rate value.
    Only documents created **after** the change use the new value.

    For a true regime change (e.g. VAT went from 10% to 11%), create a
    **new rate** (e.g. "Standard 11%"), mark it default, and **deactivate**
    the old one. Existing documents continue to show "10%" because
    that's what was true when they were posted.

    ### Tax type semantics

    | Type | What the system does |
    |---|---|
    | `standard` | Normal VAT — tax amount computed and posted to `2100 VAT Payable` |
    | `zero` | Zero-rated — no tax charged, but the transaction shows in the VAT report |
    | `exempt` | Exempt — no tax charged, transaction excluded from VAT report's net base |

    Use `zero` for exports / international sales. Use `exempt` for
    domestic services that are VAT-exempt by regulation.

=== "Auditor's view"

    ### Per-line snapshot integrity

    The snapshot is what survives rate changes — verify it's intact.

    Several entries here mean the rate changed at some point, and the snapshots
    preserved the original rate. If you ran this immediately after a rate
    change, every line dated before the change should show
    the rate saved on the document differs from today's.

    ### VAT Payable ties to per-document tax totals

    VAT charged minus VAT paid should equal VAT payable (within rounding).

    ### Default rate audit

    Exactly one rate should be the default at any time.

---

## What's NOT supported

- Compound taxes (VAT on top of a city tax). Single rate per line.
- Per-item default rates (item X always uses rate Y). The default is global;
  per-line override is operator's choice.
- Tax-inclusive pricing. The line's unit price is always the **net** of
  VAT; the customer-visible "gross" is computed. (POS has a tax-inclusive
  option, see [POS](../operations/pos.md).)
- Per-jurisdiction tax engines. One country, one regime per install.
