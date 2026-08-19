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

**Book value** — Fixed asset's cost minus depreciation so far.

## C

**Cash basis** — Accounting method that recognises revenue on receipt and
expenses on payment. The system's Finance dashboard uses this. Contrast
with **accrual basis**.

**Chart of Accounts (COA)** — The catalogue of all GL accounts with their
type, normal balance, and code. 32 seeded accounts ship with the system.

**COGS (Cost of Goods Sold)** — Direct cost of items sold. Account 5000.
Posted on every sale of a stock-backed item via `DR COGS / CR Inventory`.

**Cost layer** — In FIFO/LIFO costing, a per-receipt batch with its own
unit cost. Drawn down as items are consumed.

## D

**Default warehouse** — The warehouse the system uses when no
warehouse is specified on a stock-touching operation. Either the
user's personal default (each person's own default warehouse) or the company
default warehouse.

**Depreciation** — Spreading a fixed asset's cost over its useful life.
The system supports straight-line ((cost − salvage value) ÷ life in months).

## E

**EOS (End-of-Service indemnity)** — Lebanese statutory severance pay.
Set on each offer.

**Expected cash** — At session/reconciliation close: the opening float +
cash-in − cash-out`, computed per currency.

## F

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

**Journal entry** — One balanced posting, always two lines or more.
Identified by entry number like `JE-2026-00142`.

## L

**Landed cost** — Total cost of a purchased item including the unit cost
plus additional costs (shipping, customs, handling).

**LBP (Lebanese Pound)** — Secondary tender currency. Stored on its own
GL account (1010 Cash — LBP).

**LIFO (Last In First Out)** — Costing method drawing newest cost layers
first.

**Lot** — Identifiable batch of inventory, optionally with manufacture date
+ expiry date. Tracked separately when the item has lot tracking switched on.

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

**Per-warehouse stock** — how much of an item a given warehouse holds.
The sum of the quantity in that warehouse across warehouses equals the
the item's company-wide total.

**Period lock** — the month's lock date flag. Once set, no new
journal entry can post with entry date in that month.

**Perpetual inventory** — Accounting model where stock movements
continuously update the Inventory account. Contrast with periodic
inventory (where a count is done quarterly).

**PO (Purchase Order)** — A purchase recorded in the system. Lifecycle:
`Ordered → Received → Paid`.

**POS** — Point of Sale. Over-the-counter selling fast-path.

**Probation period** — Initial weeks/months of a new employment, set on
contracts. Captured in the contract's probation end date.

## R

**Role** — What a person is allowed to do. Each user
has one role; each role has per-module per-action grants.

**Reservation** — Stock earmarked for a confirmed production order.
the warehouse's reserved quantity tracks it. Released on MO complete
or cancel.

**Reversal** — A new entry that mirrors an existing one (debits ↔ credits)
to cancel its effect while keeping both in the history.

## S

**SKU (Stock-Keeping Unit)** — A unique inventory item. The system uses
"item" and "SKU" interchangeably.

**Snapshot** — A frozen capture of values at a point in time. Tax rates
are snapshotted per-line; period totals are snapshotted in
period snapshots; cost layers carry per-receipt cost snapshots.

**Source-event** — What caused an entry. Identified by
the document each journal entry came from.

**Spot rate** — The current LBP-per-USD exchange rate. The most recent entry in
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
