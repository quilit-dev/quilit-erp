# API surface

All 400 endpoints across 37 routers, with their authentication
requirements. Generated from the live source at manual-build time.

## Conventions

| Auth tag | Meaning |
|---|---|
| `auth` | Any signed-in user (no module check) |
| `admin` | Admin-tier role (Business Owner + admin role, plus superadmin) |
| `superadmin` | Vendor superadmin only |
| `<module>:<action>` | Standard RBAC — user's role must grant `can_<action>` for `<module>` |

## URL shape

| Type | Example |
|---|---|
| Collection | `GET /api/invoices/` |
| Detail | `GET /api/invoices/{id}` |
| Sub-resource | `GET /api/invoices/{id}/payments` |
| Action | `POST /api/quotations/{id}/convert-to-invoice` |

## Idempotency

These endpoints accept an `idempotency_key` field to make double-clicks
safe:

- `POST /api/invoices/{id}/payments` (regular invoice payment)
- `POST /api/pos/checkout` (POS sale)

Re-sending the same key returns the original response instead of creating
duplicates.

## OpenAPI

A complete machine-readable OpenAPI spec is served by the live system at:

```
http://<server>:8765/docs       # Swagger UI
http://<server>:8765/openapi.json   # raw spec
```

## Full route catalogue


### `accounting` (17 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/accounting/accounts` | `accounting:view` |
| `POST` | `/api/accounting/accounts` | `accounting:create` |
| `PUT` | `/api/accounting/accounts/{account_id}` | `accounting:edit` |
| `DELETE` | `/api/accounting/accounts/{account_id}` | `accounting:delete` |
| `GET` | `/api/accounting/journal-entries` | `accounting:view` |
| `GET` | `/api/accounting/journal-entries/{je_id}` | `accounting:view` |
| `POST` | `/api/accounting/journal-entries` | `accounting:create` |
| `POST` | `/api/accounting/journal-entries/{je_id}/reverse` | `accounting:edit` |
| `GET` | `/api/accounting/general-ledger` | `accounting:view` |
| `GET` | `/api/accounting/trial-balance` | `accounting:view` |
| `GET` | `/api/accounting/balance-sheet` | `accounting:view` |
| `GET` | `/api/accounting/income-statement` | `accounting:view` |
| `GET` | `/api/accounting/summary` | `accounting:view` |
| `GET` | `/api/accounting/fiscal-years` | `accounting:view` |
| `POST` | `/api/accounting/fiscal-years/{year}/close` | `accounting:edit` |
| `POST` | `/api/accounting/fiscal-years/{year}/reopen` | `accounting:delete` |
| `POST` | `/api/accounting/fx-revaluation` | `accounting:create` |

### `announcements` (14 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/announcements/` | auth |
| `GET` | `/api/announcements/sent` | `announcements:create` |
| `GET` | `/api/announcements/unread-count` | auth |
| `GET` | `/api/announcements/{aid}` | auth |
| `POST` | `/api/announcements/` | `announcements:create` |
| `PUT` | `/api/announcements/{aid}` | `announcements:edit` |
| `DELETE` | `/api/announcements/{aid}` | `announcements:delete` |
| `POST` | `/api/announcements/{aid}/acknowledge` | auth |
| `GET` | `/api/announcements/{aid}/comments` | auth |
| `POST` | `/api/announcements/{aid}/comments` | auth |
| `DELETE` | `/api/announcements/{aid}/comments/{cid}` | auth |
| `GET` | `/api/announcements/{aid}/audience` | auth |
| `GET` | `/api/announcements/meta/roles` | `announcements:create` |
| `GET` | `/api/announcements/meta/users` | `announcements:create` |

### `approval_policies` (6 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/approval-policies/` | auth |
| `POST` | `/api/approval-policies/` | admin |
| `PUT` | `/api/approval-policies/{policy_id}` | admin |
| `PATCH` | `/api/approval-policies/{policy_id}/toggle` | admin |
| `DELETE` | `/api/approval-policies/{policy_id}` | admin |
| `GET` | `/api/approval-policies/meta/modules` | auth |

