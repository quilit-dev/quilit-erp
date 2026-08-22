# Multi-currency (USD + LBP)

How the system represents dual-currency operations under one functional
currency (USD), with deliberate provisions for the Lebanese pound (LBP).

## Purpose

The system runs on a **single functional currency** (USD), with LBP fully
supported as a **secondary tender currency**. Every business amount stored
in the database is normalised to USD — but documents capture and preserve
the **actual tender** the operator handled.

This follows the IAS 21 / SME GAAP model. The
remediation closed every gap between the multi-currency UI and the
single-currency books.

## Personas

| Persona | What they care about |
|---|---|
| **Operator** | "I count what I have in pounds; the system handles the conversion." |
| **Administrator** | "Set the rate, designate accounts, run revaluation at period close." |
| **Accountant** | "Every LBP transaction routes to the right cash account; period-end FX adjustment is one click." |
| **Auditor** | "Verify no transaction silently mixed currencies; verify period-end revaluation per IAS 21." |

## Quick reference

- **Functional currency**: USD
- **Foreign currencies accepted**: LBP, EUR
- **Rate format**: units per 1 USD (LBP e.g. 89,000; EUR e.g. 0.92)
- **Rate history**: every rate you set is kept, with who set it and any note
- **Default fallback**: the latest rate **for that currency**
- **A cash account per currency**: `1000 Cash & Bank` (USD), `1010 Cash — LBP`,
  `1020 Cash — EUR`
- **FX gain/loss accounts**: `4910 FX Gain` and `6920 FX Loss`

Each foreign currency has its own cash account for one reason: a balance held
in a currency that is not the functional one has to be marked to the closing
rate, and that is impossible once it has been mixed into the dollars.

---

=== "Operator's view"

    ### Receiving LBP cash from a customer

    Invoice payment screen:
    - Amount: `89000000` (what the customer hands over)
    - Currency: `LBP`
    - Exchange rate: leave blank (falls back to system rate) or override

    The system computes the USD value: 89,000,000 ÷ the rate. For rate 89,000
    that's exactly $1,000. The invoice settles by $1,000 USD.

    The journal post routes the cash to **1010 Cash — LBP** (not 1000).
    LBP cash stays on its own ledger line for future revaluation.

    ### POS LBP tender

    Same model. The cashier types the LBP amount; the system computes the
    USD equivalent for the sale total. The sale's GL post hits 1010.

    ### Paying an LBP-denominated payroll

    If an employee's contract is in LBP (per the currency on their contract),
    payroll resolves their salary at the latest rate at mark-paid time.
    The DR Salaries posts the USD equivalent; the CR side hits 1010 Cash
    — LBP.

    If no exchange rate exists and an LBP contract is in the run,
    the system **refuses to post** rather than silently treating LBP face
    value as USD.

=== "Administrator's view"

    ### Setting the rate

    Settings → **Exchange Rate** → enter the new rate + optional note →
    **Save**.

    Each save adds a new rate. The most recent one
    is the active rate. History is preserved indefinitely.

    | Field | Notes |
    |---|---|
    | Rate | LBP per 1 USD (e.g. 89000) |
    | Note | "Bank rate 2026-05-15", "Customer-negotiated", … |
    | Set by | Auto-captured (set by + set by name) |

    ### When to update the rate

    Practical guidance.

    - Update daily during periods of high volatility
    - Update at least once a week in stable times
    - Update specifically at month-end (before the FX revaluation step
      of [period close](period-close.md))

    ### Period-end FX revaluation

    Once a month, after locking everything else, before the period lock.

    1. Count the physical notes you hold in each foreign currency
    2. Go to **Accounting → FX Revaluation**, enter what you counted for each
       currency and the date, and post
    3. The system marks each currency's cash account to the rate in force on
       that date and posts the difference:
       - the currency weakened → loss → DR 6920 / CR the cash account
       - the currency strengthened → gain → DR the cash account / CR 4910

    Leave a currency blank and it is not touched — only what you counted is
    revalued. Each currency gets its **own** journal entry, so the ledger
    shows which one moved rather than one netted figure covering both.

    The screen shows what the books said, what the notes are worth today, and
    the difference, after posting. The entry cannot be edited afterwards, only
    reversed — so it asks before writing.



    ### The multi-currency accounts

    | Code | Name | Role |
    |---|---|---|
    | 1000 | Cash & Bank | USD cash + bank balances |
    | 1010 | Cash — LBP | LBP cash holdings |
    | 1020 | Cash — EUR | EUR cash holdings |
    | 4910 | Foreign Exchange Gain | Realised + unrealised gains |
    | 6910 | Cash Short & Over | Till variances |
    | 6920 | Foreign Exchange Loss | Realised + unrealised losses |


