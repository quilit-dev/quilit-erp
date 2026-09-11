"""Purchases from foreign suppliers, behind a permission of their own.

The owner wanted purchases split into local and foreign, with foreign ones
gated the way cost prices are: a permission key --- `foreign_purchases` ---
that rides the role editor and the seeded matrix rather than a mechanism of
its own.

What the key means, as decided with the owner: **everyone with Purchases still
sees a foreign purchase in the list, with its total.** Without the key they
cannot open it, cannot read its lines, cannot see what any item cost, and
cannot author one. Dashboard, reports and supplier balances are untouched, so
every user reads the same numbers.

Three things these tests care about beyond the gating itself:

  * **The lines are absent, not emptied.** `items: []` would read as "this
    purchase has no lines" and be a lie; a missing key reads as "not for you",
    the same way costs.py withholds a column. `line_count` and the totals stay.

  * **Every action follows the matching flag.** The owner chose to have the
    two permission rows read the same way in the role editor: `view` opens it,
    `create` raises one, `edit` changes / receives / pays, `delete` voids or
    archives. Each is checked on top of the ordinary `purchases` action, so
    holding `purchases.edit` alone no longer receives a foreign container.

  * **A deploy takes nothing away.** Today anyone holding `purchases.create`
    can raise any purchase. The upgrade grants `foreign_purchases` with the
    same flags each role already holds on `purchases`, so the feature ships as
    a no-op and becomes a restriction only when an admin unticks it.
"""
import os

import pytest

pytestmark = pytest.mark.critical

_PG = os.environ.get("DB_BACKEND", "sqlite").lower() in ("postgres", "postgresql", "pg")

# Holds purchases view/create/edit, so after the seed it holds
# foreign_purchases too. The tests below REVOKE the key from this role to
# get a user who may see the total and nothing else --- which is the person
# the feature exists for.
ROLE = "Inventory"


def _revoke(db, role=ROLE):
    db.execute("DELETE FROM role_permissions WHERE module = 'foreign_purchases' "
               "  AND role_id = (SELECT id FROM roles WHERE name = ?)", (role,))
    db.commit()


