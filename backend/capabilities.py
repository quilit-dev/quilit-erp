"""
Module licensing graph — what a customer buys, and what that implies.

Why this exists
---------------
Modules are not independent products. `quotations` converts INTO an invoice;
`pos` writes an invoice, moves stock and touches a cash drawer; `projects`
reads invoices and expenses. Selling them a la carte therefore produces
combinations that cannot work: "Quotations without Invoices" has no meaning,
and "POS without Inventory" cannot decrement stock.

Left unguarded that does not crash — every tenant schema has every table — it
degrades. The customer sees links into modules they are not licensed for and
gets 403s, which reads as a broken product rather than an unbought one.

So a purchased set is expanded to its TRANSITIVE CLOSURE before it is stored
or enforced: buy `pos`, automatically receive `invoices`, `inventory`, `cash`
and `clients`. Invalid combinations become unrepresentable rather than
merely discouraged.

The dependency edges below were derived from the actual cross-module table
reads in `routers/` (see `_REQUIRES` notes), not from intuition.
"""
# Always licensed. Two distinct reasons:
#   * dashboard/users/roles/settings/audit — platform plumbing, gated by
#     require_admin rather than by the paywall.
#   * accounting — the general-ledger ENGINE. Seven modules post entries to it
#     (invoices, pos, purchases, assets, cash, finance, hr payroll). Disabling
#     it would silently corrupt a customer's books the day they did buy it,
#     so the engine always runs; what is sold is the accounting SURFACE
#     (chart of accounts, journals, statements, period close).
ALWAYS_ON = frozenset({
    "dashboard", "users", "roles", "settings", "audit", "accounting",
})

# module -> modules it cannot function without.
_REQUIRES = {
    # Sales chain. quotations' whole purpose is converting to an invoice.
    "quotations":    {"clients", "invoices"},
    "invoices":      {"clients"},
    # POS writes an invoice + payment, decrements stock, and settles into a
    # cash drawer.
    "pos":           {"clients", "invoices", "inventory", "cash"},
    # Daily till reconciliation reads invoices and expenses.
    "cash":          {"invoices", "finance"},
    # Supply chain.
    "purchases":     {"inventory", "suppliers"},
    "manufacturing": {"inventory"},
    "warehouses":    {"inventory"},
    # Delivery. Projects track budget vs actual: invoices in, expenses out.
    "projects":      {"clients", "invoices", "finance"},
    "planning":      {"clients"},
    # CRM deals are quoted.
    "crm":           {"clients", "quotations"},
    # Finance surface.
    "expenses":      {"finance"},
    "assets":        {"finance"},
    # People. Each of these hangs off the employee record.
    "recruitment":   {"hr"},
    "hr_contracts":  {"hr"},
    "hr_activities": {"hr"},
    # `reports` deliberately requires nothing: it renders whatever the tenant
    # is licensed for, so it must never be the reason another module is pulled
    # in (nor be blocked itself).
}

# The canonical module list lives in permissions.py, but importing it here at
# module scope would transitively import database.py — which calls init_db() at
# import time. A pure data/graph module must not have that side effect (it also
# broke pytest collection), so the list is resolved lazily and cached.
_KNOWN_CACHE = None


def _known():
    global _KNOWN_CACHE
    if _KNOWN_CACHE is None:
        from permissions import MODULES, ADMIN_MODULES
        _KNOWN_CACHE = set(MODULES) | set(ADMIN_MODULES)
    return _KNOWN_CACHE


def known_module(key: str) -> bool:
    return key in _known()


def direct_requirements(module: str) -> set:
    """Modules `module` directly depends on (one hop, no closure)."""
    return set(_REQUIRES.get(module, ()))


def resolve(selected) -> set:
    """Expand a purchased set to everything it needs to actually work.

    Returns the transitive closure of `selected` plus ALWAYS_ON. Unknown keys
    are dropped rather than raising: a stale plan naming a module that no
    longer exists should degrade, not take a tenant offline.
    """
    known = _known()
    out = {m for m in (selected or ()) if m in known} | set(ALWAYS_ON)
    # Iterate to a fixed point — dependencies have dependencies (pos -> cash
    # -> finance).
    while True:
        grown = set(out)
        for module in out:
            grown |= {d for d in direct_requirements(module) if d in known}
        if grown == out:
            return out
        out = grown


def required_by(module: str, selected) -> set:
    """Which of the customer's chosen modules force `module` to stay on.

    Drives the UI: a dependency is shown locked, with this set naming exactly
    why, so "Inventory" is never mysteriously un-uncheckable — it says
    "required by Point of Sale".
    """
    if module in ALWAYS_ON:
        return set()
    chosen = {m for m in (selected or ()) if m in _known() and m != module}
    return {c for c in chosen if module in resolve({c})}


def lock_reasons(selected) -> dict:
    """{module: [modules that require it]} for everything currently locked.

    Anything with a non-empty entry must render as checked-and-disabled.
    """
    resolved = resolve(selected)
    reasons = {}
    for module in resolved:
        if module in ALWAYS_ON:
            continue
        forced_by = required_by(module, selected)
        if forced_by and module not in set(selected or ()):
            reasons[module] = sorted(forced_by)
        elif forced_by:
            reasons[module] = sorted(forced_by)
    return reasons


def catalog() -> list:
    """The sellable module list with its dependency metadata, for the console."""
    return [
        {
            "key": m,
            "always_on": m in ALWAYS_ON,
            "requires": sorted(direct_requirements(m)),
        }
        for m in sorted(_known())
    ]
