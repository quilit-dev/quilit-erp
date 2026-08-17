"""Which letterhead a tenant prints on is a VENDOR decision, not a setting.

A custom document design is one company's identity. If a tenant could select
one, any tenant could issue invoices carrying another business's branding — so
`document_template` is resolved from the tenant server-side, served read-only,
and rejected outright on write.

The write rejection is the whole guarantee, and it is easy to lose by accident:
adding the field to SettingsUpdate "for completeness" would silently make it
settable, and nothing else in the system would complain.
"""
import pytest

import vendor_config


@pytest.fixture
def as_tenant(monkeypatch):
    """Pretend a request is running inside a given tenant schema."""
    def _use(schema):
        import tenant_context
        monkeypatch.setattr(tenant_context, "IS_SCHEMA_TENANCY", True)
        monkeypatch.setattr(tenant_context, "current_schema", lambda: schema)
    return _use


# ── Resolution ───────────────────────────────────────────────────────────────

def test_a_tenant_without_a_design_gets_the_generic_one(as_tenant):
    as_tenant("tenant_someone_else")
    assert vendor_config.document_template() == "default"


def test_the_mapped_tenant_gets_its_own(as_tenant):
    schema, template = next(iter(vendor_config.DOCUMENT_TEMPLATES.items()))
    as_tenant(schema)
    assert vendor_config.document_template() == template


def test_a_desktop_install_can_be_told_which_design_to_use(monkeypatch):
    # No schema to key off on a single-tenant install, so the env var is the
    # equivalent lever. Same property: set outside the running ERP.
    import tenant_context
    monkeypatch.setattr(tenant_context, "IS_SCHEMA_TENANCY", False)
    monkeypatch.setenv("DOCUMENT_TEMPLATE", "hajosign")
    assert vendor_config.document_template() == "hajosign"


def test_resolution_never_raises(monkeypatch):
    # A letterhead is cosmetic. If resolving one throws, the document must still
    # be served — an invoice that will not open is far worse than a plain one.
    import tenant_context
    monkeypatch.setattr(tenant_context, "IS_SCHEMA_TENANCY", True)
    monkeypatch.setattr(tenant_context, "current_schema",
                        lambda: (_ for _ in ()).throw(RuntimeError("no context")))
    monkeypatch.delenv("DOCUMENT_TEMPLATE", raising=False)

    assert vendor_config.document_template() == "default"


# ── Exposure and the write barrier ───────────────────────────────────────────

def test_settings_serves_the_template(as_role):
    r = as_role("superadmin").get("/api/settings/")
    assert r.status_code == 200
    assert r.json()["document_template"] == "default"


def test_a_tenant_cannot_give_itself_a_design(as_role):
    """The guarantee. `extra: forbid` on SettingsUpdate turns this into a 422.

    Tried as the SUPERADMIN — the most privileged account there is. If even it
    cannot set this, no tenant can.
    """
    c = as_role("superadmin")
    r = c.put("/api/settings/", json={"document_template": "hajosign"})

    assert r.status_code == 422, (
        "document_template must be rejected on write — a tenant able to set it "
        "could print another company's letterhead"
    )
    assert c.get("/api/settings/").json()["document_template"] == "default"


def test_it_is_not_in_the_writable_model():
    # Pinned directly, so the reason survives even if the route changes shape.
    from routers.settings import SettingsUpdate
    assert "document_template" not in SettingsUpdate.model_fields


def test_a_stale_settings_row_cannot_select_a_design(as_role, db):
    """Even written straight into the table, it loses to the resolved value.

    Restoring an old backup, or a hand-edited database, must not be a route to
    another company's branding.
    """
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('document_template', 'hajosign') "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    db.commit()

    assert as_role("superadmin").get("/api/settings/").json()["document_template"] == "default"


# ── The two global document toggles ──────────────────────────────────────────

def test_barcode_and_words_are_off_by_default(as_role):
    s = as_role("superadmin").get("/api/settings/").json()
    assert s["show_barcode_col"] == "0"
    assert s["show_total_words"] == "0"


def test_and_are_settable_by_any_tenant(as_role):
    # Unlike the design, these are ordinary preferences: every customer may
    # choose them, which is why they live in SettingsUpdate.
    c = as_role("superadmin")
    r = c.put("/api/settings/",
              json={"show_barcode_col": "1", "show_total_words": "1"})
    assert r.status_code == 200

    s = c.get("/api/settings/").json()
    assert s["show_barcode_col"] == "1"
    assert s["show_total_words"] == "1"


# ── Barcodes on document lines ───────────────────────────────────────────────
# A line item snapshots the name and price as they were when the document was
# raised, deliberately, so editing a product cannot rewrite a document a
# customer already holds. The barcode is a property of the PRODUCT, so it is
# resolved through the line's stock link rather than copied — which is why it
# needs testing on both document types and on lines that have no link at all.

@pytest.fixture
def doc_setup(as_role):
    c = as_role("superadmin")
    item = c.post("/api/inventory/", json={
        "name": "Flex Roll 320cm", "barcode": "1000387",
        "unit_cost": 50, "sale_price": 120}).json()
    cust = c.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    return c, item, cust


def _lines(payload):
    return {i["name"]: i.get("barcode") for i in payload["items"]}


def test_an_invoice_line_carries_its_products_barcode(doc_setup):
    c, item, cust = doc_setup
    inv = c.post("/api/invoices/", json={
        "client_id": cust["id"], "amount": 170,
        "items": [
            {"name": "Flex Roll 320cm", "quantity": 1, "unit_price": 120,
             "inventory_id": item["id"]},
            {"name": "Delivery", "quantity": 1, "unit_price": 50},
        ],
    }).json()

    lines = _lines(c.get(f"/api/invoices/{inv['id']}").json())
    assert lines["Flex Roll 320cm"] == "1000387"
    # Typed by hand, so there is no product to take a barcode from. None is the
    # only safe answer: any other code would scan as the wrong item.
    assert lines["Delivery"] is None


