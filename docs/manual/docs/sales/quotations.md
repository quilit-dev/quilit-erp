# Quotations

The proposal document. Records what you offered the customer, for how much,
and what they did with it. The pivot point between selling (CRM) and
delivering (Projects / Invoices).

## Purpose

A quotation is the **formal price commitment**. Auditors care about it
because the price the customer eventually pays should match (or be a
documented variance from) the price the approver authorised here.

## Personas

| Persona | What they do here |
|---|---|
| **Sales rep** | Drafts, tweaks line items, sends |
| **Sales Manager** | Approves discounts; reviews open proposals |
| **Project Manager** | Reads accepted quotes that spawn their projects |
| **Accountant** | Cross-references quotes against issued invoices |
| **Auditor** | Verifies invoiced amounts match quoted amounts |

## Quick reference

- **Number format**: vendor-configurable (default `Q-YYYY-NNNN`)
- **Status lifecycle**: `Draft → Sent → Accepted / Rejected`
- **Currency**: USD only (LBP at invoicing only)
- **Line items**: free-text name, quantity, unit price, optional tax rate
- **Tax**: per-line snapshot (`tax_rate_id`, `tax_rate`, `tax_amount`)
- **Conversions**: → Invoice (one click), → Project (one click), → both
- **Attachable to**: a Client, a CRM Lead, or both
- **Soft delete + soft archive**: same pattern as Clients

---

