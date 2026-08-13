"""
Promotions on invoices and quotations.

The rule that matters most here is what does NOT happen: the quantity cap is
never consumed. POS meters "first N units" by bumping `used_quantity` inside the
sale transaction. An invoice can be drafted, edited and voided, and a quotation
may expire unaccepted — metering either would burn units of a promotion the
customer never receives, denying them to a real sale. POS stays the metered
channel.

The discount is snapshotted onto the line together with the promotion that
produced it, so ending or editing a promotion later cannot retroactively
reprice a document that was already issued.
"""
import pytest
import sqlite3
import os


def _lines(table, fk, doc_id):
    con = sqlite3.connect(os.environ.get("DB_PATH", "erp.db"))
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        f"SELECT * FROM {table} WHERE {fk}=? ORDER BY id", (doc_id,))]
    con.close()
    return rows


def _used_quantity(promo_id):
    con = sqlite3.connect(os.environ.get("DB_PATH", "erp.db"))
    v = con.execute("SELECT used_quantity FROM promotions WHERE id=?",
                    (promo_id,)).fetchone()
    con.close()
    return (v[0] if v else None) or 0


def _setup(c, pct=10, max_qty=5):
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    item = c.post("/api/inventory/", json={
        "name": "Pump", "category": "Equipment", "quantity": 50,
        "unit_cost": 100, "sale_price": 200, "min_stock": 1}).json()
    promo = c.post("/api/promotions/", json={
        "name": "Test promo", "scope_type": "item", "scope_value": str(item["id"]),
        "discount_value": pct, "active": True, "max_quantity": max_qty}).json()
    return cl["id"], item["id"], promo["id"]


def test_invoice_line_gets_the_promotion_discount(make_client):
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert r.status_code == 200, r.text
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert line["discount"] == 60.0          # 10% of 3 x 200
    assert line["promotion_id"] == promo_id  # explainable in a dispute
    assert line["inventory_id"] == inv_id


def test_invoice_does_not_consume_the_quantity_cap(make_client):
    """The decision this module exists to protect. A draft that is later voided
    must not have burned promotional units."""
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    before = _used_quantity(promo_id)
    c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert _used_quantity(promo_id) == before, "an invoice consumed the cap"


def test_quotation_is_indicative_and_does_not_consume_the_cap(make_client):
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    before = _used_quantity(promo_id)
    r = c.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert r.status_code in (200, 201), r.text
    line = _lines("quotation_items", "quotation_id", r.json()["id"])[0]
    assert line["discount"] == 60.0
    # `total` is the line NET of the promotion.
    assert round(float(line["total"]), 2) == 540.0
    assert _used_quantity(promo_id) == before, "a quotation consumed the cap"


def test_a_typed_discount_beats_the_promotion(make_client):
    """Someone entering a number has made a decision; an automatic rule must not
    overwrite it."""
    c = make_client("superadmin")
    client_id, inv_id, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 450,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id, "discount": 150}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert line["discount"] == 150.0
    assert line["promotion_id"] is None