def _purchase(client, origin, supplier="Acme", cost=40.0):
    r = client.post("/api/purchases/", json={
        "supplier": supplier, "origin": origin,
        "product_name": "Widget", "quantity": 5, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _row(rows, pid):
    return next(r for r in rows if r["id"] == pid)


# ── the list: total for everyone, lines for those allowed ───────────────────
def test_the_owner_sees_lines_on_both(as_role):
    owner = as_role("superadmin")
    local, foreign = _purchase(owner, "local"), _purchase(owner, "foreign")

    rows = owner.get("/api/purchases/").json()
    assert _row(rows, local)["items"], "local lines missing for the owner"
    assert _row(rows, foreign)["items"], "foreign lines missing for the owner"
    assert _row(rows, foreign)["origin"] == "foreign"


def test_without_the_key_the_foreign_row_stays_but_its_lines_go(as_role, db):
    owner = as_role("superadmin")
    local, foreign = _purchase(owner, "local"), _purchase(owner, "foreign", cost=99.0)
    _revoke(db)

    rows = as_role(ROLE).get("/api/purchases/").json()
    f = _row(rows, foreign)

    assert "items" not in f, "the lines of a foreign purchase reached a role without the key"
    assert f["grand_total"] == pytest.approx(5 * 99.0), "the TOTAL must still be there"
    assert f["supplier"] == "Acme" and f["status"]
    assert f["line_count"] == 1, "how many lines is not what is being hidden"

    assert _row(rows, local)["items"], "a LOCAL purchase lost its lines --- overreach"


def test_absent_not_emptied(as_role, db):
    """`items: []` says 'no lines'. That is false, and a screen would draw it."""
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign")
    _revoke(db)

    f = _row(as_role(ROLE).get("/api/purchases/").json(), foreign)
    assert "items" not in f
    assert f["line_count"] == 1


def test_the_section_filter(as_role):
    owner = as_role("superadmin")
    local, foreign = _purchase(owner, "local"), _purchase(owner, "foreign")

    ids = {r["id"] for r in owner.get("/api/purchases/?origin=foreign").json()}
    assert foreign in ids and local not in ids
    ids = {r["id"] for r in owner.get("/api/purchases/?origin=local").json()}
    assert local in ids and foreign not in ids
    assert owner.get("/api/purchases/?origin=martian").status_code == 400


# ── opening one ──────────────────────────────────────────────────────────────
def test_opening_a_foreign_purchase_needs_the_key(as_role, db):
    owner = as_role("superadmin")
    local, foreign = _purchase(owner, "local"), _purchase(owner, "foreign")
    _revoke(db)
    c = as_role(ROLE)

    assert c.get(f"/api/purchases/{foreign}").status_code == 403
    assert c.get(f"/api/purchases/{local}").status_code == 200


def test_with_the_key_it_opens(as_role):
    """The seeded grant mirrors purchases, so Inventory holds it untouched."""
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign")

    body = as_role(ROLE).get(f"/api/purchases/{foreign}").json()
    assert body["origin"] == "foreign" and body["items"]


# ── authoring ────────────────────────────────────────────────────────────────
def test_creating_a_foreign_purchase_needs_the_key(as_role, db):
    _revoke(db)
    c = as_role(ROLE)

    r = c.post("/api/purchases/", json={
        "supplier": "Overseas Ltd", "origin": "foreign",
        "product_name": "Widget", "quantity": 1, "unit_cost": 10})
    assert r.status_code == 403, r.text

    # Local is untouched: the role still does its ordinary job.
    assert _purchase(c, "local")


def test_a_bad_origin_is_refused_not_defaulted(as_role):
    r = as_role("superadmin").post("/api/purchases/", json={
        "supplier": "X", "origin": "offshore",
        "product_name": "Widget", "quantity": 1, "unit_cost": 1})
    assert r.status_code == 400


def test_origin_defaults_to_local_for_every_existing_caller(as_role):
    """25 test files and the seed post purchases with no `origin`. They must
    all keep meaning what they meant."""
    owner = as_role("superadmin")
    r = owner.post("/api/purchases/", json={
        "supplier": "Acme", "product_name": "Widget", "quantity": 1, "unit_cost": 1})
    assert r.status_code in (200, 201)
    assert owner.get(f"/api/purchases/{r.json()['id']}").json()["origin"] == "local"


def test_editing_a_foreign_purchase_needs_the_key(as_role, db):
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign")
    _revoke(db)

    r = as_role(ROLE).put(f"/api/purchases/{foreign}", json={"notes": "changed"})
    assert r.status_code == 403, r.text


# ── every action follows its flag ────────────────────────────────────────────
def _grant(db, role, view=0, create=0, edit=0, delete=0):
    """Give ROLE exactly these foreign_purchases flags (replacing any row)."""
    _revoke(db, role)
    db.execute("INSERT INTO role_permissions "
               "(role_id, module, can_view, can_create, can_edit, can_delete, can_approve) "
               "VALUES ((SELECT id FROM roles WHERE name = ?), 'foreign_purchases', "
               "        ?, ?, ?, ?, 0)", (role, view, create, edit, delete))
    db.commit()


def test_receiving_a_foreign_purchase_needs_edit(as_role, db):
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign")

    _grant(db, ROLE, view=1)                       # can look, cannot touch
    r = as_role(ROLE).patch(f"/api/purchases/{foreign}/status", json={"status": "Received"})
    assert r.status_code == 403, r.text

    _grant(db, ROLE, view=1, edit=1)
    r = as_role(ROLE).patch(f"/api/purchases/{foreign}/status", json={"status": "Received"})
    assert r.status_code == 200, r.text


def test_paying_a_foreign_purchase_needs_edit(as_role, db):
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign", cost=10.0)

    _grant(db, ROLE, view=1)
    r = as_role(ROLE).post(f"/api/purchases/{foreign}/payments", json={"amount": 10.0})
    assert r.status_code == 403, r.text

    _grant(db, ROLE, view=1, edit=1)
    r = as_role(ROLE).post(f"/api/purchases/{foreign}/payments", json={"amount": 10.0})
    assert r.status_code in (200, 201), r.text


def test_voiding_a_foreign_purchase_needs_delete(as_role, db):
    """`edit` is not enough to void: that is the `purchases` rule too.

    Branch Manager rather than Inventory here, because the positive case needs
    a role that holds purchases.delete in the first place --- the foreign flag
    is checked on TOP of the ordinary one, never instead of it."""
    owner = as_role("superadmin")
    foreign = _purchase(owner, "foreign")

    _grant(db, "Branch Manager", view=1, edit=1)
    r = as_role("Branch Manager").patch(f"/api/purchases/{foreign}/void", json={"reason": "test"})
    assert r.status_code == 403, r.text

    _grant(db, "Branch Manager", view=1, edit=1, delete=1)
    r = as_role("Branch Manager").patch(f"/api/purchases/{foreign}/void", json={"reason": "test"})
    assert r.status_code == 200, r.text


def test_a_local_purchase_ignores_the_foreign_flags_entirely(as_role, db):
    """Withholding every foreign flag must not touch the ordinary job."""
    owner = as_role("superadmin")
    local = _purchase(owner, "local", cost=10.0)
    _revoke(db)
    c = as_role(ROLE)
    assert c.patch(f"/api/purchases/{local}/status", json={"status": "Received"}).status_code == 200
    assert c.post(f"/api/purchases/{local}/payments", json={"amount": 10.0}).status_code in (200, 201)


# ── a deploy takes nothing away ──────────────────────────────────────────────
# Two backends, two upgrade paths, and the bug that matters is one of them
# drifting from the other. The SQLite chain is exercised by replaying it; the
# Postgres mirror is exercised by running _ensure_pg_post_baseline against the
# real thing. Neither is allowed to stand in for the other.
def _grant_rows(db, module):
    return {r["role_id"]: tuple(r)[1:] for r in db.execute(
        "SELECT role_id, can_view, can_create, can_edit, can_delete, can_approve "
        "  FROM role_permissions WHERE module = ?", (module,))}


@pytest.mark.skipif(_PG, reason="the SQLite chain; the Postgres mirror is tested below")
def test_the_upgrade_mirrors_whatever_a_role_holds_on_purchases(db):
    """The migration's whole safety property, exercised rather than trusted.

    Wipe the grant and the marker, replay the chain, and every role must come
    back holding foreign_purchases with exactly its purchases flags --- no
    fixed role list, no admin action, nobody restricted on deploy.
    """
    import database

    db.execute("DELETE FROM role_permissions WHERE module = 'foreign_purchases'")
    db.execute("DELETE FROM schema_migrations "
               " WHERE name = '183c_foreign_purchases_capability'")
    db.commit()
    assert not db.execute("SELECT 1 FROM role_permissions "
                          "WHERE module='foreign_purchases'").fetchone()

    database._run_migrations(db, db.cursor())
    db.commit()

    expected = _grant_rows(db, "purchases")
    actual = _grant_rows(db, "foreign_purchases")
    assert expected, "setup: somebody holds purchases"
    assert actual == expected, (
        "after the upgrade a role's foreign_purchases flags differ from its "
        "purchases flags --- somebody would lose a capability on deploy")


@pytest.mark.skipif(not _PG, reason="needs DB_BACKEND=postgres")
def test_the_postgres_mirror_grants_the_same_way():
    """The path the three live tenants actually take. upgrade_all_tenant_schemas
    calls _ensure_pg_post_baseline and nothing else --- the seed never runs for
    a tenant that already exists --- so if the grant were only in the seed, every
    existing customer would deploy into a state where nobody could open a
    foreign purchase. Talks to DATABASE_URL directly: the db fixture is a
    per-test clone and the mirror runs against the real connection."""
    import psycopg
    from psycopg.rows import dict_row

    import database

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as raw:
        cur = raw.cursor()
        cur.execute("DELETE FROM role_permissions WHERE module = 'foreign_purchases'")
        cur.execute("DELETE FROM schema_migrations "
                    " WHERE name = '183c_foreign_purchases_capability'")
        raw.commit()

        database._ensure_pg_post_baseline(raw)

        def rows(module):
            cur.execute("SELECT role_id, can_view, can_create, can_edit, can_delete, can_approve "
                        "  FROM role_permissions WHERE module = %s", (module,))
            return {r["role_id"]: (r["can_view"], r["can_create"], r["can_edit"],
                                   r["can_delete"], r["can_approve"]) for r in cur.fetchall()}
        expected, actual = rows("purchases"), rows("foreign_purchases")
        assert expected, "setup: somebody holds purchases"
        assert actual == expected, "the Postgres mirror granted differently from the SQLite chain"

        # And the guard: revoke one, run the mirror again, it must stay revoked.
        cur.execute("DELETE FROM role_permissions WHERE module = 'foreign_purchases' "
                    "  AND role_id = (SELECT id FROM roles WHERE name = %s)", (ROLE,))
        raw.commit()
        database._ensure_pg_post_baseline(raw)
        cur.execute("SELECT 1 FROM role_permissions WHERE module = 'foreign_purchases' "
                    "  AND role_id = (SELECT id FROM roles WHERE name = %s)", (ROLE,))
        assert cur.fetchone() is None, "a boot re-granted what an admin revoked"


@pytest.mark.skipif(_PG, reason="the SQLite chain; the Postgres mirror is tested above")
def test_the_upgrade_does_not_regrant_what_an_admin_revoked(db):
    """The marker guard. Without it, every deploy would hand the key back to
    a role the owner deliberately took it from --- the fixed_assets bug shape."""
    import database

    _revoke(db)                       # the admin's decision
    database._run_migrations(db, db.cursor())
    db.commit()

    still_revoked = db.execute(
        "SELECT 1 FROM role_permissions "
        " WHERE module = 'foreign_purchases' "
        "   AND role_id = (SELECT id FROM roles WHERE name = ?)", (ROLE,)).fetchone()
    assert still_revoked is None, "a re-run of the migrations re-granted the key"


def test_a_role_with_purchases_create_can_raise_foreign_ones_untouched(as_role):
    """The observable version of the above: straight after the seed, with no
    admin having touched anything, the people who could raise purchases
    yesterday can raise foreign ones today."""
    assert _purchase(as_role(ROLE), "foreign")


# ── the supplier record decides, unless told otherwise ───────────────────────
# The form is a pick-list now, so a purchase can carry the supplier's id as
# well as its name. That id was never written before --- `supplier` was free
# text and supplier_id sat NULL on every row --- which is why `origin` had to
# be snapshotted at all. With a record in hand the server can default origin
# from it, so an API caller that never heard of the split still lands in the
# right section.
def _supplier(client, name, foreign):
    r = client.post("/api/suppliers/", json={"name": name, "is_foreign": foreign})
    assert r.status_code in (200, 201), r.text
    return r.json().get("id") or client.get("/api/suppliers/").json()[-1]["id"]


def test_a_foreign_supplier_record_makes_a_foreign_purchase_by_default(as_role):
    owner = as_role("superadmin")
    sid = _supplier(owner, "Fjord Imports", True)
    r = owner.post("/api/purchases/", json={
        "supplier": "Fjord Imports", "supplier_id": sid,
        "product_name": "Widget", "quantity": 1, "unit_cost": 1})
    assert r.status_code in (200, 201), r.text
    body = owner.get(f"/api/purchases/{r.json()['id']}").json()
    assert body["origin"] == "foreign"
    assert body["supplier_id"] == sid, "the record is finally linked"


def test_an_explicit_origin_beats_the_record(as_role):
    """The snapshot is the purchase's own fact. A local buy from a normally
    foreign supplier --- their stock in a bonded warehouse here --- stays local."""
    owner = as_role("superadmin")
    sid = _supplier(owner, "Fjord Imports", True)
    r = owner.post("/api/purchases/", json={
        "supplier": "Fjord Imports", "supplier_id": sid, "origin": "local",
        "product_name": "Widget", "quantity": 1, "unit_cost": 1})
    assert owner.get(f"/api/purchases/{r.json()['id']}").json()["origin"] == "local"


def test_a_supplier_id_that_does_not_exist_is_refused(as_role):
    r = as_role("superadmin").post("/api/purchases/", json={
        "supplier": "Ghost", "supplier_id": 999999,
        "product_name": "Widget", "quantity": 1, "unit_cost": 1})
    assert r.status_code == 400, r.text
