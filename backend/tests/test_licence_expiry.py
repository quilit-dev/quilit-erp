"""
Licences and trials actually expire — after a grace period.

Two gaps this covers:

  * `license_expires_at` was written at provisioning, shown in the console, and
    then consulted by NOTHING. Only `trial_ends_at` was ever swept, so a paid
    customer whose licence lapsed kept full access forever.
  * Expiry was same-day. A customer whose bank transfer clears on the 3rd should
    not lose their books on the 1st, so both dates now carry a grace period.

Suspension (not deletion) is the mechanism: the data stays, the existing 402
"workspace is suspended" path does the blocking, and taking a renewal is
flipping the status back.

Postgres-only: the tenant catalog lives in `public.tenants`.
"""
import os
from datetime import date, timedelta

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="licence expiry needs TENANCY=schema and DB_BACKEND=postgres",
)


@pytest.fixture(autouse=True)
def fresh_db():
    yield                      # these manage their own catalog rows


def _days(n):
    return (date.today() + timedelta(days=n)).isoformat()


def _set(slug, **fields):
    import tenancy
    raw = tenancy._connect()
    try:
        sets = ", ".join(f"{k} = %s" for k in fields)
        with raw.cursor() as cur:
            cur.execute(f"UPDATE public.tenants SET {sets} WHERE slug = %s",
                        (*fields.values(), slug))
        raw.commit()
    finally:
        raw.close()


def _status(slug):
    import tenancy
    raw = tenancy._connect()
    try:
        with raw.cursor() as cur:
            cur.execute("SELECT status FROM public.tenants WHERE slug = %s", (slug,))
            row = cur.fetchone()
            return row["status"] if row else None
    finally:
        raw.close()


@pytest.fixture
def tenant(app):
    """A live, active tenant with no dates set."""
    import tenancy
    slug = "lic_probe"
    tenancy.provision_tenant(slug, name="Licence Probe")
    _set(slug, status="active", trial_ends_at=None, license_expires_at=None)
    yield slug
    _set(slug, status="active", trial_ends_at=None, license_expires_at=None)


# ── the gap: a lapsed LICENCE was never swept ───────────────────────────────

def test_an_expired_licence_suspends_after_the_grace_period(tenant):
    import tenancy
    _set(tenant, license_expires_at=_days(-30))

    changed = tenancy.expire_due_licences(grace_days=7)

    assert tenant in [c["slug"] for c in changed], changed
    assert _status(tenant) == "suspended"


def test_a_licence_inside_the_grace_period_keeps_working(tenant):
    """The renewal is late, not absent. Cutting access here is how you lose a
    customer over a bank transfer."""
    import tenancy
    _set(tenant, license_expires_at=_days(-2))

    tenancy.expire_due_licences(grace_days=7)

    assert _status(tenant) == "active"


def test_a_future_licence_is_untouched(tenant):
    import tenancy
    _set(tenant, license_expires_at=_days(+90))
    tenancy.expire_due_licences(grace_days=7)
    assert _status(tenant) == "active"


def test_no_dates_means_perpetual(tenant):
    """NULL is 'no expiry', not 'expired at the beginning of time'."""
    import tenancy
    tenancy.expire_due_licences(grace_days=7)
    assert _status(tenant) == "active"


# ── trials, which were swept but with no grace ──────────────────────────────

def test_an_expired_trial_suspends_after_the_grace_period(tenant):
    import tenancy
    _set(tenant, trial_ends_at=_days(-30))
    tenancy.expire_due_licences(grace_days=7)
    assert _status(tenant) == "suspended"


def test_a_trial_inside_the_grace_period_keeps_working(tenant):
    import tenancy
    _set(tenant, trial_ends_at=_days(-1))
    tenancy.expire_due_licences(grace_days=7)
    assert _status(tenant) == "active"


def test_zero_grace_cuts_access_on_the_day_after(tenant):
    """Grace is configurable, including off."""
    import tenancy
    _set(tenant, trial_ends_at=_days(-1))
    tenancy.expire_due_licences(grace_days=0)
    assert _status(tenant) == "suspended"


# ── behaviour of the sweep itself ───────────────────────────────────────────

def test_renewing_reactivates_and_survives_the_next_sweep(tenant):
    """The point of suspending rather than deleting: taking payment is one
    update, and the customer's data is exactly where they left it."""
    import tenancy
    _set(tenant, license_expires_at=_days(-30))
    tenancy.expire_due_licences(grace_days=7)
    assert _status(tenant) == "suspended"

    # Operator renews for a year and reactivates.
    _set(tenant, license_expires_at=_days(365), status="active")
    tenancy.expire_due_licences(grace_days=7)

    assert _status(tenant) == "active"


def test_the_sweep_is_idempotent(tenant):
    """It runs on every flush cycle, so a second pass must change nothing."""
    import tenancy
    _set(tenant, license_expires_at=_days(-30))

    first  = tenancy.expire_due_licences(grace_days=7)
    second = tenancy.expire_due_licences(grace_days=7)

    assert [c["slug"] for c in first] == [tenant]
    assert second == [], "an already-suspended tenant was swept again"


def test_it_does_not_touch_other_tenants(app, tenant):
    import tenancy
    other = "lic_other"
    tenancy.provision_tenant(other, name="Other")
    _set(other, status="active", trial_ends_at=None, license_expires_at=None)
    _set(tenant, license_expires_at=_days(-30))

    tenancy.expire_due_licences(grace_days=7)

    assert _status(other) == "active"


def test_the_old_name_still_works():
    """`expire_due_trials` is what metrics.py calls on the flush cycle."""
    import tenancy
    assert tenancy.expire_due_trials is tenancy.expire_due_licences
