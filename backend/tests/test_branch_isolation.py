"""
Branch isolation — can a manager in one branch reach another branch's money?

Two INDEPENDENT layers exist (see branch_access.py / warehouse_access.py):

  * `users.branch_id`            — what a user can SEE   (this file)
  * `user_warehouse_access`      — where a user may TRANSACT stock

Only the vendor superadmin and admin-tier roles (Business Owner) are *global*
and see every branch. Every other role is pinned to its home branch.

The list endpoints were filtered from the start, but IDs in the URL were not
checked, so a scoped manager could still operate on another branch's records by
guessing an id — the record 404'd when opened yet answered PUT, accepted a
payment, and returned its payment history. Global search returned them outright,
complete with client name and amount.

These are the regression tests for that. They must never go red: each one
corresponds to a way one branch's staff could read or corrupt another's books.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

PW = "Branch123!"


@pytest.fixture
def world(app, db, make_client):
    """Two branches, a scoped manager in each, and a global owner."""
    from auth_utils import hash_password

    owner = make_client("superadmin")
    a_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1").fetchone()["id"]
    r = owner.post("/api/warehouses/",
                   json={"code": "BR2", "name": "Branch Two", "type": "Branch"})
    assert r.status_code in (200, 201), r.text
    b_id = r.json()["id"]

    role = db.execute("SELECT id FROM roles WHERE name='Manager'").fetchone()["id"]
    for name, branch in (("br_alice", a_id), ("br_bob", b_id)):
        db.execute(
            "INSERT INTO users (username, password_hash, full_name, role, role_id,"
            " is_active, is_superadmin, must_change_password, branch_id, created_at)"
            " VALUES (?,?,?,'user',?,1,0,0,?,datetime('now'))",
            (name, hash_password(PW), name, role, branch))
    db.commit()

    def login(u):
        c = TestClient(app)
        r = c.post("/api/auth/login", json={"username": u, "password": PW})
        assert r.status_code == 200, r.text
        return c

    alice, bob = login("br_alice"), login("br_bob")
    client_id = owner.post("/api/clients/", json={"name": "Shared Client"}).json()["id"]

    invoice = alice.post("/api/invoices/", json={
        "client_id": client_id,
        "items": [{"name": "ALICE-SECRET", "quantity": 1, "unit_price": 1000}]}).json()
    quote = alice.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "ALICE-QUOTE", "quantity": 1, "unit_price": 500}]}).json()
    alice.post(f"/api/invoices/{invoice['id']}/payments", json={
        "amount": 100, "method": "Cash", "idempotency_key": str(uuid.uuid4())})

    return {"owner": owner, "alice": alice, "bob": bob,
            "client_id": client_id, "invoice": invoice, "quote": quote}


def _hits(resp):
    """Result count — the response echoes the query string, so searching the
    raw body for the term matches the echo and always 'finds' it."""
    return resp.json().get("count", -1)


# ── the other branch is unreachable ─────────────────────────────────────────

def test_cannot_edit_another_branchs_invoice(world, db):
    """The one that corrupts books: this rewrote the line items and dropped a
    $1,000 invoice to $1."""
    inv = world["invoice"]
    before = db.execute("SELECT amount FROM invoices WHERE id=?", (inv["id"],)).fetchone()["amount"]

    r = world["bob"].put(f"/api/invoices/{inv['id']}", json={
        "client_id": world["client_id"],
        "items": [{"name": "HIJACKED", "quantity": 1, "unit_price": 1}]})

    after = db.execute("SELECT amount FROM invoices WHERE id=?", (inv["id"],)).fetchone()["amount"]
    assert r.status_code == 404, r.text
    assert after == before, "another branch rewrote this invoice"


def test_cannot_pay_another_branchs_invoice(world, db):
    inv = world["invoice"]
    before = db.execute("SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id=?",
                        (inv["id"],)).fetchone()["n"]

    r = world["bob"].post(f"/api/invoices/{inv['id']}/payments", json={
        "amount": 50, "method": "Bank Transfer", "idempotency_key": str(uuid.uuid4())})

    after = db.execute("SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id=?",
                       (inv["id"],)).fetchone()["n"]
    assert r.status_code == 404, r.text
    assert after == before, "a payment landed on another branch's invoice"


def test_cannot_read_another_branchs_payment_history(world):
    """Amounts, methods and dates — visible even though the invoice 404'd."""
    r = world["bob"].get(f"/api/invoices/{world['invoice']['id']}/payments")
    assert r.status_code == 404, r.text