### `approval_requests` (8 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/approval-requests/count` | auth |
| `GET` | `/api/approval-requests/` | auth |
| `GET` | `/api/approval-requests/{req_id}` | auth |
| `POST` | `/api/approval-requests/{req_id}/approve` | auth |
| `POST` | `/api/approval-requests/{req_id}/reject` | auth |
| `POST` | `/api/approval-requests/{req_id}/force-approve` | auth |
| `POST` | `/api/approval-requests/{req_id}/cancel` | auth |
| `POST` | `/api/approval-requests/{req_id}/comments` | auth |

### `archives` (2 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/archives/` | `dashboard:view` |
| `PATCH` | `/api/archives/{module}/{item_id}/unarchive` | `dashboard:create` |

### `assets` (12 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/assets` | auth |
| `GET` | `/api/assets/` | `assets:view` |
| `GET` | `/api/assets/summary` | `assets:view` |
| `GET` | `/api/assets/{asset_id}` | `assets:view` |
| `POST` | `/api/assets` | auth |
| `POST` | `/api/assets/` | `assets:create` |
| `PUT` | `/api/assets/{asset_id}` | `assets:edit` |
| `POST` | `/api/assets/{asset_id}/depreciate` | `assets:edit` |
| `POST` | `/api/assets/depreciation/run` | `assets:edit` |
| `POST` | `/api/assets/{asset_id}/dispose` | `assets:edit` |
| `PATCH` | `/api/assets/{asset_id}/archive` | `assets:delete` |
| `PATCH` | `/api/assets/{asset_id}/unarchive` | `assets:edit` |

### `attachments` (4 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/attachments/file/{attachment_id}` | auth |
| `DELETE` | `/api/attachments/file/{attachment_id}` | auth |
| `GET` | `/api/attachments/{entity_type}/{entity_id}` | auth |
| `POST` | `/api/attachments/{entity_type}/{entity_id}` | auth |

### `audit` (2 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/audit/` | admin |
| `DELETE` | `/api/audit/purge` | admin |

### `auth` (5 endpoints)

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/auth/login` | auth |
| `POST` | `/api/auth/logout` | auth |
| `GET` | `/api/auth/me` | auth |
| `POST` | `/api/auth/change-password` | auth |
| `POST` | `/api/auth/force-change-password` | auth |

### `cash` (11 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/cash/drawers` | `cash:view` |
| `POST` | `/api/cash/drawers` | `cash:create` |
| `PUT` | `/api/cash/drawers/{drawer_id}` | `cash:edit` |
| `GET` | `/api/cash/reconciliations` | `cash:view` |
| `GET` | `/api/cash/reconciliations/{rec_id}` | `cash:view` |
| `POST` | `/api/cash/reconciliations` | `cash:create` |
| `POST` | `/api/cash/reconciliations/{rec_id}/movements` | `cash:create` |
| `DELETE` | `/api/cash/reconciliations/{rec_id}/movements/{movement_id}` | `cash:edit` |
| `POST` | `/api/cash/reconciliations/{rec_id}/close` | `cash:edit` |
| `POST` | `/api/cash/reconciliations/{rec_id}/reopen` | `cash:delete` |
| `GET` | `/api/cash/summary` | `cash:view` |

### `clients` (6 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/clients/` | `clients:view` |
| `GET` | `/api/clients/{client_id}` | `clients:view` |
| `POST` | `/api/clients/` | `clients:create` |
| `PUT` | `/api/clients/{client_id}` | `clients:edit` |
| `PATCH` | `/api/clients/{client_id}/archive` | `clients:delete` |
| `PATCH` | `/api/clients/{client_id}/unarchive` | `clients:edit` |

