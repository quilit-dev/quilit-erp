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
