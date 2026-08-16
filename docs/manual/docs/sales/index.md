# Sales lifecycle — Quote to Cash

The five modules that turn an inbound enquiry into money in the bank.

| Page | What it covers |
|---|---|
| [Quote-to-cash workflow](quote-to-cash.md) | The end-to-end diagram. Read first. |
| [CRM](crm.md) | Leads → Deals pipeline, contacts, activities |
| [Clients](clients.md) | Customer master + 360° detail view |
| [Quotations](quotations.md) | Proposals, convert to invoice / convert to project |
| [Projects](projects.md) | Long-form work — budget, milestones, material consumption |
| [Invoices & Payments](invoices.md) | Sales billing, multi-currency payments, aging |
| [Sending invoices & quotations](sending.md) | Getting a document to the customer by WhatsApp or email, and seeing whether they opened it |

## The pipeline at a glance

```mermaid
flowchart LR
    LEAD[CRM Lead] -->|qualified| DEAL[CRM Deal]
    DEAL -->|propose| QUO[Quotation]
    LEAD -.->|"convert"| CLI[Client]
    QUO -->|accepted| CONV{Convert}
    CONV -->|short job| INV[Invoice]
    CONV -->|long job| PRJ[Project]
    PRJ -->|milestone billing| INV
    INV --> PAY[Payment]
    PAY --> CASH[Cash drawer]
    PAY --> GL[General Ledger]

    style LEAD fill:#fef3c7,stroke:#f59e0b
    style DEAL fill:#fef3c7,stroke:#f59e0b
    style QUO  fill:#dbeafe,stroke:#3b82f6
    style PRJ  fill:#ede9fe,stroke:#8b5cf6
    style INV  fill:#dcfce7,stroke:#10b981
    style PAY  fill:#dcfce7,stroke:#10b981
    style GL   fill:#f1f5f9,stroke:#475569
```

Each box is a separate module page in this chapter. Each arrow is an
explicit, audit-logged conversion.

## Personas you'll meet in this chapter

| Persona | Lives in |
|---|---|
| **Sales rep** | CRM — works leads, books meetings, marks deals won |
| **Sales Manager** | Across the chapter — approves discounts, reviews pipeline |
| **Project Manager** | Projects — runs the long-form work after a quote wins |
| **Accountant / Finance** | Invoices & Payments — chases A/R, applies tenders |
| **Auditor** | Cross-cutting — sample-tests conversions for completeness |