### `crm` (24 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/crm/dashboard` | `crm:view` |
| `GET` | `/api/crm/leads` | `crm:view` |
| `POST` | `/api/crm/leads` | `crm:create` |
| `GET` | `/api/crm/leads/{lead_id}` | `crm:view` |
| `PUT` | `/api/crm/leads/{lead_id}` | `crm:edit` |
| `PATCH` | `/api/crm/leads/{lead_id}/archive` | `crm:delete` |
| `POST` | `/api/crm/leads/{lead_id}/convert` | `crm:edit` |
| `GET` | `/api/crm/contacts` | `crm:view` |
| `POST` | `/api/crm/contacts` | `crm:create` |
| `PUT` | `/api/crm/contacts/{contact_id}` | `crm:edit` |
| `DELETE` | `/api/crm/contacts/{contact_id}` | `crm:delete` |
| `GET` | `/api/crm/activities` | `crm:view` |
| `POST` | `/api/crm/activities` | `crm:create` |
| `PUT` | `/api/crm/activities/{activity_id}` | `crm:edit` |
| `PATCH` | `/api/crm/activities/{activity_id}/done` | `crm:edit` |
| `DELETE` | `/api/crm/activities/{activity_id}` | `crm:delete` |
| `GET` | `/api/crm/deals` | `crm:view` |
| `POST` | `/api/crm/deals` | `crm:create` |
| `PUT` | `/api/crm/deals/{deal_id}` | `crm:edit` |
| `PATCH` | `/api/crm/deals/{deal_id}/stage` | `crm:edit` |
| `PATCH` | `/api/crm/deals/{deal_id}/archive` | `crm:delete` |
| `GET` | `/api/crm/dropdown/clients` | `crm:view` |
| `GET` | `/api/crm/dropdown/quotations` | `crm:view` |
| `GET` | `/api/crm/dropdown/users` | `crm:view` |

### `dashboard` (1 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/dashboard/` | `dashboard:view` |

### `documents` (4 endpoints)

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/documents/` | `quotations:view` |
| `GET` | `/api/documents/` | `quotations:view` |
| `GET` | `/api/documents/{doc_id}/content` | `quotations:view` |
| `DELETE` | `/api/documents/{doc_id}` | `quotations:delete` |

### `finance` (15 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/finance/summary` | `finance:view` |
| `GET` | `/api/finance/range-summary` | `finance:view` |
| `GET` | `/api/finance/range-monthly` | `finance:view` |
| `GET` | `/api/finance/range-detail` | `finance:view` |
| `GET` | `/api/finance/monthly` | `finance:view` |
| `GET` | `/api/finance/expenses` | `expenses:view` |
| `PATCH` | `/api/finance/expenses/{expense_id}/void` | `expenses:delete` |
| `POST` | `/api/finance/expenses` | `expenses:create` |
| `PUT` | `/api/finance/expenses/{expense_id}` | `expenses:edit` |
| `PATCH` | `/api/finance/expenses/{expense_id}/archive` | `expenses:delete` |
| `PATCH` | `/api/finance/expenses/{expense_id}/unarchive` | `expenses:edit` |
| `GET` | `/api/finance/periods` | `finance:view` |
| `POST` | `/api/finance/periods/{year}/{month}/lock` | admin |
| `POST` | `/api/finance/periods/{year}/{month}/unlock` | admin |
| `GET` | `/api/finance/reconciliation` | admin |

