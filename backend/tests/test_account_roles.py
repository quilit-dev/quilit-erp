"""Which account plays which part.

The chart of accounts is not universal. This one is Anglo-American — 1000 Cash,
1100 Receivable, 4000 Sales. Lebanon's statutory plan puts customers in class 4
and cash in class 5, and the digits do not merely differ: 1 is equity there and
assets here, 4 is third parties there and revenue here. Hardcoding "1100" across
the backend made this chart the only chart a tenant could ever be on.

So postings ask for the account that plays a ROLE, and `account_roles` says which
account that is for this tenant.

The property these tests exist for is that **nothing changed**. The mapping is
seeded with exactly the codes the constants have always used, so an upgraded
install posts to the same accounts it always did. A test that only proved the
indirection works would miss the whole risk.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import accounting


ROLE_TO_CONSTANT = {
    "cash":              "CASH",
    "cash_lbp":          "CASH_LBP",
    "receivable":        "AR",
    "inventory":         "INVENTORY",
    "prepaid":           "PREPAID",
    "accumulated_dep":   "ACC_DEP",
    "payable":           "AP",
    "vat_control":       "VAT_CONTROL",
    "vat_input":         "VAT_CONTROL",
    "vat_output":        "VAT_CONTROL",
    "deferred_revenue":  "DEFERRED_REV",
    "retained_earnings": "RETAINED_EARNINGS",
    "revenue":           "REVENUE",
    "service_revenue":   "SERVICE_REVENUE",
    "fx_gain":           "FX_GAIN",
    "cogs":              "COGS",
    "salaries":          "SALARIES",
    "depreciation":      "DEPRECIATION",
    "other_expense":     "OTHER_EXPENSE",
    "cash_short_over":   "CASH_SHORT_OVER",
    "fx_loss":           "FX_LOSS",
}


# ── Nothing changed ──────────────────────────────────────────────────────────

@_pytest.mark.parametrize("role,const", sorted(ROLE_TO_CONSTANT.items()))
def test_every_role_resolves_to_the_account_it_always_used(db, role, const):
    """The safety property. An upgraded install must post to the same accounts
    it posted to yesterday — the indirection is the point, not a re-think of
    which account does what."""
    assert accounting.code(db, role) == getattr(accounting, const)


def test_the_seeded_mapping_covers_every_role(db):
    """A role with no row falls back to its constant, which is safe but silent.
    The seed should not be relying on that."""
    seeded = {r["role"] for r in db.execute("SELECT role FROM account_roles")}

    assert set(ROLE_TO_CONSTANT) <= seeded


def test_the_defaults_and_the_seed_agree(db):
    """Two lists of the same thing — `_ROLE_DEFAULTS` in accounting.py and
    `_DEFAULT_ACCOUNT_ROLES` in database.py. They drift silently if nothing
    compares them."""
    seeded = {r["role"]: r["code"] for r in db.execute("SELECT role, code FROM account_roles")}

    for role, default in accounting._ROLE_DEFAULTS.items():
        assert seeded.get(role) == default, f"{role} disagrees with its seed"


# ── The indirection actually works ───────────────────────────────────────────

def test_repointing_a_role_changes_where_a_posting_lands(db):
    """The reason the table exists: a tenant on another chart re-points the
    role and the posting code never learns which chart it is on."""
    db.execute("UPDATE account_roles SET code='4111' WHERE role='receivable'")
    db.commit()

    assert accounting.code(db, "receivable") == "4111"
    # and the constant is untouched, so it stays the default for everyone else
    assert accounting.AR == "1100"


def test_an_unmapped_role_falls_back_rather_than_failing(db):
    """An install mid-upgrade, or a role nobody has mapped, must still post to
    the account it always did instead of raising in the middle of a sale."""
    db.execute("DELETE FROM account_roles WHERE role='revenue'")
    db.commit()

    assert accounting.code(db, "revenue") == accounting.REVENUE


def test_an_unknown_role_is_a_programming_error(db):
    """Not a silent default: a typo'd role name should say so loudly."""
    with _pytest.raises(ValueError):
        accounting.code(db, "not_a_real_role")


# ── The Lebanese chart is why this exists ────────────────────────────────────

def test_the_vat_roles_are_split_even_though_this_chart_nets_them(db):
    """This chart runs one VAT control account, so all three roles point at it.
    The Lebanese plan separates deductible VAT on charges (4426) from VAT due on
    revenue (4427) with a settlement account (4425) — splitting the role now
    means that chart needs no special case later."""
    assert accounting.code(db, "vat_input") == accounting.VAT_CONTROL
    assert accounting.code(db, "vat_output") == accounting.VAT_CONTROL
    assert accounting.code(db, "vat_control") == accounting.VAT_CONTROL

    db.execute("UPDATE account_roles SET code='4426' WHERE role='vat_input'")
    db.execute("UPDATE account_roles SET code='4427' WHERE role='vat_output'")
    db.commit()

    assert accounting.code(db, "vat_input") == "4426"
    assert accounting.code(db, "vat_output") == "4427"
    assert accounting.code(db, "vat_control") == accounting.VAT_CONTROL
