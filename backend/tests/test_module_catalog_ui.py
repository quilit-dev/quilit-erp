"""
Every sellable module must be offered in the Control Center's picker.

This is a cross-language consistency check, and it exists because the failure it
catches is silent and expensive: the picker renders only modules listed in its
own presentation GROUPS, so a module added to the backend but forgotten in the
frontend cannot be licensed at all. It is invisible in the editor, no operator
can tick it, and — because an empty licence means unrestricted — it quietly
appears to work until the first tenant gets a real licence and it vanishes.

That happened to `communications` on the day it was added.

Reading the JSX with a regex is deliberately crude. The alternative is no check,
because there is no shared manifest between the Python module registry and the
React picker; a crude check that fails loudly beats a clean one that does not
exist.
"""
import pathlib
import re

import pytest

import capabilities
from permissions import ADMIN_MODULES

_PICKER = (pathlib.Path(__file__).resolve().parents[2]
           / "frontend_src" / "src" / "pages" / "platform" / "ModulePicker.jsx")

# Always-on plumbing is deliberately NOT offered as a choice: it cannot be
# turned off, so a permanently-locked tickbox for each would be noise. These are
# the modules allowed to be absent from the picker.
_NOT_SELLABLE = set(ADMIN_MODULES) | set(capabilities.ALWAYS_ON)


def _picker_source() -> str:
    if not _PICKER.exists():
        pytest.skip(f"picker not found at {_PICKER}")
    return _PICKER.read_text(encoding="utf-8")


def _grouped_keys(src: str) -> set:
    """Pull every quoted key out of the GROUPS array."""
    m = re.search(r"export const GROUPS\s*=\s*\[(.*?)\n\];", src, re.S)
    assert m, "could not locate GROUPS in ModulePicker.jsx"
    return set(re.findall(r"'([a-z0-9_]+)'", m.group(1)))


def _label_keys(src: str) -> set:
    m = re.search(r"export const LABEL\s*=\s*\{(.*?)\n\};", src, re.S)
    assert m, "could not locate LABEL in ModulePicker.jsx"
    return set(re.findall(r"(\w+)\s*:", m.group(1)))


def test_every_sellable_module_is_offered_in_the_picker():
    grouped = _grouped_keys(_picker_source())
    sellable = {m["key"] for m in capabilities.catalog()} - _NOT_SELLABLE
    missing = sorted(sellable - grouped)
    assert not missing, (
        "These modules exist in the backend but are not in ModulePicker's "
        f"GROUPS, so no operator can license them: {missing}")


def test_every_offered_module_actually_exists():
    """The reverse: a key left behind after a rename would render a checkbox
    that writes a licence the backend then discards, because _apply_profile
    filters through capabilities.known_module()."""
    grouped = _grouped_keys(_picker_source())
    unknown = sorted(k for k in grouped if not capabilities.known_module(k))
    assert not unknown, (
        f"ModulePicker offers modules the backend does not know: {unknown}")


def test_every_offered_module_has_a_human_label():
    """Without a LABEL entry the picker falls back to the raw key, so an
    operator is asked to license 'hr_contracts' rather than 'Contracts'."""
    src = _picker_source()
    grouped, labels = _grouped_keys(src), _label_keys(src)
    unlabelled = sorted(grouped - labels)
    assert not unlabelled, f"No LABEL for: {unlabelled}"
