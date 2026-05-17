# ERP System — Risk Analysis & Weakness Report

Prepared by: QA / test-architecture pass
Method: 293 automated API tests (`backend/tests/`) run against a fresh database
per test, plus static review of routers, `permissions.py`, `auth_utils.py`,
`approval_engine` and `database.py`.

**Initial run:** `286 passed · 6 failed · 1 skipped` — the 6 failures mapped to
**4 distinct defects**. **All 4 have since been fixed** (see each finding's
*Status*). The suite is now **`292 passed · 1 skipped · 0 failed`**; the
formerly-failing tests are retained as permanent regression guards.

---

## 1. Confirmed defects — all FIXED

### F-01 — Unhandled `FOREIGN KEY constraint failed` → HTTP 500  ·  Severity: HIGH

Creating a record that references a non-existent parent crashes with a raw
`sqlite3.IntegrityError`, surfaced to the client as **500 Internal Server
Error**.

* Evidence: `routers/projects.py:130` — `sqlite3.IntegrityError: FOREIGN KEY
  constraint failed`. Same class of failure on invoice creation.
* Reproducing tests:
  `test_edge_cases.py::test_project_with_dangling_client_fails_cleanly`,
  `…::test_invoice_with_dangling_client_fails_cleanly`
* Root cause: `PRAGMA foreign_keys=ON` is set, so a bad `client_id` is rejected
  at the DB layer, but routers `INSERT` without first validating the relation
  and without catching `sqlite3.IntegrityError`.
* Impact: any client sending a stale/guessed id (a deleted client, a race) gets
  a 500. 500s leak stack traces, break the UI's error handling, and mask the
  real "not found" condition.
* **Status: FIXED** — `create_project` and `create_invoice` now validate
  `client_id` / `project_id` / `quotation_id` up front and return `400 "… not
  found"` instead of crashing. (Update paths in other routers should get the
  same treatment over time — tracked under W-10.)

### F-02 — The `expenses` permission module is orphaned  ·  Severity: HIGH

`database.py` seeds an **`expenses`** permission for several roles
(Finance Manager, Accountant `_VCE`, Project Manager `_VC`, Procurement Officer
`_V`), but **no endpoint ever checks it**.

* Evidence: every expense endpoint lives in the finance router and is guarded by
  `require_perm("finance", …)` — `routers/finance.py:332` (`GET /expenses`),
  `:400` (POST), `:442` (PUT), `:358/:490` (void/archive).
* Reproducing tests:
  `test_role_permission_matrix.py::test_module_view_enforcement[Project Manager-expenses]`
  and `[Procurement Officer-expenses]` — both roles **have `expenses.view`** yet
  `GET /api/finance/expenses` returns **403**.
* Impact (a textbook *permission dependency failure*):
  * a role granted `expenses` but not `finance` is wrongly **locked out**;
  * a role granted `finance` but not `expenses` gets **full expense access**
    regardless — the `expenses` grant is meaningless;
  * admins configuring roles via the UI are misled about what they're granting.
* **Status: FIXED** — all six expense endpoints in `routers/finance.py`
  (list / create / update / void / archive / unarchive) now use
  `require_perm("expenses", …)`. Verified safe: no seeded role has `finance`
  without also having `expenses`, so no role loses access. The full
  role×module matrix (196 cases) now passes.

### F-03 — Cancelled quotation can still be converted to an invoice  ·  Severity: HIGH

* Evidence / reproducing test:
  `test_state_transitions.py::test_cancelled_quotation_cannot_convert_to_invoice`
  — `POST /api/quotations/{id}/convert-to-invoice` on a **cancelled** quotation
  returns **200** and creates an invoice.
* Contradiction: the UI explicitly promises the opposite — `Quotations.jsx`'s
  cancel confirmation says *"No invoice can be raised from a cancelled
  quotation."* The rule is enforced only in the client, not the server.
* Impact: broken state transition. Revenue can be raised from a quotation that
  was deliberately voided — a financial-integrity hole, and an API caller
  bypasses the UI guard entirely.
* **Status: FIXED** — `convert-to-invoice` now rejects quotations whose status
  is `Cancelled` or `Rejected` with `400`. (Already-invoiced quotations were
  handled before.)

### F-04 — Soft-deleted records remain editable  ·  Severity: MEDIUM

* Evidence / reproducing test:
  `test_state_transitions.py::test_update_soft_deleted_client_is_not_5xx`
  — `PUT /api/clients/{id}` on a client whose `deleted_at` is set returns
  **200**; the update is applied.
* Root cause: the update path does not filter `deleted_at IS NULL`. List/read
  paths do — so a "deleted" record is invisible yet still mutable.
* Impact: a deleted entity can be silently resurrected/modified; data-lifecycle
  inconsistency. Likely **systemic** — other `PUT/PATCH` routers should be
  audited for the same gap.
* **Status: FIXED** — `update_client` now checks the row exists and
  `deleted_at IS NULL`, returning `404` otherwise (this also fixes a latent
  bug: updating a wholly non-existent client previously returned `200`).
* Residual: the same `deleted_at` re-check should be propagated to every other
  router's update/patch paths — tracked under W-10.

---

## 2. Architectural weaknesses (static analysis — not all test-confirmed)

### W-01 — Write-on-read: every authenticated request takes a write lock  ·  HIGH

`permissions._resolve_user` runs on **every** authenticated request and executes
`UPDATE user_sessions SET last_active=… ` + `db.commit()`. SQLite has a single
writer; this funnels *all* authenticated traffic — including pure `GET`s —
through the write lock. Under concurrency this is the most likely source of
`database is locked` 500s and latency spikes. Mitigation: throttle the
`last_active` write (e.g. only every N minutes), or move sessions to a store
that tolerates concurrent writes.

