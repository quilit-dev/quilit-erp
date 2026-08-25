"""Who may edit the settings.

`settings` is one of the four ADMIN_MODULES, so the Roles screen has always
offered view/create/edit/delete for it and stored the answer in
role_permissions. Nothing read the row: every settings endpoint asked for
`require_admin` — admin-tier or vendor superadmin — so granting a role "may edit
settings" changed a checkbox in a table and nothing else. The switch was in the
UI, written to the database, and honoured nowhere.

Admin-tier keeps its blanket access rather than being made to depend on a
permission row: no `settings` row is seeded for any role, so requiring one would
take the page away from the owner it already belonged to.
"""
import pytest


def _role_with(admin, perms, name="Office Manager"):
    r = admin.post("/api/roles/", json={"name": name, "description": "t",
                                        "color": "#334155"})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    p = admin.put(f"/api/roles/{rid}/permissions", json={"permissions": perms})
    assert p.status_code == 200, p.text
    return rid


def _user_in(admin, make_client, role_id, username):
    u = admin.post("/api/users/", json={
        "username": username, "password": "password123",
        "full_name": username.title(), "role_id": role_id})
    assert u.status_code == 200, u.text
    c = make_client()
    lg = c.post("/api/auth/login",
                json={"username": username, "password": "password123"})
    assert lg.status_code == 200, lg.text
    return c, lg.json()


@pytest.fixture
def admin(make_client):
    return make_client("superadmin")


def test_a_role_granted_settings_edit_can_edit_settings(admin, make_client):
    """The reported bug: the switch was on and the page stayed read-only."""
    rid = _role_with(admin, {"settings": {"view": True, "edit": True}})
    office, me = _user_in(admin, make_client, rid, "office")
    assert me["admin_access"] is False, "not an admin-tier role — that is the point"

    r = office.put("/api/settings/", json={"company_name": "Renamed Co"})

    assert r.status_code == 200, r.text
    assert admin.get("/api/settings/").json()["company_name"] == "Renamed Co"


def test_view_alone_is_still_read_only(admin, make_client):
    """The other half of the switch has to mean something too."""
    rid = _role_with(admin, {"settings": {"view": True}}, name="Settings Reader")
    reader, _ = _user_in(admin, make_client, rid, "reader")

    assert reader.get("/api/settings/").status_code == 200
    assert reader.put("/api/settings/",
                      json={"company_name": "Nope"}).status_code == 403


def test_a_role_with_no_settings_permission_is_refused(admin, make_client):
    rid = _role_with(admin, {"invoices": {"view": True, "edit": True}},
                     name="Invoices Only")
    nobody, _ = _user_in(admin, make_client, rid, "nobody")

    assert nobody.put("/api/settings/",
                      json={"company_name": "Nope"}).status_code == 403


def test_the_owner_keeps_what_they_always_had(admin, make_client):
    """Admin-tier is not made to depend on a permission row.

    No `settings` row is seeded for any role, so gating on the row alone would
    have taken the page away from the Business Owner while fixing it for
    everyone else.
    """
    rows = admin.get("/api/roles/").json()
    owner = [r for r in rows if r["name"] == "Business Owner"][0]
    boss, me = _user_in(admin, make_client, owner["id"], "theboss")
    assert me["admin_access"] is True

    r = boss.put("/api/settings/", json={"company_name": "Owner Co"})

    assert r.status_code == 200, r.text


def test_the_other_settings_writers_follow_the_same_rule(admin, make_client):
    """The exchange rate and the logo are settings and sit on the same page."""
    rid = _role_with(admin, {"settings": {"view": True, "edit": True}},
                     name="Rates Editor")
    office, _ = _user_in(admin, make_client, rid, "rates_editor")

    r = office.post("/api/settings/exchange-rate",
                    json={"currency": "LBP", "rate": 90000})

    assert r.status_code == 200, r.text


def test_tax_rates_and_categories_follow_it_too(admin, make_client):
    """Both are edited from the Settings page and lived behind require_admin.

    Half a page live and half of it refusing is not "may edit settings".
    """
    rid = _role_with(admin, {"settings": {"view": True, "edit": True}},
                     name="Page Editor")
    office, _ = _user_in(admin, make_client, rid, "page_editor")

    tax = office.post("/api/tax-rates/", json={"name": "VAT 11", "rate": 11})
    cat = office.post("/api/categories",
                      json={"name": "Spares", "domain": "inventory"})

    assert tax.status_code == 200, tax.text
    assert cat.status_code == 200, cat.text


# ── What the switch must NOT reach ───────────────────────────────────────────

def test_restoring_a_database_is_not_editing_a_setting(admin, make_client):
    """Backups, restore and the integrity check keep require_admin.

    They sit on the same page, but writing another database over the top of the
    live one is not a setting, and it must not follow a switch an owner hands
    out so somebody can fix the company address.
    """
    rid = _role_with(admin, {"settings": {"view": True, "edit": True}},
                     name="Address Fixer")
    office, _ = _user_in(admin, make_client, rid, "address_fixer")

    for path in ("/api/settings/backup", "/api/settings/backup-status",
                 "/api/settings/integrity-check"):
        assert office.get(path).status_code == 403, path
    assert office.post("/api/settings/backup-now").status_code == 403


def test_it_does_not_hand_out_users_or_roles(admin, make_client):
    """`settings` is one of four administrative modules and grants only itself."""
    rid = _role_with(admin, {"settings": {"view": True, "edit": True}},
                     name="Just Settings")
    office, _ = _user_in(admin, make_client, rid, "just_settings")

    made = office.post("/api/users/", json={
        "username": "sneaky", "password": "password123", "full_name": "S"})

    assert made.status_code == 403


def test_the_page_reads_the_same_two_flags(admin):
    """The screen had the bug from the other side: it derived its own flag as
    `Boolean(is_superadmin)` out of localStorage, so a Business Owner — allowed
    by the API all along — still saw the view-only banner."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[2] / "frontend_src" / "src"
           / "pages" / "Settings.jsx").read_text(encoding="utf-8")

    assert "Boolean(_u.is_superadmin)" not in src
    assert "const { isAdmin, can } = usePermissions();" in src
    assert "const canEdit = isAdmin || can('settings', 'edit');" in src
    # The backup block is the one thing still gated on admin.
    assert src.count("{isAdmin && form.local_backup") == 1
