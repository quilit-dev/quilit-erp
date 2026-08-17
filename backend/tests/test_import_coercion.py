"""Spreadsheet cells are text; the models want types.

The bug this covers: moving suppliers between workspaces means exporting a list
and importing it, and our own suppliers export wrote the payment terms as
"30 days". Every row then failed with

    payment_terms_days: Input should be a valid integer, unable to parse string
    as an integer

The field types in ENTITIES were declared but never applied — every cell went to
Pydantic as a raw string. They are applied now, which also fixes the files people
have already exported and cannot re-export from a workspace they have left.

The limit matters as much as the tolerance: a cell we cannot read must stay a
rejected row. Turning an unreadable cell into a plausible number puts silent
wrong data in a supplier record, which is worse than an error message.
"""
import pytest

from routers.imports import ENTITIES, _clean, _coerce, _parse_row


SUPPLIERS = ENTITIES["suppliers"]


# ── the reported failure ─────────────────────────────────────────────────────

def test_our_own_export_can_be_imported_back():
    """The exact row the suppliers export used to produce."""
    row = {"name": "Acme Ltd", "contact_name": "Sara",
           "phone": "+961 71 000 000", "payment_terms_days": "30 days"}

    model, errors = _parse_row(SUPPLIERS, row)

    assert errors == []
    assert model.payment_terms_days == 30


@pytest.mark.parametrize("cell,expected", [
    ("30 days", 30),
    ("30days", 30),
    ("  30 Days  ", 30),
    ("30", 30),
    ("30.0", 30),          # a spreadsheet that stored the integer as a float
    ("1,234", 1234),       # thousands separator from a locale-formatted sheet
    (30, 30),              # xlsx numeric cell — already typed, untouched
    (30.0, 30.0),
])
def test_integers_a_spreadsheet_actually_contains(cell, expected):
    assert _coerce(cell, "int") == expected


# ── what must still be refused ───────────────────────────────────────────────

@pytest.mark.parametrize("cell", [
    "thirty",         # words are not numbers
    "30-60",          # a RANGE: picking 30 would be inventing the answer
    "net 30",         # the number is not the whole cell
    "30.5",           # not an integer, and truncating it would be silent damage
    "3 0",
])
def test_a_cell_we_cannot_read_stays_an_error(cell):
    # _coerce hands the value back untouched so the model produces the message.
    assert _coerce(cell, "int") == cell

    model, errors = _parse_row(
        SUPPLIERS, {"name": "Acme Ltd", "payment_terms_days": cell})
    assert model is None
    assert any("payment_terms_days" in e for e in errors), errors


def test_a_range_is_not_quietly_halved():
    # Worth its own test: this is the case where tolerant parsing would do real
    # damage, by agreeing to a number nobody wrote.
    model, errors = _parse_row(
        SUPPLIERS, {"name": "Acme Ltd", "payment_terms_days": "30-60"})

    assert model is None, "a range must not import as 30"


# ── blanks still fall through to the model default ───────────────────────────

@pytest.mark.parametrize("cell", ["", "   ", None])
def test_an_empty_cell_takes_the_default(cell):
    model, errors = _parse_row(
        SUPPLIERS, {"name": "Acme Ltd", "payment_terms_days": cell})

    assert errors == []
    assert model.payment_terms_days == 30, "the model's own default"


# ── the other declared types ─────────────────────────────────────────────────

@pytest.mark.parametrize("cell,expected", [
    ("yes", True), ("Yes", True), ("TRUE", True), ("1", True), ("y", True),
    ("no", False), ("No", False), ("false", False), ("0", False), ("n", False),
])
def test_booleans_as_people_write_them(cell, expected):
    assert _coerce(cell, "bool") is expected


@pytest.mark.parametrize("cell,expected", [
    ("12.5", 12.5),
    ("12.5 kg", 12.5),
    ("1,234.56", 1234.56),
    ("-3", -3.0),
])
def test_decimals(cell, expected):
    assert _coerce(cell, "number") == expected


def test_untyped_fields_are_left_alone():
    # Most columns are free text. "30 days" in a notes field is a note.
    assert _coerce("30 days", None) == "30 days"
    assert _clean({"notes": "30 days"}, SUPPLIERS["fields"])["notes"] == "30 days"


def test_unknown_columns_are_still_dropped():
    out = _clean({"name": "Acme", "not_a_field": "x"}, SUPPLIERS["fields"])
    assert out == {"name": "Acme"}


# ── the export that produced the bad file ────────────────────────────────────

def test_the_suppliers_export_headers_map_to_import_fields():
    """The wizard auto-maps by stripping non-alphanumerics from the header, so
    an exported header must normalise to a field's key or label. 'Payment Terms'
    did not match 'payment_terms_days', which is why the column had to be mapped
    by hand before it could fail on its contents."""
    import re as _re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2]
           / "frontend_src" / "src" / "pages" / "Suppliers.jsx").read_text(encoding="utf-8")
    block = src.split("const exportData")[1].split("}));")[0]
    headers = _re.findall(r"^\s*'?([A-Za-z][^':]*?)'?:", block, _re.M)

    norm = lambda s: _re.sub(r"[^a-z0-9]", "", s.lower())
    field_names = {norm(f["key"]) for f in SUPPLIERS["fields"]}
    field_names |= {norm(f["label"]) for f in SUPPLIERS["fields"]}

    # Computed columns are reference-only and deliberately not importable.
    reference_only = {norm(h) for h in ("# Purchases", "Total Spend", "Created")}
    importable = [h for h in headers if norm(h) not in reference_only]

    assert importable, f"parsed no headers from the export block: {headers}"
    unmapped = [h for h in importable if norm(h) not in field_names]
    assert not unmapped, f"these exported columns will not auto-map: {unmapped}"


def test_the_export_writes_no_units_into_number_cells():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2]
           / "frontend_src" / "src" / "pages" / "Suppliers.jsx").read_text(encoding="utf-8")
    block = src.split("const exportData")[1].split("}));")[0]

    assert "days`" not in block, "the unit belongs in the header, not the cell"


# ── end to end, through the endpoint the wizard actually calls ───────────────

def test_the_wizard_validates_and_commits_the_exported_file(as_role):
    """The reported failure, reproduced at the API boundary and then fixed:
    six supplier rows carrying "30 days" in the payment terms column."""
    client = as_role("superadmin")
    rows = [{"name": f"Supplier {i}", "contact_name": f"Rep {i}",
             "phone": f"+961 71 00000{i}", "payment_terms_days": "30 days"}
            for i in range(1, 7)]

    v = client.post("/api/imports/suppliers/validate", json={"rows": rows})
    assert v.status_code == 200, v.text
    body = v.json()
    problems = [r for r in body["rows"] if r.get("errors")]
    assert not problems, problems
    assert body["errors"] == 0
    assert body["ok"] == 6
    # The preview the wizard shows must carry the parsed integer, not the text.
    assert body["rows"][0]["preview"]["payment_terms_days"] == 30

    c = client.post("/api/imports/suppliers/commit", json={"rows": rows})
    assert c.status_code == 200, c.text

    created = client.get("/api/suppliers/").json()
    by_name = {s["name"]: s for s in created}
    for i in range(1, 7):
        assert by_name[f"Supplier {i}"]["payment_terms_days"] == 30