@pytest.mark.parametrize("action", ["void", "archive"])
def test_cannot_void_or_archive_another_branchs_invoice(world, action):
    r = world["bob"].patch(f"/api/invoices/{world['invoice']['id']}/{action}",
                           json={"reason": "x"})
    assert r.status_code in (403, 404), r.text


def test_cannot_edit_another_branchs_quotation(world):
    r = world["bob"].put(f"/api/quotations/{world['quote']['id']}", json={
        "client_id": world["client_id"],
        "items": [{"name": "HJ", "quantity": 1, "unit_price": 1}]})
    assert r.status_code == 404, r.text


def test_cannot_convert_another_branchs_quotation(world, db):
    """Conversion mints an invoice — in the attacker's branch, from a document
    they were never allowed to see."""
    before = db.execute("SELECT COUNT(*) AS n FROM invoices").fetchone()["n"]
    r = world["bob"].post(f"/api/quotations/{world['quote']['id']}/convert-to-invoice",
                          json={})
    after = db.execute("SELECT COUNT(*) AS n FROM invoices").fetchone()["n"]
    assert r.status_code == 404, r.text
    assert after == before, "an invoice was minted from another branch's quotation"


@pytest.mark.parametrize("term", ["ALICE-SECRET", "ALICE-QUOTE"])
def test_search_does_not_cross_branches(world, term):
    """Search returned the record with client name and amount, which is the
    leak even though opening it 404s."""
    assert _hits(world["bob"].get(f"/api/search/?q={term}")) == 0


# ── ...while the owning branch is unaffected ────────────────────────────────

def test_owner_of_the_branch_keeps_full_access(world):
    a, inv, q = world["alice"], world["invoice"], world["quote"]
    assert a.get(f"/api/invoices/{inv['id']}").status_code == 200
    assert a.get(f"/api/invoices/{inv['id']}/payments").status_code == 200
    assert a.post(f"/api/invoices/{inv['id']}/payments", json={
        "amount": 100, "method": "Cash",
        "idempotency_key": str(uuid.uuid4())}).status_code == 200
    assert a.get(f"/api/quotations/{q['id']}").status_code == 200
    assert _hits(a.get("/api/search/?q=ALICE-QUOTE")) >= 1


def test_global_user_still_sees_every_branch(world):
    """The fix must not fence off the Business Owner, who runs all branches."""
    o, inv = world["owner"], world["invoice"]
    assert o.get(f"/api/invoices/{inv['id']}").status_code == 200
    assert o.get(f"/api/invoices/{inv['id']}/payments").status_code == 200
    assert _hits(o.get("/api/search/?q=ALICE-QUOTE")) >= 1


# ── expenses carry branch_id too, and had the identical hole ────────────────

@pytest.fixture
def expense_world(app, db, make_client):
    """Finance Managers in two branches. Manager has no expense permissions, so
    the invoice fixture's roles cannot exercise this path."""
    from auth_utils import hash_password

    owner = make_client("superadmin")
    a_id = db.execute("SELECT id FROM warehouses WHERE is_default=1").fetchone()["id"]
    b_id = owner.post("/api/warehouses/",
                      json={"code": "BR3", "name": "Branch Three",
                            "type": "Branch"}).json()["id"]
    role = db.execute("SELECT id FROM roles WHERE name='Finance Manager'").fetchone()["id"]
    for name, branch in (("fm_alice", a_id), ("fm_bob", b_id)):
        db.execute(
            "INSERT INTO users (username, password_hash, full_name, role, role_id,"
            " is_active, is_superadmin, must_change_password, branch_id, created_at)"
            " VALUES (?,?,?,'user',?,1,0,0,?,datetime('now'))",
            (name, hash_password(PW), name, role, branch))
    db.commit()

    def login(u):
        c = TestClient(app)
        assert c.post("/api/auth/login",
                      json={"username": u, "password": PW}).status_code == 200
        return c

    alice, bob = login("fm_alice"), login("fm_bob")
    assert alice.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 900,
        "description": "ALICE-RENT", "date": "2026-08-14"}).status_code == 200
    eid = db.execute("SELECT id FROM expenses ORDER BY id DESC LIMIT 1").fetchone()["id"]
    return {"alice": alice, "bob": bob, "owner": owner, "expense_id": eid}


