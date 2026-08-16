# Module index

The complete catalogue of all 28 permission-gated modules + 3 cross-cutting
surfaces, each with a one-liner and a link to its deep dive in the manual.

## Permission-gated modules (28)

These appear in the **Roles & Permissions matrix** and gate operational
access.

### Foundation

| Module key | One-liner | Page |
|---|---|---|
| `dashboard` | Personalized landing with KPIs across all modules | (Phase 1) |

### Sales lifecycle

| Module key | One-liner | Page |
|---|---|---|
| `crm` | Leads → deals pipeline, contacts, activities | [CRM](../sales/crm.md) |
| clients | Customer master + 360° detail | [Clients](../sales/clients.md) |
| quotations | Proposals + convert-to-invoice / convert-to-project | [Quotations](../sales/quotations.md) |
| invoices | Sales billing + multi-currency payments + aging | [Invoices](../sales/invoices.md) |
| `pos` | Register sessions, sales, returns, dual-currency tender | [POS](../operations/pos.md) |

### Delivery

| Module key | One-liner | Page |
|---|---|---|
| projects | Long-form work with budget, milestones, materials | [Projects](../sales/projects.md) |
| `planning` | Project Gantt + tasks + milestones + calendar events | [Planning](../people/planning.md) |

### Procurement / stock

| Module key | One-liner | Page |
|---|---|---|
| suppliers | Vendor master + 360° detail | [Suppliers](../operations/suppliers.md) |
| purchases | PO lifecycle Ordered → Received → Paid | [Purchases](../operations/purchases.md) |
| inventory | Items, lots, FIFO/LIFO/avg costing, low-stock alerts | [Inventory](../operations/inventory.md) |
| warehouses | Multi-location stock, transfers, per-warehouse access | [Warehouses](../operations/warehouses.md) |
| `manufacturing` | BOMs, production orders, QC, resources, costing | [Manufacturing](../operations/manufacturing.md) |

### Finance

| Module key | One-liner | Page |
|---|---|---|
| expenses | One-off + recurring expenses; project allocation | [Expenses](../finance/expenses.md) |
| `assets` | Capital register + straight-line depreciation | [Fixed Assets](../finance/assets.md) |
| `finance` | Cash-basis dashboard; period locks | [Finance](../finance/finance.md) |
| `cash` | Per-drawer reconciliation with USD + LBP variance | [Cash](../finance/cash.md) |
| `accounting` | Double-entry GL: CoA, JEs, Trial Balance, IS, BS | [Accounting](../finance/accounting.md) |
| `reports` | Financial, Aging, Expenses, VAT, Inventory-by-WH | [Reports](../finance/reports.md) |

### People

| Module key | One-liner | Page |
|---|---|---|
| `hr` | Employees, departments, payroll runs, leave | [HR](../people/hr.md) |
| contracts | Formal employment contracts | [HR Contracts](../people/hr-contracts.md) |
| HR activities | Per-employee personal calendar with reminders | [HR Activities](../people/hr-activities.md) |
| `recruitment` | Positions, applicants, interviews, offers | [Recruitment](../people/recruitment.md) |

### Comms

| Module key | One-liner | Page |
|---|---|---|
| `announcements` | Internal top-down communications + acknowledgements | [Announcements](../people/announcements.md) |

### Administration

| Module key | One-liner | Page |
|---|---|---|
| `settings` | Company info, defaults, tax engine, exchange rate | (Phase 6 — admin doc) |
| users | User accounts, status, role assignment | (Phase 6) |
| roles | Role definitions and what each may do | [Roles & permissions](../foundation/rbac.md) |
| `audit` | Immutable record of every write | [Audit trail](../foundation/audit-trail.md) |

## Cross-cutting surfaces (always-on)

These don't have a permission gate — every authenticated user gets them.

| Surface | One-liner | Page |
|---|---|---|
| Notifications | Per-user system event inbox (14 types) | [Notifications](../people/notifications.md) |
| Approvals | Rule-based multi-step approval policies + requests | [Approvals](../people/approvals.md) |
| Multi-currency (USD + LBP) | Two cash accounts + FX engine | [Multi-currency](../finance/multi-currency.md) |
| Multi-warehouse access | Which warehouses a person can work in | [Warehouse access](../foundation/warehouse-access.md) |

## By module count per chapter

| Chapter | Modules covered |
|---|---|
| Foundation | 5 (`dashboard`, users, roles, `audit`, `settings`) — most in the foundation pages |
| Sales | 5 (`crm`, clients, quotations, projects (delivery), invoices) |
| Operations | 6 (inventory, warehouses, suppliers, purchases, `manufacturing`, `pos`) |
| Finance | 8 (`finance`, expenses, `cash`, `assets`, `accounting`, `reports`, `tax`, `multi-currency`) |
| People | 8 (`hr`, contracts, HR activities, `recruitment`, `approvals`, `planning`, `announcements`, `notifications`) |

## Recently-added modules

The latest release introduced four modules that weren't in earlier
documentation:

| Module | Added in | Why it matters |
|---|---|---|
| warehouses | Phase 1 of multi-warehouse rollout | Multi-location stock and per-warehouse access |
| `accounting` | Phase 1 of accounting GL | Double-entry general ledger |
| contracts | HR maturity work | First-class contract documents |
| HR activities | HR maturity work | Per-employee calendar |
| `announcements` | Internal comms feature | Audience-targeted broadcasts |

All five appear in the Roles & Permissions matrix.

## Module-key → URL conventions

The module key (in this index) maps to the sidebar route:

| Module key | Route |
|---|---|
| `crm` | `/crm` |
| clients | `/clients` |
| quotations | `/quotations` |
| invoices | `/invoices` |
| `pos` | `/pos` |
| projects | `/projects` |
| `planning` | `/planning` |
| suppliers | `/suppliers` |
| purchases | `/purchases` |
| inventory | `/inventory` |
| warehouses | `/warehouses` |
| `manufacturing` | `/manufacturing` |
| expenses | `/expenses` |
| `assets` | `/fixed-assets` |
| `finance` | `/finance` |
| `cash` | `/cash` |
| `accounting` | `/accounting` |
| `reports` | `/reports` |
| `hr` | `/hr` |
| contracts | (within `/hr`) |
| HR activities | `/hr-activities` |
| `recruitment` | `/recruitment` |
| `announcements` | `/announcements` |
| `settings` | `/settings` |
| users | `/users` |
| roles | `/roles` |
| `audit` | (within Admin Panel) |
| `dashboard` | `/` |
