"""
Role wiring verifier.

Checks every role's module permissions against the real cross-module data
dependencies in the app, so no role can reach a screen that needs data from a
module it can't read. Two failure classes:

  * HARD  — the page does Promise.all([... , depFetch()]) on load, so a 403 on
            the dependency throws a visible error. (e.g. ProjectDetail loads
            inventory; a role with projects:view but no inventory:view crashes.)
  * FORM  — a create/edit dropdown fetches the dependency. A 403 is swallowed,
            but the form's selector is empty, so the role can't fill it in.
            Only matters when the role can create/edit the owning module.

Read-only by default — prints a gap report. Pass --fix to grant the missing
*view* permissions in the live DB.

Run from project root:
    python backend/check_role_wiring.py
    python backend/check_role_wiring.py --fix
"""
import os
import sqlite3
import sys
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH") or str(Path(__file__).resolve().parent.parent / "erp.db")

# (owning module, trigger, [dependency modules that need view])
#   trigger 'view'  -> dependency is fetched on page LOAD (hard crash if 403)
#   trigger 'write' -> dependency is a create/edit form selector (empty if 403)
DEP_RULES = [
    ('projects',   'view',  ['inventory']),                      # ProjectDetail Promise.all -> getInventory
    ('projects',   'write', ['clients']),                        # project ↔ client selector
    ('quotations', 'write', ['clients', 'projects', 'inventory']),
    ('invoices',   'write', ['clients', 'projects', 'inventory']),
    ('purchases',  'write', ['suppliers', 'inventory']),
    ('assets',     'write', ['suppliers']),
    ('expenses',   'write', ['projects']),
]


def _gaps(perms):
    """perms: {module: {'can_view','can_create','can_edit',...}}. Returns list of (dep, severity, why)."""
    out = []
    for module, trigger, deps in DEP_RULES:
        p = perms.get(module)
        if not p:
            continue
        if trigger == 'view':
            triggered = bool(p['can_view'])
            severity, why = 'HARD', f'opening {module} loads {{dep}} (page crash)'
        else:
            triggered = bool(p['can_create'] or p['can_edit'])
            severity, why = 'FORM', f'creating/editing {module} needs {{dep}} selector'
        if not triggered:
            continue
        for dep in deps:
            dp = perms.get(dep)
            if not dp or not dp['can_view']:
                out.append((dep, severity, why.format(dep=dep)))
    # de-dupe (same dep can be required by several rules), keep worst severity
    best = {}
    for dep, sev, why in out:
        if dep not in best or (sev == 'HARD' and best[dep][0] != 'HARD'):
            best[dep] = (sev, why)
    return [(d, s, w) for d, (s, w) in best.items()]


def main(fix=False):
    if not os.path.exists(DB_PATH):
        sys.exit(f"DB not found at {DB_PATH}.")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    roles = c.execute("SELECT id, name FROM roles ORDER BY id").fetchall()
    total_gaps = 0
    fixed = 0

    for role in roles:
        perms = {
            row["module"]: row
            for row in c.execute(
                "SELECT module, can_view, can_create, can_edit, can_delete, can_approve "
                "FROM role_permissions WHERE role_id=?", (role["id"],)
            ).fetchall()
        }
        gaps = _gaps(perms)
        if not gaps:
            continue
        total_gaps += len(gaps)
        print(f"\n{role['name']}")
        for dep, sev, why in gaps:
            print(f"  [{sev}] missing {dep}:view  - {why}")
            if fix:
                c.execute("""
                    INSERT INTO role_permissions
                        (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
                    VALUES (?,?,1,0,0,0,0)
                    ON CONFLICT(role_id, module) DO UPDATE SET can_view=1
                """, (role["id"], dep))
                fixed += 1

    if fix:
        conn.commit()
        print(f"\nFixed {fixed} permission gap(s). Re-run without --fix to confirm.")
    elif total_gaps == 0:
        print("All roles are correctly wired - no missing module dependencies.")
    else:
        print(f"\n{total_gaps} gap(s) found. Run with --fix to grant the missing view permissions.")
    conn.close()


if __name__ == "__main__":
    main(fix="--fix" in sys.argv)
