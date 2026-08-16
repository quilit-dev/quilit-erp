# Warehouses & Transfers

The location dimension on every stock balance. Lets the system answer "what's
at MAIN?" vs "what's at BRANCH-A?" — and move stock between them with an
auditable workflow.

## Purpose

A **warehouse** is a physical location where stock is held. The system treats
warehouses as a **stock dimension**, not an accounting entity.

- One company-wide `1200 Inventory` GL account
- Per-warehouse the quantity in that warehouse balances
- Internal transfers reallocate quantities without posting to the GL

This means the multi-warehouse feature gives you operational visibility and
control **without** changing your books-of-record.

## Personas

| Persona | What they do here |
|---|---|
| **Operations Manager** | Defines warehouses, sets the company default, manages access |
| **Inventory clerk** | Initiates transfers, dispatches and receives them |
| **Warehouse manager** | Reads "View stock" for their location, runs adjustments |
| **Administrator** | Grants per-user warehouse access |
| **Auditor** | Reconciles transfers (every dispatch has a receive), verifies access controls |

## Quick reference

- **Types**: `Main`, `Branch`, `Production`, `Damaged`, `Transit`, `Returns`
- **Default warehouse** — exactly one warehouse has marked as the default
- **Per-user default** — each person's own default warehouse overrides the company
  default
- **Access model** — zero grants = access to all; first grant flips to allow-list
- **Transfer lifecycle** — `Draft → In Transit → Completed` (or `Cancelled`)
- **GL impact** — **none** for internal transfers

---

=== "Operator's view"

    ### The Warehouses page — three tabs

    1. **Warehouses** — list/create/edit + Set Default + Archive + **View stock**
    2. **Transfers** — Draft / In Transit / Completed / Cancelled
    3. **Access** — admin only

    ### Viewing what's at a warehouse

    Warehouses → row → **View stock**. A modal opens with.

    - Search box (live filter by item name or category)
    - One line per item: Quantity, Unit cost, Value (= quantity × cost)
    - Badges for Reserved / Quarantined
    - Footer total: SKUs · units · USD value
    - Sorted by value desc (most-capital items first)

    ### Creating a transfer

    Warehouses → Transfers tab → **+ New transfer**.

    1. Pick **From** (source) and **To** (destination) warehouses
    2. Add line items with quantities
    3. Save — lands in **Draft**

    ### Dispatching

    Open the Draft transfer → **Dispatch**.
    - Source warehouse stock is **decremented immediately**
    - A stock movement records the goods leaving
    - Status → **In Transit**

    The destination warehouse hasn't received it yet — that's the trucker's
    journey.

    ### Receiving

    Open the In Transit transfer → **Receive (full)** when goods arrive.
    Alternatively, edit per-line received quantity if some units were lost
    in transit.

    - Destination stock is **incremented**
    - A stock movement records the goods arriving
    - Status → **Completed**

    ### Cancelling

    | At status | Effect |
    |---|---|
    | Draft | Just marks Cancelled. No stock motion. |
    | In Transit | Re-credits the source warehouse (un-does the dispatch). |
    | Completed | ❌ Not allowed. Create an opposite-direction transfer to reverse. |

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Operations Manager | ✅ | ✅ | ✅ | ✅ |
    | Inventory clerk | ✅ | ✅ | ✅ | ✗ |
    | Procurement Officer | ✅ | ✗ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ |

    Plus warehouse access — see [Multi-warehouse
    access](../foundation/warehouse-access.md).

    ### Setting the default warehouse

    Warehouses → row → **Set default**. Exactly one warehouse has
    marked as the default at any time (enforced by a unique partial index).

    The default is the fallback when:
    - A user has no personal default set
    - A purchase/POS/manufacturing form is submitted without warehouse
    - A stock adjustment is made without naming a warehouse

    ### Warehouse types

    | Type | Typical role |
    |---|---|
    | `Main` | Primary stock location (the seeded default is type Main) |
    | `Branch` | Secondary selling / holding location |
    | `Production` | Workshop or factory floor — feeds manufacturing |
    | `Damaged` | Damaged or expired stock pending write-off |
    | `Transit` | In-transit stock between warehouses (if you model it explicitly) |
    | `Returns` | Customer returns awaiting QC |

    Types are informational — they don't affect logic. Use them for
    reporting and filtering.

    ### Granting per-user access

    Warehouses → **Access** tab → pick a warehouse → **+ Grant access** →
    pick a user.

    Remember: the *first* grant for a user **anywhere** flips them from
    "see all warehouses" to "see only the explicit list".

    ### Archiving a warehouse

    Two preconditions:
    1. The warehouse is not currently the default
    2. The warehouse holds zero stock (transfer everything out first)

    Both are enforced server-side.

=== "Auditor's view"

    ### Every transfer has matched dispatch + receive

    The completeness control: every transfer out movement should have a
    matching transfer in (same `reference`), and total qtys should match.

    Non-zero lost in transit = real loss. Each one needs a write-off
    decision (adjustment + audit note).

    ### Transfers never post to the GL

    Verify the invariant.

    ### Per-warehouse balances sum to company total

    An empty result means everything agrees. Anything listed does not.

    ### Access trail

    Every grant and revoke is in the audit trail.

---

## Transfer lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft : + New transfer
    Draft --> InTransit : Dispatch<br/>source stock -qty
    Draft --> Cancelled : Cancel<br/>no stock motion
    InTransit --> Completed : Receive<br/>destination stock +qty
    InTransit --> Cancelled : Cancel<br/>re-credits source
    Completed --> [*]
    Cancelled --> [*]

    note right of Completed
        ❌ Cannot cancel:
        create opposite-direction
        transfer to reverse.
    end note
```

## What's NOT supported (deliberately)

- Per-warehouse general ledger accounts. One company = one Inventory
  account. If a customer ever needs distinct sub-ledgers, it's a structural
  change, not a configuration.
- Per-warehouse costing. Unit cost stays company-wide
  — deferred until there is a clear need for it.
- Transfer pricing between warehouses. Internal transfers move stock at
  carrying cost; no markup.
- Per-bin or per-aisle locations within a warehouse. That's a WMS feature,
  out of scope.
- Manufacturing across warehouses. By design, one production
  order consumes and produces in **the same** warehouse — explicit
  source and destination is not supported.
