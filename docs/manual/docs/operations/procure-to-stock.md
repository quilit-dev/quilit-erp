# Procure-to-stock workflow

How goods come in, move around, and go out — and what each step updates
for you.

## Pipeline 1 — Procure-to-stock

```mermaid
flowchart TB
    LSA[Low-stock alert<br/>or operator decides<br/>to restock] --> CRT[Create PO<br/>status=Ordered]
    CRT --> SUP[supplier reads PO]
    SUP --> ARR[Goods arrive]
    ARR --> RCV[Mark Received<br/>status=Received]
    RCV --> WR{Writes}
    WR --> W1[Stock goes up,<br/>at the order's warehouse]
    WR --> W2[Cost recorded<br/>by your costing method]
    WR --> W3[Stock movement logged<br/>as a purchase]
    WR --> W4[GL: DR Inventory 1200<br/>CR Cash & Bank 1000]
    RCV --> PAY[Mark Paid<br/>status=Paid]
    PAY --> EXP[Expense recorded]
    PAY --> AUD[Audit trail entry]

    style WR fill:#fef3c7,stroke:#f59e0b
    style W4 fill:#dcfce7,stroke:#10b981
```

Every step is one click in the UI. The receipt step does the most writes —
several to your stock, plus a journal entry and an audit-trail entry, all in one
transaction.

## Pipeline 2 — Make-to-stock (Manufacturing)

```mermaid
flowchart TB
    BOM[BOM defined<br/>components + resources<br/>+ optional QC] --> MO[Production Order opened<br/>status=Draft]
    MO --> CNF[Confirm<br/>reserves components<br/>status=Confirmed]
    CNF --> START[Start<br/>status=In Progress]
    START --> COMP[Complete<br/>book actual consumption + hours]
    COMP --> W{Writes per item}
    W --> W1[Components:<br/>stock goes down<br/>at the order's warehouse]
    W --> W2[Finished goods:<br/>stock goes up<br/>at its unit cost]
    W --> W3[Stock movement logged<br/>as production]
    W --> W4[Actual quantity<br/>and cost locked in]

    COMP --> QC{QC required?}
    QC -->|no| DONE[status=Completed]
    QC -->|yes| QUAR[Held in quarantine<br/>not yet sellable]
    QUAR --> INSP[Inspector decides:<br/>passed / rejected / rework]
    INSP --> REL[passed: release to stock<br/>rejected: scrap cost recognised<br/>rework: spawns rework order]
    REL --> DONE

    style W fill:#ede9fe,stroke:#8b5cf6
    style W4 fill:#fef3c7,stroke:#f59e0b
```

## Pipeline 3 — POS sale

A till sale does the whole cycle in one step: it bills the customer, records
the payment, takes the stock off the shelf and posts the sale to the accounts —
all at once. See [POS](pos.md).

## Cross-pipeline timing

When does the GL get written? Different events post differently:

```mermaid
flowchart LR
    PURRCV[Purchase Received] --> GL1[DR Inventory<br/>CR Cash]
    PURPAID[Purchase Paid] -.->|already posted at receipt| GL1
    POSSALE[POS sale] --> GL2[DR Cash CR Revenue<br/>+ DR COGS CR Inventory]
    INVPAY[Invoice payment] --> GL3[DR Cash CR Revenue]
    EXPREC[Expense recorded] --> GL4[DR Expense CR Cash]
    PAYRUN[Payroll paid] --> GL5[DR Salaries CR Cash]
    DEPR[Depreciation period] --> GL6[DR Depr Exp CR Acc Depr]
    TRANS[Stock transfer] --> GL7[no GL post<br/>internal motion only]
    ADJUST[Stock adjustment] --> GL7

    style GL7 fill:#fef3c7,stroke:#f59e0b
```

The two **non-posting** events — internal transfers and stock adjustments —
are deliberate. They don't change the **company's** inventory value, just
its location or count. Adjustments need a separate write-off accounting
treatment if the operator chooses (typically via a manual journal entry
debiting "Inventory Adjustment" expense).

## What auditors verify on the operations chapter

Five top-level controls cover most operations audit work:

1. **Inventory ties to the GL** — quantity × unit cost, added up per item, summed
   across all items, should equal the GL's `1200 Inventory` balance at any
   moment (after Phase 1's audit remediation).
2. **Every receipt has a stock movement and a journal entry** — both with
   source ref linking to the PO number.
3. **Every sale has a COGS posting** — invoice + DR Cash CR Revenue + DR
   COGS CR Inventory.
4. **Production output equals the sum of consumed inputs valued at their
   costing-method cost** — quantity made × unit cost ≈ Σ component
   component costs + labour + overhead.
5. **Cash drawer variances are posted** — `Cash Short & Over` account
   reflects the actual end-of-day discrepancies.

Each module page below gives the SQL for these.