def test_a_line_with_no_stock_link_gets_nothing(make_client):
    """A hand-typed service line has no inventory id, so no promotion can apply.
    Matching on the name instead would misprice the moment an item is renamed."""
    c = make_client("superadmin")
    client_id, _, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 500,
        "items": [{"name": "Consulting", "quantity": 1, "unit_price": 500}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert (line["discount"] or 0) == 0
    assert line["inventory_id"] is None
    assert line["promotion_id"] is None


def test_tax_is_charged_on_the_discounted_net(make_client):
    """The promotion changes what the customer owes, so tax follows the actual
    consideration — not the pre-discount sticker price."""
    c = make_client("superadmin")
    client_id, inv_id, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    full = c.get(f"/api/invoices/{r.json()['id']}").json()
    # 600 gross - 60 promo = 540 net.
    assert round(float(full["subtotal"]), 2) == 540.0


def test_an_inactive_promotion_is_ignored(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    item = c.post("/api/inventory/", json={
        "name": "Widget", "category": "Parts", "quantity": 10,
        "unit_cost": 10, "sale_price": 20, "min_stock": 1}).json()
    c.post("/api/promotions/", json={
        "name": "Off", "scope_type": "item", "scope_value": str(item["id"]),
        "discount_value": 50, "active": False})
    r = c.post("/api/invoices/", json={
        "client_id": cl["id"], "amount": 20,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 20,
                   "inventory_id": item["id"]}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert (line["discount"] or 0) == 0


# ── the form preview ────────────────────────────────────────────────────────
#
# The form computes its own running totals. Without a preview it showed a
# discount of zero while the server was about to apply one, so the figure the
# operator quoted was contradicted by the document that got saved.

def _promo_setup(c, pct=20):
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    it = c.post("/api/inventory/", json={"name": "Promo Widget", "quantity": 100,
                                         "unit_cost": 40, "sale_price": 100}).json()
    c.post("/api/promotions/", json={"name": "Preview Promo", "scope_type": "item",
                                     "scope_value": str(it["id"]),
                                     "discount_value": pct, "active": True})
    return cl["id"], it["id"]


def test_preview_matches_what_gets_saved(make_client):
    """The whole point. A preview that disagrees with the save is worse than no
    preview, because it is believed."""
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c)
    line = {"name": "Promo Widget", "quantity": 2, "unit_price": 100,
            "discount": 0, "inventory_id": iid}

    previewed = c.post("/api/promotions/preview",
                       json={"lines": [line]}).json()["lines"][0]
    inv = c.post("/api/invoices/", json={"client_id": client_id,
                                         "items": [line]}).json()
    saved = c.get(f"/api/invoices/{inv['id']}").json()["items"][0]

    assert float(previewed["discount"]) == float(saved["discount"])
    assert previewed["promotion_name"] == "Preview Promo"


def test_preview_leaves_a_typed_discount_alone(make_client):
    c = make_client("superadmin")
    _, iid = _promo_setup(c)
    r = c.post("/api/promotions/preview", json={"lines": [
        {"inventory_id": iid, "quantity": 2, "unit_price": 100, "discount": 15}]}).json()
    assert r["lines"][0]["discount"] == 15
    assert r["lines"][0]["source"] == "manual"
    assert r["lines"][0]["promotion_id"] is None


def test_preview_ignores_lines_with_no_stock_link(make_client):
    """A hand-typed line has no inventory id, so no promotion can reach it."""
    c = make_client("superadmin")
    _promo_setup(c)
    r = c.post("/api/promotions/preview", json={"lines": [
        {"inventory_id": None, "quantity": 1, "unit_price": 50, "discount": 0}]}).json()
    assert r["lines"][0]["discount"] == 0
    assert r["lines"][0]["promotion_id"] is None


def test_preview_never_meters_the_cap(make_client):
    """Previewing is reading. Calling it repeatedly must not consume a promotion
    the customer has not been given."""
    c = make_client("superadmin")
    _, iid = _promo_setup(c)
    line = {"inventory_id": iid, "quantity": 3, "unit_price": 100, "discount": 0}
    for _ in range(5):
        c.post("/api/promotions/preview", json={"lines": [line]})
    promos = c.get("/api/promotions/").json()
    rows = promos if isinstance(promos, list) else promos.get("items", [])
    assert all((p.get("used_quantity") or 0) == 0 for p in rows)


def test_preview_requires_a_relevant_permission(make_client):
    """Display-only, but still business data: an anonymous caller gets nothing."""
    anon = make_client()
    r = anon.post("/api/promotions/preview", json={"lines": []})
    assert r.status_code in (401, 403)


# ── diagnosis ───────────────────────────────────────────────────────────────
#
# "The discount isn't showing" has half a dozen causes. Answering it by
# elimination means guessing at data only the customer can see, so the server
# reports the verdict for every promotion with the reason attached.

def _server_today():
    from datetime import datetime
    from utils import _now
    return datetime.strptime(_now()[:10], "%Y-%m-%d").date()


def test_diagnose_names_the_matching_promotion(make_client):
    c = make_client("superadmin")
    _, iid = _promo_setup(c, pct=25)
    d = c.get(f"/api/promotions/diagnose?inventory_id={iid}&quantity=2&unit_price=100").json()
    assert d["discount"] == 50.0
    assert d["chosen_promotion_name"] == "Preview Promo"
    assert d["eligible_count"] == 1
    assert "off" in d["verdict"]


def test_diagnose_explains_each_rejection(make_client):
    """The reason has to be specific enough to act on — "not eligible" is not an
    answer anyone can do anything with."""
    from datetime import timedelta
    c = make_client("superadmin")
    _, iid = _promo_setup(c, pct=25)
    other = c.post("/api/inventory/", json={"name": "Other", "quantity": 5,
                                            "unit_cost": 1, "sale_price": 10}).json()
    today = _server_today()
    c.post("/api/promotions/", json={"name": "Inactive", "scope_type": "all",
                                     "discount_value": 80, "active": False})
    c.post("/api/promotions/", json={"name": "Expired", "scope_type": "all",
                                     "discount_value": 70, "active": True,
                                     "end_date": (today - timedelta(days=1)).isoformat()})
    c.post("/api/promotions/", json={"name": "Future", "scope_type": "all",
                                     "discount_value": 60, "active": True,
                                     "start_date": (today + timedelta(days=5)).isoformat()})
    c.post("/api/promotions/", json={"name": "Other item", "scope_type": "item",
                                     "scope_value": str(other["id"]),
                                     "discount_value": 90, "active": True})

    d = c.get(f"/api/promotions/diagnose?inventory_id={iid}&quantity=1&unit_price=100").json()
    by_name = {p["name"]: p for p in d["promotions"]}
    assert "not active" in by_name["Inactive"]["rejected_because"]
    assert any("ended" in r for r in by_name["Expired"]["rejected_because"])
    assert any("starts" in r for r in by_name["Future"]["rejected_because"])
    assert "scope does not match" in by_name["Other item"]["rejected_because"]
    # The one that should win still wins despite a 90% promotion existing.
    assert d["chosen_promotion_name"] == "Preview Promo"


def test_diagnose_reports_the_server_date(make_client):
    """Promotion windows are evaluated in UTC. Someone debugging a window needs
    to see the date the server is actually using, not assume it is theirs."""
    c = make_client("superadmin")
    _, iid = _promo_setup(c)
    d = c.get(f"/api/promotions/diagnose?inventory_id={iid}").json()
    from utils import _now
    assert d["server_date_utc"] == _now()[:10]


def test_diagnose_agrees_with_what_actually_saves(make_client):
    """A diagnosis that disagreed with production would be worse than none."""
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=25)
    line = {"name": "Promo Widget", "quantity": 2, "unit_price": 100,
            "discount": 0, "inventory_id": iid}
    d = c.get(f"/api/promotions/diagnose?inventory_id={iid}&quantity=2&unit_price=100").json()
    inv = c.post("/api/invoices/", json={"client_id": client_id, "items": [line]}).json()
    saved = c.get(f"/api/invoices/{inv['id']}").json()["items"][0]
    assert float(d["discount"]) == float(saved["discount"])


def test_diagnose_404s_on_an_unknown_item(make_client):
    c = make_client("superadmin")
    assert c.get("/api/promotions/diagnose?inventory_id=999999").status_code == 404


def test_diagnose_says_so_when_there_are_no_promotions(make_client):
    c = make_client("superadmin")
    it = c.post("/api/inventory/", json={"name": "Lonely", "quantity": 1,
                                         "unit_cost": 1, "sale_price": 5}).json()
    d = c.get(f"/api/promotions/diagnose?inventory_id={it['id']}").json()
    assert d["eligible_count"] == 0
    assert d["discount"] == 0


def test_diagnose_by_name_matches_scope_correctly(make_client):
    """Regression: looking up by name resolved the item but then matched scope
    against the raw (None) inventory_id parameter, so every promotion came back
    "scope does not match". A diagnostic that confidently blames a correct
    promotion is worse than no diagnostic."""
    c = make_client("superadmin")
    _, iid = _promo_setup(c, pct=25)
    by_id = c.get(f"/api/promotions/diagnose?inventory_id={iid}"
                  "&quantity=2&unit_price=100").json()
    by_name = c.get("/api/promotions/diagnose?name=Promo Widget"
                    "&quantity=2&unit_price=100").json()
    assert by_name["discount"] == by_id["discount"] == 50.0
    assert by_name["chosen_promotion_id"] == by_id["chosen_promotion_id"]
    assert by_name["item"]["id"] == iid


def test_diagnose_by_partial_name(make_client):
    c = make_client("superadmin")
    _, iid = _promo_setup(c, pct=25)
    d = c.get("/api/promotions/diagnose?name=widget&quantity=1&unit_price=100").json()
    assert d["item"]["id"] == iid


def test_diagnose_miss_lists_what_is_available(make_client):
    """A 404 that only says "not found" invites another guess."""
    c = make_client("superadmin")
    _promo_setup(c)
    r = c.get("/api/promotions/diagnose?inventory_id=999999")
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert detail["total_items"] >= 1
    assert any(i["name"] == "Promo Widget" for i in detail["available_items"])


# ── the discount field itself ───────────────────────────────────────────────
#
# The field is always on the form now. Empty means "let the promotion decide";
# anything typed is a human decision the promotion must not overwrite —
# including a deliberate zero.

def _line(iid, **extra):
    line = {"name": "Promo Widget", "quantity": 2, "unit_price": 100,
            "inventory_id": iid}
    line.update(extra)
    return line


def test_untouched_line_takes_the_promotion(make_client):
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=20)
    inv = c.post("/api/invoices/", json={"client_id": client_id,
        "items": [_line(iid, discount=0, discount_auto=True)]}).json()
    got = c.get(f"/api/invoices/{inv['id']}").json()
    assert got["items"][0]["discount"] == 40.0
    assert got["items"][0]["promotion_id"] is not None
    assert got["amount"] == 160.0