def test_cannot_edit_another_branchs_expense(expense_world, db):
    eid = expense_world["expense_id"]
    before = dict(db.execute(
        "SELECT amount, description FROM expenses WHERE id=?", (eid,)).fetchone())

    r = expense_world["bob"].put(f"/api/finance/expenses/{eid}", json={
        "category": "Rent", "amount": 1,
        "description": "HIJACKED", "date": "2026-08-14"})

    after = dict(db.execute(
        "SELECT amount, description FROM expenses WHERE id=?", (eid,)).fetchone())
    assert r.status_code == 404, r.text
    assert after == before, "another branch rewrote this expense"


def test_cannot_void_another_branchs_expense(expense_world, db):
    eid = expense_world["expense_id"]
    r = expense_world["bob"].patch(f"/api/finance/expenses/{eid}/void",
                                   json={"reason": "x"})
    voided = db.execute("SELECT voided_at FROM expenses WHERE id=?",
                        (eid,)).fetchone()["voided_at"]
    assert r.status_code == 404, r.text
    assert voided is None, "another branch voided this expense"


def test_expense_owner_and_global_user_are_unaffected(expense_world):
    eid = expense_world["expense_id"]
    assert expense_world["alice"].put(f"/api/finance/expenses/{eid}", json={
        "category": "Rent", "amount": 950,
        "description": "ALICE-EDIT", "date": "2026-08-14"}).status_code == 200
    assert expense_world["owner"].put(f"/api/finance/expenses/{eid}", json={
        "category": "Rent", "amount": 960,
        "description": "OWNER-EDIT", "date": "2026-08-14"}).status_code == 200


# ── personnel: the most sensitive branch data of all ────────────────────────

@pytest.fixture
def hr_world(app, db, make_client):
    """HR Managers in two branches, with an employee and a contract PDF."""
    import io
    from auth_utils import hash_password

    owner = make_client("superadmin")
    a_id = db.execute("SELECT id FROM warehouses WHERE is_default=1").fetchone()["id"]
    b_id = owner.post("/api/warehouses/",
                      json={"code": "BR4", "name": "Branch Four",
                            "type": "Branch"}).json()["id"]
    role = db.execute("SELECT id FROM roles WHERE name='HR Manager'").fetchone()["id"]
    for name, branch in (("hr_alice", a_id), ("hr_bob", b_id)):
        db.execute(
            "INSERT INTO users (username, password_hash, full_name, role, role_id,"
            " is_active, is_superadmin, must_change_password, branch_id, created_at)"
            " VALUES (?,?,?,'user',?,1,0,0,?,datetime('now'))",
            (name, hash_password(PW), name, role, branch))
    db.commit()

    def login(u):
        c = TestClient(app)
        assert c.post("/api/auth/login",
                      json={"username": u, "password": PW}).status_code == 200
        return c

    alice, bob = login("hr_alice"), login("hr_bob")
    assert alice.post("/api/hr/employees", json={
        "full_name": "ALICE-STAFF", "position": "Engineer", "salary": 8500,
        "hire_date": "2026-01-10", "phone": "+96170111222",
        "email": "staff@a.test"}).status_code == 200
    emp_id = db.execute(
        "SELECT id FROM hr_employees ORDER BY id DESC LIMIT 1").fetchone()["id"]

    pdf = b"%PDF-1.4\n" + b"0" * 200
    alice.post(f"/api/hr/employees/{emp_id}/files?kind=contract",
               files={"file": ("contract.pdf", io.BytesIO(pdf), "application/pdf")})
    row = db.execute(
        "SELECT id FROM hr_employee_files ORDER BY id DESC LIMIT 1").fetchone()

    return {"alice": alice, "bob": bob, "owner": owner,
            "emp_id": emp_id, "file_id": row["id"] if row else None}