=== "Auditor's view"

    ### LBP cash routing audit

    Every LBP payment should debit 1010, not 1000.

    posted to should consistently show `1010`. Any `1000` is an older
    transaction (or a bug).

    ### FX revaluation effect

    A revaluation entry should net to zero in the books except for the
    gain/loss recognition.

    Every entry must balance — debits equal credits. The size of the
    delta is the period's recognised FX gain or loss.

    ### Cash — LBP balance vs. physical reality

    At period close after revaluation, `1010 Cash — LBP` balance should
    equal the LBP you counted, divided by the rate.

    the USD value on the books, at the current rate, should equal the LBP you actually hold.

    ### Exchange rate change history

    Inspect for unexpected spikes (potential data-entry error) or stale
    periods (rate not updated for a long time during volatility).

---

## What's NOT supported

- Currencies beyond USD, LBP and EUR. Adding one is a small vendor-level
  change: a cash account, a role pointing at it, and an entry in the
  currency map.
- **Euro at the till.** The register counts dollars and pounds at close, so
  euro is not offered as POS tender — it would create a cash balance nobody
  counts. Euro is taken on invoice payments and on account payments.
- **Buying in euro.** Purchase and product costing accept dollars and pounds.
- Auto-pull live rates from a feed. Manual entry is the supported path —
  reflects the deliberate decision to record the rate the customer
  actually used, not whatever Reuters said.
- **Invoices denominated in a foreign currency.** Sales documents are always
  in USD; the multi-currency layer is at the payment level. A customer who
  owes you €1,000 — rather than owing you dollars and paying in euro — cannot
  be represented, and the difference when the rate moves has nowhere to go.
  See the note below.

---

## Currency Differences — closing a period

**Accounting → Currency Differences.** Every difference the books contain, with
what produced it.

Two kinds, and the screen keeps them apart because they mean different things:

| | What it means |
|---|---|
| **Realised** | The money arrived. An invoice raised at one rate and settled at another brought in more or less cash than the claim was carried at, and the company genuinely has that much more or less. |
| **Unrealised** | Nothing moved. Foreign notes you are holding are worth something different today than when they came in, and that reverses the moment the rate does. |

Adding them into one figure would misstate what the period actually earned, so
the totals are reported separately.

### What a row tells you

Open any row and it walks the chain in the order it happened:

1. **Document** — the invoice, or the account that was revalued
2. **Agreed amount** — the currency and figure the customer agreed
3. **Rate when recognised** — and the value that gave in your own currency
4. **Rate at settlement or revaluation** — and the value at that rate
5. **Difference** — the gap between those two values
6. **Posted as** — the journal entry that carried it, with a link to it

Both rates are shown together in the list for the same reason: the difference
*is* the gap between them, and one without the other says nothing.

### Filtering

Date range, kind (realised or unrealised), currency, gain or loss, customer,
and status — still to review, reviewed, or reversed. **Clear** resets them all.
The list exports to Excel and PDF exactly as shown.

### Marking one reviewed

**This is not an accounting action.** The difference was posted when it arose,
and marking it records that a person has read it — nothing is posted, and the
transaction that produced it is not touched. It can be undone, and it carries
your name, the date, and any note you leave.

The **Still to review** tile is the number you work down to zero at period end.

### What does not appear here

- A settlement at the same rate it was recognised at. Nothing moved, so there
  is nothing to reconcile, and a row reading zero is noise in the one place
  noise is most expensive.
- Supplier differences. Purchase costs convert when they are entered and are
  carried in your own currency from that point, so no difference arises later.

---

## "My customer has an account in euro"

Two different things go by that name, and only one of them is supported.

**They pay in euro; the deal is in dollars.** The invoice says $1,000 and they
hand over €920 at the day's rate. The debt is a dollar debt and the euro is
just the notes. This works: set their **preferred currency** to EUR on the
client record and the payment screen opens in euro. The euro lands in
`1020 Cash — EUR`, and there is no exchange exposure — whatever the euro
converted to at the moment you received it *is* the settlement.

**The debt itself is in euro.** You agreed €1,000 and they owe €1,000 whatever
the dollar does. **This is not supported.** The invoice would be stored as its
dollar equivalent on the day, and when they pay the agreed euro months later at
a different rate it converts to a different dollar figure — so the invoice sits
short forever, or the payment is refused as an overpayment. That gap is a real
exchange gain or loss and there is nowhere in the books to put it.

If that is your arrangement, agree a fixed rate with the customer and invoice
in dollars at that rate. It turns the second case into the first deliberately,
and both sides know what was agreed.
