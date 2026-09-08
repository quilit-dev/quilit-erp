"""A backfill that runs on every boot must be one that cannot do harm twice.

`_ensure_pg_post_baseline` runs on EVERY worker boot, for EVERY tenant schema.
Its `CREATE ... IF NOT EXISTS` and `ALTER ... IF NOT EXISTS` statements are
no-ops once applied. Its `UPDATE`s are not: an UPDATE re-runs in full, every
time, and only its WHERE clause decides whether that is harmless.

The rule, which is what this file enforces:

    An unguarded backfill is safe only if its WHERE clause describes a state
    the running application can never create again.

`fixed_assets` broke that rule and cost real money. The SQLite chain had it
behind `need("167j_existing_assets_are_openings")` -- run once, ever. The
Postgres mirror was hand-copied without the guard, so on every deploy it ran:

    UPDATE fixed_assets SET is_opening_balance = 1
     WHERE acquisition_entry_id IS NULL

`acquisition_entry_id IS NULL` is not a legacy state. `routers/assets.py`
creates every asset that way and only fills it in on approval, so an asset held
behind a capex policy sat in exactly that shape. A deploy in that window
relabelled it an opening balance; `approval_engine.py` then posts the
acquisition only `if not acquisition_entry_id and not is_opening_balance`, so
it skipped. The asset was approved, appeared on the register, and never reached
the general ledger -- no error, no log line, and a balance sheet quietly short.

Every other unguarded UPDATE in that function was audited against the same
rule and allowed below, each with the reason it cannot re-match. Adding a new
one fails this test until it is either guarded or justified here, which is the
point: the next person has to make the same argument deliberately.
"""
import pathlib
import re

import pytest

pytestmark = pytest.mark.critical

_DB = pathlib.Path(__file__).resolve().parents[1] / "database.py"


def _postgres_mirror() -> str:
    src = _DB.read_text(encoding="utf-8")
    start = src.index("def _ensure_pg_post_baseline")
    end = src.index("\ndef ", start + 10)
    return src[start:end]


def _updates_with_guard_state():
    """Every UPDATE in the mirror, paired with whether a marker guards it.

    'Guarded' means the ledger is consulted just above it --- the shape used by
    159b, 172c and the rest:

        cur.execute("SELECT 1 FROM schema_migrations WHERE name='...'")
        if not cur.fetchone():
            ...
    """
    lines = _postgres_mirror().splitlines()
    out = []
    for i, line in enumerate(lines):
        if "cur.execute(" not in line:
            continue
        # The statement must START with UPDATE. Matching "UPDATE anywhere in
        # the next four lines" also catches the guard's own
        # `SELECT 1 FROM schema_migrations` line, whose window then reads as
        # unguarded --- flagging precisely the correctly-guarded backfills.
        tail = line.split("cur.execute(", 1)[1].lstrip()
        if not tail or tail[0] in ")":                       # execute(sql_var)
            continue
        opener = tail.lstrip("f").lstrip("\"'").lstrip()
        if not opener:                                       # opens on the next line
            opener = lines[i + 1].strip().lstrip("f").lstrip("\"'").lstrip() \
                if i + 1 < len(lines) else ""
        if not opener.upper().startswith("UPDATE"):
            continue

        stmt = " ".join(x.strip().strip('"') for x in lines[i:i + 4])
        out.append((stmt, _inside_a_guard(lines, i)))
    return out


def _inside_a_guard(lines, i) -> bool:
    """Is line `i` in the BODY of an `if not cur.fetchone():`?

    Scope has to come from indentation, not proximity. A window that merely
    looks back N lines calls the statement *after* a guarded block guarded too
    --- so a newly added, genuinely unguarded backfill placed under an existing
    guard would slip through, which is the failure this function exists to
    avoid.
    """
    indent = len(lines[i]) - len(lines[i].lstrip())
    for j in range(i - 1, max(-1, i - 40), -1):
        line = lines[j]
        if not line.strip():
            continue
        here = len(line) - len(line.lstrip())
        if here >= indent:
            continue                    # sibling or deeper: keep walking out
        # First line strictly shallower than us: our enclosing block.
        return (line.strip().startswith("if not cur.fetchone():")
                and "schema_migrations" in "\n".join(lines[max(0, j - 4):j]))
    return False