def test_an_explicit_zero_survives_the_promotion(make_client):
    """The case the flag exists for. Without it the server cannot tell "nothing
    typed" from "deliberately zero", so a customer told they get no discount
    would silently receive one anyway."""
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=20)
    inv = c.post("/api/invoices/", json={"client_id": client_id,
        "items": [_line(iid, discount=0, discount_auto=False)]}).json()
    got = c.get(f"/api/invoices/{inv['id']}").json()
    assert got["items"][0]["discount"] == 0
    assert got["items"][0]["promotion_id"] is None
    assert got["amount"] == 200.0


def test_a_typed_discount_beats_the_promotion(make_client):
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=20)
    inv = c.post("/api/invoices/", json={"client_id": client_id,
        "items": [_line(iid, discount=15, discount_auto=False)]}).json()
    got = c.get(f"/api/invoices/{inv['id']}").json()
    assert got["items"][0]["discount"] == 15
    assert got["items"][0]["promotion_id"] is None
    assert got["amount"] == 185.0


@pytest.mark.parametrize("extra", [{}, {"discount_auto": None}])
def test_absent_or_null_flag_means_not_set(make_client, extra):
    """An older client, or one serialising an absent value as null, must keep the
    previous behaviour rather than 422 on a field it never knew about."""
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=20)
    r = c.post("/api/invoices/", json={"client_id": client_id,
        "items": [_line(iid, discount=0, **extra)]})
    assert r.status_code == 200, r.text
    got = c.get(f"/api/invoices/{r.json()['id']}").json()
    assert got["items"][0]["discount"] == 40.0


def test_quotations_behave_identically(make_client):
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c, pct=20)
    auto = c.post("/api/quotations/", json={"client_id": client_id,
        "items": [_line(iid, discount=0, discount_auto=True)]}).json()
    zero = c.post("/api/quotations/", json={"client_id": client_id,
        "items": [_line(iid, discount=0, discount_auto=False)]}).json()
    a = c.get(f"/api/quotations/{auto['id']}").json()["items"][0]
    z = c.get(f"/api/quotations/{zero['id']}").json()["items"][0]
    assert a["discount"] == 40.0 and a["promotion_id"] is not None
    assert z["discount"] == 0 and z["promotion_id"] is None