### `hr` (29 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/hr/departments` | `hr:view` |
| `POST` | `/api/hr/departments` | `hr:create` |
| `PUT` | `/api/hr/departments/{dept_id}` | `hr:edit` |
| `PATCH` | `/api/hr/departments/{dept_id}/archive` | `hr:delete` |
| `PATCH` | `/api/hr/departments/{dept_id}/unarchive` | `hr:edit` |
| `GET` | `/api/hr/employees` | `hr:view` |
| `GET` | `/api/hr/employees/{emp_id}` | `hr:view` |
| `POST` | `/api/hr/employees` | `hr:create` |
| `PUT` | `/api/hr/employees/{emp_id}` | `hr:edit` |
| `PATCH` | `/api/hr/employees/{emp_id}/archive` | `hr:delete` |
| `PATCH` | `/api/hr/employees/{emp_id}/unarchive` | `hr:edit` |
| `GET` | `/api/hr/leave` | `hr:view` |
| `POST` | `/api/hr/leave` | `hr:create` |
| `PUT` | `/api/hr/leave/{leave_id}` | `hr:edit` |
| `POST` | `/api/hr/leave/{leave_id}/approve` | `hr:approve` |
| `POST` | `/api/hr/leave/{leave_id}/reject` | `hr:approve` |
| `DELETE` | `/api/hr/leave/{leave_id}` | `hr:delete` |
| `GET` | `/api/hr/summary` | `hr:view` |
| `POST` | `/api/hr/employees/{emp_id}/files` | `hr:edit` |
| `GET` | `/api/hr/employees/{emp_id}/files` | `hr:view` |
| `GET` | `/api/hr/files/{file_id}/download` | `hr:view` |
| `DELETE` | `/api/hr/files/{file_id}` | `hr:edit` |
| `GET` | `/api/hr/payroll/runs` | `hr:view` |
| `GET` | `/api/hr/payroll/runs/{run_id}` | `hr:view` |
| `POST` | `/api/hr/payroll/runs` | `hr:create` |
| `PUT` | `/api/hr/payroll/lines/{line_id}` | `hr:edit` |
| `POST` | `/api/hr/payroll/runs/{run_id}/approve` | `hr:approve` |
| `POST` | `/api/hr/payroll/runs/{run_id}/mark-paid` | `hr:approve` |
| `POST` | `/api/hr/payroll/runs/{run_id}/cancel` | `hr:delete` |

### `hr_activities` (9 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/hr-activities` | `hr_activities:view` |
| `GET` | `/api/hr-activities/summary` | `hr_activities:view` |
| `GET` | `/api/hr-activities/{aid}` | `hr_activities:view` |
| `POST` | `/api/hr-activities` | `hr_activities:create` |
| `PUT` | `/api/hr-activities/{aid}` | `hr_activities:edit` |
| `PATCH` | `/api/hr-activities/{aid}/complete` | `hr_activities:edit` |
| `PATCH` | `/api/hr-activities/{aid}/archive` | `hr_activities:delete` |
| `GET` | `/api/hr-activities/dropdown/applicants` | `hr_activities:view` |
| `GET` | `/api/hr-activities/dropdown/employees` | `hr_activities:view` |

### `hr_contracts` (7 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/hr/contracts/` | `hr_contracts:view` |
| `GET` | `/api/hr/contracts/{contract_id}` | `hr_contracts:view` |
| `POST` | `/api/hr/contracts/` | `hr_contracts:create` |
| `PUT` | `/api/hr/contracts/{contract_id}` | `hr_contracts:edit` |
| `POST` | `/api/hr/contracts/{contract_id}/status` | `hr_contracts:edit` |
| `PATCH` | `/api/hr/contracts/{contract_id}/archive` | `hr_contracts:delete` |
| `GET` | `/api/hr/contracts/{contract_id}/print-data` | `hr_contracts:view` |

### `inventory` (13 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/inventory/` | `inventory:view` |
| `GET` | `/api/inventory/categories` | auth |
| `GET` | `/api/inventory/lots` | `inventory:view` |
| `GET` | `/api/inventory/lots/{lot_id}` | `inventory:view` |
| `GET` | `/api/inventory/{item_id}` | `inventory:view` |
| `GET` | `/api/inventory/{item_id}/by-warehouse` | `inventory:view` |
| `GET` | `/api/inventory/{item_id}/movements` | `inventory:view` |
| `POST` | `/api/inventory/` | `inventory:create` |
| `PUT` | `/api/inventory/{item_id}` | `inventory:edit` |
| `PATCH` | `/api/inventory/{item_id}/stock` | `inventory:edit` |
| `POST` | `/api/inventory/{item_id}/deduct-to-project` | `inventory:create` |
| `PATCH` | `/api/inventory/{item_id}/archive` | `inventory:delete` |
| `PATCH` | `/api/inventory/{item_id}/unarchive` | `inventory:edit` |