def test_cannot_read_another_branchs_employee(hr_world):
    """This returned the full record: name, SALARY, phone and email."""
    r = hr_world["bob"].get(f"/api/hr/employees/{hr_world['emp_id']}")
    assert r.status_code == 404, r.text


def test_cannot_rewrite_another_branchs_salary(hr_world, db):
    emp_id = hr_world["emp_id"]
    before = dict(db.execute(
        "SELECT full_name, salary FROM hr_employees WHERE id=?", (emp_id,)).fetchone())

    r = hr_world["bob"].put(f"/api/hr/employees/{emp_id}", json={
        "full_name": "HIJACKED", "position": "Engineer", "salary": 1,
        "hire_date": "2026-01-10"})

    after = dict(db.execute(
        "SELECT full_name, salary FROM hr_employees WHERE id=?", (emp_id,)).fetchone())
    assert r.status_code == 404, r.text
    assert after == before, "another branch rewrote this person's salary"


def test_cannot_reach_another_branchs_hr_files(hr_world):
    """Contracts and ID documents. The download endpoint is keyed on the FILE
    id and had no employee check at all, so ids could simply be iterated."""
    bob, emp_id, file_id = hr_world["bob"], hr_world["emp_id"], hr_world["file_id"]
    assert bob.get(f"/api/hr/employees/{emp_id}/files").status_code == 404
    if file_id is not None:
        assert bob.get(f"/api/hr/files/{file_id}/download").status_code == 404


def test_cannot_archive_another_branchs_employee(hr_world, db):
    emp_id = hr_world["emp_id"]
    r = hr_world["bob"].patch(f"/api/hr/employees/{emp_id}/archive", json={"reason": "x"})
    archived = db.execute("SELECT archived_at FROM hr_employees WHERE id=?",
                          (emp_id,)).fetchone()["archived_at"]
    assert r.status_code == 404, r.text
    assert archived is None, "another branch archived this employee"


def test_hr_owner_and_global_user_are_unaffected(hr_world):
    a, o = hr_world["alice"], hr_world["owner"]
    emp_id, file_id = hr_world["emp_id"], hr_world["file_id"]
    assert a.get(f"/api/hr/employees/{emp_id}").status_code == 200
    assert a.get(f"/api/hr/employees/{emp_id}/files").status_code == 200
    assert a.put(f"/api/hr/employees/{emp_id}", json={
        "full_name": "ALICE-STAFF", "position": "Engineer", "salary": 9000,
        "hire_date": "2026-01-10"}).status_code == 200
    assert o.get(f"/api/hr/employees/{emp_id}").status_code == 200
    if file_id is not None:
        assert a.get(f"/api/hr/files/{file_id}/download").status_code == 200
        assert o.get(f"/api/hr/files/{file_id}/download").status_code == 200


def test_writes_are_forced_into_the_callers_own_branch(world, db):
    """A scoped user naming someone else's branch is refused, not silently
    redirected — so a mistake is visible rather than filed in the wrong place."""
    r = world["bob"].post("/api/invoices/", json={
        "client_id": world["client_id"], "branch_id": 1,
        "items": [{"name": "PLANTED", "quantity": 1, "unit_price": 1}]})
    assert r.status_code == 403, r.text


def test_cannot_read_another_branchs_postings_through_its_document(world):
    """The drill-through endpoint takes a document id and hands back journal
    entries. Without scoping it is a second door onto another branch's books —
    amounts, accounts and dates — reached from an invoice that 404s directly."""
    inv = world["invoice"]["id"]

    mine  = world["alice"].get(f"/api/accounting/for/invoice/{inv}").json()
    theirs = world["bob"].get(f"/api/accounting/for/invoice/{inv}")

    assert mine["entries"], "the branch's own owner must still see them"
    # Not a 404: the document may legitimately span branches. What must not
    # happen is another branch's entries coming back in the list.
    assert theirs.status_code in (200, 403, 404)
    if theirs.status_code == 200:
        assert theirs.json()["entries"] == []