### W-02 — SQLite single-writer under concurrent sensitive actions  ·  MEDIUM

`busy_timeout=5000` + WAL keeps reads concurrent, but month-end finance jobs,
bulk approvals or multiple uvicorn workers can still serialise into lock
timeouts → 500. The suite's concurrency tests pass at 2–5 parallel requests;
they are **not** a guarantee at production load or with multiple workers.

### W-03 — Approval double-resolution is guarded only in Python  ·  MEDIUM

`test_concurrency.py::test_concurrent_approval_does_not_double_resolve` **passes**
— the engine refuses the second concurrent approve. Good. But the guard is a
check-then-act in application code, not a DB constraint. With multiple worker
processes or higher contention the check and the write are not atomic. Consider
a conditional `UPDATE … WHERE status='pending'` and asserting `rowcount==1`.

### W-04 — `must_change_password` is not globally enforced  ·  MEDIUM

The flag only special-cases the password endpoints. A user flagged
must-change can still call every other API route normally — forced rotation is
effectively advisory. A middleware/dependency should block all non-auth routes
until the password is changed.

### W-05 — Login rate-limit keyed on `request.client.host`  ·  MEDIUM

Behind a reverse proxy every user shares the proxy IP: one attacker locks out
all users, and a NAT'd office is rate-limited as a single client. The limiter
ignores `X-Forwarded-For`. Per-account limiting (or trusted-proxy header
parsing) is needed.

### W-06 — Broad `except Exception` swallows real errors  ·  LOW–MEDIUM

`utils.notify`, `routers/audit.log_action` and `auth_utils.verify_password`
catch bare `Exception`. Audit-trail or notification failures vanish silently.
(`routers/search.py` was already changed in a prior pass to log instead.)
Recommendation: catch specific exceptions and log the rest.

### W-07 — Single active session per user, login is destructive  ·  LOW

`POST /login` revokes all of a user's other sessions
(`test_auth_session.py::test_second_login_revokes_the_first_session` confirms).
By design, but it means a second device/tab silently kills the first — and two
near-simultaneous logins race on the same `user_sessions` rows.

### W-08 — `audit` module classification is ambiguous  ·  LOW

`permissions.ADMIN_MODULES` includes `audit`, yet `database.py` seeds the
Auditor role with an `audit` view grant — implying `audit` endpoints are
`require_perm`-gated, not `require_admin`. The two cannot both be true. This
suite deliberately excludes `/api/audit/` from the strict admin-only test
(see `helpers/catalog.py`); the classification needs a decision and a test.

### W-09 — Silent JSON fallbacks hide data corruption  ·  LOW

`approval_requests._serialize` parses `entity_snapshot` inside `try/except → {}`.
A malformed snapshot is silently shown as empty rather than flagged.

### W-10 — FK / soft-delete guards not yet propagated to all routers  ·  MEDIUM

F-01 and F-04 were fixed at the endpoints the suite exercised
(`create_project`, `create_invoice`, `update_client`). The same two patterns —
unguarded foreign-id inserts, and update/patch paths that don't re-check
`deleted_at` — very likely recur in other routers (quotations, purchases,
inventory, suppliers, CRM, planning…). A systematic audit plus a shared
validation helper is recommended so the fix is uniform, not per-endpoint.

---

## 3. What passed — verified-good behaviour

* No GET endpoint returns 5xx, authenticated or anonymous (smoke).
* No GET endpoint serves data without authentication (no auth bypass).
* Login: bad password / unknown user → 401; disabled account → 403;
  6th failed attempt → 429 (rate-limit works in the single-IP case).
* Logout revokes the session; `/me` reports the correct role.
* RBAC matrix: **236 / 238** role×module checks enforce the seed correctly
  (the 2 failures are F-02).
* Admin endpoints (`/users`, `/roles`) reject every non-superadmin role.
* A no-role user is uniformly 403'd.
* Approvals: approve / reject / force-approve / cancel single- and multi-step
  all behave; steps run in order; a step-2 approver cannot jump ahead.
* Invalid transitions are refused: double-approve, approve-after-reject,
  cancel-after-resolved, wrong-role approve — all return 4xx, never 5xx.
* Circular-flow guard: a 2-step policy reusing the same role terminates.
* Concurrency: double-approve race refused; idempotent payments recorded once;
  parallel distinct payments all land (no lost writes at tested scale).

---

## 4. Priority recommendations

| # | Action | Addresses | Status |
|---|--------|-----------|--------|
| 1 | Validate foreign ids → 400 instead of an unhandled FK 500 | F-01 | ✅ done (create paths) |
| 2 | Resolve the `expenses` vs `finance` permission contract | F-02 | ✅ done |
| 3 | Enforce terminal states server-side (cancelled quote, soft-deleted client) | F-03, F-04 | ✅ done |
| 4 | Propagate the FK + soft-delete guards to all remaining routers | W-10 | open |
| 5 | Throttle the `last_active` write in `_resolve_user` | W-01 | open |
| 6 | Make approval double-resolution atomic (`UPDATE … WHERE status='pending'`) | W-03 | open |
| 7 | Globally enforce `must_change_password`; proxy-aware rate limiting | W-04, W-05 | open |

> The four confirmed defects (F-01…F-04) are fixed and each is now locked in by
> a regression test. The remaining items are architectural and were left
> untouched pending a dedicated hardening pass.
