# Cash & Reconciliation

Per-drawer daily reconciliation, separately for USD and LBP. Verifies that
physical cash matches what the system says should be there — and posts any
variance to the ledger.

## Purpose

A **cash drawer** is a physical cash point (Main Till, Petty Cash, Workshop
Petty Cash, …). A **reconciliation** is one drawer-day: opening balance,
expected cash, counted cash, variance.

The system computes "expected" from real activity (cash payments + cash
expenses dated that day). The cashier counts the physical cash. Variance =
counted − expected. The system posts that variance to the ledger.

## Personas

| Persona | What they do here |
|---|---|
| **Cashier** | Counts the till at end of shift; closes the reconciliation |
| **Cash Manager** | Reviews variances, creates new drawers, sets auto-capture |
| **Operations Manager** | Approves recurrent variance investigations |
| **Auditor** | Reconciles physical cash trail to GL Cash account, verifies variance postings |

## Quick reference

- **One drawer is auto capture** — receives all cash transactions that don't specify a drawer
- **Per-currency reconciliation** — USD and LBP are counted separately
- **Variance posting** — closing a drawer posts any difference to 6910 Cash Short & Over
- **Thresholds** for variance alerts: ≥ $5 USD or ≥ 100,000 LBP triggers notification
- **Status**: only `open` (active reconciliation) or `closed` (finalized)

---

=== "Operator's view"

    ### Opening a reconciliation

    Cash → pick a drawer → **+ New reconciliation** for today's business
    date. Enter.

    - Opening balance USD (defaults to the prior close)
    - Opening balance LBP (same)

    Save. Reconciliation is now **open**.

    ### What "expected cash" means

    While the reconciliation is open, the system tracks.

    | Cash in | Cash out |
    |---|---|
    | Cash invoice payments dated today | Cash expenses dated today |
    | POS cash sales dated today | POS refunds (returns) |
    | Manual cash-in movements | Manual cash-out movements |

    Per currency. The dashboard shows.

    | | USD | LBP |
    |---|---|---|
    | Opening | (entered) | (entered) |
    | + Cash in | sum of today's cash payments + sales | (LBP equivalent) |
    | − Cash out | sum of today's cash expenses + refunds | (LBP equivalent) |
    | = Expected | computed | computed |
    | Counted (you fill in) | — | — |
    | Variance | counted − expected | counted − expected |

    ### Closing — the count

    End of shift:
    1. Count physical USD bills and coins → enter **Counted USD**
    2. Count physical LBP bills → enter **Counted LBP**
    3. Click **Close**

    The system posts the variance to the ledger automatically.

    | Variance | GL post |
    |---|---|
    | USD < 0 (till short) | `DR 6910 Cash Short & Over / CR 1000 Cash & Bank` |
    | USD > 0 (till over) | `DR 1000 Cash & Bank / CR 6910 Cash Short & Over` |
    | LBP < 0 (till short) | `DR 6910 Cash Short & Over / CR 1010 Cash — LBP` |
    | LBP > 0 (till over) | `DR 1010 Cash — LBP / CR 6910 Cash Short & Over` |

    LBP variance is translated to USD at the latest spot rate for the
    journal post.

    ### Reopening (admin only)

    If you closed by mistake (typo in the count, for example), an
    administrator can **Reopen** the reconciliation. The variance entry is
    reversed; you can re-count and re-close.

    ### Manual cash movements

    Inside an open reconciliation: **+ Add movement** records an
    out-of-band cash event (cash withdrawal, owner draw, ad-hoc
    safe-load).

    - Direction: `in` or `out`
    - Amount, currency
    - Category (free text)
    - Description

    Manual movements affect the **expected cash** computation but **do
    NOT auto-post to the GL** — that's the operator's separate journal
    entry decision.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete | approve |
    |---|---|---|---|---|---|
    | Cashier | ✅ (their drawer) | ✅ | ✅ | ✗ | ✗ |
    | Cash Manager | ✅ | ✅ | ✅ | ✅ | ✅ |
    | Finance Manager | ✅ | ✅ | ✅ | ✗ | ✅ |
    | Operations Manager | ✅ | ✅ | ✅ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ | ✗ |

    `approve` is what lets a user **reopen** a closed reconciliation —
    a high-trust action.

    ### Creating drawers

    Cash → **Drawers** tab → **+ Add drawer**.

    | Field | Notes |
    |---|---|
    | Name | "Main Till", "Workshop Petty Cash", … |
    | Active | Inactive drawers don't appear in selectors |
    | **Auto capture** | Exactly one drawer carries auto-capture switched on |

    The auto-capture drawer is where unattributed cash transactions land
    — POS sales without a drawer, expenses without a drawer.

    Promoting a new drawer to auto-capture flips the old one off
    automatically (enforced by a uniqueness constraint).

    ### Variance thresholds

    Hard-coded in `cash.py`.

    - `_USD_THRESHOLD = 5.0` — variance ≥ $5 USD fires a notification
    - `_LBP_THRESHOLD = 100_000.0` — variance ≥ LBP 100,000 fires a notification

    At today's rate that's about $1.12 — a sensible noise floor.

    ### LBP variance translation

    The variance posting translates LBP variance to USD using the **latest
    stored exchange rate**. If no rate is configured, the LBP variance is
    **not posted** (the till-side variance is still recorded on the
    reconciliation, and surfaced in the notification).

=== "Auditor's view"

    ### Cash trail — physical → ledger

    The headline control: physical cash deposited equals GL Cash balance.

    Sum these counted cash values across drawers — should equal the
    `1000 Cash & Bank` GL balance at the same point in time.

    ### Checking variances were posted

    Every closed reconciliation with a non-trivial variance should have a
    matching entry.

    An empty entry column with a non-zero variance means nothing was posted (or
    an LBP variance with no exchange rate, which is the documented
    no-post case).

    ### Recurring shortfalls per cashier

    Cashiers with persistent shortages need investigation.

---

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Open : + New reconciliation
    Open --> Open : Add cash movements
    Open --> Closed : Close<br/>variance posted
    Closed --> Open : Reopen (admin)<br/>entry reversed
    Closed --> [*]
```

## What's NOT supported

- Multi-cashier per drawer per day. One reconciliation per drawer per day —
  if two cashiers share a till, the second's count happens at handover via
  a manual movement.
- Cash deposit / withdrawal to/from a bank account. Manual journal entry
  in the GL.
- Reconciliation across multiple drawers in one click. Each drawer
  reconciles independently.