def test_the_clients_report_does_not_total_another_branchs_revenue(world):
    """Every other financial report is branch-scoped. This one lists revenue
    per client across the whole company, so a scoped manager reads another
    branch's takings — by customer name — from a report they are allowed to
    open."""
    mine = world["alice"].get("/api/reports/clients").json()
    theirs = world["bob"].get("/api/reports/clients").json()

    alice_total = sum(c["total_invoiced"] for c in mine)
    bob_total   = sum(c["total_invoiced"] for c in theirs)

    assert alice_total > 0, "the branch's own manager must still see their own"
    assert bob_total == 0, "another branch's invoicing must not appear"


# ── a till sale belongs to the branch that rang it ──────────────────────────
#
# A POS sale's branch is its invoice's, which comes from the register session's
# warehouse. Undoing one moves that branch's stock and that branch's cash, so
# every by-id endpoint on a sale needs the guard — the list being filtered
# proves nothing, exactly as it proved nothing for invoices above.

@pytest.fixture
def pos_world(app, db, world):
    """Alice rings a sale at her own branch; Bob has a register open at his."""
    alice, bob = world["alice"], world["bob"]
    b_id = db.execute(
        "SELECT id FROM warehouses WHERE code='BR2'").fetchone()["id"]
    a_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1").fetchone()["id"]
    # Each cashier transacts at their own branch.
    for u, w in (("br_alice", a_id), ("br_bob", b_id)):
        uid = db.execute("SELECT id FROM users WHERE username=?", (u,)).fetchone()["id"]
        db.execute("INSERT INTO user_warehouse_access "
                   "(user_id, warehouse_id, granted_at) "
                   "VALUES (?,?,datetime('now'))", (uid, w))
    db.commit()

    item = world["owner"].post("/api/inventory/", json={
        "name": "BRANCH-WIDGET", "quantity": 40, "unit_cost": 2,
        "sale_price": 10}).json()["id"]

    ra = alice.post("/api/pos/session/open",
                    json={"opening_float": 0, "warehouse_id": a_id})
    assert ra.status_code == 200, ra.text
    rb = bob.post("/api/pos/session/open",
                  json={"opening_float": 0, "warehouse_id": b_id})
    assert rb.status_code == 200, rb.text

    sale = alice.post("/api/pos/checkout", json={
        "items": [{"name": "BRANCH-WIDGET", "inventory_id": item,
                   "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 20,
        "idempotency_key": str(uuid.uuid4())})
    assert sale.status_code == 200, sale.text
    return {**world, "sale": sale.json(), "item": item}


def test_cannot_return_another_branchs_sale(pos_world):
    """A refund from another branch's till: it puts the goods back into a
    warehouse Bob cannot transact in and takes the money out of Alice's
    drawer, against a session Bob has never seen."""
    r = pos_world["bob"].post(
        f"/api/pos/sales/{pos_world['sale']['id']}/return", json={"reason": "x"})
    assert r.status_code == 404, r.text


def test_cannot_correct_another_branchs_sale(pos_world):
    r = pos_world["bob"].post(
        f"/api/pos/sales/{pos_world['sale']['id']}/amend",
        json={"items": [{"name": "BRANCH-WIDGET",
                         "inventory_id": pos_world["item"],
                         "quantity": 2, "unit_price": 50}],
              "payment_method": "Cash", "amount_tendered": 80,
              "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 404, r.text


def test_cannot_read_another_branchs_sale(pos_world):
    """What was sold, to whom, at what cost and what margin."""
    r = pos_world["bob"].get(f"/api/pos/sales/{pos_world['sale']['id']}")
    assert r.status_code == 404, r.text


def test_another_branchs_sale_is_not_in_the_history(pos_world):
    rows = pos_world["bob"].get("/api/pos/sales").json()
    assert not [s for s in rows if s["id"] == pos_world["sale"]["id"]]


def test_the_branchs_own_cashier_can_still_undo_the_sale(pos_world):
    """The guard must not lock the till out of its own work."""
    r = pos_world["alice"].post(
        f"/api/pos/sales/{pos_world['sale']['id']}/return", json={"reason": "ok"})
    assert r.status_code == 200, r.text