# Unguarded UPDATEs that were audited and found genuinely re-runnable. The
# reason is the load-bearing part: each says WHY the running application cannot
# recreate the state its WHERE clause selects.
_ALLOWED_UNGUARDED = {
    "branch_id":
        "accounting.py:337 assigns a branch on every insert when none is "
        "given, so `WHERE branch_id IS NULL` stops matching after the first "
        "pass and no new row can re-enter that state.",
    "username = username":
        "self-limiting by its own `AND username NOT LIKE ('%#deleted' || id)` "
        "-- a row it has already suffixed is excluded from the next pass.",
    "service_jobs SET status":
        "Draft / Scheduled / In Progress / Completed were renamed and now "
        "appear nowhere in routers/service.py except a comment (ST_OPEN = "
        "'Open'), so the application cannot produce a row this matches.",
    "invoices SET source_type":
        "fills blanks only, and the pos/service/quotation/project inferences "
        "run BEFORE the 'sales' catch-all, so an invoice that belongs to one "
        "of those is labelled from its join rather than defaulted.",
    "exchange_rates SET effective_date":
        "routers/settings.py:439 does `on = (body.effective_date or "
        "_today())[:10]` before every insert, so `WHERE effective_date IS "
        "NULL` cannot match a row the application created.",
}


def _is_allowed(stmt: str) -> bool:
    return any(key in stmt for key in _ALLOWED_UNGUARDED)


def test_the_fixed_assets_backfill_is_marker_guarded():
    """The one that cost money. Pinned by name so it cannot regress quietly."""
    mirror = _postgres_mirror()
    idx = mirror.find("UPDATE fixed_assets SET is_opening_balance")
    assert idx != -1, "the backfill vanished -- if that is deliberate, delete this test"

    window = mirror[max(0, idx - 900):idx]
    assert "167j_existing_assets_are_openings" in window, (
        "UPDATE fixed_assets SET is_opening_balance is no longer behind its "
        "schema_migrations marker. Unguarded, it runs on every worker boot for "
        "every tenant and relabels assets that are merely awaiting approval -- "
        "and approval_engine then skips posting them to the ledger.")
    assert "if not cur.fetchone():" in window


def test_every_unguarded_backfill_has_been_justified():
    """A new unguarded UPDATE has to be argued for, not just written."""
    offenders = [stmt for stmt, guarded in _updates_with_guard_state()
                 if not guarded and not _is_allowed(stmt)]
    assert not offenders, (
        "Unguarded UPDATE(s) in _ensure_pg_post_baseline that are not in the "
        "audited allow-list.\n\nThis function runs on every worker boot for "
        "every tenant, so an UPDATE re-runs in full each time. Either put it "
        "behind a schema_migrations marker, or add it to _ALLOWED_UNGUARDED "
        "with the reason the running application cannot recreate the state its "
        "WHERE clause selects.\n\n  " + "\n  ".join(s[:160] for s in offenders))


def test_the_allow_list_still_describes_real_statements():
    """Stops the allow-list rotting into a set of excuses for nothing."""
    mirror = _postgres_mirror()
    for key in _ALLOWED_UNGUARDED:
        assert key in mirror, (
            "%r is allow-listed but no longer appears in the mirror -- remove "
            "the entry so the list keeps meaning something." % key)


def test_a_guarded_backfill_also_records_its_marker():
    """A guard that never writes its marker runs forever anyway."""
    mirror = _postgres_mirror()
    for m in re.finditer(r"WHERE name='([0-9a-z_]+)'", mirror):
        name = m.group(1)
        after = mirror[m.end():m.end() + 1200]
        assert name in after.split("cur.execute(\"SELECT 1 FROM")[0], (
            "%s is checked but never inserted into schema_migrations, so the "
            "guard is decorative and the backfill repeats on every boot." % name)