### `invoices` (10 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/invoices/` | `invoices:view` |
| `GET` | `/api/invoices/{invoice_id}` | `invoices:view` |
| `POST` | `/api/invoices/` | `invoices:create` |
| `PUT` | `/api/invoices/{invoice_id}` | `invoices:edit` |
| `PATCH` | `/api/invoices/{invoice_id}/void` | `invoices:delete` |
| `POST` | `/api/invoices/{invoice_id}/payments` | `invoices:create` |
| `GET` | `/api/invoices/{invoice_id}/payments` | `invoices:view` |
| `DELETE` | `/api/invoices/{invoice_id}/payments/{payment_id}` | `invoices:delete` |
| `PATCH` | `/api/invoices/{invoice_id}/archive` | `invoices:delete` |
| `PATCH` | `/api/invoices/{invoice_id}/unarchive` | `invoices:edit` |

### `manufacturing` (30 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/manufacturing/resources` | `manufacturing:view` |
| `POST` | `/api/manufacturing/resources` | `manufacturing:create` |
| `PUT` | `/api/manufacturing/resources/{res_id}` | `manufacturing:edit` |
| `PATCH` | `/api/manufacturing/resources/{res_id}/archive` | `manufacturing:delete` |
| `PATCH` | `/api/manufacturing/resources/{res_id}/unarchive` | `manufacturing:edit` |
| `GET` | `/api/manufacturing/boms` | `manufacturing:view` |
| `GET` | `/api/manufacturing/boms/{bom_id}` | `manufacturing:view` |
| `GET` | `/api/manufacturing/boms/{bom_id}/versions` | `manufacturing:view` |
| `POST` | `/api/manufacturing/boms` | `manufacturing:create` |
| `PUT` | `/api/manufacturing/boms/{bom_id}` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/boms/{bom_id}/new-version` | `manufacturing:edit` |
| `PATCH` | `/api/manufacturing/boms/{bom_id}/archive` | `manufacturing:delete` |
| `PATCH` | `/api/manufacturing/boms/{bom_id}/unarchive` | `manufacturing:edit` |
| `GET` | `/api/manufacturing/orders` | `manufacturing:view` |
| `GET` | `/api/manufacturing/orders/{order_id}` | `manufacturing:view` |
| `POST` | `/api/manufacturing/orders` | `manufacturing:create` |
| `PUT` | `/api/manufacturing/orders/{order_id}` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/orders/{order_id}/confirm` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/orders/{order_id}/start` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/orders/{order_id}/complete` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/orders/{order_id}/complete-partial` | `manufacturing:edit` |
| `POST` | `/api/manufacturing/orders/{order_id}/cancel` | `manufacturing:edit` |
| `PATCH` | `/api/manufacturing/orders/{order_id}/archive` | `manufacturing:delete` |
| `PATCH` | `/api/manufacturing/orders/{order_id}/unarchive` | `manufacturing:edit` |
| `GET` | `/api/manufacturing/qc` | `manufacturing:view` |
| `GET` | `/api/manufacturing/qc/{qc_id}` | `manufacturing:view` |
| `POST` | `/api/manufacturing/qc/{qc_id}/resolve` | `manufacturing:edit` |
| `GET` | `/api/manufacturing/products` | `manufacturing:view` |
| `GET` | `/api/manufacturing/summary` | `manufacturing:view` |
| `GET` | `/api/manufacturing/analytics` | `manufacturing:view` |

### `notifications` (6 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/notifications/count` | auth |
| `GET` | `/api/notifications/` | auth |
| `PATCH` | `/api/notifications/mark-all-read` | auth |
| `PATCH` | `/api/notifications/{notif_id}/read` | auth |
| `DELETE` | `/api/notifications/clear-read` | auth |
| `DELETE` | `/api/notifications/{notif_id}` | auth |

