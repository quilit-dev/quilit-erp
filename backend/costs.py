"""
Hiding what stock cost to buy, from staff who only need what it sells for.

A shop floor works in unit PRICE. What an item cost the business is a different
number, and an owner may reasonably not want it on every screen a cashier or a
salesperson opens. The RBAC is module x action, so there is no field-level
permission to hang this on — `costs` is therefore a permission key of its own
(see permissions.MODULES), read with `permissions.can`, and used to shape
responses rather than refuse them.

Stripping happens on the SERVER. The inventory list is a `SELECT i.*`, so
`unit_cost` rides along in the JSON whether or not React draws a column for it;
hiding it in the browser would leave it one devtools panel away, which is not
hiding. The one list of field names lives here rather than being spelled out at
each call site, because the failure mode of scattering it is that one endpoint
quietly keeps returning cost and nobody notices.

What this deliberately does NOT do
----------------------------------
The general ledger is left alone. A trial balance with account 5000 suppressed
does not balance, and an unbalanced trial balance is worse than a visible cost
figure — so anyone holding `accounting:view` can still see COGS in aggregate,
and the seeded matrix gives those roles `costs:view` to match rather than
pretending otherwise.

Cost also remains derivable by anyone who can see both a sale and its margin.
This raises the wall from "a column on screen" to "reconstruct it deliberately
with finance access". That is the honest description of what it buys.
"""
import permissions

# Every column across the schema that states, or trivially yields, what
# something cost. `actual_cost`/`estimated_cost` are project roll-ups and
# `total_cost`/`materials_cost` are production roll-ups: aggregates, but of
# purchase costs, so they belong here too.
COST_FIELDS = frozenset({
    "unit_cost",
    "avg_cost",
    "cost",
    "cost_total",
    "line_cost",
    "landed_cost",
    "additional_costs",
    "parts_cost",
    "materials_cost",
    "labor_cost",
    "machine_cost",
    "electricity_cost",
    "overhead_cost",
    "operation_cost",
    "scrap_cost",
    "total_cost",
    "actual_cost",
    "estimated_cost",
    "acquisition_cost",
    "cogs_total",
    # Stock valuation is quantity x unit cost, so a value column divides
    # straight back out to the cost it was meant to conceal.
    "value",
    "stock_value",
    "total_value",
})


def visible(user, db) -> bool:
    """May this user see cost prices?"""
    return permissions.can(user, db, "costs", "view")


# Figures that are not cost but hand it straight back when they sit beside the
# revenue in the same response. A project detail carrying `expected_profit` and
# `expected_revenue` states its budget by subtraction, so stripping only
# `estimated_cost` hides the column and not the number.
#
# Kept per-call-site rather than in COST_FIELDS because these names are generic:
# `total_expenses` on a finance report is the report, not a leak.
PROJECT_DERIVED = frozenset({
    "budget_remaining",
    "expected_profit",
    "margin_pct",
    "total_expenses",
})


def strip(data, user, db, extra=None):
    """Remove cost fields from a response unless the user may see them.

    Accepts a dict, a list of dicts, or anything else (returned untouched), so
    a call site can wrap its return value without first working out its shape.
    Nested dicts and lists are walked, because several endpoints return a
    record with its lines attached.

    `extra` adds field names for this call site only — figures that are not
    cost in general but yield it in the shape this particular endpoint returns.

    Rows are copied rather than mutated: several handlers build their response
    from sqlite3.Row objects converted once and reused, and mutating in place
    has a habit of emptying a cache somebody else is reading.
    """
    if visible(user, db):
        return data
    return _strip(data, COST_FIELDS | frozenset(extra or ()))


def _strip(data, fields):
    if isinstance(data, dict):
        return {k: _strip(v, fields) for k, v in data.items() if k not in fields}
    if isinstance(data, (list, tuple)):
        return [_strip(v, fields) for v in data]
    return data
