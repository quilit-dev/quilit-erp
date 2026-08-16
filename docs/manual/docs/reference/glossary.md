# Glossary

Business and technical terms used throughout the manual. Sorted
alphabetically; mouse over a term in another page to deep-link here (in
future versions).

## A

**Accrual basis** — Accounting method that recognises revenue when *earned*
and expenses when *incurred*, regardless of cash flow timing. The system's
Accounting GL operates on this basis. Contrast with **cash basis**.

**Approval policy** — A rule that gates a business action (e.g. expense >
$5K) behind one or more human approvers. Configured in Approval Policies;
fires when a triggering action happens.

**A/R aging** — Accounts Receivable bucketed by days overdue (Current /
1-30 / 31-60 / 61-90 / 90+). Surface for collection prioritisation.

**Audit log** — Append-only the audit trail table recording every state-changing
operation with user, `action`, `module`, the record it refers to, `detail`,
creation date.

## B

**Balance Sheet** — Statement of financial position: Assets = Liabilities +
Equity + Net Income, "as of" a specific date.

**BOM (Bill of Materials)** — Recipe defining components + resources +
operations needed to produce one unit of a manufactured item.

**Book value** — Fixed asset's `acquisition_cost − accumulated_depreciation`.

## C

**Cash basis** — Accounting method that recognises revenue on receipt and
expenses on payment. The system's Finance dashboard uses this. Contrast
with **accrual basis**.

**Chart of Accounts (COA)** — The catalogue of all GL accounts with their
type, normal balance, and code. 30 seeded accounts ship with the system.

**COGS (Cost of Goods Sold)** — Direct cost of items sold. Account 5000.
Posted on every sale of a stock-backed item via `DR COGS / CR Inventory`.

**Cost layer** — In FIFO/LIFO costing, a per-receipt batch with its own
unit cost. Drawn down as items are consumed.

## D

**Default warehouse** — The warehouse the system uses when no
warehouse is specified on a stock-touching operation. Either the
user's personal default (`users.default_warehouse_id`) or the company
default (`warehouses.is_default = 1`).

**Depreciation** — Spreading a fixed asset's cost over its useful life.
The system supports straight-line (`(cost − salvage) / useful_life_months`).

## E

**EOS (End-of-Service indemnity)** — Lebanese statutory severance pay.
Configurable on each recruitment offers row.

**Expected cash** — At session/reconciliation close: `opening_balance +
cash-in − cash-out`, computed per currency.

## F

**F-1 through F-9** — The findings from the multi-currency audit
remediation. Each is a specific audit fix applied to the codebase. See
[Multi-currency](../finance/multi-currency.md) for the full reference.

**FEFO (First Expired First Out)** — Costing order for lot-tracked items:
consume the lot expiring soonest first.

**FIFO (First In First Out)** — Costing method drawing oldest cost layers
first.

**Fiscal year** — A 12-month period. The system supports closing
(transfers Income + Expense to Retained Earnings) and reopening
(reverses the closing entry).

**Functional currency** — The single base currency the books are
denominated in. USD here.

**FX gain/loss** — Foreign-exchange revaluation result. Posts to `4910 FX
Gain` (account credit) or `6920 FX Loss` (account debit).

## G

**Gantt** — Visual project schedule with bars per task across a time
axis. Surface in Planning.

**GL (General Ledger)** — The double-entry books — every business event
captured as a balanced journal entry.

## I

**Idempotency** — Property of an operation where repeating it has the same
effect as doing it once. Important for POS checkout and invoice payments
(double-click safety).

**Income Statement** — Revenue − Expense = Net Income, over a period.

**In-service date** — When a fixed asset begins being used. Depreciation
starts from this date.

**Inventory adjustment** — Manual change to stock quantity (count
discrepancy, write-off). Warehouse-specific; writes a stock movements
row.

## J

**JE (Journal Entry)** — One balanced double-entry posting with `≥ 2` lines
in journal entry lines. Identified by entry number like `JE-2026-00142`.

## L

**Landed cost** — Total cost of a purchased item including the unit cost
plus additional costs (shipping, customs, handling).

**LBP (Lebanese Pound)** — Secondary tender currency. Stored on its own
GL account (1010 Cash — LBP).

**LIFO (Last In First Out)** — Costing method drawing newest cost layers
first.

**Lot** — Identifiable batch of inventory, optionally with manufacture date
+ expiry date. Tracked separately when `inventory.lot_tracked = 1`.

## M

**MO (Manufacturing Order / Production Order)** — One run of a BOM with a
specific quantity. Lifecycle: `Draft → Confirmed → In Progress → Completed`.

**Multi-currency revaluation** — Period-end mark-to-market of LBP cash to
the current spot rate. Posts the delta to FX Gain or FX Loss.

## N

**Normal balance** — The side (debit or credit) on which an account
naturally carries a positive balance. Assets/Expenses are debit-normal;
Liabilities/Equity/Income are credit-normal.

**NSSF** — National Social Security Fund (Lebanon). Configurable rate on
payroll computation.

## P

**Per-warehouse stock** — stock per warehouse row per (item, warehouse) pair.
The sum of `inventory_stock.quantity` across warehouses equals the
company-wide `inventory.quantity`.

**Period lock** — `accounting_periods.locked_at` flag. Once set, no new
journal entry can post with entry date in that month.

**Perpetual inventory** — Accounting model where stock movements
continuously update the Inventory account. Contrast with periodic
inventory (where a count is done quarterly).

**PO (Purchase Order)** — A purchase recorded in the system. Lifecycle:
`Ordered → Received → Paid`.

**POS** — Point of Sale. Over-the-counter selling fast-path.

**Probation period** — Initial weeks/months of a new employment, set on
contracts. Captured in `hr_contracts.probation_end_date`.

## R

**Role** — What a person is allowed to do. Each user
has one role; each role has per-module per-action grants.

**Reservation** — Stock earmarked for a confirmed production order.
`inventory_stock.reserved_quantity` tracks it. Released on MO complete
or cancel.

**Reversal** — A new JE that mirrors an existing one (debits ↔ credits)
to cancel its effect while preserving both rows in history.

## S

**SKU (Stock-Keeping Unit)** — A unique inventory item. The system uses
"item" and "SKU" interchangeably.

**Snapshot** — A frozen capture of values at a point in time. Tax rates
are snapshotted per-line; period totals are snapshotted in
period snapshots; cost layers carry per-receipt cost snapshots.

**Source-event** — The business event that originated a JE. Identified by
`(source_type, source_id)` on the journal entries row.

**Spot rate** — Current LBP-per-USD exchange rate. Latest row in
exchange rates.

## T

**Tax rate snapshot** — When a tax rate is applied to a document line,
both the tax rate and the **value of the rate at that moment** are
stored, so future rate changes don't retroactively alter old documents.

**Tender** — The form of payment (cash, card, bank transfer). For cash
payments, the **tender currency** (USD or LBP) is captured separately
from the invoice's USD-denominated `amount`.

**Trial Balance** — Per-account list of debit + credit totals on a
specific date. Must show ✓ Balanced (total debits = total credits) — by
construction.

## W

**Warehouse type** — What kind of warehouse it is: `Main`, `Branch`,
`Production`, `Damaged`, `Transit`, `Returns`. Informational; doesn't
affect logic.

**WMS (Warehouse Management System)** — Bin-level location tracking
within a warehouse. **Not** in scope for this system; warehouses are
atomic locations.
