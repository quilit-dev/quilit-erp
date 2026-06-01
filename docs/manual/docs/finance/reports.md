# Reports

The analytics surface. Eight built-in reports cover Financial, Aging, VAT,
Pipeline, Inventory-by-Warehouse, and per-project / per-client breakdowns.
Each is exportable to Excel.

## Purpose

Reports answer **specific business questions** with the data the system
already has:

| Report | Question it answers |
|---|---|
| **Financial** | Cash-basis P&L over a period, with monthly breakdown |
| **Projects** | Margin per project, time to complete, budget vs. actual |
| **Clients** | Top customers by lifetime value, last activity |
| **Invoice Aging** | Where's the A/R sitting (current / 30/60/90/90+ days) |
| **Expenses** | Per-category, per-project, per-month breakdown |
| **Pipeline** | CRM funnel: leads, deals, conversion rates by source |
| **VAT** | Output / input VAT by rate, net VAT due |
| **Inventory by Warehouse** | Per-warehouse SKU count, quantity, value (Phase 3 add) |

## Personas

| Persona | What they read |
|---|---|
| **Owner / CEO** | Financial, Projects, Pipeline |
| **Finance Manager** | All of them, especially Aging + VAT for cash-flow planning |
| **Accountant** | Financial, Expenses, VAT — for the tax return |
| **Sales Manager** | Clients, Pipeline |
| **Operations Manager** | Inventory by Warehouse, Projects |
| **Auditor** | All — each is a useful corroboration |

## Quick reference

- **Date range picker** at the top: presets (This Month / Last Month / This
  Quarter / This Year / YTD / Last 30 Days / Custom)
- **Per-report tabs** — switch between reports without losing the date range
- **Excel export** — every report has an "Export" button → XLSX

---

=== "Operator's view"

    ### Setting the date range

    All reports honour the date range you pick at the top. Defaults to
    **This Month**. Pick a preset or "Custom" for a specific window.

    Click **Apply** — every visible report reloads.

    ### Financial Report

    The headline. For the selected period:

    - Total income (cash-basis from `invoice_payments.amount`)
    - Total expenses (from `expenses.amount`)
    - Net profit
    - Profit margin
    - 12-month bar chart (income vs. expenses)
    - Top 10 paying clients
    - Top expense categories

    Use case: monthly board pack, owner briefing.

    ### Projects Report

    Per-project rows:

    | Column | What |
    |---|---|
    | Project | Name |
    | Client | Owner |
    | Status | Quotation Sent / Active / Invoiced / Completed |
    | Estimated cost | Budget at start |
    | Actual cost | What you've spent (expenses + materials) |
    | Expected revenue | What you quoted |
    | Billed | Sum of issued invoices |
    | Margin | (revenue − cost) |

    Filter by status. Use case: project review meetings.

    ### Clients Report

    Lifetime value per client:

    - Total billed
    - Total received
    - Open A/R
    - Last activity date

    Use case: top-customer recognition, A/R follow-up.

    ### Invoice Aging

    Open A/R bucketed by days overdue:

    - Current (not yet due)
    - 1-30 days overdue
    - 31-60
    - 61-90
    - 90+

    Per-client breakdown showing which customers owe what in each bucket.
    Use case: collection prioritisation.

    ### Expenses Report

    Breakdown over the period:

    - By category (14 standard categories)
    - By project
    - By month (12-month trend)

    Use case: cost-control review, budget vs. actual.

    ### Pipeline Report

    From CRM:

    - Deals by stage (count + value)
    - Win rate
    - Pipeline value (weighted by probability)
    - Sales cycle length
    - By source (referral / website / cold-call)

    Use case: sales review.

    ### VAT Report

    Per-rate breakdown for the period:

    - Output VAT (sales) per rate
    - Input VAT (purchases) per rate
    - Net VAT due (output − input)
    - Monthly trend

    Use case: VAT filing.

    ### Inventory by Warehouse Report

    Phase 3 addition. Per-warehouse:

    - SKU count
    - Quantity total
    - Value (qty × unit_cost)
    - Top 25 SKUs by value with their primary location

    Use case: warehouse manager review, capital concentration analysis.