### `planning` (24 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/planning/projects` | `planning:view` |
| `POST` | `/api/planning/projects` | `planning:create` |
| `GET` | `/api/planning/projects/{pid}` | `planning:view` |
| `PUT` | `/api/planning/projects/{pid}` | `planning:edit` |
| `PATCH` | `/api/planning/projects/{pid}/archive` | `planning:delete` |
| `GET` | `/api/planning/tasks` | `planning:view` |
| `POST` | `/api/planning/tasks` | `planning:create` |
| `GET` | `/api/planning/tasks/{tid}` | `planning:view` |
| `PUT` | `/api/planning/tasks/{tid}` | `planning:edit` |
| `PATCH` | `/api/planning/tasks/{tid}/dates` | `planning:edit` |
| `PATCH` | `/api/planning/tasks/{tid}/status` | `planning:edit` |
| `PATCH` | `/api/planning/tasks/{tid}/progress` | `planning:edit` |
| `PATCH` | `/api/planning/tasks/{tid}/archive` | `planning:delete` |
| `GET` | `/api/planning/milestones` | `planning:view` |
| `POST` | `/api/planning/milestones` | `planning:create` |
| `PUT` | `/api/planning/milestones/{mid}` | `planning:edit` |
| `DELETE` | `/api/planning/milestones/{mid}` | `planning:delete` |
| `GET` | `/api/planning/dropdown/clients` | `planning:view` |
| `GET` | `/api/planning/dropdown/users` | `planning:view` |
| `GET` | `/api/planning/summary` | `planning:view` |
| `GET` | `/api/planning/events` | `planning:view` |
| `POST` | `/api/planning/events` | `planning:create` |
| `PUT` | `/api/planning/events/{eid}` | `planning:edit` |
| `DELETE` | `/api/planning/events/{eid}` | `planning:delete` |

### `pos` (11 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/pos/session/current` | `pos:view` |
| `POST` | `/api/pos/session/open` | `pos:create` |
| `POST` | `/api/pos/session/close` | `pos:edit` |
| `GET` | `/api/pos/sessions` | `pos:view` |
| `GET` | `/api/pos/sessions/{session_id}` | `pos:view` |
| `GET` | `/api/pos/products` | `pos:view` |
| `GET` | `/api/pos/cash-drawers` | `pos:view` |
| `POST` | `/api/pos/checkout` | `pos:create` |
| `GET` | `/api/pos/sales` | `pos:view` |
| `GET` | `/api/pos/sales/{sale_id}` | `pos:view` |
| `POST` | `/api/pos/sales/{sale_id}/return` | `pos:edit` |

### `projects` (8 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/projects/` | `projects:view` |
| `GET` | `/api/projects/{project_id}` | `projects:view` |
| `POST` | `/api/projects/` | `projects:create` |
| `PUT` | `/api/projects/{project_id}` | `projects:edit` |
| `PATCH` | `/api/projects/{project_id}/status` | `projects:edit` |
| `PATCH` | `/api/projects/{project_id}/cancel` | `projects:edit` |
| `PATCH` | `/api/projects/{project_id}/archive` | `projects:delete` |
| `PATCH` | `/api/projects/{project_id}/unarchive` | `projects:edit` |

### `purchases` (9 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/purchases/` | `purchases:view` |
| `GET` | `/api/purchases/stats` | `purchases:view` |
| `GET` | `/api/purchases/{purchase_id}` | `purchases:view` |
| `POST` | `/api/purchases/` | `purchases:create` |
| `PUT` | `/api/purchases/{purchase_id}` | `purchases:edit` |
| `PATCH` | `/api/purchases/{purchase_id}/status` | `purchases:edit` |
| `PATCH` | `/api/purchases/{purchase_id}/archive` | `purchases:delete` |
| `PATCH` | `/api/purchases/{purchase_id}/unarchive` | `purchases:edit` |
| `GET` | `/api/purchases/supplier/{supplier_name}/history` | `purchases:view` |

### `quotations` (9 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/quotations/` | `quotations:view` |
| `GET` | `/api/quotations/{quote_id}` | `quotations:view` |
| `POST` | `/api/quotations/` | `quotations:create` |
| `PUT` | `/api/quotations/{quote_id}` | `quotations:edit` |
| `POST` | `/api/quotations/{quote_id}/convert-to-invoice` | `quotations:create` |
| `POST` | `/api/quotations/{quote_id}/convert-to-project` | `quotations:create` |
| `PATCH` | `/api/quotations/{quote_id}/cancel` | `quotations:edit` |
| `PATCH` | `/api/quotations/{quote_id}/archive` | `quotations:delete` |
| `PATCH` | `/api/quotations/{quote_id}/unarchive` | `quotations:edit` |

