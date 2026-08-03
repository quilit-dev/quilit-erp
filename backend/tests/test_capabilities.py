"""
Module licensing graph — every sellable combination must resolve to a set that
actually works. These tests exist to stop an invalid plan from ever reaching a
customer: the failure mode is not a crash but a tenant seeing 403s on links the
UI still shows, which reads as a broken product.
"""
import capabilities as caps


def test_always_on_survives_an_empty_purchase():
    """A customer who buys nothing still gets the platform plumbing and the
    ledger engine — seven modules post to the GL, so it can never be off."""
    resolved = caps.resolve(set())
    assert caps.ALWAYS_ON <= resolved
    assert "accounting" in resolved


def test_pos_pulls_its_whole_chain():
    """POS writes an invoice, moves stock and settles into a drawer."""
    resolved = caps.resolve({"pos"})
    for needed in ("invoices", "inventory", "cash", "clients"):
        assert needed in resolved, f"pos must imply {needed}"


def test_closure_is_transitive_not_one_hop():
    """pos -> cash -> finance. A single pass would miss finance."""
    resolved = caps.resolve({"pos"})
    assert "cash" in resolved
    assert "finance" in resolved, "closure stopped before the second hop"


def test_quotations_imply_invoices():
    assert "invoices" in caps.resolve({"quotations"})


def test_people_modules_hang_off_hr():
    for module in ("recruitment", "hr_contracts", "hr_activities"):
        assert "hr" in caps.resolve({module}), f"{module} must imply hr"


def test_reports_never_drags_other_modules_in():
    """Reports renders whatever is licensed; it must not force a purchase."""
    resolved = caps.resolve({"reports"})
    assert resolved == caps.ALWAYS_ON | {"reports"}


def test_unknown_modules_are_dropped_not_fatal():
    """A stale plan naming a removed module should degrade, not 500."""
    assert caps.resolve({"pos", "no_such_module"}) == caps.resolve({"pos"})


def test_required_by_explains_the_lock():
    """The UI needs to say WHY a box is checked and disabled."""
    assert caps.required_by("inventory", {"pos"}) == {"pos"}
    assert caps.required_by("inventory", {"crm"}) == set()


def test_always_on_is_never_reported_as_locked_by_a_purchase():
    """Platform modules are on for their own reasons, not because of a sale."""
    assert caps.required_by("dashboard", {"pos"}) == set()


def test_resolve_is_idempotent():
    once = caps.resolve({"pos", "manufacturing"})
    assert caps.resolve(once) == once


def test_every_dependency_is_itself_a_known_module():
    """Guards against a typo in the graph silently doing nothing."""
    for module, needs in caps._REQUIRES.items():
        assert caps.known_module(module), f"unknown module in graph: {module}"
        for dep in needs:
            assert caps.known_module(dep), f"{module} requires unknown {dep}"


def test_no_module_requires_itself():
    for module, needs in caps._REQUIRES.items():
        assert module not in needs, f"{module} requires itself"


def test_every_known_module_resolves_without_error():
    """Sanity: buying any single module produces a workable set."""
    for entry in caps.catalog():
        resolved = caps.resolve({entry["key"]})
        assert entry["key"] in resolved
        assert caps.ALWAYS_ON <= resolved
