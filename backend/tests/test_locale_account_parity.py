"""
Every seeded account must exist in BOTH locale files, with its English text
matching the seed exactly.

The chart of accounts is written to the database in English, so the UI can only
translate it through a lookup keyed by account code. A seeded account with no
locale entry silently renders in English — which is invisible, because English
IS the fallback. That is exactly how it was reported: an Arabic General Ledger
still listing "Foreign Exchange Gain".

It happened because the accounts are seeded in TWO places — the original 26 in
`_seed_accounts`, plus four more added by migration 120 (multi-currency) — and
only the first list was translated. A third list added later would repeat it.

Reads source as TEXT, like test_migration_parity.py: no database, no app import,
and it therefore also covers the PostgreSQL baseline that a fresh cloud install
actually uses.
"""
import re
import pathlib

import pytest

BACKEND  = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = BACKEND.parent / "frontend_src" / "src" / "locales"

pytestmark = pytest.mark.skipif(
    not FRONTEND.exists(),
    reason="frontend sources not present (backend-only checkout)",
)

_ACCOUNT_ROW = re.compile(
    r"\(\s*\"(\d{4})\",\s*\"([^\"]+)\",\s*\"(?:Asset|Liability|Equity|Income|Expense)\""
)
_PG_ROW = re.compile(r"\((?:\d+,\s*)?'(\d{4})',\s*'((?:[^']|'')+)'")


def _seeded_accounts() -> dict:
    """{code: english_name} from every place accounts are seeded."""
    out = {}
    src = (BACKEND / "database.py").read_text(encoding="utf-8-sig")
    for code, name in _ACCOUNT_ROW.findall(src):
        out[code] = name

    baseline = BACKEND / "migrations" / "pg_baseline.sql"
    if baseline.exists():
        pg = baseline.read_text(encoding="utf-8", errors="replace")
        idx = pg.find("INSERT INTO chart_of_accounts")
        if idx != -1:
            for code, name in _PG_ROW.findall(pg[idx:idx + 8000]):
                out.setdefault(code, name.replace("''", "'"))
    return out


def _locale_accounts(lang: str) -> dict:
    text = (FRONTEND / f"{lang}.js").read_text(encoding="utf-8")
    block = re.search(r"accountNames: \{(.*?)\n  \},", text, re.S)
    assert block, f"{lang}.js has no accountNames block"
    return dict(re.findall(r"'(\d{4})':\s*['\"](.+?)['\"],", block.group(1)))


def test_the_seed_lists_are_actually_found():
    """Guard the guard: if the regex stops matching, every assertion below
    passes vacuously and the check quietly stops protecting anything."""
    seeded = _seeded_accounts()
    assert len(seeded) >= 26, f"only found {len(seeded)} seeded accounts"
    # One from each of the two seed sites.
    assert seeded.get("1000") == "Cash & Bank"
    assert seeded.get("6920") == "Foreign Exchange Loss"


@pytest.mark.parametrize("lang", ["en", "ar"])
def test_every_seeded_account_has_a_locale_entry(lang):
    seeded = _seeded_accounts()
    have = _locale_accounts(lang)
    missing = sorted(set(seeded) - set(have))
    assert not missing, (
        f"{lang}.js is missing {len(missing)} seeded account(s): "
        + ", ".join(f"{c} ({seeded[c]})" for c in missing)
        + " — they will render in English on an otherwise translated screen"
    )


def test_english_locale_matches_the_seed_text_exactly():
    """`tAccount` translates only while the stored name still equals the seeded
    English — that is how an owner's rename is respected. So a typo here does
    not show up as a wrong label; it silently disables translation for that
    account."""
    seeded = _seeded_accounts()
    en = _locale_accounts("en")
    wrong = [(c, seeded[c], en[c]) for c in seeded if c in en and seeded[c] != en[c]]
    assert not wrong, (
        "en.js text differs from the seeded name, which disables translation:\n"
        + "\n".join(f"  {c}: seed={s!r} locale={l!r}" for c, s, l in wrong)
    )


def test_arabic_is_actually_translated():
    """An Arabic entry left as its English source is the bug wearing a
    disguise: present, so nothing looks missing, but still English on screen."""
    en = _locale_accounts("en")
    ar = _locale_accounts("ar")
    untranslated = [c for c in en if c in ar and ar[c] == en[c]]
    assert not untranslated, (
        "these Arabic entries are still the English text: "
        + ", ".join(f"{c} ({en[c]})" for c in untranslated)
    )


def test_no_stale_locale_entries():
    """An account removed from the seed should not linger in the dictionaries."""
    seeded = _seeded_accounts()
    for lang in ("en", "ar"):
        extra = sorted(set(_locale_accounts(lang)) - set(seeded))
        assert not extra, f"{lang}.js has entries for accounts that are not seeded: {extra}"