### `recruitment` (26 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/recruitment/positions` | `recruitment:view` |
| `GET` | `/api/recruitment/positions/{pos_id}` | `recruitment:view` |
| `POST` | `/api/recruitment/positions` | `recruitment:create` |
| `PUT` | `/api/recruitment/positions/{pos_id}` | `recruitment:edit` |
| `PATCH` | `/api/recruitment/positions/{pos_id}/archive` | `recruitment:delete` |
| `GET` | `/api/recruitment/applicants` | `recruitment:view` |
| `GET` | `/api/recruitment/applicants/{app_id}` | `recruitment:view` |
| `POST` | `/api/recruitment/applicants` | `recruitment:create` |
| `PUT` | `/api/recruitment/applicants/{app_id}` | `recruitment:edit` |
| `POST` | `/api/recruitment/applicants/{app_id}/status` | `recruitment:edit` |
| `PATCH` | `/api/recruitment/applicants/{app_id}/archive` | `recruitment:delete` |
| `POST` | `/api/recruitment/applicants/{app_id}/interviews` | `recruitment:edit` |
| `PUT` | `/api/recruitment/interviews/{interview_id}` | `recruitment:edit` |
| `DELETE` | `/api/recruitment/interviews/{interview_id}` | `recruitment:delete` |
| `POST` | `/api/recruitment/applicants/{app_id}/files` | `recruitment:edit` |
| `GET` | `/api/recruitment/applicants/{app_id}/files` | `recruitment:view` |
| `GET` | `/api/recruitment/files/{file_id}/download` | `recruitment:view` |
| `DELETE` | `/api/recruitment/files/{file_id}` | `recruitment:edit` |
| `POST` | `/api/recruitment/applicants/{app_id}/convert` | `recruitment:edit` |
| `GET` | `/api/recruitment/summary` | `recruitment:view` |
| `GET` | `/api/recruitment/applicants/{app_id}/offers` | `recruitment:view` |
| `POST` | `/api/recruitment/applicants/{app_id}/offers` | `recruitment:create` |
| `PUT` | `/api/recruitment/offers/{offer_id}` | `recruitment:edit` |
| `POST` | `/api/recruitment/offers/{offer_id}/status` | `recruitment:edit` |
| `PATCH` | `/api/recruitment/offers/{offer_id}/archive` | `recruitment:delete` |
| `GET` | `/api/recruitment/offers/{offer_id}/print-data` | `recruitment:view` |

### `recurring` (11 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/recurring-expenses` | auth |
| `GET` | `/api/recurring-expenses/` | `expenses:view` |
| `GET` | `/api/recurring-expenses/{tpl_id}` | `expenses:view` |
| `POST` | `/api/recurring-expenses` | auth |
| `POST` | `/api/recurring-expenses/` | `expenses:create` |
| `PUT` | `/api/recurring-expenses/{tpl_id}` | `expenses:edit` |
| `PATCH` | `/api/recurring-expenses/{tpl_id}/toggle` | `expenses:edit` |
| `POST` | `/api/recurring-expenses/{tpl_id}/run` | `expenses:create` |
| `POST` | `/api/recurring-expenses/run-due` | `expenses:create` |
| `PATCH` | `/api/recurring-expenses/{tpl_id}/archive` | `expenses:delete` |
| `PATCH` | `/api/recurring-expenses/{tpl_id}/unarchive` | `expenses:edit` |

### `reports` (8 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/reports/financial` | `reports:view` |
| `GET` | `/api/reports/projects` | `reports:view` |
| `GET` | `/api/reports/clients` | `reports:view` |
| `GET` | `/api/reports/invoice-aging` | `reports:view` |
| `GET` | `/api/reports/expenses` | `reports:view` |
| `GET` | `/api/reports/pipeline` | `reports:view` |
| `GET` | `/api/reports/vat` | `reports:view` |
| `GET` | `/api/reports/inventory-by-warehouse` | `reports:view` |

