"""The inventory import wizard offers the tenant's OWN attribute columns.

This failed silently in production and nowhere else. The query read

    SELECT DISTINCT name FROM attribute_defs ORDER BY sort_order, name

which SQLite accepts and PostgreSQL rejects — "for SELECT DISTINCT, ORDER BY
expressions must appear in select list". Every test and every dev install runs
SQLite, so it passed everywhere it was ever run; the deployed database raised,
and a bare `except Exception` turned that into silence. The wizard then offered
only the built-in columns, so a customer who had defined "Voltage" could not
import it — the exact failure the function exists to prevent.

Two guards below: the behaviour, and the portability rule for the whole codebase,
since a SQLite-only construct is invisible to a SQLite-only test run.
"""
import re
import pathlib

import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _define(client, name, sort_order, **extra):
    """Create an attribute the way the product screens do.

    Through the API rather than a direct connection: seeding with
    `database.session()` holds a pooled connection across the harness's
    per-test database reset, which is fine on SQLite and makes the Postgres
    run error in teardown. The endpoint is also what a tenant actually uses.
    """
    body = {"name": name, "input_type": "text", "sort_order": sort_order,
            "scope_type": "global", "scope_value": None, "is_variant_axis": False}
    body.update(extra)
    return client.post("/api/products/attribute-defs", json=body)


def test_the_wizard_offers_the_tenants_own_attributes(client):
    assert _define(client, "Voltage", 1).status_code == 200
    assert _define(client, "Finish", 2).status_code == 200

    schema = client.get("/api/imports/inventory/schema")
    assert schema.status_code == 200, schema.text
    keys = [f["key"] for f in schema.json()["fields"]]

    assert "Voltage" in keys, "a customer's own attribute must be importable"
    assert "Finish" in keys


def test_they_come_back_in_the_defined_order(client):
    # sort_order is the point of ordering by it: the wizard's column list should
    # follow the order the tenant arranged their attributes in.
    _define(client, "Zeta", 2)
    _define(client, "Alpha", 1)

    fields = client.get("/api/imports/inventory/schema").json()["fields"]
    keys = [f["key"] for f in fields]

    assert keys.index("Alpha") < keys.index("Zeta")


def test_a_repeated_name_is_listed_once(client):
    # The original query used DISTINCT for this. GROUP BY has to keep doing it,
    # or a duplicated definition shows the column twice in the mapping step.
    # Same name in two scopes — the uniqueness constraint is per scope, so this
    # is a shape a tenant can genuinely reach.
    _define(client, "Voltage", 1)
    _define(client, "Voltage", 5, scope_type="category", scope_value="Tools")

    keys = [f["key"] for f in client.get("/api/imports/inventory/schema").json()["fields"]]
    assert keys.count("Voltage") == 1


def test_no_attributes_defined_is_not_an_error(client):
    schema = client.get("/api/imports/inventory/schema")
    assert schema.status_code == 200
    assert any(f["key"] == "name" for f in schema.json()["fields"])


# ── the portability rule, for every query in the codebase ────────────────────

def _sql_literals():
    """Every string literal in backend/ that is actually a SQL statement.

    Matching on 'starts with SELECT' keeps docstrings and prose out — an earlier
    version of this scan reported four findings, three of which were English
    sentences that happened to contain the words it was looking for.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    pattern = re.compile(r'"""(.*?)"""|"([^"\n]*)"|\'([^\'\n]*)\'', re.S)
    for path in root.rglob("*.py"):
        if "tests" in path.parts:
            continue
        src = path.read_text(encoding="utf-8", errors="ignore")
        for m in pattern.finditer(src):
            text = next(g for g in m.groups() if g is not None)
            if re.match(r'\s*SELECT\s', text, re.I):
                yield path.name, src[:m.start()].count("\n") + 1, text


def test_no_select_distinct_orders_by_an_unselected_column():
    """PostgreSQL rejects it; SQLite does not. A SQLite-only test run cannot
    tell the difference, so the rule is checked statically instead."""
    offenders = []
    for name, line, sql in _sql_literals():
        if not re.search(r'SELECT\s+DISTINCT', sql, re.I):
            continue
        order = re.search(r'ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s*$)', sql, re.I | re.S)
        select = re.search(r'SELECT\s+DISTINCT\s+(.+?)\s+FROM', sql, re.I | re.S)
        if not (order and select):
            continue
        selected = {c.strip().split()[-1].lower().split(".")[-1]
                    for c in select.group(1).split(",") if c.strip()}
        for term in order.group(1).split(","):
            col = term.strip().split()[0].lower().split(".")[-1]
            if col and not col.isdigit() and col not in selected:
                offenders.append(f"{name}:{line} ORDER BY {col} — {sql.strip()[:70]}")
                break

    assert not offenders, (
        "SELECT DISTINCT ordered by a column that is not selected. Valid on "
        "SQLite, rejected by PostgreSQL:\n  " + "\n  ".join(offenders))
