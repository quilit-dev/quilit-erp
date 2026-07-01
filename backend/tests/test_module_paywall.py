"""
Server-side module paywall.

`vendor_config.ENABLED_MODULES` (build constant or ENABLED_MODULES env var)
whitelists which modules an instance ships with. The sidebar hides the rest,
and this suite proves the *backend* also refuses their API — before the
superadmin bypass, so even the owner can't reach a module that wasn't
purchased. An empty whitelist means "all modules" (dev / demo / full build),
which must stay a complete no-op.
"""
import vendor_config


# ── Unit: the allow decision ─────────────────────────────────────────────────
def test_unrestricted_allows_everything(monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "")
    assert vendor_config.enabled_modules_set() is None
    for m in ("manufacturing", "hr", "crm", "anything"):
        assert vendor_config.module_allowed(m)


def test_whitelist_blocks_unlisted_but_allows_listed(monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "crm,clients,invoices")
    assert vendor_config.module_allowed("crm")
    assert vendor_config.module_allowed("invoices")
    assert not vendor_config.module_allowed("manufacturing")
    assert not vendor_config.module_allowed("hr")
    # System keys are never paywalled.
    assert vendor_config.module_allowed("dashboard")
    assert vendor_config.module_allowed("users")


def test_childless_subfeature_rides_with_parent(monkeypatch):
    # hr_contracts has no sidebar entry of its own — it ships with `hr`.
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "hr")
    assert vendor_config.module_allowed("hr_contracts")
    # …but a sub-feature that HAS its own key must be listed explicitly.
    assert not vendor_config.module_allowed("recruitment")


def test_own_key_subfeatures_require_explicit_listing(monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "inventory")
    assert vendor_config.module_allowed("inventory")
    assert not vendor_config.module_allowed("warehouses")   # separate purchasable key


# ── Integration: check_perm rejects a disabled module's API ──────────────────
def test_disabled_module_api_blocked_even_for_superadmin(as_role, monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "crm,clients")
    c = as_role("superadmin")
    assert c.get("/api/crm/leads").status_code == 200            # purchased
    assert c.get("/api/manufacturing/resources").status_code == 403  # not purchased


def test_hr_contracts_follows_hr(as_role, monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "hr")
    c = as_role("superadmin")
    assert c.get("/api/hr/contracts/").status_code == 200


def test_unrestricted_build_reaches_all_apis(as_role, monkeypatch):
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "")
    c = as_role("superadmin")
    assert c.get("/api/manufacturing/resources").status_code == 200