=== "Operator's view"

    ### Creating a quotation

    1. Quotations → **+ Add quotation**
    2. Pick a Client (or a Lead if the contact isn't promoted yet)
    3. Set a `project_name` — what you're proposing, in one line
    4. Add line items: name, qty, unit price, optional tax rate
    5. Save. Lands in status **Draft**.

    ### Sending

    Open the quote → **Mark as Sent**. Status moves from Draft to Sent and
    timestamps in `audit_log`. The customer presumably gets a PDF or email
    from you outside the system (the PDF render is bundled but delivery is
    manual).

    ### When the customer accepts

    Two paths depending on what the work is:

    | Job size | Action | Result |
    |---|---|---|
    | Short, one-shot | **Convert to invoice** | Invoice created with same line items + tax. Quote status → Accepted. Money owed is now in A/R. |
    | Long, milestone-billed | **Convert to project** | Project created (status Active). You'll invoice milestones from the project later. Quote status → Accepted. |
    | Both | First **Convert to project**, then bill milestones | Project carries the budget; each milestone invoice references the project |

    The conversions are **idempotent** — clicking "Convert to invoice"
    twice doesn't create two invoices; the second click jumps to the
    existing one.

    ### When the customer says no

    Open the quote → **Mark as Rejected** (with an optional reason in
    `notes`). Status → Rejected. The deal it was attached to should be
    marked Lost in CRM.

    ### Editing a sent quote

    Sent quotes are editable until they're either Accepted or Rejected. If
    the customer asks for a revised price, edit in place — the audit log
    captures both the original `total` and the new value.

    !!! tip "Versioning"
        For substantial revisions, **clone** the quote (Quotations → row
        menu → Clone) so the original stays as historical record. The
        clone starts Draft.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete | approve |
    |---|---|---|---|---|---|
    | Sales | ✅ | ✅ | ✅ | ✗ | ✗ |
    | Sales Manager | ✅ | ✅ | ✅ | ✅ | ✅ |
    | Project Manager | ✅ | ✗ | ✗ | ✗ | ✗ |
    | Accountant | ✅ | ✗ | ✗ | ✗ | ✗ |
    | Auditor | ✅ | ✗ | ✗ | ✗ | ✗ |

    `approve` is used by **approval policies** — e.g. "quotations with
    discount > 15% need Sales Manager approval before they can be sent".
    See Approvals (Phase 5).

    ### Numbering

    The quote number generator is centralised. The vendor configures the
    prefix in `vendor_config.py`; the sequence (NNNN) is per-year and
    resets each January.

    ### Tax engine

    Each line carries:
    - `tax_rate_id` — FK to `tax_rates`
    - `tax_rate` — snapshot of the rate value at the time of write
    - `tax_amount` — computed

    The snapshot means a tax rate change next year won't retroactively
    alter old quotes. See **Tax Rates** (Phase 4).

    ### Approval policies that gate sending

    A common policy: "Quotations with total > $10,000 need approval before
    converting to invoice". Configure in **Approval Policies**:
    - Module: `quotations`
    - Trigger action: `send` (or `convert`)
    - Condition: `total > 10000`
    - Approvers: `Sales Manager`

    See Approvals (Phase 5) for the policy engine.

=== "Auditor's view"

    ### The headline control — invoiced = quoted

    ```sql
    -- Quotes that became invoices, with any price variance
    SELECT q.id, q.quote_number, q.total AS quoted,
           i.invoice_number, i.amount AS invoiced,
           ROUND(i.amount - q.total, 2) AS variance
    FROM quotations q
    JOIN invoices i ON i.quotation_id = q.id
    WHERE q.deleted_at IS NULL
      AND ABS(i.amount - q.total) > 0.01
    ORDER BY ABS(i.amount - q.total) DESC;
    ```

    Each non-zero variance row needs an explanation: scope change?
    discount applied?

    ### Status integrity

    ```sql
    -- Accepted quotes should have either a linked invoice or a linked project
    SELECT q.id, q.quote_number, q.total
    FROM quotations q
    LEFT JOIN invoices i ON i.quotation_id = q.id AND i.deleted_at IS NULL
    LEFT JOIN projects p ON p.source_quotation_id = q.id
    WHERE q.status = 'Accepted'
      AND i.id IS NULL
      AND p.id IS NULL;
    ```

    Result should be empty. Otherwise = a control gap: the quote says
    Accepted but no downstream document was produced.

    ### Conversion audit trail

    Every conversion writes an `audit_log` row with
    `action='convert_to_invoice'` or `convert_to_project`.

    ```sql
    SELECT a.created_at, u.username,
           a.action, a.record_ref AS quote_no, a.detail
    FROM audit_log a
    JOIN users u ON u.id = a.user_id
    WHERE a.module = 'quotation'
      AND a.action LIKE 'convert%'
    ORDER BY a.created_at DESC LIMIT 50;
    ```

---

## Status lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft : + Add quotation
    Draft --> Sent : Mark as Sent
    Draft --> Draft : Edit line items
    Sent --> Accepted : Convert to invoice/project
    Sent --> Rejected : Mark as Rejected
    Sent --> Sent : Edit (price revision)
    Accepted --> [*]
    Rejected --> [*]

    note right of Accepted
        Side-effect:
        - INVOICE row created OR
        - PROJECT row created OR
        - both
    end note
```

## Workflow — accept and convert to invoice

```mermaid
sequenceDiagram
    autonumber
    participant SR as Sales rep
    participant API as POST /api/quotations/<br/>{id}/convert-to-invoice
    participant ACC as Accounting engine
    participant DB as SQLite

    SR->>API: { quote_id: 42, due_date: '2026-03-15' }
    API->>DB: SELECT quotations WHERE id=42 AND status='Sent'
    DB-->>API: quote + items + client_id

    Note over API: ❌ if already linked to an invoice → return existing

    API->>DB: BEGIN
    API->>DB: INSERT invoices<br/>(quotation_id=42, client_id, amount=quote.total,<br/> subtotal, tax_total, due_date)
    API->>DB: INSERT invoice_items × N<br/>(copy from quotation_items, tax snapshot preserved)
    API->>DB: UPDATE quotations SET status='Accepted'
    API->>DB: UPDATE crm_deals SET stage='Won', won_at=now<br/>WHERE quotation_id=42
    API->>DB: INSERT audit_log (action='convert_to_invoice')
    API->>DB: COMMIT

    Note over ACC: ⚠ No GL post yet —<br/>the invoice creates A/R conceptually,<br/>but the cash-basis books post on PAYMENT.

    API-->>SR: { invoice_id: 117, invoice_number: 'INV-2026-0117' }
```

The invoice gets created but **no journal entry posts**. The system runs on
**cash-basis revenue recognition** by default — the GL hit happens only
when the customer actually pays (see Invoices & Payments). The accrual A/R
view is available from the **Aging report** in Reports.

## Workflow — accept and convert to project

```mermaid
sequenceDiagram
    participant SR as Sales rep
    participant API as POST /api/quotations/<br/>{id}/convert-to-project
    participant DB as SQLite

    SR->>API: { quote_id: 42, location, start_date, end_date }
    API->>DB: BEGIN
    API->>DB: INSERT projects<br/>(name=quote.project_name, client_id,<br/> estimated_cost, expected_revenue=quote.total,<br/> source_quotation_id=42, status='Active')
    API->>DB: UPDATE quotations SET status='Accepted',<br/>project_id=<new>
    API->>DB: INSERT audit_log
    API->>DB: COMMIT
    API-->>SR: { project_id: 19, message: 'Project created' }
```

Now the project is the active record. Subsequent milestone invoices link to
the **project_id** (not the original quote).

## Data model

```mermaid
erDiagram
    QUOTATIONS ||--o{ QUOTATION_ITEMS : "has"
    QUOTATIONS }o..|| CLIENTS : "billed to"
    QUOTATIONS }o..|| CRM_LEADS : "or lead"
    QUOTATIONS }o..|| PROJECTS : "linked from"
    QUOTATIONS }o..|| INVOICES : "becomes"
    QUOTATIONS }o..|| CRM_DEALS : "attached to"
    TAX_RATES ||--o{ QUOTATION_ITEMS : "applies to"

    QUOTATIONS {
        int  id PK
        text quote_number UK
        int  project_id FK
        int  client_id FK
        int  lead_id FK
        text project_name
        text status
        text notes
        real total
        real tax_total
        text created_at
        text deleted_at
        text archived_at
    }

    QUOTATION_ITEMS {
        int  id PK
        int  quotation_id FK
        text name
        real quantity
        real unit_price
        real total
        int  tax_rate_id FK
        real tax_rate
        real tax_amount
    }
```

## Integrations

```mermaid
flowchart LR
    LEAD[CRM Lead] -.->|attach| QUO[Quotation]
    CLI[Client] -->|target of| QUO
    DEAL[CRM Deal] -.->|attach| QUO

    QUO -->|"convert"| INV[Invoice]
    QUO -->|"convert"| PRJ[Project]
    PRJ -->|"milestone"| INV
    QUO -.->|tax snapshot| TAX[Tax Rates]

    APP[Approval policy] -.->|gates send/convert| QUO
    SEARCH[Global search] -.->|indexes| QUO
    REP[Reports → Pipeline] -.->|reads| QUO
```

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/quotations/` | List (filter by status, client, date range) |
| `POST /api/quotations/` | Create (with line items) |
| `GET /api/quotations/{id}` | Detail + items |
| `PUT /api/quotations/{id}` | Update header + items |
| `POST /api/quotations/{id}/send` | Status Draft → Sent |
| `POST /api/quotations/{id}/reject` | Status → Rejected with reason |
| `POST /api/quotations/{id}/clone` | Copy as new Draft |
| `POST /api/quotations/{id}/convert-to-invoice` | Create linked invoice |
| `POST /api/quotations/{id}/convert-to-project` | Create linked project |
| `POST /api/quotations/{id}/render-pdf` | Server-side PDF render |
| `DELETE /api/quotations/{id}` | Soft-delete |
| `PATCH /api/quotations/{id}/archive` | Soft-archive |

## What's NOT supported (deliberately)

- Multi-currency quotations. The system commits to one functional currency
  (USD) for sales documents.
- Partial accept. If the customer accepts 3 of 5 lines, you either edit
  the quote down to 3 then accept, or clone and trim.
- Negotiated revision history *inside* the same quote. Substantial
  revisions use Clone (so each version is its own auditable record).