=== "Administrator's view"

    ### Permissions

    | Role | view |
    |---|---|
    | Finance Manager | ✅ all |
    | Accountant | ✅ all |
    | Owner | ✅ all |
    | Sales Manager | ✅ Pipeline, Clients |
    | Operations Manager | ✅ Inventory, Projects, Expenses |
    | Auditor | ✅ all |

    No create/edit/delete on reports — they're derived views.

    ### Data sources

    Each report reads from existing operational tables — no separate
    `reports` table or batch-computed denormalised view:

    | Report | Primary source |
    |---|---|
    | Financial | `invoice_payments`, `expenses` |
    | Projects | `projects` + joins to `invoices`, `expenses` |
    | Clients | `clients` + joins to `invoices`, `invoice_payments` |
    | Aging | `invoices` + `invoice_payments` |
    | Expenses | `expenses` |
    | Pipeline | `crm_leads`, `crm_deals` |
    | VAT | `invoices`, `invoice_items`, `purchases` |
    | Inventory by WH | `inventory_stock`, `inventory`, `warehouses` |

    Real-time → numbers change as fast as operators record events.

    ### Excel export

    Each report's Export button packs the visible filter into an XLSX with
    multiple sheets (e.g. by-warehouse + top-skus). The export uses the
    SheetJS library bundled with the frontend.

=== "Auditor's view"

    Each report ties back to underlying tables. Spot-check with SQL:

    ### Financial Report cross-check

    The numbers should match the cash-basis Finance dashboard for the
    same period:

    ```sql
    SELECT
      (SELECT SUM(amount) FROM invoice_payments
       WHERE strftime('%Y-%m', paid_at) = '2026-05') AS revenue,
      (SELECT SUM(amount) FROM expenses
       WHERE strftime('%Y-%m', date) = '2026-05'
         AND deleted_at IS NULL AND voided_at IS NULL
         AND status = 'Recorded') AS expenses;
    ```

    ### Aging Report bucket arithmetic

    Verify the system's bucketing matches independent calculation:

    ```sql
    SELECT
      CASE
        WHEN julianday('now') - julianday(i.due_date) <= 0 THEN 'Current'
        WHEN julianday('now') - julianday(i.due_date) <= 30 THEN '1-30 days'
        WHEN julianday('now') - julianday(i.due_date) <= 60 THEN '31-60 days'
        WHEN julianday('now') - julianday(i.due_date) <= 90 THEN '61-90 days'
        ELSE '90+ days'
      END AS bucket,
      ROUND(SUM(i.amount - COALESCE(p.paid, 0)), 2) AS open_ar
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid
               FROM invoice_payments GROUP BY invoice_id) p
      ON p.invoice_id = i.id
    WHERE i.deleted_at IS NULL AND i.voided_at IS NULL
      AND (i.amount - COALESCE(p.paid, 0)) > 0.01
    GROUP BY bucket;
    ```

    ### VAT Report self-balancing check

    Net VAT due = Output VAT collected − Input VAT paid. The Net VAT for
    the period should match the change in `2100 VAT Payable` over the
    same period:

    ```sql
    -- VAT Payable closing balance (from GL)
    SELECT
      SUM(jel.credit) - SUM(jel.debit) AS vat_payable_balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts a ON a.id = jel.account_id
    WHERE a.code = '2100' AND je.status = 'posted'
      AND je.entry_date <= '2026-05-31';
    ```

    Compare to the Net VAT in the report — they should agree at month-end.

---

## API surface

| Endpoint | Returns |
|---|---|
| `GET /api/reports/financial` | Financial report (with optional `start`, `end`) |
| `GET /api/reports/projects` | Per-project margin |
| `GET /api/reports/clients` | Per-client lifetime |
| `GET /api/reports/invoice-aging` | Aging buckets |
| `GET /api/reports/expenses` | Expense breakdown |
| `GET /api/reports/pipeline` | CRM funnel |
| `GET /api/reports/vat` | Output / input VAT |
| `GET /api/reports/inventory-by-warehouse` | Per-warehouse SKU + qty + value |

All endpoints accept a date range via query params (`start`, `end`,
ISO 8601).

## What's NOT supported

- Custom report builder. The list is fixed; for ad-hoc analytics, export
  the underlying data and use Excel.
- Scheduled report email. Reports are pull (user-initiated), not push.
- Drill-down chart drill-up. Charts are static SVG — no zoom-and-pan.
- Cross-report joins (e.g. "show me clients filtered to a specific VAT
  rate"). Each report stands alone.
