---
title: Welcome
hide:
  - navigation
  - toc
---

# ERP System — Comprehensive Manual

<div style="font-size:1.1rem; color: var(--md-default-fg-color--light); max-width: 760px;">
A multi-warehouse, dual-currency, double-entry ERP for small and medium
enterprises. This manual covers <strong>every module</strong> from three
perspectives — Operator, Administrator, and Auditor — with workflow
diagrams, data models, and the audit evidence each operation leaves behind.
</div>

---

## Quick orientation

<div class="grid cards" markdown>

-   :material-account-cog:{ .lg .middle } **Operator**

    ---

    *"How do I do my job today?"*

    Step-by-step workflows for clerks, cashiers, project managers, accountants
    and HR staff. Look for the **Operator's view** tab on every module page.

    [:octicons-arrow-right-24: Start at the Module map](architecture/module-map.md)

-   :material-shield-account:{ .lg .middle } **Administrator**

    ---

    *"How do I configure and govern this?"*

    Permissions, multi-warehouse access, RBAC, settings, integrations and
    operational controls. Look for the **Administrator's view** tab.

    [:octicons-arrow-right-24: Authentication & RBAC](foundation/rbac.md)

-   :material-magnify-scan:{ .lg .middle } **Auditor**

    ---

    *"What evidence is recorded?"*

    Audit trails, journal entries, period locks, segregation of duties,
    immutable history. Look for the **Auditor's view** tab on every module.

    [:octicons-arrow-right-24: Audit trail](foundation/audit-trail.md)

</div>

---

## What the system does

```mermaid
flowchart LR
    subgraph SALES ["🛒 Sales"]
        CRM[CRM<br/>leads & deals]
        QUO[Quotations]
        INV[Invoices &<br/>Payments]
    end

    subgraph OPS ["📦 Operations"]
        INVT[Inventory<br/>multi-warehouse]
        PUR[Purchases]
        MFG[Manufacturing]
        POS[POS]
    end

    subgraph FIN ["💰 Finance"]
        FINS[Cash-basis<br/>finance]
        ACCT[Double-entry<br/>GL]
        REP[Reports]
    end

    subgraph HR ["👥 People"]
        EMP[HR]
        REC[Recruitment]
    end

    CRM --> QUO --> INV
    QUO -.->|win| PROJ[Projects]
    INV --> FINS
    POS --> INV
    POS --> INV
    PUR --> INVT
    MFG --> INVT
    INVT -.->|low-stock| PUR
    INV --> ACCT
    FINS --> REP
    ACCT --> REP
    EMP --> FINS

    style SALES fill:#eef2ff,stroke:#6366f1
    style OPS  fill:#fef3c7,stroke:#f59e0b
    style FIN  fill:#dcfce7,stroke:#10b981
    style HR   fill:#fce7f3,stroke:#ec4899
```

The arrows aren't just navigation hints — they reflect **real data flow**.
A POS sale becomes an invoice + a payment + a stock movement + a journal
entry, all in one atomic transaction. The manual maps each of these for you.

---

## Headline capabilities

<div class="grid cards" markdown>

-   :material-warehouse: **Multi-warehouse stock**

    First-class warehouses with row-level access, transfer workflow,
    per-warehouse balances. One company-wide Inventory GL account.

-   :material-currency-usd: **Dual-currency (USD + LBP)**

    Functional currency is USD; LBP is fully supported for POS tenders,
    invoice payments, payroll, cash drawers, and period-end FX revaluation.

-   :material-book-multiple: **Double-entry accounting**

    Real general ledger. Trial balance always ties, Income Statement and
    Balance Sheet are derived from journal entries, never inflated.

-   :material-account-key: **RBAC + row-level access**

    18 seeded roles × 28 modules × 5 actions, plus per-warehouse access for
    inventory operations.

-   :material-history: **Comprehensive audit trail**

    Every write recorded with `user_id`, `action`, `record_ref`, `detail`,
    `created_at`. Reversal-only corrections — nothing is silently deleted.

-   :material-check-decagram: **Approval workflows**

    Rule-based multi-step approvals on expenses, purchases, invoices,
    projects, and fixed-asset capex.

-   :material-translate: **Bilingual (EN + AR)**

    Full Arabic with RTL layout. Every UI string flows through one
    translation dictionary; perfect parity verified.

-   :material-database-arrow-right: **Resilient backups**

    Automatic + manual backups, one-click backup to a USB stick or network
    share, restore on a fresh install.

</div>

---

## How to read this manual

Each module page in the manual follows the same shape, so once you've read
one you know where to look in every other:

| Section | What it answers |
|---|---|
| **Purpose** | What problem the module solves |
| **Personas** | Who uses it day-to-day |
| **Operator's view** | The buttons you click and what they do |
| **Administrator's view** | Configuration, permissions, controls |
| **Auditor's view** | What records are written and how to verify them |
| **Data model** | ER diagram of the tables involved |
| **Workflow** | Sequence/flow diagram of the most common operation |
| **Permissions** | Module-level + row-level table |
| **Integrations** | What other modules read from / write to this one |
| **API surface** | Endpoints invoked when the UI does its work |

!!! tip "Searching the manual"
    Hit ++slash++ (or click the magnifying glass) at any time to open the
    full-text search. Results highlight matching terms across every page.

!!! info "Version covered"
    This manual describes the ERP at version **2.1.0+** — multi-warehouse,
    multi-currency audit remediation, and the expanded RBAC catalog are all
    in scope.
