# Projects

The long-form-work container. When a quotation wins and the delivery spans
weeks or months, the work lives here — with a budget, milestones, material
consumption, and progressive invoicing.

## Purpose

A project is the **work order** of the system. It carries.

- The **commercial promise** (expected revenue — what the customer pays)
- The **operational promise** (line items, location, dates)
- The **actual cost** as it accumulates (actual cost — materials + labour
  + sub-contracts)
- The **billing trail** (one project, many invoices over time)

A 30-day construction job, a 6-month consulting engagement, or a year-long
maintenance contract — all fit this model.

## Personas

| Persona | What they do here |
|---|---|
| **Project Manager** | Lives in this module — runs the work, books materials, marks milestones |
| **Foreman / Field tech** | Uses inventory deduct-to-project to draw materials |
| **Accountant** | Issues milestone invoices, reads budget vs. actual |
| **Sales Manager** | Reviews margin (expected revenue minus actual cost) per project |
| **Auditor** | Verifies material consumption matches stock movements |

## Quick reference

- **Status lifecycle**: `Quotation Sent → Active → Invoiced → Completed`
  (or paused: `On Hold`)
- **Created from**: usually `Convert quotation to project`, sometimes manual
- **Soft delete + soft archive**: same pattern as other entities
- **Linked entities**: client, source quotation, milestones, expenses,
  invoices, material consumption (via inventory deduct-to-project)

---

=== "Operator's view"

    ### Project list

    Sidebar → **Projects**. Columns: Name, Client, Status, Start, End,
    Estimated cost, Actual cost, **margin**.

    Filter by status to see "what's running right now".

    ### Creating a project

    Most projects arrive by themselves: when a customer accepts a quotation,
    choose **Convert to project** and everything carries across — the client,
    the value, the line items. That is the normal route, and it keeps the
    quote and the project linked.

    To start one from scratch, **Projects → + New Project**.

    | Field | What to put |
    |---|---|
    | **Project Name** | Required. |
    | **Client** | Who the work is for. |
    | **Status** | Where it stands — see the list under Quick reference. |
    | **Location** | Where the work happens. |
    | **Start / End Date** | The planned span. |
    | **Estimated Cost** | What you expect it to cost you. |
    | **Expected Revenue** | What the customer is paying. |
    | **Description** | Anything the team needs to know. |

    Those two money fields are what the margin figures are built from.
    Expected revenue minus estimated cost is the profit you are planning for,
    and the project page warns you as real spending approaches the estimate. A
    project with both left empty still runs — you just get no warning.

    ### Project detail — six tabs

    1. **Overview** — budget, dates, location, description, **margin
       indicator**
    2. **Milestones** — milestones with a due date and
       reached-at
    3. **Quotations** — quotes linked to this project (typically the
       source quote)
    4. **Invoices** — every invoice billed against this project
    5. **Expenses** — every expense charged to the project
    6. **Materials** — every stock deduction performed via "Deduct to
       project"

    ### Running a project

    | Operation | Where |
    |---|---|
    | Mark a milestone reached | Project → Milestones → click reached date |
    | Book material consumption | **Inventory → Deduct to project** (you pick the warehouse — see [Multi-warehouse access](../foundation/warehouse-access.md)) |
    | Add an expense | **Expenses → + Add expense** with this project picked |
    | Bill a milestone | **+ New invoice from this project** (top right) |
    | Mark completed | Status dropdown → Completed |

    ### Budget vs. actual

    The Overview tab shows three numbers.

    | Field | Source |
    |---|---|
    | Expected revenue | expected revenue (from accepted quote) |
    | Estimated cost | estimated cost (your budget at start) |
    | Actual cost | Sum of expenses + materials valued at unit cost |

    Two things go red on the project page, and they mean different things.

    - **Expected profit** turns red when it is negative — the project is
      priced to lose money.
    - **Total expenses** turns red once spending passes **90% of the
      estimated cost**. That is the early warning: it fires while there is
      still budget left, not after it is gone.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete | approve |
    |---|---|---|---|---|---|
    | Project Manager | ✅ | ✅ | ✅ | ✗ | ✗ |
    | Sales | ✅ | ✗ | ✗ | ✗ | ✗ |
    | Accountant | ✅ | ✗ | ✗ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ | ✗ |
    | Sales Manager | ✅ | ✅ | ✅ | ✅ | ✅ |

    `approve` is used by approval policies on large projects (e.g.
    estimated cost > $50,000 requires Operations Manager approval before
    materials can be drawn).

    ### Project status transitions

    The status field is free-text-ish but the values matter for reports.

    | Status | When |
    |---|---|
    | `Quotation Sent` | Auto-set when created from a Sent quote |
    | `Active` | Work is happening; default after acceptance |
    | `On Hold` | Pause without closing — surfaces in "Stalled projects" report |
    | `Invoiced` | Final invoice issued, work mostly done |
    | `Completed` | Final settlement done; archived shortly after |

    ### Material consumption controls

    "Deduct to project" is the **only** controlled path to charge materials.
    It writes:
    - an expense in the Materials category, against this project
    - a stock movement recording the goods used on the project, and where from
    - the item's company-wide total goes down
    - the quantity in that warehouse decrement (per-warehouse)
    - cost layers draw-down (FIFO/LIFO/avg per costing method)

    All five writes in a single transaction. See Audit trail for proof.

=== "Auditor's view"

    ### Budget overruns

    Each should have either a margin discussion, a scope-change quote, or
    a write-down decision.

    ### Material-flow reconciliation

    Every project material draw should match a stock movement.

    The numbers won't be equal (one is $, one is units) but **every
    project with non-zero expenses materials should have non-zero
    stock movements** (and vice versa).

    ### Revenue vs. cost margin per project

---

## Status lifecycle

```mermaid
stateDiagram-v2
    [*] --> QuoteSent : Convert from quote
    QuoteSent --> Active : Work begins
    [*] --> Active : Created manually
    Active --> OnHold : Pause
    OnHold --> Active : Resume
    Active --> Invoiced : Final invoice issued
    Invoiced --> Completed : Customer signed off
    Completed --> [*]

    note right of Active
        Materials drawn:
        deduct-to-project +
        stock movements
    end note

    note right of Invoiced
        actual cost frozen for
        margin reporting
    end note
```

## What's NOT supported (deliberately)

- Per-line-item project billing tied to specific quote lines. Invoices
  attached to a project are free-form line items — you describe what
  you're billing this period.
- Time tracking. The system doesn't track hours-by-person against a
  project. If you need it, log it as Expenses with `category='Labour'`.
- Sub-projects. Projects don't nest. A long programme breaks into
  separate projects with a shared client.
