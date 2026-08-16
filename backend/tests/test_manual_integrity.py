"""Cheap structural checks on the user manual's source.

`mkdocs build --strict` catches broken links and missing nav entries. It does
not catch a code fence that was opened and never closed — Markdown simply
treats the rest of the file as code, so half a page renders as a grey block and
the build reports success. That is exactly how it failed once: removing a SQL
example left its closing ``` behind, and everything below it on the page —
headings, tables, a diagram — silently became code.

Nor does it catch a diagram that will not parse. A broken Mermaid block renders
as "Syntax error in text" in the browser, at build time it is just a string.
Parsing Mermaid properly needs a browser, so this settles for the mistake that
actually happened: a label containing brackets or parentheses, which ends the
label early and derails the parser.
"""
import pathlib
import re

import pytest

MANUAL = pathlib.Path(__file__).resolve().parents[2] / "docs" / "manual" / "docs"
PAGES = sorted(MANUAL.rglob("*.md"))
FENCE = re.compile(r"^\s*```")


def _rel(p):
    return str(p.relative_to(MANUAL)).replace("\\", "/")


def test_the_manual_is_where_this_expects_it():
    # A moved docs tree would make every test below vacuously pass.
    assert PAGES, f"no manual pages found under {MANUAL}"


@pytest.mark.parametrize("page", PAGES, ids=_rel)
def test_code_fences_are_balanced(page):
    opens = [i for i, line in enumerate(page.read_text(encoding="utf-8").splitlines(), 1)
             if FENCE.match(line)]

    assert len(opens) % 2 == 0, (
        f"{_rel(page)} has {len(opens)} code fences — an odd number means one was "
        f"left open (last at line {opens[-1]}), and everything after it renders "
        f"as code instead of prose"
    )


@pytest.mark.parametrize("page", PAGES, ids=_rel)
def test_diagram_labels_do_not_break_the_parser(page):
    """Mermaid ends a [label] at the first bracket, so nesting one kills it."""
    text = page.read_text(encoding="utf-8")
    offenders = []
    for block in re.findall(r"```mermaid\n(.*?)```", text, re.S):
        for label in re.findall(r"\[([^\]]*)\]", block):
            if label.startswith('"') and label.endswith('"'):
                continue                      # quoting is the documented escape
            if any(c in label for c in "()[]{}"):
                offenders.append(label)

    assert not offenders, (
        f"{_rel(page)}: Mermaid labels containing brackets render as "
        f"'Syntax error in text' — quote them or reword: {offenders}"
    )
