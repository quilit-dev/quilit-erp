# CRM — Customer Relationship Management

The system's funnel: capture inbound enquiries, qualify them, work them through
stages, win them, and convert into the rest of the sales documents.

## Purpose

CRM holds four kinds of records:

| Record | What it represents |
|---|---|
| **Lead** | A person/company that *might* become a customer |
| **Deal** | A specific opportunity (with a $ value and a probability of close) |
| **Contact** | A named human at a client or lead |
| **Activity** | A call, meeting, email, or task — with due-date and outcome |

A lead becomes a deal becomes a quotation becomes an invoice — each
transition is a single, audited conversion.

## Personas

| Persona | What they do here |
|---|---|
| **Sales rep** | Captures inbound leads, logs every touch, updates stages, marks deals won |
| **Sales Manager** | Watches pipeline value, win rate, sales-cycle length, source attribution |
| **CRM Specialist** | Cleans data, merges duplicate leads, runs reporting |
| **Auditor** | Verifies every won opportunity has an invoice (completeness) |

---

=== "Operator's view"

    ### Capturing a lead

    1. CRM → **Leads** tab → **+ Add lead**
    2. Fill in name, company, contact details, source (referral, website,
       cold-call, …)
    3. Optionally set `estimated_value` and `expected_close` — these are what
       feed pipeline KPIs
    4. Save. The lead lands in status **New**.

    ### Working the funnel

    Each lead has a status that moves left-to-right:

    `New → Contacted → Qualified → Proposal → Won (or Lost)`

    Update via the status dropdown on the lead detail. **Don't skip stages**
    — the funnel report relies on each stage being touched at least once.

    ### Logging activities

    On any lead or deal: **+ Add activity** → pick type (Call / Meeting /
    Email / Task), subject, due date. Mark `done_at` when you complete it
    and add an `outcome` ("Customer wants 10% discount; needs Director
    sign-off").

    Activities surface on the **HR Activities** dashboard for the person
    they're assigned to — handy as a personal to-do list.

    ### Converting a lead

    On a lead detail, top-right menu offers:

    - **Convert to client** — creates a `clients` row, links it to the lead,
      moves status to "Won"
    - **Create deal** — opens a new deal with the lead's company and
      estimated value pre-filled

    Once the lead has a `client_id`, all subsequent quotations and invoices
    can attach to the client (and indirectly back to the originating lead).

    ### Working a deal

    Deals carry stage `Qualification → Proposal → Negotiation → Won (or
    Lost)` plus a **probability %** and a **value**. The pipeline-value
    report sums `value × probability/100` across all open deals.

    Mark won via **Mark won** — sets `won_at` to now. Lost → **Mark lost**
    with a required `lost_reason` (cycle-loss analysis depends on it).

=== "Administrator's view"

    ### Permissions

    The `crm` module has the standard 5 actions. Plus:

    - `Sales` role: `view`, `create`, `edit` (no delete)
    - `Sales Manager`: full, including approve (used for high-value deals
      via approval policies)
    - `CRM Specialist`: full
    - `Auditor`: view only
    - Other roles: typically no access

    ### Lead source taxonomy

    Lead `source` is free-text by design — the install can use whatever
    taxonomy suits. Common values: `referral`, `website`, `cold-call`,
    `event`, `partner`, `repeat`. Run **Reports → Pipeline** to see
    win-rate by source.

    ### Lead scoring

    Each lead carries a `score` (0–100) you can edit manually. There's no
    automatic scoring algorithm — the field is there for sales teams that
    want to bucket leads by quality.

    ### Bulk operations

    The Archives module exposes mass-archive of stale records. Old leads
    that have been "Lost" for > 6 months are good candidates.

=== "Auditor's view"

    ### Completeness check — every won deal has a sales document

    A core control: a won opportunity should result in revenue evidence
    (quotation, invoice, or both). Find gaps:

    ```sql
    -- Won deals with no linked quotation
    SELECT d.id, d.title, d.won_at, d.value, c.name AS client
    FROM crm_deals d
    LEFT JOIN clients c ON c.id = d.client_id
    WHERE d.won_at IS NOT NULL
      AND d.quotation_id IS NULL
      AND d.archived_at IS NULL
    ORDER BY d.won_at;
    ```

    Each row needs an explanation: was the work invoiced under a different
    deal? Was it free-of-charge? Was it never invoiced (control gap)?

    ### Cycle time

    ```sql
    -- Time from lead creation to win (in days)
    SELECT l.id, l.name,
           julianday(d.won_at) - julianday(l.created_at) AS cycle_days,
           d.value
    FROM crm_leads l
    JOIN crm_deals d ON d.lead_id = l.id
    WHERE d.won_at IS NOT NULL;
    ```

    ### Source attribution

    ```sql
    -- Win rate by source
    SELECT source,
           COUNT(*) AS total,
           SUM(CASE WHEN status='Won' THEN 1 ELSE 0 END) AS won,
           ROUND(100.0 * SUM(CASE WHEN status='Won' THEN 1 ELSE 0 END)
                       / COUNT(*), 1) AS win_pct
    FROM crm_leads
    WHERE archived_at IS NULL
    GROUP BY source ORDER BY total DESC;
    ```

    ### Activities trail

    ```sql
    -- Every activity logged on a given lead/deal
    SELECT a.created_at, a.type, a.subject, a.outcome, u.username
    FROM crm_activities a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.lead_id = ?  -- or a.client_id = ?
    ORDER BY a.created_at;
    ```

---

## Status lifecycle

```mermaid
stateDiagram-v2
    [*] --> New : Lead captured
    New --> Contacted : First touch logged
    Contacted --> Qualified : Needs + budget confirmed
    Qualified --> Proposal : Quote sent
    Proposal --> Won : Deal closed
    Proposal --> Lost : With required reason
    Qualified --> Lost
    Contacted --> Lost
    Won --> [*] : Converted to client
    Lost --> [*] : Archived

    note right of Won
        Sets crm_leads.status = 'Won'
        Links crm_leads.client_id
        Deal probability → 100%
    end note
```

Deals carry their own four-stage timeline — `Qualification → Proposal →
Negotiation → Won`. They overlap with leads on purpose: a lead can spawn
multiple deals over time (re-engagement, upsell, …).

## Data model

```mermaid
erDiagram
    CRM_LEADS ||--o{ CRM_DEALS : "spawns"
    CRM_LEADS ||--o{ CRM_CONTACTS : "has"
    CRM_LEADS ||--o{ CRM_ACTIVITIES : "logged on"
    CRM_LEADS }o..|| CLIENTS : "promoted to"

    CRM_DEALS }o..|| CLIENTS : "for"
    CRM_DEALS }o..|| QUOTATIONS : "attached to"

    CLIENTS ||--o{ CRM_CONTACTS : "has"
    CLIENTS ||--o{ CRM_ACTIVITIES : "logged on"

    CRM_LEADS {
        int  id PK
        text name
        text company
        text email
        text phone
        text source
        text status
        int  score
        real estimated_value
        text expected_close
        int  assigned_to FK
        int  client_id FK
        text notes
        text created_at
    }

    CRM_DEALS {
        int  id PK
        text title
        int  client_id FK
        int  lead_id FK
        int  quotation_id FK
        text stage
        real value
        int  probability
        text expected_close
        text won_at
        text lost_at
        text lost_reason
        int  assigned_to FK
    }

    CRM_CONTACTS {
        int  id PK
        int  client_id FK
        int  lead_id FK
        text name
        text title
        text email
        text phone
        int  is_primary
    }

    CRM_ACTIVITIES {
        int  id PK
        text type
        text subject
        text description
        int  client_id FK
        int  lead_id FK
        int  contact_id FK
        int  user_id FK
        text due_date
        text done_at
        text outcome
    }
```

## Workflow — lead converts to client + deal

```mermaid
sequenceDiagram
    autonumber
    participant SR as Sales rep
    participant API as FastAPI
    participant DB as SQLite

    SR->>API: POST /api/crm/leads/<br/>{ name, company, source, ... }
    API->>DB: INSERT crm_leads (status='New')
    API-->>SR: { id: 42 }

    Note over SR: Multiple touches over weeks →

    SR->>API: PUT /api/crm/leads/42<br/>{ status: 'Qualified' }
    API->>DB: UPDATE crm_leads SET status='Qualified'<br/>+ audit_log row

    SR->>API: POST /api/crm/deals/<br/>{ lead_id: 42, title, value, stage: 'Qualification' }
    API->>DB: INSERT crm_deals (lead_id=42, stage='Qualification')

    Note over SR: Proposal sent, customer accepts →

    SR->>API: POST /api/crm/leads/42/convert
    API->>DB: BEGIN
    API->>DB: INSERT clients (name=lead.company, ...)
    API->>DB: UPDATE crm_leads SET status='Won', client_id=<new>
    API->>DB: UPDATE crm_deals SET stage='Won', won_at=now, probability=100
    API->>DB: INSERT audit_log (action='convert_lead', module='crm')
    API->>DB: COMMIT
    API-->>SR: { client_id: 7, message: 'Lead converted' }
```

## Permissions

| Action | Default access |
|---|---|
| `view` | Sales, Sales Manager, CRM Specialist, Auditor, Business Owner, Admin |
| `create` | Sales, Sales Manager, CRM Specialist |
| `edit` | Sales (own leads), Sales Manager (all), CRM Specialist |
| `delete` | CRM Specialist, Admin |
| `approve` | Sales Manager (used by high-value deal approval policies) |

Customise in **Roles & Permissions**. Per-warehouse access does not apply to
CRM (no stock motion).

## Integrations

```mermaid
flowchart LR
    CRM[CRM] -->|"Lead won →<br/>create"| CLI[Clients]
    CRM -->|"Deal won →<br/>attach"| QUO[Quotations]
    QUO -.->|backlinked| CRM
    INV[Invoices] -.->|via client_id<br/>backlinked| CRM
    HRA[HR Activities] -.->|same activity table| CRM
    APP[Approvals] -.->|high-value deals| CRM
    REP[Reports] -.->|Pipeline report| CRM
```

CRM activities (`crm_activities`) and HR Activities (`hr_activities`) are
**separate tables** despite the similar name. CRM is customer-facing; HR is
internal calendar.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/crm/leads` | List leads (filter by status, source, assigned_to) |
| `POST /api/crm/leads` | Create lead |
| `PUT /api/crm/leads/{id}` | Update lead (status changes here) |
| `POST /api/crm/leads/{id}/convert` | Promote to client |
| `GET /api/crm/deals` | List deals (filter by stage) |
| `POST /api/crm/deals` | Create deal |
| `PUT /api/crm/deals/{id}` | Update (stage, probability, value) |
| `POST /api/crm/deals/{id}/mark-won` | Set won_at, probability=100 |
| `POST /api/crm/deals/{id}/mark-lost` | Set lost_at + lost_reason |
| `GET /api/crm/contacts` | List contacts |
| `POST /api/crm/activities` | Log a touch |
| `GET /api/crm/summary` | Pipeline KPIs (count + value by stage) |

The OpenAPI spec at `/docs` documents request/response shapes precisely.
