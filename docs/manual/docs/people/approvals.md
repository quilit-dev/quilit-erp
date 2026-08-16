# Approvals

Some actions need someone senior to say yes first. Approvals is where those
rules live, and where pending requests wait.

## Purpose

You set a rule like "any expense over $5,000 needs the Finance Manager".
From then on, anyone recording an expense above that amount creates a
**request** instead of the expense itself. The approver sees it, approves or
rejects, and only then does the expense exist.

Rules can be set for expenses, purchases, fixed assets, projects, quotations
and invoices, and can require several people in turn.

An invoice waiting for approval sits in **Pending Approval**: it takes no
payments and does not move its project along until it is approved.

!!! tip "Created something and cannot find it?"
    It is probably waiting for approval. Check **Approvals**.

## Personas

| Persona | What they do here |
|---|---|
| **Administrator** | Designs policies (e.g. "Expenses > $5K need Finance Manager") |
| **Operator** | Triggers requests by doing normal work; sees "Pending Approval" status |
| **Approver** | Receives notifications, opens Approvals page, approves/rejects with comment |
| **Auditor** | Verifies every high-value transaction has approval evidence |

## Quick reference

- **Modules with approval policies**: expenses, purchases, fixed assets, projects, quotations, invoices
- **Approval types**: one approver clears it, or several in turn
- **Conditions**: built from a list — pick a field, a comparison, and a value
- **Request status**: pending → approved / rejected / cancelled
- **Re-approving a closed request does nothing** — it cannot be approved twice

---

=== "Operator's view"

    ### Seeing approval status on your work

    When a policy fires, the entity you created shows.

    - **Status badge**: `Pending Approval` (orange)
    - **Approval requests** sidebar: who's holding it, current step, who approved so far

    You can't edit a Pending Approval entity until it clears. To cancel
    your own request before it's approved: open the request → **Cancel**.

    ### Approving a request

    Approvals page (sidebar) shows your queue: every request where you're
    on the current step.

    Open one. The system shows.

    - Entity snapshot (what was created/changed)
    - Previous approvers' comments
    - Approve / Reject buttons + comment field

    Click **Approve** (with optional comment). If you're the last approver
    on the chain (or this is a `single`-type policy), the action applies
    immediately — expense posts to GL, asset becomes Active, etc.

    Click **Reject** with a required comment. The request closes with
    status `rejected`. The original entity stays in `Pending Approval`
    until the operator cancels or re-submits.

=== "Administrator's view"

    ### Permissions

    | Role | view requests | approve | manage policies |
    |---|---|---|---|
    | Approver roles (per policy) | ✅ (own queue) | ✅ | ✗ |
    | Finance Manager | ✅ all | ✅ (configured) | ✅ |
    | Administrator | ✅ all | ✗ unless approver | ✅ |
    | Auditor | ✅ all | ✗ | ✗ |

    Policy management is admin-tier.

    ### Designing a policy

    Approval Policies → **+ New policy**.

    | Field | Notes |
    |---|---|
    | Name | Display name |
    | Description | What this policy guards |
    | Module | Which part of the system this guards — Expenses, Purchases, Fixed Assets, Projects, Quotations or Invoices |
    | Trigger action | What someone has to do to set it off, usually creating the record |
    | Conditions | When it applies — see below |
    | Approval type | One approver is enough, or several in turn |
    | Approver roles | Which roles can approve |
    | Priority | If two policies both match, the lower number wins |
    | Is active | On or off |

    ### Setting the conditions

    Click **Add condition** and you get three boxes: a **field**, a
    **comparison**, and a **value**. The fields offered change with the
    module you picked, so you can only build conditions that make sense.

    | You want | Field | Comparison | Value |
    |---|---|---|---|
    | Expenses over $5,000 | Amount | is greater than | 5000 |
    | Any subcontractor expense | Category | is | Subcontractor |
    | Purchases over $10,000 | Total cost | is greater than | 10000 |
    | Assets over $25,000 | Acquisition cost | is greater than | 25000 |

    Add more than one condition and you choose whether **all** of them must
    be true (AND) or **any** of them (OR).
    | Project budgets > $100K | estimated cost is greater than 100000 |

    ### What happens when an approval is granted

    The engine looks up the original "pending" action and applies it. For
    expenses, that means posting the deferred journal entry. For assets,
    that means flipping status from Pending Approval to Active.

    Each application is one transaction with an audit-trail entry showing
    the approval action.

=== "Auditor's view"

    ### Every high-value transaction has approval

    Sample a high-value expense.

    It should show which approval request covered it and who resolved
    them. If there is none, no policy applied at the time — which is fine
    if that was intended, and worth asking about if it was not.

    ### Approval chain reconstruction

    For a specific approved request.

    ### Comments trail (negotiation history)

---
