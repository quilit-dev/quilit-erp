# Chart of Accounts

The 30 seeded accounts plus what posts to each. Generated from the live
database — these are the codes the GL engine actually uses.

## At a glance

| Range | Section | Account count |
|---|---|---|
| 1000-1599 | Assets | 6 |
| 2000-2299 | Liabilities | 3 |
| 3000-3999 | Equity | 2 |
| 4000-4999 | Income | 3 |
| 5000-5999 | Cost of Goods Sold | 1 |
| 6000-6999 | Operating + Other Expenses | 15 |

## Full table

### Assets (debit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `1000` | Cash & Bank | Current Asset | USD cash + bank balances; default cash account |
| `1010` | Cash — LBP | Current Asset | LBP cash holdings |
| `1100` | Accounts Receivable | Current Asset | Informational — system runs cash-basis |
| `1200` | Inventory | Current Asset | Perpetual inventory — purchases DR here, sales DR COGS CR here |
| `1500` | Fixed Assets | Non-Current Asset | Capital register at acquisition cost |
| `1510` | Accumulated Depreciation | Contra Asset (credit-normal) | Auto-posted monthly from the monthly depreciation run |

### Liabilities (credit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `2000` | Accounts Payable | Current Liability | Informational |
| `2100` | VAT Payable | Current Liability | Tax engine credits on output VAT; debits on input VAT |
| `2200` | Payroll Liabilities | Current Liability | NSSF / PAYE accruals (informational) |

### Equity (credit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `3000` | Owner's Equity | Equity | Capital contributions (posted by hand) |
| `3900` | Retained Earnings | Equity | Year-end closing target — receives net income |

### Income (credit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `4000` | Sales Revenue | Operating Income | Every invoice payment + every POS sale |
| `4900` | Other Income | Other Income | Asset disposal gains |
| `4910` | Foreign Exchange Gain | Other Income | FX revaluation gains |

### Cost of Goods Sold (debit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `5000` | Cost of Goods Sold | Cost of Sales | Debited on every sale of an item you hold in stock |

### Operating Expenses (debit-normal)

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `6000` | Salaries & Wages | Operating Expense | Payroll, when marked paid, in either currency |
| `6100` | Rent | Operating Expense | Expense category `Rent` |
| `6200` | Utilities | Operating Expense | Expense category `Utilities` |
| `6300` | Depreciation Expense | Operating Expense | Per-asset monthly auto-post |
| `6400` | Materials | Operating Expense | Project material consumption |
| `6500` | Labour | Operating Expense | Expense category `Labour` |
| `6600` | Equipment | Operating Expense | Expense category `Equipment` |
| `6700` | Transport | Operating Expense | Expense category `Transport` |
| `6800` | Subcontractor | Operating Expense | Expense category `Subcontractor` |
| `6850` | Insurance | Operating Expense | Expense category `Insurance` |
| `6860` | Subscriptions | Operating Expense | Expense category `Subscription` |
| `6870` | Permits & Fees | Operating Expense | Expense category `Permits` |
| `6900` | General & Other Expense | Operating Expense | Default for uncategorised; asset disposal losses |
| `6910` | Cash Short & Over | Operating Expense | Till variances when a drawer is counted |

### Other Expense

| Code | Name | Subtype | Used by |
|---|---|---|---|
| `6920` | Foreign Exchange Loss | Other Expense | FX revaluation losses |

## Source-event → account map

For each business event, which accounts get hit:

| Event | DR | CR |
|---|---|---|
| Invoice payment (USD) | 1000 Cash | 4000 Revenue |
| Invoice payment (LBP) | 1010 Cash — LBP | 4000 Revenue |
| POS sale (USD) | 1000 + 5000 COGS | 4000 + 1200 Inventory |
| POS sale (LBP) | 1010 + 5000 COGS | 4000 + 1200 Inventory |
| Purchase receipt | 1200 Inventory | 1000 Cash |
| Expense (any category) | 6xxx (per category) | 1000 Cash |
| Payroll paid | 6000 Salaries | 1000 + 1010 (per currency) |
| Asset depreciation | 6300 Depreciation Exp | 1510 Accumulated Depr |
| Asset disposal — gain | 1000 Cash | 4900 Other Income |
| Asset disposal — loss | 6900 General Expense | 1000 Cash |
| Cash variance — short | 6910 Cash Short & Over | 1000 or 1010 |
| Cash variance — over | 1000 or 1010 | 6910 Cash Short & Over |
| FX revaluation — gain | 1010 Cash — LBP | 4910 FX Gain |
| FX revaluation — loss | 6920 FX Loss | 1010 Cash — LBP |
| Fiscal year close | All Income + Expense accounts | 3900 Retained Earnings |
| Posted by hand | Operator's choice | Operator's choice |

## Reversed-by convention

A reversal entry mirrors the original (debits ↔ credits). The original's
reversed by points to the reversal's id; the reversal's reverses id
points back. Both remain visible. There is no edit / delete on
posted entries.

## Adding custom accounts

Allowed for the customer-specific extensions — e.g. distinct sub-accounts
for "Bank A" vs "Bank B" if the customer wants per-bank GL granularity.

Constraints:

- Code must be unique (not collide with seeded 1000-6920)
- `type` ∈ `{Asset, Liability, Equity, Income, Expense}`
- normal balance consistent with type
- Accounts you add yourself are yours to edit or remove

Custom accounts can have their name + description edited; they cannot be
deleted once they've received any journal entry.

## Account-code prefixes (memo)

The numeric scheme isn't enforced by the engine — just a convention:

| Prefix | Convention |
|---|---|
| `1xxx` | Assets (debit-normal) |
| `2xxx` | Liabilities (credit-normal) |
| `3xxx` | Equity (credit-normal) |
| `4xxx` | Income (credit-normal) |
| `5xxx` | Cost of Goods Sold (debit-normal) |
| `6xxx` | Expenses (debit-normal) |
| `15xx` | Long-lived assets (range within 1xxx for fixed assets) |
| `49xx` | Non-operating income (within 4xxx) |
| `69xx` | Non-operating expense (within 6xxx) |

Custom accounts should follow this pattern so future extensions remain
intuitive.
