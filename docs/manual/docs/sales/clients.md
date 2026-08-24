# Clients

The customer master. Every quotation, project, invoice, and CRM record
ultimately points here.

## Purpose

A single, deduplicated record per customer — referenced by every downstream
document. The Client detail view is the **360°** screen: every quote,
project, invoice, payment, and activity for that customer in one place.

## Personas

| Persona | What they do here |
|---|---|
| **Sales rep** | Looks up the customer's history before a call |
| **Accountant** | Opens the client to see outstanding A/R, payment patterns |
| **Sales Manager** | Reviews lifetime value, recent activity, last touch |
| **Administrator** | Adds clients manually, merges duplicates, archives inactive |
| **Auditor** | Tests for duplicates, verifies customer-id integrity across documents |

## Quick reference

- **Type**: `private` (individual) or `company`
- **Created from**: Manual entry, or auto-created from CRM "Convert lead"
- **Required**: `name`. Everything else is optional (`company`, `phone`,
  `email`, `address`, `notes`).
- **Soft delete**: deletion date flag. The Recycle Bin restores it.
- **Soft archive**: archive date flag + archive reason. The Archives
  page restores it.

---

=== "Operator's view"

    ### The clients list

    Sidebar → **Clients**. You see a searchable table of every active client
    (deleted and archived excluded).

    Columns: Name, Company, Type, Phone, Email, **last activity**, **open
    A/R**.

    Click any row to open the **360° detail**.

    ### The 360° detail

    Six tabs, in this order.

    1. **Overview** — contact details, **billing terms**, recent activity,
       totals and attachments
    2. **Projects** — every project for this client (linked back)
    3. **Quotations** — every quote ever issued to this client (linked to
       the source quote)
    4. **Invoices** — every invoice + payment status (linked back)
    5. **Payments** — what they have paid, as they paid it, with the receipt
    6. **Statement** — the running account over a date range, exportable

    ### Billing terms

    Four fields on the client that change what the rest of the system offers.

    | Field | What it does |
    |---|---|
    | **Financial ID** | The customer's tax registration number. Printed on their documents |
    | **Preferred currency** | Pre-selects this currency when you take a payment from them. It does **not** change the currency the invoice is issued in — invoices stay in the company currency. At the till it applies only where the register can take that currency (dollars and pounds); a customer who prefers euro is left on the default rather than being put into a currency checkout would refuse |
    | **VAT status** | Whether they are subject to VAT or exempt |
    | **Allow instalments** | Whether this customer may be put on a payment plan |

    **Allow instalments** is a credit decision about that customer, and it
    governs one thing: whether their whole **account** may go on a payment
    plan. A plan on a single **invoice** is a different arrangement — splitting
    one document into agreed dates — and is available for every customer
    regardless of this setting.

    With it off, the payment-plan panel on the customer says so, and the server
    refuses an account plan if asked anyway — the message names the customer
    and says to change it on their record. Turning it off does **not** disturb
    a plan they are already halfway through; it decides what happens next.

    Every customer already on your books was set to *allowed* when this became
    enforceable, because that is what they were before the field existed, and a
    new customer starts allowed for the same reason. Unticking it is always a
    deliberate act.

    Set **instalments** and **every** alongside it and those become the
    starting figures whenever a plan is set up for them — on an invoice or at
    the counter. They are a starting point: whatever the operator types over
    them wins.

    ### Taking a payment for the account

    A customer pays "for the account", not for invoice #114. Open their record
    → **Record payment**, enter what they handed over, and the system settles
    their **oldest invoices first**, splitting the money across as many as it
    reaches. The screen previews exactly which invoices it will touch before
    you commit, and shows what actually happened afterwards.

    Overpayment is refused rather than parked: a credit balance is a real
    thing with its own rules, and inventing one as a side effect of a rounding
    difference would be worse than asking.

    ### Putting the account on a payment plan

    A customer owing 4,000 who agrees to eight payments of 500 has agreed one
    thing, and the plan records it: their **account balance** on eight dates.
    It is not a schedule per invoice, so an invoice raised later does not
    disturb it and one voided does not tear a hole in it.

    Open their record → **Overview** → the **Payment Plan** panel →
    **Set up a plan**. It is the same panel, the same four boxes and the same
    table as the plan beside an invoice, so there is nothing new to learn:

    | Box | Meaning |
    |---|---|
    | **Instalments** | How many payments |
    | **First due** | The date the first one falls due |
    | **Every** | Month, quarter or year |
    | **Deposit** | Optional money down. It does not eat an instalment — a deposit and four payments is five rows |

    The schedule always adds up to the **whole account balance as it stands
    now**, with the last instalment carrying the rounding so the plan sums
    exactly.

    Agreeing terms is **not** a payment. It moves no money, posts nothing to
    the ledger and touches no invoice — it records the dates the customer is
    expected to pay on, which is what the arrears reporting reads. Take the
    money separately through **Record payment**, and each payment counts
    towards the plan automatically and settles their oldest invoices first,
    exactly as any account payment does.

    Two figures are shown apart on purpose: what the plan still covers, and
    what the account owes. When an invoice is raised after the terms were
    agreed the panel says how much sits outside the plan, because chasing a
    customer for a figure nobody agreed to is the mistake this prevents.

    Every instalment on the plan raises its own reminder three days before
    it falls due, on the day, and again once it has passed — on the bell and
    in **Notifications**, filed under *Finance*, linking straight back to the
    customer. They stop as soon as the money arrives, and cancelling the plan
    stops them for good.

    **Change plan** restates the terms while nothing has been paid against
    them. Once a payment has arrived it is locked, because restating would
    re-interpret what that money settled — three of eight silently becoming
    one of four. **Remove plan** stays available either way: a customer who
    has stopped paying has to be takeable off terms, and it removes only the
    remaining schedule. Payments already made stay exactly as they are.

    ### The receipt

    Press **Receipt Voucher** on the confirmation, and the customer gets one
    bilingual slip naming **every invoice their money reached** and the amount
    applied to each.

    The number is issued once and never changes. Print it again — from the
    **Payments** tab, any time later — and it is the same receipt on fresh
    paper, not a second claim on the same money. Paid in pounds, the slip
    shows the pounds they handed over as well as the converted figure.

    This is a different document from the receipt voucher on an **invoice**,
    which states what has been paid against that one invoice to date. Both
    exist; use the payment one when the customer paid for the account.

    ### Adding a client manually

    Clients → **+ Add client** → fill in the form. If the client was already
    created by converting a CRM lead, **don't add another one** — open the
    existing record and edit it.

    ### Updating a client

    Open the detail → **Edit**. Saved changes are audit-logged with
    before/after values.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Sales | ✅ | ✅ | ✅ | ✗ |
    | Sales Manager | ✅ | ✅ | ✅ | ✅ |
    | Accountant | ✅ | ✗ | ✗ | ✗ |
    | Project Manager | ✅ | ✗ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ |

    ### Merging duplicates

    The system doesn't have a native "merge clients" action — duplicates
    happen and require a deliberate procedure.

    1. Decide which is the **canonical** record (usually the older one with
       more linked documents)
    2. Re-attach the duplicate's quotations / projects / invoices /
       activities to the canonical id (via direct SQL or via the
       Administrator panel)
    3. Archive the duplicate with the reason "Merged into client #X"

    !!! warning "Don't hard-delete a client with linked documents"
        The system will refuse the delete. Archiving is
        the supported one.

    ### Archiving vs. deleting

    | Action | Effect |
    |---|---|
    | **Archive** | archive date set + archive reason. Hidden from default lists. Documents stay linked. Restorable from Archives. |
    | **Delete** | deletion date set. Hidden from default lists AND from the Archives view. Restorable from Recycle Bin (admin only). |

    Archive for "no longer trading with them"; delete for "shouldn't have
    been created at all".

=== "Auditor's view"

    ### Duplicate detection

    A common control: ensure no client appears twice under slightly different
    names/contacts.

    ### Orphan reference check

    Every quotation, project, invoice, and CRM record references a
    client. None should be orphaned.

    All counts should be zero — the system will not let them be anything else.

    ### Top customers by A/R

---
