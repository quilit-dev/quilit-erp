"""The audit write helper must not live behind an HTTP layer.

`log_action` is a plain function: connection in, row out. It used to be defined
in `routers/audit.py`, so 39 of the 47 routers imported a *router* --- a module
whose reason to exist is GET /api/audit, which pulls in FastAPI, `require_admin`
and `get_db` --- in order to write a log row. The import graph said the router
layer depended on itself, which is both untrue and the kind of thing that ends
with a circular import at the worst possible moment.

Nothing here tests behaviour; `test_audit_chain.py` does that. These tests
protect the shape, because the shape is the entire point of the move and is
exactly what an unthinking `from routers.audit import log_action` would undo.
"""
import ast
import pathlib

import pytest

BACKEND = pathlib.Path(__file__).resolve().parent.parent
ROUTERS = BACKEND / "routers"


def _imported_modules(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            out.append(node.module)
        elif isinstance(node, ast.Import):
            out.extend(a.name for a in node.names)
    return out


def test_no_router_reaches_into_the_audit_router_for_log_action():
    offenders = [
        p.name for p in ROUTERS.glob("*.py")
        if p.name != "audit.py"
        and "from routers.audit import" in p.read_text(encoding="utf-8")
    ]
    assert not offenders, (
        "these routers import the audit ROUTER to write a log row: %s. "
        "It is `from audit_log import log_action`." % ", ".join(sorted(offenders)))


def test_the_helper_module_knows_nothing_about_http():
    """If this module ever needs FastAPI it has stopped being a helper."""
    mods = _imported_modules(BACKEND / "audit_log.py")
    forbidden = [m for m in mods
                 if m.split(".")[0] in {"fastapi", "starlette", "routers", "main"}]
    assert not forbidden, (
        "audit_log.py imported %s. The write path must stay callable from a "
        "script, a migration or a background job --- anywhere without a "
        "request." % forbidden)


def test_it_does_not_import_the_router_layer_back():
    """The direction of the dependency is the whole change.

    `routers/audit.py` importing `audit_log` is correct. The reverse would
    reinstate the cycle under a new name.
    """
    assert "audit_log" in _imported_modules(ROUTERS / "audit.py")


def test_the_old_import_path_still_resolves():
    """Re-exported on purpose: a move should not be able to break a caller."""
    import audit_log
    import routers.audit as audit_router
    assert audit_router.log_action is audit_log.log_action


@pytest.mark.parametrize("name", ["_GENESIS", "_chain_hash", "_content_payload"])
def test_verify_still_shares_one_chain_implementation(name):
    """Two copies of the hash rule would make GET /verify report tampering on
    honest rows --- the failure mode is a false accusation, so the shared
    identity is worth asserting rather than assuming."""
    import audit_log
    import routers.audit as audit_router
    assert getattr(audit_router, name) is getattr(audit_log, name)