### `roles` (7 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/roles/` | admin |
| `GET` | `/api/roles/modules` | admin |
| `GET` | `/api/roles/{role_id}` | admin |
| `POST` | `/api/roles/` | admin |
| `PUT` | `/api/roles/{role_id}` | admin |
| `PUT` | `/api/roles/{role_id}/permissions` | admin |
| `DELETE` | `/api/roles/{role_id}` | admin |

### `search` (1 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/search/` | auth |

### `settings` (14 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/settings/` | auth |
| `PUT` | `/api/settings/` | admin |
| `GET` | `/api/settings/exchange-rate` | auth |
| `POST` | `/api/settings/exchange-rate` | admin |
| `GET` | `/api/settings/logo` | auth |
| `POST` | `/api/settings/logo` | admin |
| `GET` | `/api/settings/backup` | admin |
| `GET` | `/api/settings/backup-status` | admin |
| `POST` | `/api/settings/backup-now` | admin |
| `POST` | `/api/settings/backup-export` | admin |
| `POST` | `/api/settings/restore` | admin |
| `GET` | `/api/settings/setup-status` | auth |
| `POST` | `/api/settings/complete-setup` | auth |
| `GET` | `/api/settings/integrity-check` | admin |

### `suppliers` (6 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/suppliers/` | `suppliers:view` |
| `GET` | `/api/suppliers/{supplier_id}` | `suppliers:view` |
| `POST` | `/api/suppliers/` | `suppliers:create` |
| `PUT` | `/api/suppliers/{supplier_id}` | `suppliers:edit` |
| `PATCH` | `/api/suppliers/{supplier_id}/archive` | `suppliers:delete` |
| `PATCH` | `/api/suppliers/{supplier_id}/unarchive` | `suppliers:edit` |

### `tax_rates` (4 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/tax-rates/` | auth |
| `POST` | `/api/tax-rates/` | admin |
| `PUT` | `/api/tax-rates/{rate_id}` | admin |
| `DELETE` | `/api/tax-rates/{rate_id}` | admin |

### `users` (10 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/users/` | admin |
| `GET` | `/api/users/sessions` | admin |
| `GET` | `/api/users/online` | admin |
| `DELETE` | `/api/users/sessions/{session_id}` | admin |
| `GET` | `/api/users/{user_id}` | admin |
| `POST` | `/api/users/` | admin |
| `PUT` | `/api/users/{user_id}` | admin |
| `POST` | `/api/users/{user_id}/reset-password` | admin |
| `PATCH` | `/api/users/{user_id}/toggle-active` | admin |
| `DELETE` | `/api/users/{user_id}` | admin |

### `warehouses` (17 endpoints)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/warehouses/` | auth |
| `POST` | `/api/warehouses/` | `warehouses:create` |
| `GET` | `/api/warehouses/{wid}` | auth |
| `PUT` | `/api/warehouses/{wid}` | `warehouses:edit` |
| `POST` | `/api/warehouses/{wid}/set-default` | `warehouses:edit` |
| `PATCH` | `/api/warehouses/{wid}/archive` | `warehouses:delete` |
| `GET` | `/api/warehouses/{wid}/access` | `warehouses:view` |
| `POST` | `/api/warehouses/{wid}/access` | `warehouses:edit` |
| `DELETE` | `/api/warehouses/{wid}/access/{user_id}` | `warehouses:edit` |
| `GET` | `/api/warehouses/me/accessible` | auth |
| `GET` | `/api/warehouses/transfers/` | auth |
| `GET` | `/api/warehouses/transfers/{tid}` | auth |
| `POST` | `/api/warehouses/transfers/` | `warehouses:create` |
| `POST` | `/api/warehouses/transfers/{tid}/dispatch` | `warehouses:edit` |
| `POST` | `/api/warehouses/transfers/{tid}/receive` | `warehouses:edit` |
| `POST` | `/api/warehouses/transfers/{tid}/cancel` | `warehouses:delete` |
| `GET` | `/api/warehouses/{wid}/stock` | auth |