def test_a_quotation_line_does_too(doc_setup):
    c, item, cust = doc_setup
    q = c.post("/api/quotations/", json={
        "client_id": cust["id"], "total": 120,
        "items": [{"name": "Flex Roll 320cm", "quantity": 1, "unit_price": 120,
                   "inventory_id": item["id"]}],
    }).json()

    assert _lines(c.get(f"/api/quotations/{q['id']}").json()) == {
        "Flex Roll 320cm": "1000387"}


def test_a_product_with_no_barcode_yields_none_not_an_error(doc_setup):
    c, _item, cust = doc_setup
    plain = c.post("/api/inventory/", json={"name": "Unlabelled", "sale_price": 10}).json()
    inv = c.post("/api/invoices/", json={
        "client_id": cust["id"], "amount": 10,
        "items": [{"name": "Unlabelled", "quantity": 1, "unit_price": 10,
                   "inventory_id": plain["id"]}],
    }).json()

    assert _lines(c.get(f"/api/invoices/{inv['id']}").json()) == {"Unlabelled": None}


def test_the_barcode_follows_the_product_after_it_is_relabelled(doc_setup):
    """The name on the line is frozen; the barcode is not.

    This is the intended split and worth stating: an old document keeps the
    description the customer agreed to, while the barcode still points at the
    item now on the shelf. Freezing the barcode too would print codes that no
    longer scan.
    """
    c, item, cust = doc_setup
    inv = c.post("/api/invoices/", json={
        "client_id": cust["id"], "amount": 120,
        "items": [{"name": "Flex Roll 320cm", "quantity": 1, "unit_price": 120,
                   "inventory_id": item["id"]}],
    }).json()

    c.put(f"/api/inventory/{item['id']}", json={
        "name": "Flex Roll 320cm (v2)", "barcode": "9999999",
        "unit_cost": 50, "sale_price": 120})

    lines = _lines(c.get(f"/api/invoices/{inv['id']}").json())
    assert lines == {"Flex Roll 320cm": "9999999"}


# ── Pre-printed stationery ───────────────────────────────────────────────────
# The same argument, one step further. Whether the tenant's letterhead is already
# ON the paper is a fact about their stationery cupboard, not a preference, and it
# used to be a toggle in Settings. That was wrong twice over: it is the same class
# of fact as which letterhead they have, and as a switch it could only be set
# wrong — meaningless for every tenant without a design, and a double-printed
# invoice for the one tenant it applied to if they forgot it.

def test_only_the_listed_tenants_print_on_their_own_stationery(as_tenant):
    as_tenant("tenant_someone_else")
    assert vendor_config.preprinted_stationery() is False


def test_the_listed_tenant_gets_the_data_alone(as_tenant):
    as_tenant(next(iter(vendor_config.PREPRINTED_STATIONERY)))
    assert vendor_config.preprinted_stationery() is True


def test_drawing_the_design_is_the_safe_default(as_tenant):
    # A tenant who gets the letterhead drawn when they did not need it has an
    # ugly document. One who gets it omitted when they did need it has a document
    # that looks blank. So an unknown tenant must draw.
    as_tenant("tenant_brand_new")
    assert vendor_config.preprinted_stationery() is False


def test_every_preprinted_tenant_actually_has_a_design(as_tenant):
    # Suppressing a letterhead that was never going to be drawn is a no-op that
    # reads like a configured behaviour — a sign the two lists have drifted.
    for schema in vendor_config.PREPRINTED_STATIONERY:
        assert schema in vendor_config.DOCUMENT_TEMPLATES, (
            f"{schema} prints on pre-printed stationery but has no letterhead")


def test_it_is_served_read_only_and_refused_on_write(as_role):
    client = as_role("superadmin")

    got = client.get("/api/settings/")
    assert got.status_code == 200
    assert got.json()["preprinted_stationery"] in ("0", "1")

    # The barrier that makes it vendor-controlled: `extra: forbid` turns an
    # attempt to set it into a 422 rather than a silent no-op.
    r = client.put("/api/settings/", json={"preprinted_stationery": "1"})
    assert r.status_code == 422, r.text


def test_a_desktop_install_can_still_declare_it(monkeypatch):
    import tenant_context
    monkeypatch.setattr(tenant_context, "IS_SCHEMA_TENANCY", False)
    monkeypatch.setenv("PREPRINTED_STATIONERY", "1")
    assert vendor_config.preprinted_stationery() is True


def test_the_customers_copy_still_gets_the_letterhead_drawn(as_role):
    """The exception that makes the rule usable.

    Pre-printed means the SUPPLIER's printer is loaded with headed paper. Whoever
    opens the share link is looking at a screen and has none of it, so their copy
    must be drawn in full. The public payload therefore carries the letterhead id
    and NOT the pre-printed flag — and now that the flag is vendor-fixed rather
    than a toggle nobody switches on, adding it to that allow-list would quietly
    strip the design from every customer's copy.
    """
    client = as_role("superadmin")
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 100,
        "items": [{"name": "Sign", "quantity": 1, "unit_price": 100}],
    }).json()
    url = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp",
        "to": "9613111222",
    }).json()["url"]
    token = url.rstrip("/").split("/")[-1]

    company = client.get(f"/api/communications/public/{token}").json()["company"]

    assert "document_template" in company, "the customer's copy needs the design"
    assert "preprinted_stationery" not in company, (
        "carrying this to the customer's copy strips the letterhead from a "
        "document they are reading on a screen")
