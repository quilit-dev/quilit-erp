import sqlite3, os
from datetime import datetime

from db_compat import CompatConn
from dialect import get_dialect
from tenant_context import IS_SCHEMA_TENANCY, current_schema, valid_schema_name

DB_PATH = os.environ.get("DB_PATH", "erp.db")

# Database backend selector for the SaaS migration (docs/SAAS_ARCHITECTURE.md §5).
#   'sqlite'   — default. Desktop / self-hosted / tests. The CompatConn wrapper is
#                transparent here (identity dialect; native sqlite3.Row passes
#                through), so behavior is byte-for-byte what it was before.
#   'postgres' — cloud backend. Wired in Phase 1.
DB_BACKEND = os.environ.get("DB_BACKEND", "sqlite").lower()

def _configure(conn):
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -8000")
    return conn

def get_db():
    """Yield a request-scoped DB connection wrapped in CompatConn.

    The wrapper lets the routers' raw SQL run unchanged on whichever backend
    DB_BACKEND selects. In 'sqlite' mode the wrapping is transparent; the
    PostgreSQL branch (pooling + per-tenant search_path) is added in Phase 1.
    """
    if DB_BACKEND in ("sqlite", "sqlite3"):
        raw = _configure(sqlite3.connect(DB_PATH, check_same_thread=False))
        conn = CompatConn(raw, get_dialect("sqlite"))
        try:
            yield conn
        finally:
            conn.close()
    elif DB_BACKEND in ("postgres", "postgresql", "pg"):
        import psycopg
        from psycopg.rows import dict_row
        connect_kwargs = {"row_factory": dict_row}
        # Schema-per-tenant routing (Phase 2): pin the session's search_path to the
        # request's tenant schema at connection time (libpq -c option, applied
        # before any transaction). The schema name is validated, so it is safe to
        # interpolate. In single-tenant mode this is skipped → default `public`.
        if IS_SCHEMA_TENANCY:
            schema = current_schema()
            if valid_schema_name(schema):
                connect_kwargs["options"] = f"-c search_path={schema},public"
        raw = psycopg.connect(_pg_dsn(), **connect_kwargs)
        conn = CompatConn(raw, get_dialect("postgres"))
        try:
            yield conn
        finally:
            # Discard any uncommitted work (mirrors closing a sqlite connection);
            # routers persist via explicit db.commit().
            try:
                raw.rollback()
            except Exception:
                pass
            raw.close()
    else:
        raise RuntimeError(f"Unknown DB_BACKEND={DB_BACKEND!r}")


# ── Migration helpers ─────────────────────────────────────────────────────────

def _run_migrations(conn, c):
    """Apply and record schema migrations. Each is idempotent and recorded once."""
    c.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT UNIQUE NOT NULL,
            applied_at TEXT NOT NULL
        )
    """)
    conn.commit()

    applied = {row[0] for row in c.execute("SELECT name FROM schema_migrations").fetchall()}

    def done(name):
        c.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))",
            (name,)
        )

    def need(name):
        return name not in applied

    def cols(table):
        # pragma_table_info() is a table-valued function and accepts a bound
        # parameter, so the table name is never interpolated into SQL text.
        return [r[0] for r in c.execute(
            "SELECT name FROM pragma_table_info(?)", (table,)
        ).fetchall()]

    def all_tables():
        return [r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

    def add_col(name, table, col, sql):
        if not need(name):
            return
        if table in all_tables() and col not in cols(table):
            c.execute(sql)
        done(name)

    # ── 001: soft-delete columns ─────────────────────────────────────────
    # Each ALTER is a fixed literal statement — ALTER TABLE cannot bind an
    # identifier as a parameter, so the table name is hard-coded, not built.
    if need("001_soft_delete"):
        tbls = all_tables()
        _soft_delete_alters = {
            "clients":    "ALTER TABLE clients ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "projects":   "ALTER TABLE projects ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "quotations": "ALTER TABLE quotations ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "invoices":   "ALTER TABLE invoices ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "inventory":  "ALTER TABLE inventory ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "purchases":  "ALTER TABLE purchases ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "expenses":   "ALTER TABLE expenses ADD COLUMN deleted_at TEXT DEFAULT NULL",
        }
        for tbl, alter_sql in _soft_delete_alters.items():
            if tbl in tbls and "deleted_at" not in cols(tbl):
                c.execute(alter_sql)
        done("001_soft_delete")

    # ── 002: migrate paid_amount column → invoice_payments rows ──────────
    if need("002_invoice_paid_amount"):
        if "invoices" in all_tables() and "paid_amount" in cols("invoices"):
            old_invoices = c.execute(
                "SELECT id, paid_amount FROM invoices WHERE paid_amount > 0"
            ).fetchall()
            for inv in old_invoices:
                existing = c.execute(
                    "SELECT COUNT(*) FROM invoice_payments WHERE invoice_id=?", (inv[0],)
                ).fetchone()[0]
                if existing == 0:
                    c.execute(
                        "INSERT INTO invoice_payments (invoice_id, amount, method, note, paid_at) "
                        "VALUES (?,?,'Cash','Migrated from paid_amount',datetime('now'))",
                        (inv[0], inv[1])
                    )
            c.executescript("""
                CREATE TABLE IF NOT EXISTS invoices_new (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_number TEXT UNIQUE NOT NULL,
                    quotation_id   INTEGER REFERENCES quotations(id),
                    project_id     INTEGER REFERENCES projects(id),
                    client_id      INTEGER REFERENCES clients(id),
                    amount         REAL DEFAULT 0,
                    due_date       TEXT,
                    notes          TEXT,
                    created_at     TEXT
                );
                INSERT OR IGNORE INTO invoices_new
                    (id, invoice_number, quotation_id, project_id, client_id, amount, due_date, notes, created_at)
                SELECT id, invoice_number, NULL, project_id, client_id, amount, due_date, notes, created_at
                FROM invoices;
                DROP TABLE invoices;
                ALTER TABLE invoices_new RENAME TO invoices;
            """)
        done("002_invoice_paid_amount")

    # ── 003: drop legacy quotation_payments table ─────────────────────────
    if need("003_drop_quotation_payments"):
        if "quotation_payments" in all_tables():
            c.execute("DROP TABLE quotation_payments")
        done("003_drop_quotation_payments")

    # ── 004–006: quotation and project columns ────────────────────────────
    add_col("004_quotation_project_name", "quotations", "project_name",
            "ALTER TABLE quotations ADD COLUMN project_name TEXT DEFAULT NULL")
    add_col("005_project_expected_revenue", "projects", "expected_revenue",
            "ALTER TABLE projects ADD COLUMN expected_revenue REAL DEFAULT 0")
    add_col("006_project_source_quotation", "projects", "source_quotation_id",
            "ALTER TABLE projects ADD COLUMN source_quotation_id INTEGER REFERENCES quotations(id)")

    # ── 007: rename inventory.unit_price → unit_cost ──────────────────────
    if need("007_inventory_unit_cost"):
        if "inventory" in all_tables():
            inv_cols = cols("inventory")
            if "unit_price" in inv_cols and "unit_cost" not in inv_cols:
                c.executescript("""
                    CREATE TABLE IF NOT EXISTS inventory_new (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        name       TEXT NOT NULL,
                        category   TEXT,
                        quantity   REAL DEFAULT 0,
                        min_stock  REAL DEFAULT 0,
                        unit_cost  REAL DEFAULT 0,
                        supplier   TEXT,
                        unit       TEXT DEFAULT 'pcs',
                        created_at TEXT,
                        deleted_at TEXT DEFAULT NULL
                    );
                    INSERT INTO inventory_new
                        (id, name, category, quantity, min_stock, unit_cost, supplier, unit, created_at, deleted_at)
                    SELECT id, name, category, quantity, min_stock, unit_price, supplier, unit, created_at,
                           CASE WHEN typeof(deleted_at)='null' THEN NULL ELSE deleted_at END
                    FROM inventory;
                    DROP TABLE inventory;
                    ALTER TABLE inventory_new RENAME TO inventory;
                """)
        done("007_inventory_unit_cost")

    # ── 008: purchases supplier_id FK ────────────────────────────────────
    add_col("008_purchases_supplier_id", "purchases", "supplier_id",
            "ALTER TABLE purchases ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)")

    # ── 009–011: invoice financial-safety columns ─────────────────────────
    add_col("009_invoice_version",     "invoices", "version",
            "ALTER TABLE invoices ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
    add_col("010_invoice_voided_at",   "invoices", "voided_at",
            "ALTER TABLE invoices ADD COLUMN voided_at TEXT DEFAULT NULL")
    add_col("011_invoice_void_reason", "invoices", "void_reason",
            "ALTER TABLE invoices ADD COLUMN void_reason TEXT DEFAULT NULL")

    # ── 012: payment idempotency key ──────────────────────────────────────
    add_col("012_payment_idempotency", "invoice_payments", "idempotency_key",
            "ALTER TABLE invoice_payments ADD COLUMN idempotency_key TEXT DEFAULT NULL")

    # ── 013–019: users table columns ─────────────────────────────────────
    add_col("013_users_email",          "users", "email",
            "ALTER TABLE users ADD COLUMN email TEXT")
    add_col("014_users_is_active",      "users", "is_active",
            "ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1")
    add_col("015_users_is_superadmin",  "users", "is_superadmin",
            "ALTER TABLE users ADD COLUMN is_superadmin INTEGER DEFAULT 0")
    add_col("016_users_role_id",        "users", "role_id",
            "ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)")
    add_col("017_users_last_login",     "users", "last_login",
            "ALTER TABLE users ADD COLUMN last_login TEXT")
    add_col("018_users_deleted_at",     "users", "deleted_at",
            "ALTER TABLE users ADD COLUMN deleted_at TEXT")
    add_col("019_users_must_change_pw", "users", "must_change_password",
            "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")

    # ── 020–021: expense void columns ────────────────────────────────────
    add_col("020_expenses_voided_at",   "expenses", "voided_at",
            "ALTER TABLE expenses ADD COLUMN voided_at TEXT DEFAULT NULL")
    add_col("021_expenses_void_reason", "expenses", "void_reason",
            "ALTER TABLE expenses ADD COLUMN void_reason TEXT DEFAULT NULL")

    # ── 022: archived_at + archive_reason for all entity tables ──────────
    # Fixed literal ALTER statements per table — see the note on migration 001.
    if need("022_archive_columns"):
        _archive_col_alters = {
            "clients":    ("ALTER TABLE clients ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE clients ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "projects":   ("ALTER TABLE projects ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE projects ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "quotations": ("ALTER TABLE quotations ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE quotations ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "invoices":   ("ALTER TABLE invoices ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE invoices ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "inventory":  ("ALTER TABLE inventory ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE inventory ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "purchases":  ("ALTER TABLE purchases ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE purchases ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "expenses":   ("ALTER TABLE expenses ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE expenses ADD COLUMN archive_reason TEXT DEFAULT NULL"),
            "suppliers":  ("ALTER TABLE suppliers ADD COLUMN archived_at TEXT DEFAULT NULL",
                           "ALTER TABLE suppliers ADD COLUMN archive_reason TEXT DEFAULT NULL"),
        }
        tbls = all_tables()
        for tbl, (archived_at_sql, archive_reason_sql) in _archive_col_alters.items():
            if tbl in tbls:
                if "archived_at" not in cols(tbl):
                    c.execute(archived_at_sql)
                if "archive_reason" not in cols(tbl):
                    c.execute(archive_reason_sql)
        done("022_archive_columns")

    # ── 023: documents table for PDF/HTML attachments ─────────────────────
    if need("023_documents"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                record_type  TEXT NOT NULL,
                record_id    INTEGER NOT NULL,
                client_id    INTEGER,
                project_id   INTEGER,
                title        TEXT NOT NULL,
                html_content TEXT NOT NULL,
                created_at   TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_documents_record  ON documents(record_type, record_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_documents_client  ON documents(client_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)")
        done("023_documents")

    # ── 024: CRM leads ────────────────────────────────────────────────────
    if need("024_crm_leads"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS crm_leads (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                company         TEXT,
                email           TEXT,
                phone           TEXT,
                source          TEXT DEFAULT 'Other',
                status          TEXT DEFAULT 'New',
                score           INTEGER DEFAULT 0,
                estimated_value REAL DEFAULT 0,
                expected_close  TEXT,
                assigned_to     INTEGER REFERENCES users(id),
                client_id       INTEGER REFERENCES clients(id),
                notes           TEXT,
                archived_at     TEXT DEFAULT NULL,
                created_at      TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_leads_status    ON crm_leads(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_leads_client_id ON crm_leads(client_id)")
        done("024_crm_leads")

    # ── 025: CRM contacts ─────────────────────────────────────────────────
    if need("025_crm_contacts"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS crm_contacts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id   INTEGER REFERENCES clients(id),
                lead_id     INTEGER REFERENCES crm_leads(id),
                name        TEXT NOT NULL,
                title       TEXT,
                email       TEXT,
                phone       TEXT,
                is_primary  INTEGER DEFAULT 0,
                notes       TEXT,
                archived_at TEXT DEFAULT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_contacts_client ON crm_contacts(client_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead   ON crm_contacts(lead_id)")
        done("025_crm_contacts")

    # ── 026: CRM activities ───────────────────────────────────────────────
    if need("026_crm_activities"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS crm_activities (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                type        TEXT NOT NULL,
                subject     TEXT NOT NULL,
                description TEXT,
                client_id   INTEGER REFERENCES clients(id),
                lead_id     INTEGER REFERENCES crm_leads(id),
                contact_id  INTEGER REFERENCES crm_contacts(id),
                user_id     INTEGER REFERENCES users(id),
                due_date    TEXT,
                done_at     TEXT,
                outcome     TEXT,
                archived_at TEXT DEFAULT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_activities_client   ON crm_activities(client_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_activities_lead     ON crm_activities(lead_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_activities_due_date ON crm_activities(due_date)")
        done("026_crm_activities")

    # ── 027: CRM deals ────────────────────────────────────────────────────
    if need("027_crm_deals"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS crm_deals (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                title          TEXT NOT NULL,
                client_id      INTEGER REFERENCES clients(id),
                lead_id        INTEGER REFERENCES crm_leads(id),
                quotation_id   INTEGER REFERENCES quotations(id),
                stage          TEXT DEFAULT 'Prospect',
                value          REAL DEFAULT 0,
                probability    INTEGER DEFAULT 0,
                expected_close TEXT,
                won_at         TEXT,
                lost_at        TEXT,
                lost_reason    TEXT,
                assigned_to    INTEGER REFERENCES users(id),
                notes          TEXT,
                archived_at    TEXT DEFAULT NULL,
                created_at     TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_deals_client_id ON crm_deals(client_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_deals_stage     ON crm_deals(stage)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_crm_deals_lead_id   ON crm_deals(lead_id)")
        done("027_crm_deals")

    if need("028_planning_projects"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS planning_projects (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                description  TEXT,
                client_id    INTEGER REFERENCES clients(id),
                color        TEXT DEFAULT '#4f8ef7',
                start_date   TEXT,
                end_date     TEXT,
                status       TEXT DEFAULT 'Active',
                created_by   INTEGER REFERENCES users(id),
                archived_at  TEXT DEFAULT NULL,
                created_at   TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_projects_client ON planning_projects(client_id)")
        done("028_planning_projects")

    if need("029_planning_tasks"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS planning_tasks (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id     INTEGER NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
                name           TEXT NOT NULL,
                description    TEXT,
                assigned_to    INTEGER REFERENCES users(id),
                status         TEXT DEFAULT 'To Do',
                priority       TEXT DEFAULT 'Medium',
                start_date     TEXT,
                end_date       TEXT,
                progress       INTEGER DEFAULT 0,
                milestone_id   INTEGER REFERENCES planning_milestones(id),
                depends_on     INTEGER REFERENCES planning_tasks(id),
                color          TEXT,
                sort_order     INTEGER DEFAULT 0,
                archived_at    TEXT DEFAULT NULL,
                created_at     TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_tasks_project ON planning_tasks(project_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_tasks_assigned ON planning_tasks(assigned_to)")
        done("029_planning_tasks")

    if need("030_planning_milestones"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS planning_milestones (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                due_date    TEXT,
                reached_at  TEXT,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_milestones_project ON planning_milestones(project_id)")
        done("030_planning_milestones")

    if need("031_notifications"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type        TEXT NOT NULL,
                title       TEXT NOT NULL,
                body        TEXT,
                link        TEXT,
                entity_type TEXT,
                entity_id   INTEGER,
                is_read     INTEGER NOT NULL DEFAULT 0,
                read_at     TEXT,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, is_read)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_notifications_type    ON notifications(type)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)")
        done("031_notifications")

    # ── 032: approval policies ────────────────────────────────────────────
    if need("032_approval_policies"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS approval_policies (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                description     TEXT,
                module          TEXT NOT NULL,
                trigger_action  TEXT NOT NULL DEFAULT 'create',
                condition_logic TEXT NOT NULL DEFAULT 'AND',
                conditions      TEXT NOT NULL DEFAULT '[]',
                approval_type   TEXT NOT NULL DEFAULT 'single',
                approver_roles  TEXT NOT NULL DEFAULT '[]',
                steps           TEXT NOT NULL DEFAULT '[]',
                priority        INTEGER NOT NULL DEFAULT 0,
                is_active       INTEGER NOT NULL DEFAULT 1,
                created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            )
        """)
        done("032_approval_policies")

    # ── 033: approval requests ────────────────────────────────────────────
    if need("033_approval_requests"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS approval_requests (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                policy_id           INTEGER REFERENCES approval_policies(id) ON DELETE SET NULL,
                policy_name         TEXT NOT NULL,
                module              TEXT NOT NULL,
                entity_id           INTEGER NOT NULL,
                entity_label        TEXT,
                trigger_action      TEXT NOT NULL,
                entity_snapshot     TEXT,
                status              TEXT NOT NULL DEFAULT 'pending',
                approval_type       TEXT NOT NULL DEFAULT 'single',
                current_step        INTEGER NOT NULL DEFAULT 1,
                total_steps         INTEGER NOT NULL DEFAULT 1,
                requested_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                requested_at        TEXT NOT NULL,
                resolved_at         TEXT,
                resolved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
                resolution_comment  TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_appreq_status ON approval_requests(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_appreq_module ON approval_requests(module, entity_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_appreq_req_by ON approval_requests(requested_by)")
        done("033_approval_requests")

    # ── 034: approval steps ───────────────────────────────────────────────
    if need("034_approval_steps"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS approval_steps (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id       INTEGER NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
                step_number      INTEGER NOT NULL,
                approver_role    TEXT NOT NULL,
                approver_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                status           TEXT NOT NULL DEFAULT 'pending',
                acted_at         TEXT,
                comment          TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_appstep_request ON approval_steps(request_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_appstep_req_step ON approval_steps(request_id, step_number)")
        done("034_approval_steps")

    # Purge login_attempts older than 90 days to prevent table bloat
    c.execute("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-90 days')")

    # ── 035: milestone soft-delete ────────────────────────────────────────
    if need("035_milestone_archived_at"):
        try:
            c.execute("ALTER TABLE planning_milestones ADD COLUMN archived_at TEXT")
        except Exception:
            pass
        done("035_milestone_archived_at")

    # ── 036: expense status column ────────────────────────────────────────
    if need("036_expense_status"):
        try:
            c.execute("ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'Recorded'")
        except Exception:
            pass
        done("036_expense_status")

    # ── 037: approval comment thread ──────────────────────────────────────
    if need("037_approval_comments"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS approval_comments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id  INTEGER NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
                user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                comment     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_appcomment_request ON approval_comments(request_id)")
        done("037_approval_comments")

    # ── 038: backfill legacy users.role from assigned RBAC role ───────────
    # Historically users.role was hardcoded to 'user'; approval routing needs
    # it to mirror roles.name. Sync existing rows once.
    if need("038_backfill_user_roles"):
        try:
            c.execute("""
                UPDATE users
                SET role = (SELECT r.name FROM roles r WHERE r.id = users.role_id)
                WHERE role_id IS NOT NULL
                  AND (SELECT r.name FROM roles r WHERE r.id = users.role_id) IS NOT NULL
            """)
        except Exception:
            pass
        done("038_backfill_user_roles")

    # ── 039: HR — departments ─────────────────────────────────────────────
    if need("039_hr_departments"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_departments (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                description    TEXT,
                archived_at    TEXT,
                archive_reason TEXT,
                created_at     TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_dept_archived ON hr_departments(archived_at)")
        done("039_hr_departments")

    # ── 040: HR — employees ───────────────────────────────────────────────
    if need("040_hr_employees"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_employees (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_code   TEXT,
                full_name       TEXT NOT NULL,
                job_title       TEXT,
                department_id   INTEGER REFERENCES hr_departments(id) ON DELETE SET NULL,
                employment_type TEXT NOT NULL DEFAULT 'Full-time',
                status          TEXT NOT NULL DEFAULT 'Active',
                hire_date       TEXT,
                end_date        TEXT,
                email           TEXT,
                phone           TEXT,
                salary          REAL DEFAULT 0,
                manager_id      INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL,
                user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
                address         TEXT,
                notes           TEXT,
                archived_at     TEXT,
                archive_reason  TEXT,
                created_at      TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_dept     ON hr_employees(department_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_status   ON hr_employees(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_archived ON hr_employees(archived_at)")
        done("040_hr_employees")

    # ── 041: HR — leave requests ──────────────────────────────────────────
    if need("041_hr_leave_requests"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_leave_requests (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
                leave_type  TEXT NOT NULL DEFAULT 'Annual',
                start_date  TEXT NOT NULL,
                end_date    TEXT NOT NULL,
                days        REAL NOT NULL DEFAULT 0,
                reason      TEXT,
                status      TEXT NOT NULL DEFAULT 'Pending',
                reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TEXT,
                review_note TEXT,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_leave_emp    ON hr_leave_requests(employee_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_leave_status ON hr_leave_requests(status)")
        done("041_hr_leave_requests")

    # ── 042: dual-currency — manual exchange-rate history ─────────────────
    if need("042_exchange_rates"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS exchange_rates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                rate        REAL NOT NULL,
                set_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                set_by_name TEXT,
                note        TEXT,
                created_at  TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_exchange_rates_created ON exchange_rates(created_at)")
        done("042_exchange_rates")

    # ── 043: multi-currency payments ──────────────────────────────────────
    # A payment may be tendered in LBP. `amount` stays the USD value applied
    # to the invoice balance; the new columns record what the client handed
    # over and the rate used.
    if need("043_payment_currency"):
        for ddl in (
            "ALTER TABLE invoice_payments ADD COLUMN paid_currency TEXT NOT NULL DEFAULT 'USD'",
            "ALTER TABLE invoice_payments ADD COLUMN paid_amount REAL",
            "ALTER TABLE invoice_payments ADD COLUMN exchange_rate REAL",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        try:
            c.execute("UPDATE invoice_payments SET paid_amount = amount WHERE paid_amount IS NULL")
        except Exception:
            pass
        done("043_payment_currency")

    # ── 044: tax rates configuration table ────────────────────────────────
    # Admin-managed list of named tax rates. Replaces the single
    # `default_tax_rate` setting; `tax_enabled` stays the master on/off switch.
    if need("044_tax_rates"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS tax_rates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                rate        REAL    NOT NULL DEFAULT 0,
                tax_type    TEXT    NOT NULL DEFAULT 'standard',
                is_default  INTEGER NOT NULL DEFAULT 0,
                is_active   INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        # Seed from the legacy single-rate setting so existing installs keep
        # their VAT rate; add zero-rated / exempt rows for per-line exemptions.
        if not c.execute("SELECT 1 FROM tax_rates LIMIT 1").fetchone():
            row = c.execute("SELECT value FROM settings WHERE key='default_tax_rate'").fetchone()
            try:
                std = float(row[0]) if row and row[0] else 11.0
            except (TypeError, ValueError):
                std = 11.0
            if std <= 0:
                std = 11.0
            std_label = f"VAT {std:g}%"
            c.execute("INSERT INTO tax_rates (name, rate, tax_type, is_default, is_active, created_at) "
                      "VALUES (?,?,'standard',1,1,datetime('now'))", (std_label, std))
            c.execute("INSERT INTO tax_rates (name, rate, tax_type, is_default, is_active, created_at) "
                      "VALUES ('Zero-rated',0,'zero',0,1,datetime('now'))")
            c.execute("INSERT INTO tax_rates (name, rate, tax_type, is_default, is_active, created_at) "
                      "VALUES ('Exempt',0,'exempt',0,1,datetime('now'))")
        done("044_tax_rates")

    # ── 045: per-line and per-document tax columns ────────────────────────
    # Line items carry a tax rate snapshot + computed tax amount; documents
    # store the rolled-up subtotal / tax_total. `invoices.amount` and
    # `quotations.total` keep their existing meaning (grand total / subtotal).
    if need("045_line_item_tax"):
        for ddl in (
            "ALTER TABLE invoice_items   ADD COLUMN tax_rate_id INTEGER",
            "ALTER TABLE invoice_items   ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
            "ALTER TABLE invoice_items   ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0",
            "ALTER TABLE quotation_items ADD COLUMN tax_rate_id INTEGER",
            "ALTER TABLE quotation_items ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
            "ALTER TABLE quotation_items ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0",
            "ALTER TABLE invoices   ADD COLUMN subtotal  REAL NOT NULL DEFAULT 0",
            "ALTER TABLE invoices   ADD COLUMN tax_total REAL NOT NULL DEFAULT 0",
            "ALTER TABLE quotations ADD COLUMN tax_total REAL NOT NULL DEFAULT 0",
            "ALTER TABLE purchases  ADD COLUMN tax_rate_id INTEGER",
            "ALTER TABLE purchases  ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
            "ALTER TABLE purchases  ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0",
            "ALTER TABLE expenses   ADD COLUMN tax_rate_id INTEGER",
            "ALTER TABLE expenses   ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
            "ALTER TABLE expenses   ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        # Backfill from the legacy global rate so historical documents stay
        # consistent with what the VAT report showed before this migration.
        en = c.execute("SELECT value FROM settings WHERE key='tax_enabled'").fetchone()
        rr = c.execute("SELECT value FROM settings WHERE key='default_tax_rate'").fetchone()
        try:
            legacy_rate = float(rr[0]) if (en and en[0] == '1' and rr and rr[0]) else 0.0
        except (TypeError, ValueError):
            legacy_rate = 0.0
        if legacy_rate > 0:
            drow = c.execute("SELECT id FROM tax_rates WHERE is_default=1 LIMIT 1").fetchone()
            drid = drow[0] if drow else None
            frac = legacy_rate / 100.0
            mult = 1.0 + frac
            try:
                c.execute("UPDATE invoice_items   SET tax_rate_id=?, tax_rate=?, "
                          "tax_amount=ROUND(quantity*unit_price*?,2)", (drid, legacy_rate, frac))
                c.execute("UPDATE quotation_items SET tax_rate_id=?, tax_rate=?, "
                          "tax_amount=ROUND(quantity*unit_price*?,2)", (drid, legacy_rate, frac))
                # invoices.amount is tax-inclusive; quotations.total is the net subtotal.
                c.execute("UPDATE invoices SET "
                          "tax_total=COALESCE((SELECT ROUND(SUM(tax_amount),2) FROM invoice_items "
                          "  WHERE invoice_id=invoices.id),0), "
                          "subtotal=amount-COALESCE((SELECT ROUND(SUM(tax_amount),2) FROM invoice_items "
                          "  WHERE invoice_id=invoices.id),0)")
                c.execute("UPDATE quotations SET "
                          "tax_total=COALESCE((SELECT ROUND(SUM(tax_amount),2) FROM quotation_items "
                          "  WHERE quotation_id=quotations.id),0)")
                c.execute("UPDATE expenses SET tax_amount=ROUND(amount-amount/?,2)", (mult,))
            except Exception:
                pass
        else:
            # Tax was off — subtotal simply equals the stored amount.
            try:
                c.execute("UPDATE invoices SET subtotal=amount")
            except Exception:
                pass
        done("045_line_item_tax")

    # ── 046: barcode / SKU on inventory items ─────────────────────────────
    # Lets the POS register scan or type a code to add an item instantly.
    if need("046_inventory_barcode"):
        if "barcode" not in cols("inventory"):
            c.execute("ALTER TABLE inventory ADD COLUMN barcode TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode)")
        done("046_inventory_barcode")

    # ── 047: POS register / cash-drawer sessions ──────────────────────────
    if need("047_pos_sessions"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS pos_sessions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                cashier_id    INTEGER NOT NULL REFERENCES users(id),
                cashier_name  TEXT,
                status        TEXT    NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
                opening_float REAL    NOT NULL DEFAULT 0,
                closing_count REAL,
                expected_cash REAL,
                variance      REAL,
                note          TEXT,
                opened_at     TEXT    NOT NULL,
                closed_at     TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_sessions_cashier ON pos_sessions(cashier_id, status)")
        done("047_pos_sessions")

    # ── 048: POS sales — one row per completed checkout ───────────────────
    # The financial record is a real `invoices` row; this table links the sale
    # to its register session and holds POS-only fields (tendered / change).
    if need("048_pos_sales"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS pos_sales (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id      INTEGER NOT NULL REFERENCES pos_sessions(id),
                invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
                cashier_id      INTEGER NOT NULL REFERENCES users(id),
                cashier_name    TEXT,
                payment_method  TEXT    NOT NULL DEFAULT 'Cash',     -- 'Cash' | 'Card'
                paid_currency   TEXT    NOT NULL DEFAULT 'USD',      -- 'USD' | 'LBP'
                amount_tendered REAL    NOT NULL DEFAULT 0,          -- in paid_currency
                change_given    REAL    NOT NULL DEFAULT 0,          -- in paid_currency
                total_usd       REAL    NOT NULL DEFAULT 0,
                status          TEXT    NOT NULL DEFAULT 'completed',-- 'completed' | 'returned'
                returned_at     TEXT,
                created_at      TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_sales_session ON pos_sales(session_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_sales_invoice ON pos_sales(invoice_id)")
        done("048_pos_sales")

    # ── 049: POS sale items — inventory linkage for restock-on-return ─────
    # Financial line data lives in `invoice_items`; this records which
    # inventory row each line drew from (NULL for free-text service lines).
    if need("049_pos_sale_items"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS pos_sale_items (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pos_sale_id     INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
                invoice_item_id INTEGER REFERENCES invoice_items(id) ON DELETE SET NULL,
                inventory_id    INTEGER REFERENCES inventory(id),
                name            TEXT    NOT NULL,
                quantity        REAL    NOT NULL DEFAULT 1,
                unit_price      REAL    NOT NULL DEFAULT 0,
                line_type       TEXT    NOT NULL DEFAULT 'product'  -- 'product' | 'service'
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_sale_items_sale ON pos_sale_items(pos_sale_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_sale_items_inv  ON pos_sale_items(inventory_id)")
        done("049_pos_sale_items")

    # ── 050: POS returns / refunds ────────────────────────────────────────
    if need("050_pos_returns"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS pos_returns (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                pos_sale_id   INTEGER NOT NULL REFERENCES pos_sales(id),
                session_id    INTEGER NOT NULL REFERENCES pos_sessions(id),
                invoice_id    INTEGER NOT NULL REFERENCES invoices(id),
                cashier_id    INTEGER NOT NULL REFERENCES users(id),
                refund_amount REAL    NOT NULL DEFAULT 0,
                reason        TEXT,
                created_at    TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_pos_returns_sale ON pos_returns(pos_sale_id)")
        done("050_pos_returns")

    # ── 051: retail sale price on inventory items ─────────────────────────
    # The price the POS rings an item up at (VAT-inclusive). `unit_cost` stays
    # the landed cost used for stock valuation and COGS.
    if need("051_inventory_sale_price"):
        if "sale_price" not in cols("inventory"):
            c.execute("ALTER TABLE inventory ADD COLUMN sale_price REAL NOT NULL DEFAULT 0")
        done("051_inventory_sale_price")

    # ── 052: per-line discount on invoice items ───────────────────────────
    # Total discount applied to the line (line markdown + the line's share of
    # any order-level discount). Informational — `unit_price` is already the
    # post-discount net, so existing invoice readers stay correct.
    if need("052_invoice_item_discount"):
        if "discount" not in cols("invoice_items"):
            c.execute("ALTER TABLE invoice_items ADD COLUMN discount REAL NOT NULL DEFAULT 0")
        done("052_invoice_item_discount")

    # ── 053: POS pricing — discounts & cost of goods sold ─────────────────
    if need("053_pos_pricing"):
        for ddl in (
            "ALTER TABLE pos_sales ADD COLUMN discount_total REAL NOT NULL DEFAULT 0",
            "ALTER TABLE pos_sales ADD COLUMN cogs_total     REAL NOT NULL DEFAULT 0",
            "ALTER TABLE pos_sale_items ADD COLUMN discount   REAL NOT NULL DEFAULT 0",
            "ALTER TABLE pos_sale_items ADD COLUMN unit_cost  REAL NOT NULL DEFAULT 0",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        done("053_pos_pricing")

    # ── 054: cash drawers / tills ─────────────────────────────────────────
    # Named cash points reconciled daily. Exactly one drawer may carry
    # `auto_capture` — it receives the day's automatic business cash.
    if need("054_cash_drawers"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS cash_drawers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT    NOT NULL UNIQUE,
                is_active    INTEGER NOT NULL DEFAULT 1,
                auto_capture INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT    NOT NULL
            )
        """)
        if not c.execute("SELECT 1 FROM cash_drawers LIMIT 1").fetchone():
            c.execute("INSERT INTO cash_drawers (name, is_active, auto_capture, created_at) "
                      "VALUES ('Main Till', 1, 1, datetime('now'))")
        done("054_cash_drawers")

    # ── 055: daily cash reconciliations (one per drawer per day) ──────────
    if need("055_cash_reconciliations"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS cash_reconciliations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                drawer_id       INTEGER NOT NULL REFERENCES cash_drawers(id),
                business_date   TEXT    NOT NULL,
                opening_balance REAL    NOT NULL DEFAULT 0,
                counted_cash    REAL,
                expected_cash   REAL,
                variance        REAL,
                status          TEXT    NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
                note            TEXT,
                opened_by       INTEGER REFERENCES users(id),
                opened_by_name  TEXT,
                opened_at       TEXT    NOT NULL,
                closed_by       INTEGER REFERENCES users(id),
                closed_by_name  TEXT,
                closed_at       TEXT,
                UNIQUE(drawer_id, business_date)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_cash_recon_drawer "
                  "ON cash_reconciliations(drawer_id, business_date)")
        done("055_cash_reconciliations")

    # ── 056: manual cash movements within a reconciliation ────────────────
    if need("056_cash_movements"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS cash_movements (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                reconciliation_id INTEGER NOT NULL REFERENCES cash_reconciliations(id) ON DELETE CASCADE,
                direction         TEXT    NOT NULL,            -- 'in' | 'out'
                amount            REAL    NOT NULL,
                category          TEXT,
                description       TEXT,
                created_by        INTEGER REFERENCES users(id),
                created_by_name   TEXT,
                created_at        TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_cash_movements_recon "
                  "ON cash_movements(reconciliation_id)")
        done("056_cash_movements")

    # ── 057: payment method on expenses ───────────────────────────────────
    # Lets the daily cash reconciliation auto-capture cash-paid expenses.
    if need("057_expense_payment_method"):
        if "payment_method" not in cols("expenses"):
            c.execute("ALTER TABLE expenses ADD COLUMN payment_method TEXT")
        done("057_expense_payment_method")

    # ── 058: attribute cash to a specific drawer ──────────────────────────
    # A cash payment / expense may name the drawer it belongs to. Untagged
    # cash (cash_drawer_id NULL) falls back to the default drawer.
    if need("058_cash_drawer_attribution"):
        for ddl in (
            "ALTER TABLE invoice_payments ADD COLUMN cash_drawer_id INTEGER",
            "ALTER TABLE expenses        ADD COLUMN cash_drawer_id INTEGER",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        done("058_cash_drawer_attribution")

    # ── 059: dual-currency cash reconciliation (USD + LBP) ────────────────
    # A drawer physically holds USD notes AND LBP notes — two separate cash
    # balances that are never summed. Each currency keeps its own opening,
    # counted, expected and variance; each movement carries its currency.
    if need("059_cash_dual_currency"):
        for ddl in (
            "ALTER TABLE cash_reconciliations ADD COLUMN opening_balance_lbp REAL NOT NULL DEFAULT 0",
            "ALTER TABLE cash_reconciliations ADD COLUMN counted_cash_lbp    REAL",
            "ALTER TABLE cash_reconciliations ADD COLUMN expected_cash_lbp   REAL",
            "ALTER TABLE cash_reconciliations ADD COLUMN variance_lbp        REAL",
            "ALTER TABLE cash_movements ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        done("059_cash_dual_currency")

    # ── 060: dual-currency POS register sessions ──────────────────────────
    # A cashier counts the USD float and the LBP float separately at open and
    # close — two independent drawer positions, two variances.
    if need("060_pos_session_dual_currency"):
        for ddl in (
            "ALTER TABLE pos_sessions ADD COLUMN opening_float_lbp REAL NOT NULL DEFAULT 0",
            "ALTER TABLE pos_sessions ADD COLUMN closing_count_lbp REAL",
            "ALTER TABLE pos_sessions ADD COLUMN expected_cash_lbp REAL",
            "ALTER TABLE pos_sessions ADD COLUMN variance_lbp      REAL",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass
        done("060_pos_session_dual_currency")

    # ── 061: manufacturing — bills of materials ───────────────────────────
    # A BOM is a recipe: a finished inventory item produced from component
    # inventory items. `output_quantity` is the batch yield; `labor_cost` is
    # the per-batch labour/overhead added on top of material cost.
    if need("061_boms"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS boms (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT    NOT NULL,
                output_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
                output_quantity     REAL    NOT NULL DEFAULT 1,
                labor_cost          REAL    NOT NULL DEFAULT 0,
                notes               TEXT,
                is_active           INTEGER NOT NULL DEFAULT 1,
                archived_at         TEXT,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_boms_output ON boms(output_inventory_id)")
        done("061_boms")

    # ── 062: BOM component lines ──────────────────────────────────────────
    if need("062_bom_components"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS bom_components (
                id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                bom_id                 INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
                component_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
                quantity               REAL    NOT NULL DEFAULT 1
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_bom_components_bom ON bom_components(bom_id)")
        done("062_bom_components")

    # ── 063: production orders ────────────────────────────────────────────
    # Costs (materials / total / unit) are computed and frozen at completion.
    if need("063_production_orders"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_orders (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number        TEXT    UNIQUE NOT NULL,
                bom_id              INTEGER REFERENCES boms(id),
                output_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
                quantity            REAL    NOT NULL DEFAULT 1,
                status              TEXT    NOT NULL DEFAULT 'Draft',
                labor_cost          REAL    NOT NULL DEFAULT 0,
                materials_cost      REAL    NOT NULL DEFAULT 0,
                total_cost          REAL    NOT NULL DEFAULT 0,
                unit_cost           REAL    NOT NULL DEFAULT 0,
                notes               TEXT,
                started_at          TEXT,
                completed_at        TEXT,
                cancelled_at        TEXT,
                cancel_reason       TEXT,
                archived_at         TEXT,
                created_by          INTEGER REFERENCES users(id),
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_orders_status ON production_orders(status)")
        done("063_production_orders")

    # ── 064: production order component requirements (BOM snapshot) ───────
    # Snapshotted + scaled at order creation; unit_cost / line_cost are filled
    # in at completion from the component's cost at that moment.
    if need("064_production_order_items"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_order_items (
                id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                production_order_id    INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
                component_inventory_id INTEGER REFERENCES inventory(id),
                name                   TEXT    NOT NULL,
                quantity_required      REAL    NOT NULL DEFAULT 0,
                unit_cost              REAL    NOT NULL DEFAULT 0,
                line_cost              REAL    NOT NULL DEFAULT 0
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_order_items_order "
                  "ON production_order_items(production_order_id)")
        done("064_production_order_items")

    # ── 065: fixed assets register ────────────────────────────────────────
    # Capital assets tracked for straight-line depreciation. Each posted
    # depreciation period writes a row to `expenses` (category 'Depreciation')
    # so it flows into the Finance P&L exactly like any other cost.
    if need("065_fixed_assets"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS fixed_assets (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_code               TEXT    UNIQUE NOT NULL,
                name                     TEXT    NOT NULL,
                category                 TEXT,
                description              TEXT,
                acquisition_cost         REAL    NOT NULL DEFAULT 0,
                acquisition_date         TEXT    NOT NULL,
                in_service_date          TEXT,
                depreciation_method      TEXT    NOT NULL DEFAULT 'straight_line',
                useful_life_months       INTEGER NOT NULL DEFAULT 0,
                salvage_value            REAL    NOT NULL DEFAULT 0,
                accumulated_depreciation REAL    NOT NULL DEFAULT 0,
                last_depreciated_period  TEXT,
                status                   TEXT    NOT NULL DEFAULT 'Active',
                supplier_id              INTEGER REFERENCES suppliers(id),
                disposal_date            TEXT,
                disposal_proceeds        REAL,
                disposal_reason          TEXT,
                archived_at              TEXT,
                created_by               INTEGER REFERENCES users(id),
                created_at               TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_fixed_assets_status ON fixed_assets(status)")
        done("065_fixed_assets")

    # ── 066: asset depreciation ledger ────────────────────────────────────
    # One immutable row per asset per posted month, linked to the expense row
    # it generated. UNIQUE(asset_id, period) makes posting idempotent.
    if need("066_asset_depreciation"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS asset_depreciation (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id          INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
                period            TEXT    NOT NULL,
                amount            REAL    NOT NULL DEFAULT 0,
                accumulated_after REAL    NOT NULL DEFAULT 0,
                book_value_after  REAL    NOT NULL DEFAULT 0,
                expense_id        INTEGER REFERENCES expenses(id),
                posted_at         TEXT    NOT NULL,
                posted_by         INTEGER REFERENCES users(id),
                UNIQUE(asset_id, period)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_asset_depreciation_asset ON asset_depreciation(asset_id)")
        done("066_asset_depreciation")

    # ── 067: recurring expense templates ──────────────────────────────────
    # A template that generates real `expenses` rows on its schedule. The
    # template itself never appears in financial totals — only the rows it
    # produces do, so there is a single source of truth.
    if need("067_recurring_expenses"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recurring_expenses (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT    NOT NULL,
                category            TEXT    NOT NULL,
                description         TEXT,
                amount              REAL    NOT NULL DEFAULT 0,
                frequency           TEXT    NOT NULL DEFAULT 'monthly',
                start_date          TEXT    NOT NULL,
                end_date            TEXT,
                next_run_date       TEXT    NOT NULL,
                last_generated_date TEXT,
                project_id          INTEGER REFERENCES projects(id),
                payment_method      TEXT,
                tax_rate_id         INTEGER REFERENCES tax_rates(id),
                is_active           INTEGER NOT NULL DEFAULT 1,
                archived_at         TEXT,
                created_by          INTEGER REFERENCES users(id),
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recurring_expenses_active ON recurring_expenses(is_active)")
        done("067_recurring_expenses")

    # ── 068-069: trace generated expenses back to their source ────────────
    add_col("068_expense_recurring_id", "expenses", "recurring_expense_id",
            "ALTER TABLE expenses ADD COLUMN recurring_expense_id INTEGER REFERENCES recurring_expenses(id)")
    add_col("069_expense_fixed_asset_id", "expenses", "fixed_asset_id",
            "ALTER TABLE expenses ADD COLUMN fixed_asset_id INTEGER REFERENCES fixed_assets(id)")

    # ═══ Manufacturing v2 ═════════════════════════════════════════════════
    # Each block adds several columns; ALTER cannot bind identifiers so the
    # DDL is fixed-literal, guarded by an existence check.
    def _add_cols(migration, specs):
        """specs = [(table, column, ddl), ...]  — apply missing columns once."""
        if not need(migration):
            return
        tables = all_tables()
        for tbl, col, ddl in specs:
            if tbl in tables and col not in cols(tbl):
                c.execute(ddl)
        done(migration)

    # ── 070: product types + material reservation on inventory ────────────
    _add_cols("070_mfg_inventory", [
        ("inventory", "product_type",
         "ALTER TABLE inventory ADD COLUMN product_type TEXT"),
        ("inventory", "reserved_quantity",
         "ALTER TABLE inventory ADD COLUMN reserved_quantity REAL NOT NULL DEFAULT 0"),
    ])

    # ── 071: BOM versioning, overhead and revision notes ──────────────────
    _add_cols("071_mfg_boms", [
        ("boms", "version",
         "ALTER TABLE boms ADD COLUMN version INTEGER NOT NULL DEFAULT 1"),
        ("boms", "bom_group_id",
         "ALTER TABLE boms ADD COLUMN bom_group_id INTEGER"),
        ("boms", "overhead_cost",
         "ALTER TABLE boms ADD COLUMN overhead_cost REAL NOT NULL DEFAULT 0"),
        ("boms", "revision_note",
         "ALTER TABLE boms ADD COLUMN revision_note TEXT"),
    ])
    if need("072_mfg_bom_group_backfill"):
        if "boms" in all_tables() and "bom_group_id" in cols("boms"):
            c.execute("UPDATE boms SET bom_group_id = id WHERE bom_group_id IS NULL")
        done("072_mfg_bom_group_backfill")

    # ── 073: per-component scrap allowance ────────────────────────────────
    _add_cols("073_mfg_bom_components", [
        ("bom_components", "scrap_pct",
         "ALTER TABLE bom_components ADD COLUMN scrap_pct REAL NOT NULL DEFAULT 0"),
    ])

    # ── 074: production-order lifecycle + costing + variance ──────────────
    _add_cols("074_mfg_orders", [
        ("production_orders", "quantity_produced",
         "ALTER TABLE production_orders ADD COLUMN quantity_produced REAL"),
        ("production_orders", "overhead_cost",
         "ALTER TABLE production_orders ADD COLUMN overhead_cost REAL NOT NULL DEFAULT 0"),
        ("production_orders", "scrap_cost",
         "ALTER TABLE production_orders ADD COLUMN scrap_cost REAL NOT NULL DEFAULT 0"),
        ("production_orders", "confirmed_at",
         "ALTER TABLE production_orders ADD COLUMN confirmed_at TEXT"),
        ("production_orders", "bom_version",
         "ALTER TABLE production_orders ADD COLUMN bom_version INTEGER"),
    ])

    # ── 075: per-line actual consumption + scrap (variance tracking) ──────
    _add_cols("075_mfg_order_items", [
        ("production_order_items", "quantity_consumed",
         "ALTER TABLE production_order_items ADD COLUMN quantity_consumed REAL"),
        ("production_order_items", "quantity_scrapped",
         "ALTER TABLE production_order_items ADD COLUMN quantity_scrapped REAL NOT NULL DEFAULT 0"),
        ("production_order_items", "scrap_pct",
         "ALTER TABLE production_order_items ADD COLUMN scrap_pct REAL NOT NULL DEFAULT 0"),
    ])

    # ── 076: module-request inbox ─────────────────────────────────────────
    # Captures prospect submissions from the public /discover configurator:
    # a card-grid of business-friendly modules → company + contact details
    # + the JSON list of selected module keys. Status moves new → contacted
    # → converted (or archived) as the sales conversation progresses.
    if need("076_module_requests"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS module_requests (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                company           TEXT    NOT NULL,
                contact_name      TEXT    NOT NULL,
                email             TEXT,
                phone             TEXT,
                country           TEXT,
                employee_count    TEXT,                 -- "1-5", "6-20", ...
                industry          TEXT,
                selected_modules  TEXT    NOT NULL,     -- JSON array of module keys
                notes             TEXT,
                status            TEXT    NOT NULL DEFAULT 'new',
                ip_address        TEXT,
                user_agent        TEXT,
                created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
                contacted_at      TEXT,
                converted_at      TEXT,
                archived_at       TEXT,
                internal_notes    TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_module_requests_status "
                  "ON module_requests(status)")
        done("076_module_requests")

    # ── 077: standalone planning events ───────────────────────────────────
    # Calendar in the Planning module shows user-planned events (meetings,
    # reminders, deadlines), NOT project tasks — the Gantt + Board + List
    # views already cover those. Events are independent of projects: any
    # signed-in user with planning.view can read; create/edit/delete is
    # gated by the usual planning permissions. A single date is required;
    # end_date is optional for multi-day events; start_time/end_time are
    # optional and only used when all_day is 0.
    if need("077_planning_events"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS planning_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT    NOT NULL,
                description  TEXT,
                start_date   TEXT    NOT NULL,
                end_date     TEXT,                      -- nullable; defaults to start_date
                start_time   TEXT,                      -- 'HH:MM' or NULL
                end_time     TEXT,                      -- 'HH:MM' or NULL
                all_day      INTEGER NOT NULL DEFAULT 1,
                color        TEXT,                      -- hex; NULL → use accent
                owner_id     INTEGER,                   -- creator (FK to users.id)
                owner_name   TEXT,                      -- denormalised for display
                created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT,
                archived_at  TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_events_start_date "
                  "ON planning_events(start_date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_planning_events_owner "
                  "ON planning_events(owner_id)")
        done("077_planning_events")

    # ── 078: announcement system ──────────────────────────────────────────
    # Internal announcements broadcast top-down by users who hold the
    # `announcements.create` permission. Recipients are materialised at
    # publish time so we can compute per-user unread counts and
    # acknowledgement progress with simple JOINs. New users joining later
    # do not retroactively receive historical announcements — that is the
    # intended scope for an internal-comms tool.
    if need("078_announcements"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS announcements (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                title             TEXT    NOT NULL,
                body              TEXT    NOT NULL,
                priority          TEXT    NOT NULL DEFAULT 'medium',  -- low|medium|high|critical
                audience_type     TEXT    NOT NULL,                   -- all|roles|users
                audience_payload  TEXT,                                -- JSON list of role_ids/user_ids; NULL when audience_type='all'
                requires_ack      INTEGER NOT NULL DEFAULT 0,
                pinned            INTEGER NOT NULL DEFAULT 0,
                author_id         INTEGER NOT NULL,
                author_name       TEXT,
                published_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                expires_at        TEXT,                                -- nullable; auto-archived after this date
                archived_at       TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS announcement_recipients (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                announcement_id INTEGER NOT NULL REFERENCES announcements(id),
                user_id         INTEGER NOT NULL REFERENCES users(id),
                read_at         TEXT,
                acknowledged_at TEXT,
                UNIQUE(announcement_id, user_id)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS announcement_comments (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                announcement_id INTEGER NOT NULL REFERENCES announcements(id),
                author_id       INTEGER NOT NULL REFERENCES users(id),
                author_name     TEXT,
                body            TEXT    NOT NULL,
                created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                deleted_at      TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_ann_pub        ON announcements(published_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ann_archived   ON announcements(archived_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ann_rec_user   ON announcement_recipients(user_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ann_rec_ann    ON announcement_recipients(announcement_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ann_cmt_ann    ON announcement_comments(announcement_id)")
        done("078_announcements")

    # ── 079: attendees on planning_events ─────────────────────────────────
    # Stored as a comma-separated string of user IDs (e.g. "3,7,12"). Lets
    # the creator invite teammates so a notification fires for the people
    # who actually need to know about the meeting, while keeping personal
    # reminders (no attendees) a no-op for the rest of the team.
    add_col("079_event_attendees", "planning_events", "attendees",
            "ALTER TABLE planning_events ADD COLUMN attendees TEXT DEFAULT NULL")

    # ── 080: admin-tier role flag ─────────────────────────────────────────
    # Marks a role as having administrative access (users/roles/settings/audit/
    # backups) WITHOUT being a vendor superadmin. Drives the "Business Owner"
    # role: full admin EXCEPT the module marketplace (Module Requests +
    # enabled_modules), which stays superadmin-only.
    add_col("080_roles_is_admin", "roles", "is_admin",
            "ALTER TABLE roles ADD COLUMN is_admin INTEGER DEFAULT 0")

    # ── 081: drop the stale enabled_modules row ───────────────────────────
    # `enabled_modules` is no longer a runtime setting — it lives in
    # `backend/vendor_config.py` as an immutable build-time constant. Old
    # installs may still carry a row in `settings` from the pre-081 era.
    # The settings GET endpoint already ignores it (overrides with the
    # constant), but we delete the row so a future operator inspecting the
    # DB isn't misled by a value that has no effect.
    if need("081_drop_enabled_modules_setting"):
        c.execute("DELETE FROM settings WHERE key='enabled_modules'")
        done("081_drop_enabled_modules_setting")

    # ── 082: drop the module_requests table ───────────────────────────────
    # The Module Requests inbox no longer exists in the customer's ERP —
    # it has been moved to the vendor-hosted marketing site. Any data
    # collected pre-082 is dropped along with the table.
    if need("082_drop_module_requests_table"):
        c.execute("DROP TABLE IF EXISTS module_requests")
        done("082_drop_module_requests_table")

    # ── 083: rolled back — invoice write-off ──────────────────────────────
    # The feature was retracted to keep invoice settlement auditable: every
    # closed invoice now must be backed by actual `invoice_payments` rows,
    # never a phantom write-off amount. We drop the columns on installs
    # that briefly had them so the schema stays clean. SQLite supports
    # ALTER TABLE DROP COLUMN since 3.35; the try/except handles older
    # SQLite and fresh installs that never had the columns in the first
    # place — both are harmless no-ops.
    if need("083_drop_invoice_writeoff"):
        for col in ("written_off", "writeoff_reason"):
            try:
                c.execute(f"ALTER TABLE invoices DROP COLUMN {col}")
            except sqlite3.OperationalError:
                pass
        done("083_drop_invoice_writeoff")

    # ── 084: archive_reason for CRM & Planning entities ───────────────────
    # CRM leads/deals and Planning projects/tasks could be archived but never
    # restored — they lacked the `archive_reason` column the Archives router
    # writes and weren't registered there, so an archived row vanished from
    # every list with no way back. Add the column so the generic
    # archive/unarchive (and the Archives page) cover them like every other
    # entity. The column defaults NULL, so existing archived rows are unaffected.
    add_col("084_crm_leads_archive_reason", "crm_leads", "archive_reason",
            "ALTER TABLE crm_leads ADD COLUMN archive_reason TEXT DEFAULT NULL")
    add_col("084_crm_deals_archive_reason", "crm_deals", "archive_reason",
            "ALTER TABLE crm_deals ADD COLUMN archive_reason TEXT DEFAULT NULL")
    add_col("084_planning_projects_archive_reason", "planning_projects", "archive_reason",
            "ALTER TABLE planning_projects ADD COLUMN archive_reason TEXT DEFAULT NULL")
    add_col("084_planning_tasks_archive_reason", "planning_tasks", "archive_reason",
            "ALTER TABLE planning_tasks ADD COLUMN archive_reason TEXT DEFAULT NULL")

    # ── 085: purchases.category ────────────────────────────────────────────
    # The Purchases form/payload has always carried a `category` field, but it
    # was only ever written to the linked `inventory.category` — never stored
    # on the purchase row itself. Result: the table and filter dropdown in the
    # Purchases page were permanently empty. Persist it on the purchase too so
    # historical orders keep their classification independent of the inventory
    # item (which can be re-categorised later).
    add_col("085_purchases_category", "purchases", "category",
            "ALTER TABLE purchases ADD COLUMN category TEXT")

    # ── 086: quotations.lead_id ────────────────────────────────────────────
    # Quotations can be sent to CRM leads, not only existing clients. Add an
    # optional FK to crm_leads so a quote can be addressed to either party.
    # Conversion to invoice/project requires a real client_id — leads must be
    # converted first (the routers enforce that at runtime).
    add_col("086_quotations_lead_id", "quotations", "lead_id",
            "ALTER TABLE quotations ADD COLUMN lead_id INTEGER REFERENCES crm_leads(id)")

    # ── 087: hr_employment_changes ─────────────────────────────────────────
    # Immutable history of compensation / role / department / manager changes.
    # One row per change — a promotion may move several columns simultaneously
    # (title + salary + manager), captured atomically as one row.
    # change_type values: hire | raise | promotion | demotion | role_change
    #                     transfer | termination | adjustment
    # The PUT /api/hr/employees endpoint diffs old vs new and writes one row
    # whenever any tracked field differs (see routers/hr.py).
    if need("087_hr_employment_changes"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_employment_changes (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id         INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
                effective_date      TEXT    NOT NULL,
                change_type         TEXT    NOT NULL DEFAULT 'adjustment',
                old_salary          REAL,
                new_salary          REAL,
                old_title           TEXT,
                new_title           TEXT,
                old_department_id   INTEGER REFERENCES hr_departments(id) ON DELETE SET NULL,
                new_department_id   INTEGER REFERENCES hr_departments(id) ON DELETE SET NULL,
                old_manager_id      INTEGER REFERENCES hr_employees(id)   ON DELETE SET NULL,
                new_manager_id      INTEGER REFERENCES hr_employees(id)   ON DELETE SET NULL,
                reason              TEXT,
                created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_changes_emp ON hr_employment_changes(employee_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_changes_date ON hr_employment_changes(effective_date)")
        done("087_hr_employment_changes")

    # ── 088: hr_payroll_runs ───────────────────────────────────────────────
    # One row per pay period (typically a month). Lifecycle:
    #   Draft → Approved → Paid
    # `posted_expense_id` links to the single `expenses` row inserted when the
    # run is marked Paid — payroll cost flows into Finance automatically, no
    # double-entry. Cancellation deletes the linked expense if not yet paid.
    if need("088_hr_payroll_runs"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_payroll_runs (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                period_start        TEXT    NOT NULL,
                period_end          TEXT    NOT NULL,
                status              TEXT    NOT NULL DEFAULT 'Draft',
                total_gross         REAL    NOT NULL DEFAULT 0,
                total_bonuses       REAL    NOT NULL DEFAULT 0,
                total_deductions    REAL    NOT NULL DEFAULT 0,
                total_net           REAL    NOT NULL DEFAULT 0,
                posted_expense_id   INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
                notes               TEXT,
                approved_at         TEXT,
                approved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
                paid_at             TEXT,
                paid_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
                archived_at         TEXT,
                created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_status ON hr_payroll_runs(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_period ON hr_payroll_runs(period_start, period_end)")
        done("088_hr_payroll_runs")

    # ── 089: hr_payroll_lines ──────────────────────────────────────────────
    # One row per (run × employee). Frozen at run creation from the employee's
    # current salary; bonuses/deductions/notes are edited on the line itself.
    if need("089_hr_payroll_lines"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_payroll_lines (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                payroll_run_id      INTEGER NOT NULL REFERENCES hr_payroll_runs(id) ON DELETE CASCADE,
                employee_id         INTEGER NOT NULL REFERENCES hr_employees(id)    ON DELETE RESTRICT,
                base_salary         REAL    NOT NULL DEFAULT 0,
                bonuses             REAL    NOT NULL DEFAULT 0,
                deductions          REAL    NOT NULL DEFAULT 0,
                net_amount          REAL    NOT NULL DEFAULT 0,
                notes               TEXT,
                created_at          TEXT    NOT NULL,
                UNIQUE (payroll_run_id, employee_id)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_payroll_lines_run ON hr_payroll_lines(payroll_run_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_payroll_lines_emp ON hr_payroll_lines(employee_id)")
        done("089_hr_payroll_lines")

    # ── 090: hr_employee_files ─────────────────────────────────────────────
    # PDF attachments per employee (CV, contract, other). Stored as BLOB inside
    # SQLite so the customer's install ships one self-contained DB file — no
    # extra filesystem layout to back up. Capped at 8MB / file (enforced in the
    # router). `kind` is a lightweight tag: cv | contract | other.
    if need("090_hr_employee_files"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_employee_files (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id     INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
                kind            TEXT    NOT NULL DEFAULT 'other',
                filename        TEXT    NOT NULL,
                content_type    TEXT    NOT NULL DEFAULT 'application/pdf',
                size_bytes      INTEGER NOT NULL DEFAULT 0,
                data            BLOB    NOT NULL,
                uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at      TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_emp_files_emp ON hr_employee_files(employee_id)")
        done("090_hr_employee_files")

    # ── 092: recruitment_positions ─────────────────────────────────────────
    # Open job postings the company is recruiting for. An applicant is always
    # attached to a position so analytics like "30 candidates per opening"
    # are trivial. Positions are soft-deleted via archived_at.
    if need("092_recruitment_positions"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_positions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                title           TEXT    NOT NULL,
                department_id   INTEGER REFERENCES hr_departments(id) ON DELETE SET NULL,
                employment_type TEXT    NOT NULL DEFAULT 'Full-time',
                location        TEXT,
                salary_min      REAL,
                salary_max      REAL,
                headcount       INTEGER NOT NULL DEFAULT 1,
                status          TEXT    NOT NULL DEFAULT 'Open',
                description     TEXT,
                requirements    TEXT,
                posted_at       TEXT,
                closed_at       TEXT,
                created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                archived_at     TEXT,
                created_at      TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_pos_status ON recruitment_positions(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_pos_dept   ON recruitment_positions(department_id)")
        done("092_recruitment_positions")

    # ── 093: recruitment_applicants ────────────────────────────────────────
    # Pipeline: Applied → Screening → Interview → Technical Test →
    #          Accepted / Rejected / Withdrawn
    # `converted_employee_id` is filled when an Accepted applicant is converted
    # into an hr_employees row — keeps the link both ways.
    if need("093_recruitment_applicants"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_applicants (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                position_id           INTEGER REFERENCES recruitment_positions(id) ON DELETE SET NULL,
                full_name             TEXT    NOT NULL,
                email                 TEXT,
                phone                 TEXT,
                source                TEXT    DEFAULT 'Other',
                expected_salary       REAL,
                offered_salary        REAL,
                status                TEXT    NOT NULL DEFAULT 'Applied',
                rating                INTEGER,
                rejected_reason       TEXT,
                notes                 TEXT,
                assigned_to           INTEGER REFERENCES users(id) ON DELETE SET NULL,
                converted_employee_id INTEGER REFERENCES hr_employees(id) ON DELETE SET NULL,
                applied_at            TEXT    NOT NULL,
                last_status_change    TEXT,
                archived_at           TEXT,
                created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at            TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_app_position ON recruitment_applicants(position_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_app_status   ON recruitment_applicants(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_app_emp      ON recruitment_applicants(converted_employee_id)")
        done("093_recruitment_applicants")

    # ── 094: recruitment_applicant_status_history ──────────────────────────
    # Every status transition is logged: who changed it, when, from / to, and
    # an optional reason. Append-only audit trail.
    if need("094_recruitment_status_history"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_status_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                applicant_id  INTEGER NOT NULL REFERENCES recruitment_applicants(id) ON DELETE CASCADE,
                old_status    TEXT,
                new_status    TEXT NOT NULL,
                note          TEXT,
                changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at    TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_sh_app ON recruitment_status_history(applicant_id)")
        done("094_recruitment_status_history")

    # ── 095: recruitment_interviews ────────────────────────────────────────
    # One row per scheduled interview. `interviewer_id` may be NULL when the
    # interviewer is external. `score` is 1–10 (NULL until completed).
    if need("095_recruitment_interviews"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_interviews (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                applicant_id     INTEGER NOT NULL REFERENCES recruitment_applicants(id) ON DELETE CASCADE,
                interview_type   TEXT    NOT NULL DEFAULT 'Phone',
                scheduled_at     TEXT    NOT NULL,
                duration_min     INTEGER DEFAULT 60,
                location         TEXT,
                interviewer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
                interviewer_name TEXT,
                status           TEXT    NOT NULL DEFAULT 'Scheduled',
                score            INTEGER,
                decision         TEXT,
                notes            TEXT,
                completed_at     TEXT,
                created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at       TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_int_app ON recruitment_interviews(applicant_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_int_when ON recruitment_interviews(scheduled_at)")
        done("095_recruitment_interviews")

    # ── 096: recruitment_applicant_files ───────────────────────────────────
    # Applicants attach PDFs (CV, cover letter, portfolio, certificates, etc.)
    # before they become employees. Stored as BLOB inside SQLite, capped to
    # 8MB / file by the router (same policy as hr_employee_files).
    if need("096_recruitment_applicant_files"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_applicant_files (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                applicant_id  INTEGER NOT NULL REFERENCES recruitment_applicants(id) ON DELETE CASCADE,
                kind          TEXT    NOT NULL DEFAULT 'cv',
                filename      TEXT    NOT NULL,
                content_type  TEXT    NOT NULL DEFAULT 'application/pdf',
                size_bytes    INTEGER NOT NULL DEFAULT 0,
                data          BLOB    NOT NULL,
                uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at    TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recr_af_app ON recruitment_applicant_files(applicant_id)")
        done("096_recruitment_applicant_files")

    # ── 097: hr_contracts ──────────────────────────────────────────────────
    # First-class employment contracts (separate from the contract PDF the user
    # uploads as an attachment). Carries the legal terms of employment so a
    # printable PDF can be generated server-side from structured data:
    #   • contract_type    Permanent | Fixed-term | Probation | Internship | Consultant
    #   • salary_currency  Stored separately so multi-currency installs print correctly.
    #   • benefits         Free-text bullets / JSON-string blob; rendered verbatim on PDF.
    #   • status           Draft → Active → Expired / Terminated
    if need("097_hr_contracts"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_contracts (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id        INTEGER NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
                contract_number    TEXT,
                contract_type      TEXT    NOT NULL DEFAULT 'Permanent',
                status             TEXT    NOT NULL DEFAULT 'Draft',
                start_date         TEXT    NOT NULL,
                end_date           TEXT,
                probation_end_date TEXT,
                job_title          TEXT,
                work_schedule      TEXT,
                weekly_hours       REAL,
                salary             REAL    NOT NULL DEFAULT 0,
                salary_currency    TEXT    DEFAULT 'USD',
                benefits           TEXT,
                terms              TEXT,
                signed_at          TEXT,
                terminated_at      TEXT,
                terminated_reason  TEXT,
                created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
                archived_at        TEXT,
                created_at         TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_contracts_emp ON hr_contracts(employee_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_contracts_status ON hr_contracts(status)")
        done("097_hr_contracts")

    # ── 098: payroll line breakdown — tax + NSSF + overtime ────────────────
    # Each payroll line carries the full breakdown so payslip PDFs and Finance
    # reconciliation can show employer cost vs. take-home. Defaults keep
    # existing rows unchanged (all zero). Computed by the payroll engine on
    # line creation / edit.
    add_col("098_payroll_lines_tax",          "hr_payroll_lines", "tax_amount",
            "ALTER TABLE hr_payroll_lines ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_lines_nssf_emp",     "hr_payroll_lines", "nssf_employee",
            "ALTER TABLE hr_payroll_lines ADD COLUMN nssf_employee REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_lines_nssf_co",      "hr_payroll_lines", "nssf_employer",
            "ALTER TABLE hr_payroll_lines ADD COLUMN nssf_employer REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_lines_ovt_hours",    "hr_payroll_lines", "overtime_hours",
            "ALTER TABLE hr_payroll_lines ADD COLUMN overtime_hours REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_lines_ovt_amount",   "hr_payroll_lines", "overtime_amount",
            "ALTER TABLE hr_payroll_lines ADD COLUMN overtime_amount REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_lines_gross",        "hr_payroll_lines", "gross_total",
            "ALTER TABLE hr_payroll_lines ADD COLUMN gross_total REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_runs_tax",           "hr_payroll_runs",  "total_tax",
            "ALTER TABLE hr_payroll_runs ADD COLUMN total_tax REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_runs_nssf_emp",      "hr_payroll_runs",  "total_nssf_employee",
            "ALTER TABLE hr_payroll_runs ADD COLUMN total_nssf_employee REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_runs_nssf_co",       "hr_payroll_runs",  "total_nssf_employer",
            "ALTER TABLE hr_payroll_runs ADD COLUMN total_nssf_employer REAL NOT NULL DEFAULT 0")
    add_col("098_payroll_runs_overtime",      "hr_payroll_runs",  "total_overtime",
            "ALTER TABLE hr_payroll_runs ADD COLUMN total_overtime REAL NOT NULL DEFAULT 0")

    # ── 099: notifications.deliver_at ──────────────────────────────────────
    # Nullable timestamp that lets a notification be created *now* but only
    # surfaced to the user when the wall-clock catches up. Powers the HR
    # Activities reminder system (e.g. "ping me 15 minutes before") without
    # needing a background scheduler — the list endpoint filters on
    # `deliver_at IS NULL OR deliver_at <= now()`. Existing notifications
    # default to NULL and therefore remain immediately visible.
    add_col("099_notifications_deliver_at", "notifications", "deliver_at",
            "ALTER TABLE notifications ADD COLUMN deliver_at TEXT DEFAULT NULL")

    # ── 100: hr_activities ─────────────────────────────────────────────────
    # A unified log of HR touchpoints — calls, meetings, interviews, emails,
    # notes — owned by a specific HR user and optionally linked to an
    # applicant or an existing employee. Distinct from recruitment_interviews
    # (which stays as-is) because it covers activities that aren't tied to
    # any applicant (1:1s, general meetings, follow-up emails) and the
    # owner-private visibility model differs from the applicant-centric
    # interview record.
    #
    # Reminder model: when an activity is created/edited with a non-zero
    # `reminder_minutes_before`, the router inserts a notification row whose
    # `deliver_at = scheduled_at - reminder_minutes_before`. The notification
    # list endpoint filters on deliver_at so the bell stays quiet until the
    # reminder is due — no scheduler, no daemon.
    if need("100_hr_activities"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS hr_activities (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                activity_type           TEXT    NOT NULL DEFAULT 'Meeting',
                subject                 TEXT    NOT NULL,
                description             TEXT,
                scheduled_at            TEXT    NOT NULL,
                duration_min            INTEGER NOT NULL DEFAULT 30,
                location                TEXT,
                status                  TEXT    NOT NULL DEFAULT 'Planned',
                applicant_id            INTEGER REFERENCES recruitment_applicants(id) ON DELETE SET NULL,
                employee_id             INTEGER REFERENCES hr_employees(id)           ON DELETE SET NULL,
                reminder_minutes_before INTEGER NOT NULL DEFAULT 15,
                reminder_notif_id       INTEGER REFERENCES notifications(id)          ON DELETE SET NULL,
                completed_at            TEXT,
                completed_notes         TEXT,
                archived_at             TEXT,
                created_at              TEXT    NOT NULL,
                updated_at              TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_activities_owner_sched "
                  "ON hr_activities(owner_id, scheduled_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_activities_applicant "
                  "ON hr_activities(applicant_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_hr_activities_employee "
                  "ON hr_activities(employee_id)")
        done("100_hr_activities")

    # ── 101: recruitment_interviews.hr_activity_id ─────────────────────────
    # Each scheduled interview now mirrors itself as an HR Activity in the
    # interviewer's personal queue so reminders + the daily-touchpoints view
    # both pick it up. The link column lets edits and deletes on the
    # interview keep the mirror row in sync (one-to-one). Existing
    # interviews stay NULL — they pre-date the feature and don't need a
    # retroactive mirror.
    add_col("101_recr_interviews_hr_activity_id", "recruitment_interviews",
            "hr_activity_id",
            "ALTER TABLE recruitment_interviews ADD COLUMN hr_activity_id "
            "INTEGER REFERENCES hr_activities(id) ON DELETE SET NULL")

    # ── 102: recruitment_applicants.accepted_reason ────────────────────────
    # Symmetric to rejected_reason — captures *why* the applicant was hired
    # (strongest portfolio, referral, etc.) so a future hiring retrospective
    # has the rationale next to the outcome. Stored only when the new status
    # is 'Accepted'.
    add_col("102_recr_applicants_accepted_reason", "recruitment_applicants",
            "accepted_reason",
            "ALTER TABLE recruitment_applicants ADD COLUMN accepted_reason TEXT")

    # ── 101: recruitment_offers ────────────────────────────────────────────
    # An "offer letter" / pre-employment draft contract for an applicant who
    # hasn't yet been onboarded. Distinct from hr_contracts (which requires
    # an employee_id and is the *final* contract activated on hire):
    #   * Attached to recruitment_applicants, so it can exist before HR has
    #     created the employee record.
    #   * Holds the Lebanon-aware toggles the print template renders (NSSF,
    #     end-of-service indemnity clause, confidentiality, non-compete).
    #   * Lifecycle: Draft → Sent → Accepted / Declined / Expired. When the
    #     applicant later runs through the Convert flow, the values from an
    #     Accepted offer pre-fill the employee record and an Active row in
    #     hr_contracts is auto-minted to mirror the offer.
    if need("101_recruitment_offers"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS recruitment_offers (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                applicant_id             INTEGER NOT NULL REFERENCES recruitment_applicants(id) ON DELETE CASCADE,
                offer_number             TEXT,
                status                   TEXT    NOT NULL DEFAULT 'Draft',
                contract_type            TEXT    NOT NULL DEFAULT 'Permanent',
                job_title                TEXT,
                department_id            INTEGER REFERENCES hr_departments(id) ON DELETE SET NULL,
                start_date               TEXT    NOT NULL,
                end_date                 TEXT,
                probation_months         INTEGER NOT NULL DEFAULT 3,
                probation_end_date       TEXT,
                work_schedule            TEXT,
                weekly_hours             REAL    DEFAULT 48,
                annual_leave_days        INTEGER NOT NULL DEFAULT 15,
                notice_period_days       INTEGER NOT NULL DEFAULT 30,
                salary                   REAL    NOT NULL DEFAULT 0,
                salary_currency          TEXT    NOT NULL DEFAULT 'USD',
                payment_schedule         TEXT    NOT NULL DEFAULT 'Monthly',
                -- Lebanon-aware clause toggles. Default to standard practice
                -- (NSSF registration + EOS indemnity), confidentiality is
                -- common; non-compete is opt-in.
                include_nssf             INTEGER NOT NULL DEFAULT 1,
                include_eos              INTEGER NOT NULL DEFAULT 1,
                include_confidentiality  INTEGER NOT NULL DEFAULT 1,
                include_non_compete      INTEGER NOT NULL DEFAULT 0,
                non_compete_months       INTEGER NOT NULL DEFAULT 6,
                benefits                 TEXT,
                additional_terms         TEXT,
                place_of_work            TEXT,
                sent_at                  TEXT,
                accepted_at              TEXT,
                declined_at              TEXT,
                declined_reason          TEXT,
                expires_at               TEXT,
                created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at               TEXT    NOT NULL,
                updated_at               TEXT,
                archived_at              TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_recruitment_offers_applicant "
                  "ON recruitment_offers(applicant_id, archived_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_recruitment_offers_status "
                  "ON recruitment_offers(status, archived_at)")
        done("101_recruitment_offers")

    # ── 105: manufacturing work centers + routing + actual-time costing ────
    # Work centers carry hourly rates (labor / machine / overhead) and a power
    # draw (kW) for electricity costing. BOMs gain a routing of operations; each
    # production order snapshots that routing so actual run time can be logged
    # and the conversion cost computed precisely at completion.
    if need("105_mfg_work_centers"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS work_centers (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                code          TEXT    UNIQUE,
                name          TEXT    NOT NULL,
                type          TEXT    NOT NULL DEFAULT 'Machine',
                labor_rate    REAL    NOT NULL DEFAULT 0,   -- per hour
                machine_rate  REAL    NOT NULL DEFAULT 0,   -- per hour (machine depreciation / maintenance)
                overhead_rate REAL    NOT NULL DEFAULT 0,   -- per hour
                power_kw      REAL    NOT NULL DEFAULT 0,   -- machine draw, for electricity costing
                is_active     INTEGER NOT NULL DEFAULT 1,
                notes         TEXT,
                archived_at   TEXT,
                created_at    TEXT    NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS bom_operations (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                bom_id               INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
                sequence             INTEGER NOT NULL DEFAULT 1,
                name                 TEXT    NOT NULL,
                work_center_id       INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
                setup_minutes        REAL    NOT NULL DEFAULT 0,   -- fixed per production run
                run_minutes_per_unit REAL    NOT NULL DEFAULT 0,   -- × output quantity
                notes                TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_bom_operations_bom ON bom_operations(bom_id)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_order_operations (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
                sequence            INTEGER NOT NULL DEFAULT 1,
                name                TEXT    NOT NULL,
                work_center_id      INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
                work_center_name    TEXT,
                planned_minutes     REAL    NOT NULL DEFAULT 0,
                actual_minutes      REAL,
                status              TEXT    NOT NULL DEFAULT 'Pending',
                -- rate snapshot frozen at completion
                labor_rate          REAL    NOT NULL DEFAULT 0,
                machine_rate        REAL    NOT NULL DEFAULT 0,
                overhead_rate       REAL    NOT NULL DEFAULT 0,
                power_kw            REAL    NOT NULL DEFAULT 0,
                electricity_tariff  REAL    NOT NULL DEFAULT 0,
                -- computed cost breakdown
                labor_cost          REAL    NOT NULL DEFAULT 0,
                machine_cost        REAL    NOT NULL DEFAULT 0,
                electricity_cost    REAL    NOT NULL DEFAULT 0,
                overhead_cost       REAL    NOT NULL DEFAULT 0,
                operation_cost      REAL    NOT NULL DEFAULT 0,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_po_operations_order "
                  "ON production_order_operations(production_order_id)")
        # Conversion-cost breakdown columns on the order header.
        if "production_orders" in all_tables():
            _poc = cols("production_orders")
            if "machine_cost" not in _poc:
                c.execute("ALTER TABLE production_orders ADD COLUMN machine_cost REAL NOT NULL DEFAULT 0")
            if "electricity_cost" not in _poc:
                c.execute("ALTER TABLE production_orders ADD COLUMN electricity_cost REAL NOT NULL DEFAULT 0")
        done("105_mfg_work_centers")

    # ── 106: manufacturing quality control + quarantine ───────────────────
    # qc_required BOMs route their finished goods into a non-sellable
    # quarantine bucket at completion; an inspection record (with defect lines)
    # then releases the passed quantity to sellable stock, scraps rejects, and
    # can spawn a linked rework order.
    if need("106_mfg_qc"):
        if "boms" in all_tables() and "qc_required" not in cols("boms"):
            c.execute("ALTER TABLE boms ADD COLUMN qc_required INTEGER NOT NULL DEFAULT 0")
        if "production_orders" in all_tables():
            _poc = cols("production_orders")
            if "qc_required" not in _poc:
                c.execute("ALTER TABLE production_orders ADD COLUMN qc_required INTEGER NOT NULL DEFAULT 0")
            if "rework_of_order_id" not in _poc:
                c.execute("ALTER TABLE production_orders ADD COLUMN rework_of_order_id INTEGER")
        if "inventory" in all_tables() and "quarantine_quantity" not in cols("inventory"):
            c.execute("ALTER TABLE inventory ADD COLUMN quarantine_quantity REAL NOT NULL DEFAULT 0")
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_qc (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
                output_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
                quantity            REAL    NOT NULL DEFAULT 0,   -- units under inspection (quarantined)
                unit_cost           REAL    NOT NULL DEFAULT 0,
                passed_qty          REAL    NOT NULL DEFAULT 0,
                rejected_qty        REAL    NOT NULL DEFAULT 0,
                rework_qty          REAL    NOT NULL DEFAULT 0,
                scrap_cost          REAL    NOT NULL DEFAULT 0,
                status              TEXT    NOT NULL DEFAULT 'Pending',  -- Pending/Passed/Failed/Partial
                notes               TEXT,
                inspector_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                inspected_at        TEXT,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_qc_order  ON production_qc(production_order_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_qc_status ON production_qc(status)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_qc_defects (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                qc_id    INTEGER NOT NULL REFERENCES production_qc(id) ON DELETE CASCADE,
                reason   TEXT    NOT NULL,
                quantity REAL    NOT NULL DEFAULT 0,
                notes    TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_qc_defects_qc ON production_qc_defects(qc_id)")
        done("106_mfg_qc")

    # ── 107: batch/lot tracking + traceability ─────────────────────────────
    # Per-item opt-in (inventory.lot_tracked). Lot-tracked items carry physical
    # lots with manufacture/expiry dates; stock-OUT consumes them First-Expired-
    # First-Out and records consumption for full forward/backward traceability.
    if need("107_inventory_lots"):
        if "inventory" in all_tables():
            _ic = cols("inventory")
            if "lot_tracked" not in _ic:
                c.execute("ALTER TABLE inventory ADD COLUMN lot_tracked INTEGER NOT NULL DEFAULT 0")
            if "shelf_life_days" not in _ic:
                c.execute("ALTER TABLE inventory ADD COLUMN shelf_life_days INTEGER")
        c.execute("""
            CREATE TABLE IF NOT EXISTS inventory_lots (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                inventory_id       INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
                lot_number         TEXT,
                quantity_remaining REAL    NOT NULL DEFAULT 0,
                original_quantity  REAL    NOT NULL DEFAULT 0,
                unit_cost          REAL    NOT NULL DEFAULT 0,
                manufacture_date   TEXT,
                expiry_date        TEXT,
                source_type        TEXT,                       -- purchase/production/opening/adjustment
                source_ref         TEXT,
                status             TEXT    NOT NULL DEFAULT 'active',  -- active/consumed
                created_at         TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_lots_item   ON inventory_lots(inventory_id, status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_lots_expiry ON inventory_lots(expiry_date)")
        # Each draw from a lot — drives forward (where did this lot go) and, via
        # production_order_id + output_lot_id, backward (what fed this lot) trace.
        c.execute("""
            CREATE TABLE IF NOT EXISTS lot_consumption (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                lot_id              INTEGER NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
                inventory_id        INTEGER NOT NULL REFERENCES inventory(id),
                quantity            REAL    NOT NULL DEFAULT 0,
                unit_cost           REAL    NOT NULL DEFAULT 0,
                source_type         TEXT,                       -- sale/project/production/adjustment
                source_ref          TEXT,
                production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
                output_lot_id       INTEGER REFERENCES inventory_lots(id) ON DELETE SET NULL,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_lotcons_lot    ON lot_consumption(lot_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_lotcons_order  ON lot_consumption(production_order_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_lotcons_output ON lot_consumption(output_lot_id)")
        done("107_inventory_lots")

    # ── 108: production scheduling, priority & partial completion ──────────
    if need("108_mfg_scheduling"):
        if "production_orders" in all_tables():
            _poc = cols("production_orders")
            for _col, _sql in (
                ("priority",           "ALTER TABLE production_orders ADD COLUMN priority TEXT NOT NULL DEFAULT 'Normal'"),
                ("planned_start_date", "ALTER TABLE production_orders ADD COLUMN planned_start_date TEXT"),
                ("due_date",           "ALTER TABLE production_orders ADD COLUMN due_date TEXT"),
                # Cumulative quantity produced across partial completion runs.
                ("quantity_completed", "ALTER TABLE production_orders ADD COLUMN quantity_completed REAL NOT NULL DEFAULT 0"),
            ):
                if _col not in _poc:
                    c.execute(_sql)
        c.execute("CREATE INDEX IF NOT EXISTS idx_production_orders_due "
                  "ON production_orders(due_date)")
        done("108_mfg_scheduling")

    # ── 109: resource-based overhead costing (SME model) ──────────────────
    # Replaces the work-center/routing approach: a reusable list of resources
    # (Labor, Electricity, CNC, Oven, …) each with a per-hour rate. A BOM assigns
    # resources (from the list or inline); production cost = Σ(rates) × actual
    # production hours. No work centers, capacity planning, or scheduling.
    if need("109_mfg_resources"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS manufacturing_resources (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                cost_type   TEXT    NOT NULL DEFAULT 'per_hour',
                hourly_rate REAL    NOT NULL DEFAULT 0,
                is_active   INTEGER NOT NULL DEFAULT 1,
                notes       TEXT,
                archived_at TEXT,
                created_at  TEXT    NOT NULL
            )
        """)
        # Resources assigned to a BOM. resource_id links the master list (its
        # name + rate are snapshotted); a NULL resource_id is an inline resource.
        c.execute("""
            CREATE TABLE IF NOT EXISTS bom_resources (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                bom_id      INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
                resource_id INTEGER REFERENCES manufacturing_resources(id) ON DELETE SET NULL,
                name        TEXT    NOT NULL,
                hourly_rate REAL    NOT NULL DEFAULT 0
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_bom_resources_bom ON bom_resources(bom_id)")
        # Per-order snapshot; hours + cost are filled in at completion.
        c.execute("""
            CREATE TABLE IF NOT EXISTS production_order_resources (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
                resource_id         INTEGER REFERENCES manufacturing_resources(id) ON DELETE SET NULL,
                name                TEXT    NOT NULL,
                hourly_rate         REAL    NOT NULL DEFAULT 0,
                hours               REAL    NOT NULL DEFAULT 0,
                cost                REAL    NOT NULL DEFAULT 0,
                created_at          TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_po_resources_order "
                  "ON production_order_resources(production_order_id)")
        # Standard production time (hours per batch) on the BOM — drives the
        # estimated conversion cost + variance. Actual hours captured per order.
        if "boms" in all_tables() and "standard_hours" not in cols("boms"):
            c.execute("ALTER TABLE boms ADD COLUMN standard_hours REAL NOT NULL DEFAULT 0")
        if "production_orders" in all_tables() and "production_hours" not in cols("production_orders"):
            c.execute("ALTER TABLE production_orders ADD COLUMN production_hours REAL NOT NULL DEFAULT 0")
        done("109_mfg_resources")

    # ── 110: financial-year closing ────────────────────────────────────────
    # A closed year locks all dated-in-year modifications (via the shared
    # period-lock guard) and snapshots its P&L + the year-end closing entry.
    if need("110_fiscal_years"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS fiscal_years (
                year             INTEGER PRIMARY KEY,
                status           TEXT    NOT NULL DEFAULT 'open',
                total_income     REAL    NOT NULL DEFAULT 0,
                total_expense    REAL    NOT NULL DEFAULT 0,
                net_income       REAL    NOT NULL DEFAULT 0,
                closing_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
                closed_at        TEXT,
                closed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                notes            TEXT
            )
        """)
        done("110_fiscal_years")

    # ── 102: inventory cost layers (FIFO / LIFO costing) ───────────────────
    # Each row is a surviving "lot" of stock at a known unit cost. Only
    # populated/consumed when inventory_costing_method is fifo or lifo; under
    # the default weighted_avg the table stays empty and costing is unchanged.
    if need("102_inventory_cost_layers"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS inventory_cost_layers (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                inventory_id  INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
                qty_remaining REAL    NOT NULL,
                unit_cost     REAL    NOT NULL DEFAULT 0,
                source_type   TEXT,
                source_ref    TEXT,
                created_at    TEXT    NOT NULL
            )
        """)
        # FIFO/LIFO ordering and per-item lookups both ride this index.
        c.execute("CREATE INDEX IF NOT EXISTS idx_cost_layers_item "
                  "ON inventory_cost_layers(inventory_id, created_at, id)")
        done("102_inventory_cost_layers")

    # ── 104: double-entry accounting (Chart of Accounts + Journal) ─────────
    # A real general ledger sitting alongside the existing cash-basis finance
    # views. Journal entries are auto-posted from business events (invoice
    # payment, expense, payroll, depreciation, purchase) so the Income
    # Statement reconciles with the Finance dashboard, plus manual entries.
    if need("104_accounting"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS chart_of_accounts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                code           TEXT    UNIQUE NOT NULL,
                name           TEXT    NOT NULL,
                type           TEXT    NOT NULL,   -- Asset/Liability/Equity/Income/Expense
                subtype        TEXT,
                normal_balance TEXT    NOT NULL,   -- 'debit' or 'credit'
                parent_code    TEXT,
                is_system      INTEGER NOT NULL DEFAULT 0,
                is_active      INTEGER NOT NULL DEFAULT 1,
                description    TEXT,
                created_at     TEXT    NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS journal_entries (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_number TEXT,
                entry_date   TEXT    NOT NULL,
                memo         TEXT,
                source_type  TEXT,    -- manual/invoice_payment/expense/payroll/depreciation/purchase/reversal
                source_id    INTEGER,
                status       TEXT    NOT NULL DEFAULT 'posted',  -- draft/posted/reversed
                reverses_id  INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
                reversed_by  INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
                total_debit  REAL    NOT NULL DEFAULT 0,
                total_credit REAL    NOT NULL DEFAULT 0,
                created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at   TEXT    NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS journal_entry_lines (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
                account_id       INTEGER NOT NULL REFERENCES chart_of_accounts(id),
                debit            REAL NOT NULL DEFAULT 0,
                credit           REAL NOT NULL DEFAULT 0,
                memo             TEXT,
                line_no          INTEGER
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_je_date   ON journal_entries(entry_date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_jel_entry ON journal_entry_lines(journal_entry_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_jel_acct  ON journal_entry_lines(account_id)")

        # Seed a sensible default Chart of Accounts. (code, name, type, normal, subtype)
        _seed_accounts = [
            ("1000", "Cash & Bank",              "Asset",     "debit",  "Current Asset"),
            ("1100", "Accounts Receivable",      "Asset",     "debit",  "Current Asset"),
            ("1200", "Inventory",                "Asset",     "debit",  "Current Asset"),
            ("1500", "Fixed Assets",             "Asset",     "debit",  "Non-Current Asset"),
            ("1510", "Accumulated Depreciation", "Asset",     "credit", "Contra Asset"),
            ("2000", "Accounts Payable",         "Liability", "credit", "Current Liability"),
            ("2100", "VAT Payable",              "Liability", "credit", "Current Liability"),
            ("2200", "Payroll Liabilities",      "Liability", "credit", "Current Liability"),
            ("3000", "Owner's Equity",           "Equity",    "credit", "Equity"),
            ("3900", "Retained Earnings",        "Equity",    "credit", "Equity"),
            ("4000", "Sales Revenue",            "Income",    "credit", "Operating Income"),
            ("4900", "Other Income",             "Income",    "credit", "Other Income"),
            ("5000", "Cost of Goods Sold",       "Expense",   "debit",  "Cost of Sales"),
            ("6000", "Salaries & Wages",         "Expense",   "debit",  "Operating Expense"),
            ("6100", "Rent",                     "Expense",   "debit",  "Operating Expense"),
            ("6200", "Utilities",                "Expense",   "debit",  "Operating Expense"),
            ("6300", "Depreciation Expense",     "Expense",   "debit",  "Operating Expense"),
            ("6400", "Materials",                "Expense",   "debit",  "Operating Expense"),
            ("6500", "Labour",                   "Expense",   "debit",  "Operating Expense"),
            ("6600", "Equipment",                "Expense",   "debit",  "Operating Expense"),
            ("6700", "Transport",                "Expense",   "debit",  "Operating Expense"),
            ("6800", "Subcontractor",            "Expense",   "debit",  "Operating Expense"),
            ("6850", "Insurance",                "Expense",   "debit",  "Operating Expense"),
            ("6860", "Subscriptions",            "Expense",   "debit",  "Operating Expense"),
            ("6870", "Permits & Fees",           "Expense",   "debit",  "Operating Expense"),
            ("6900", "General & Other Expense",  "Expense",   "debit",  "Operating Expense"),
        ]
        _ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        for code, name, typ, normal, subtype in _seed_accounts:
            c.execute(
                "INSERT OR IGNORE INTO chart_of_accounts "
                "(code, name, type, subtype, normal_balance, is_system, is_active, created_at) "
                "VALUES (?,?,?,?,?,1,1,?)",
                (code, name, typ, subtype, normal, _ts),
            )
        done("104_accounting")

    # ── 120: multi-currency chart-of-accounts additions ────────────────────
    # Four accounts the original CoA was missing, required by IAS 21 (foreign
    # currency monetary items) and standard cash controls:
    #   1010  Cash — LBP             LBP cash holdings, distinct from USD bank
    #   4910  Foreign Exchange Gain
    #   6910  Cash Short & Over      over/short on till close
    #   6920  Foreign Exchange Loss
    # MUST run AFTER 104_accounting because that's where chart_of_accounts is
    # created. INSERT OR IGNORE makes it idempotent for already-installed DBs.
    if need("120_multi_currency_accounts"):
        _ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        for code, name, typ, normal, subtype in [
            ("1010", "Cash — LBP",             "Asset",     "debit",  "Current Asset"),
            ("4910", "Foreign Exchange Gain",  "Income",    "credit", "Other Income"),
            ("6910", "Cash Short & Over",      "Expense",   "debit",  "Operating Expense"),
            ("6920", "Foreign Exchange Loss",  "Expense",   "debit",  "Other Expense"),
        ]:
            c.execute(
                "INSERT OR IGNORE INTO chart_of_accounts "
                "(code, name, type, subtype, normal_balance, is_system, is_active, created_at) "
                "VALUES (?,?,?,?,?,1,1,?)",
                (code, name, typ, subtype, normal, _ts),
            )
        done("120_multi_currency_accounts")

    # ── 121: payroll line currency (F-6 audit fix) ──────────────────────────
    # `hr_contracts` carries `salary_currency` but `hr_payroll_lines` did not,
    # so the mark-paid handler posted every line as USD regardless of the
    # underlying contract — an 89,000× mis-statement for any LBP salary.
    # Adding the column lets us snapshot the per-line currency at run-creation
    # time and convert correctly to USD when posting to the GL. Existing
    # payroll lines default to 'USD' (matches current 100%-USD data).
    if need("121_payroll_line_currency"):
        try:
            c.execute(
                "ALTER TABLE hr_payroll_lines ADD COLUMN salary_currency TEXT NOT NULL DEFAULT 'USD'"
            )
        except Exception:
            pass    # column already exists on a partial earlier run
        done("121_payroll_line_currency")

    # ── 122: multi-warehouse foundation ─────────────────────────────────────
    # Adds warehouses as an inventory dimension (NOT an accounting entity).
    # Design decisions (per design proposal):
    #   * One company-wide Inventory GL account (1200) — transfers never post.
    #   * `inventory.quantity` stays the maintained company-wide total so every
    #     existing query keeps working. `inventory_stock` carries the per-
    #     warehouse breakdown.
    #   * Lots and cost layers stay company-wide for v1 — per the explicit
    #     "postpone warehouse-specific valuation" decision.
    #   * Row-level RBAC: zero rows in `user_warehouse_access` for a user
    #     means access to all warehouses (admin-friendly default). Any rows
    #     restrict access to that explicit allow-list.
    #   * Backfill seeds one default 'MAIN' warehouse, places all existing
    #     stock there, and stamps historical movements and module records with
    #     it — every existing install behaves identically after this migration.
    if need("122_warehouses"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS warehouses (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                code           TEXT    UNIQUE NOT NULL,
                name           TEXT    NOT NULL,
                type           TEXT    NOT NULL DEFAULT 'Main',
                                       -- 'Main' | 'Branch' | 'Production'
                                       -- | 'Damaged' | 'Transit' | 'Returns'
                address        TEXT,
                manager_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                is_active      INTEGER NOT NULL DEFAULT 1,
                is_default     INTEGER NOT NULL DEFAULT 0,
                notes          TEXT,
                archived_at    TEXT,
                archive_reason TEXT,
                created_at     TEXT    NOT NULL
            )
        """)
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_one_default "
                  "ON warehouses(is_default) WHERE is_default=1")

        # Per-warehouse stock balances. `inventory.quantity` stays the SUM of
        # `inventory_stock.quantity` rows for that item (maintained on every
        # write so legacy SELECTs keep working).
        c.execute("""
            CREATE TABLE IF NOT EXISTS inventory_stock (
                inventory_id        INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
                warehouse_id        INTEGER NOT NULL REFERENCES warehouses(id),
                quantity            REAL    NOT NULL DEFAULT 0,
                reserved_quantity   REAL    NOT NULL DEFAULT 0,
                quarantine_quantity REAL    NOT NULL DEFAULT 0,
                PRIMARY KEY (inventory_id, warehouse_id)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_inv_stock_warehouse "
                  "ON inventory_stock(warehouse_id)")

        # Row-level access list. Zero rows for a user = access to all
        # warehouses (the safe default for existing installs).
        c.execute("""
            CREATE TABLE IF NOT EXISTS user_warehouse_access (
                user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
                granted_at   TEXT    NOT NULL,
                granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
                PRIMARY KEY (user_id, warehouse_id)
            )
        """)

        # Stock transfers — explicit workflow with audit trail.
        c.execute("""
            CREATE TABLE IF NOT EXISTS stock_transfers (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                transfer_number   TEXT    UNIQUE NOT NULL,
                from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
                to_warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
                status            TEXT    NOT NULL DEFAULT 'Draft',
                                          -- Draft | In Transit | Completed | Cancelled
                notes             TEXT,
                created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at        TEXT    NOT NULL,
                dispatched_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                dispatched_at     TEXT,
                received_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
                received_at       TEXT,
                cancelled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                cancelled_at      TEXT,
                cancel_reason     TEXT,
                CHECK (from_warehouse_id <> to_warehouse_id)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_transfers_status "
                  "ON stock_transfers(status, created_at)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS stock_transfer_items (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                transfer_id       INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
                inventory_id      INTEGER NOT NULL REFERENCES inventory(id),
                quantity          REAL    NOT NULL,
                received_quantity REAL,
                note              TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer "
                  "ON stock_transfer_items(transfer_id)")

        # Adding the per-module location dimension. SQLite ALTER TABLE
        # rejects adding a column twice — wrap each in try/except so re-runs
        # don't fail.
        for ddl in (
            "ALTER TABLE users             ADD COLUMN default_warehouse_id INTEGER REFERENCES warehouses(id)",
            "ALTER TABLE stock_movements   ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)",
            "ALTER TABLE purchases         ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)",
            "ALTER TABLE pos_sessions      ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)",
            "ALTER TABLE production_orders ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)",
        ):
            try:
                c.execute(ddl)
            except Exception:
                pass

        # ── Seed the default warehouse + backfill ─────────────────────────
        # Exactly one warehouse is required for the system to function (every
        # stock-touching operation defaults to it). Seed it before any
        # backfill so the FK relationships are satisfiable.
        _ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        c.execute(
            "INSERT OR IGNORE INTO warehouses "
            "(code, name, type, is_active, is_default, notes, created_at) "
            "VALUES ('MAIN', 'Main Warehouse', 'Main', 1, 1, "
            " 'Default warehouse, auto-created during multi-warehouse migration.', ?)",
            (_ts,),
        )
        main_id = c.execute(
            "SELECT id FROM warehouses WHERE code='MAIN'"
        ).fetchone()[0]

        # Backfill: every existing item's stock lives in MAIN
        c.execute("""
            INSERT OR IGNORE INTO inventory_stock
                (inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity)
            SELECT id, ?,
                   COALESCE(quantity, 0),
                   COALESCE(reserved_quantity, 0),
                   COALESCE(quarantine_quantity, 0)
            FROM inventory
        """, (main_id,))

        # Stamp historical movements + module records with MAIN so every
        # row has a warehouse and we can drop NULLs from analytics.
        for sql in (
            "UPDATE stock_movements   SET warehouse_id = ? WHERE warehouse_id IS NULL",
            "UPDATE purchases         SET warehouse_id = ? WHERE warehouse_id IS NULL",
            "UPDATE pos_sessions      SET warehouse_id = ? WHERE warehouse_id IS NULL",
            "UPDATE production_orders SET warehouse_id = ? WHERE warehouse_id IS NULL",
        ):
            c.execute(sql, (main_id,))

        done("122_warehouses")

    # ── 123: per-line discount on quotation_items ──────────────────────────
    # invoice_items and pos_sale_items already carry a `discount` column from
    # earlier migrations; quotation_items did not. Adding it here closes the
    # last gap so the Settings → "Enable per-line discounts" toggle has a
    # column to drive in every customer-facing document type.
    add_col(
        "123_quotation_items_discount",
        "quotation_items",
        "discount",
        "ALTER TABLE quotation_items ADD COLUMN discount REAL NOT NULL DEFAULT 0",
    )

    # ── 103: generic attachments (files on any business entity) ────────────
    # One table backs file attachments for every module (invoices, purchases,
    # projects, expenses, assets, suppliers, clients, quotations, inventory).
    # Files are stored as BLOBs — no filesystem path, hence no path-traversal
    # surface — mirroring hr_employee_files / recruitment_applicant_files.
    if need("103_attachments"):
        c.execute("""
            CREATE TABLE IF NOT EXISTS attachments (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type      TEXT    NOT NULL,
                entity_id        INTEGER NOT NULL,
                filename         TEXT    NOT NULL,
                content_type     TEXT    NOT NULL,
                size_bytes       INTEGER NOT NULL,
                data             BLOB    NOT NULL,
                uploaded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                uploaded_by_name TEXT,
                created_at       TEXT    NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_attachments_entity "
                  "ON attachments(entity_type, entity_id, created_at)")
        done("103_attachments")

    # ── 124: attachment object-storage backend (Phase 3) ──────────────────
    # `storage_backend` says where the bytes live: 'db' (the BLOB column, the
    # default — unchanged behavior) or 's3' (an S3/R2 object keyed by
    # `storage_key`). For 's3' rows the BLOB is left empty. Adding columns only
    # (no table rebuild) keeps this migration cheap and reversible.
    if need("124_attachment_storage"):
        if "attachments" in all_tables():
            ac = cols("attachments")
            if "storage_backend" not in ac:
                c.execute("ALTER TABLE attachments ADD COLUMN storage_backend "
                          "TEXT NOT NULL DEFAULT 'db'")
            if "storage_key" not in ac:
                c.execute("ALTER TABLE attachments ADD COLUMN storage_key TEXT")
        done("124_attachment_storage")

    # ── 091: backfill hire-row per existing employee ───────────────────────
    # Every employee already in the system gets a synthetic 'hire' row so the
    # timeline view isn't blank on existing data. Idempotent: only inserts when
    # the employee has zero history rows yet.
    if need("091_backfill_employment_changes"):
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        rows = c.execute(
            "SELECT id, hire_date, salary, job_title, department_id, manager_id, created_at "
            "FROM hr_employees"
        ).fetchall()
        # Cursor here uses tuple rows (no row_factory). Index by position.
        for emp_id, hire_date, salary, job_title, dept_id, mgr_id, created_at in rows:
            existing = c.execute(
                "SELECT 1 FROM hr_employment_changes WHERE employee_id=? LIMIT 1",
                (emp_id,),
            ).fetchone()
            if existing:
                continue
            eff = (hire_date or created_at or now)[:10]
            c.execute(
                """INSERT INTO hr_employment_changes
                   (employee_id, effective_date, change_type,
                    old_salary, new_salary, old_title, new_title,
                    old_department_id, new_department_id,
                    old_manager_id, new_manager_id,
                    reason, created_at)
                   VALUES (?, ?, 'hire', NULL, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?)""",
                (emp_id, eff,
                 salary or 0, job_title, dept_id, mgr_id,
                 "Backfilled hire record (existing employee)", now),
            )
        done("091_backfill_employment_changes")

    conn.commit()


# ── Base schema ───────────────────────────────────────────────────────────────

def _pg_dsn():
    """PostgreSQL connection string. DATABASE_URL wins; otherwise assembled from
    the standard libpq variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE."""
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return dsn
    host = os.environ.get("PGHOST", "localhost")
    port = os.environ.get("PGPORT", "5432")
    user = os.environ.get("PGUSER", "postgres")
    pw   = os.environ.get("PGPASSWORD", "postgres")
    name = os.environ.get("PGDATABASE", "erp")
    return f"postgresql://{user}:{pw}@{host}:{port}/{name}"


def _split_sql_statements(script):
    """Split a SQL script into statements: drop full-line ``--`` comments, then
    split on ``;`` outside single-quoted strings. Sufficient for the generated
    pg_baseline.sql (which never embeds a semicolon inside a string literal)."""
    lines = [ln for ln in script.splitlines() if not ln.lstrip().startswith("--")]
    text = "\n".join(lines)
    stmts, buf, in_str = [], [], False
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        buf.append(ch)
        if ch == "'":
            if in_str and i + 1 < n and text[i + 1] == "'":
                buf.append("'"); i += 2; continue
            in_str = not in_str
        elif ch == ";" and not in_str:
            s = "".join(buf).strip().rstrip(";").strip()
            if s:
                stmts.append(s)
            buf = []
        i += 1
    tail = "".join(buf).strip().rstrip(";").strip()
    if tail:
        stmts.append(tail)
    return stmts


def _pg_initialized(raw):
    """True once the baseline has been applied (schema_migrations exists + filled).
    Uses named columns so it works regardless of the connection's row_factory."""
    with raw.cursor() as cur:
        cur.execute("SELECT to_regclass('public.schema_migrations') AS reg")
        row = cur.fetchone()
        reg = row["reg"] if hasattr(row, "keys") else row[0]
        if reg is None:
            return False
        cur.execute("SELECT count(*) AS n FROM schema_migrations")
        row = cur.fetchone()
        return (row["n"] if hasattr(row, "keys") else row[0]) > 0


def _apply_pg_baseline(raw):
    """Apply the squashed Postgres schema (DDL + indexes + migration ledger)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "migrations", "pg_baseline.sql")
    with open(path, encoding="utf-8") as f:
        script = f.read()
    with raw.cursor() as cur:
        for stmt in _split_sql_statements(script):
            cur.execute(stmt)
    raw.commit()


def _init_db_postgres():
    """PostgreSQL init: apply the baseline once, then run the SHARED seeding
    through a CompatConn so the very same SQL the SQLite path uses is translated."""
    import psycopg
    from psycopg.rows import dict_row
    raw = psycopg.connect(_pg_dsn(), row_factory=dict_row)
    try:
        if not _pg_initialized(raw):
            _apply_pg_baseline(raw)
        conn = CompatConn(raw, get_dialect("postgres"))
        _seed_roles_and_admin(conn)
        conn.commit()
    finally:
        raw.close()
    print("Database initialized (postgres).")


def init_db():
    """Create the schema (if needed) and seed roles + admin for whichever backend
    DB_BACKEND selects. SQLite replays its migration chain; PostgreSQL applies the
    squashed baseline (docs/SAAS_ARCHITECTURE.md §6)."""
    if DB_BACKEND not in ("sqlite", "sqlite3"):
        return _init_db_postgres()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    c = conn.cursor()

    # Core tables (CREATE IF NOT EXISTS — safe to run every startup)
    c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name     TEXT,
            role          TEXT DEFAULT 'admin',
            created_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS clients (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            company    TEXT,
            phone      TEXT,
            email      TEXT,
            address    TEXT,
            type       TEXT DEFAULT 'private',
            notes      TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projects (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            name             TEXT NOT NULL,
            client_id        INTEGER REFERENCES clients(id),
            location         TEXT,
            status           TEXT DEFAULT 'Inquiry',
            start_date       TEXT,
            end_date         TEXT,
            estimated_cost   REAL DEFAULT 0,
            actual_cost      REAL DEFAULT 0,
            expected_revenue REAL DEFAULT 0,
            source_quotation_id INTEGER REFERENCES quotations(id),
            description      TEXT,
            created_at       TEXT
        );

        CREATE TABLE IF NOT EXISTS quotations (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            quote_number TEXT UNIQUE NOT NULL,
            project_id   INTEGER REFERENCES projects(id),
            client_id    INTEGER REFERENCES clients(id),
            lead_id      INTEGER REFERENCES crm_leads(id),
            project_name TEXT DEFAULT NULL,
            status       TEXT DEFAULT 'Draft',
            notes        TEXT,
            total        REAL DEFAULT 0,
            created_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS quotation_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            quantity     REAL DEFAULT 1,
            unit_price   REAL DEFAULT 0,
            total        REAL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT UNIQUE NOT NULL,
            quotation_id   INTEGER REFERENCES quotations(id),
            project_id     INTEGER REFERENCES projects(id),
            client_id      INTEGER REFERENCES clients(id),
            amount         REAL DEFAULT 0,
            due_date       TEXT,
            notes          TEXT,
            version        INTEGER NOT NULL DEFAULT 1,
            voided_at      TEXT DEFAULT NULL,
            void_reason    TEXT DEFAULT NULL,
            created_at     TEXT
        );

        CREATE TABLE IF NOT EXISTS invoice_payments (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            amount           REAL NOT NULL,
            method           TEXT DEFAULT 'Cash',
            note             TEXT,
            idempotency_key  TEXT DEFAULT NULL,
            paid_at          TEXT
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            quantity   REAL NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS inventory (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            category   TEXT,
            quantity   REAL DEFAULT 0,
            min_stock  REAL DEFAULT 0,
            unit_cost  REAL DEFAULT 0,
            supplier   TEXT,
            unit       TEXT DEFAULT 'pcs',
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
            type         TEXT NOT NULL,
            delta        REAL NOT NULL,
            qty_before   REAL NOT NULL,
            qty_after    REAL NOT NULL,
            reference    TEXT,
            note         TEXT,
            created_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS expenses (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER REFERENCES projects(id),
            category    TEXT NOT NULL,
            description TEXT,
            amount      REAL DEFAULT 0,
            date        TEXT,
            created_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS purchases (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            po_number        TEXT UNIQUE NOT NULL,
            supplier         TEXT NOT NULL,
            supplier_id      INTEGER REFERENCES suppliers(id),
            inventory_id     INTEGER REFERENCES inventory(id),
            product_name     TEXT NOT NULL,
            category         TEXT,
            quantity         REAL NOT NULL,
            unit_cost        REAL DEFAULT 0,
            additional_costs REAL DEFAULT 0,
            status           TEXT DEFAULT 'Ordered',
            stock_updated    INTEGER DEFAULT 0,
            expense_recorded INTEGER DEFAULT 0,
            notes            TEXT,
            ordered_at       TEXT,
            received_at      TEXT,
            paid_at          TEXT
        );

        CREATE TABLE IF NOT EXISTS suppliers (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            name               TEXT NOT NULL,
            contact_name       TEXT,
            phone              TEXT,
            email              TEXT,
            payment_terms_days INTEGER DEFAULT 30,
            notes              TEXT,
            deleted_at         TEXT,
            created_at         TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER,
            username   TEXT,
            action     TEXT NOT NULL,
            module     TEXT NOT NULL,
            record_id  INTEGER,
            record_ref TEXT,
            detail     TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ip           TEXT NOT NULL,
            attempted_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounting_periods (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            year      INTEGER NOT NULL,
            month     INTEGER NOT NULL,
            locked_at TEXT,
            locked_by TEXT,
            UNIQUE(year, month)
        );

        CREATE TABLE IF NOT EXISTS period_snapshots (
            year          INTEGER NOT NULL,
            month         INTEGER NOT NULL,
            income        REAL    NOT NULL DEFAULT 0,
            expenses      REAL    NOT NULL DEFAULT 0,
            profit        REAL    NOT NULL DEFAULT 0,
            payment_count INTEGER NOT NULL DEFAULT 0,
            expense_count INTEGER NOT NULL DEFAULT 0,
            locked_at     TEXT    NOT NULL,
            locked_by     TEXT,
            PRIMARY KEY (year, month)
        );

        CREATE TABLE IF NOT EXISTS roles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            description TEXT,
            color       TEXT DEFAULT '#6B7280',
            is_system   INTEGER DEFAULT 0,
            is_admin    INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS role_permissions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            module      TEXT NOT NULL,
            can_view    INTEGER DEFAULT 0,
            can_create  INTEGER DEFAULT 0,
            can_edit    INTEGER DEFAULT 0,
            can_delete  INTEGER DEFAULT 0,
            can_approve INTEGER DEFAULT 0,
            UNIQUE(role_id, module)
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            jti         TEXT UNIQUE NOT NULL,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TEXT NOT NULL,
            last_active TEXT NOT NULL,
            expires_at  TEXT NOT NULL,
            revoked     INTEGER DEFAULT 0
        );
    """)

    # Indexes (all IF NOT EXISTS — safe to repeat)
    c.executescript("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency
            ON invoice_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_login_attempts_ip     ON login_attempts(ip, attempted_at);
        CREATE INDEX IF NOT EXISTS idx_invoices_client_id    ON invoices(client_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_project_id   ON invoices(project_id);
        CREATE INDEX IF NOT EXISTS idx_invoice_payments_inv  ON invoice_payments(invoice_id);
        CREATE INDEX IF NOT EXISTS idx_invoice_items_inv     ON invoice_items(invoice_id);
        CREATE INDEX IF NOT EXISTS idx_quotation_items_quote ON quotation_items(quotation_id);
        CREATE INDEX IF NOT EXISTS idx_expenses_project_id   ON expenses(project_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_item  ON stock_movements(inventory_id);
        CREATE INDEX IF NOT EXISTS idx_purchases_supplier    ON purchases(supplier);
        CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id ON purchases(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_module      ON audit_log(module);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action      ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_username    ON audit_log(username);
        CREATE INDEX IF NOT EXISTS idx_sessions_user         ON user_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_jti          ON user_sessions(jti);
        CREATE INDEX IF NOT EXISTS idx_sessions_revoked      ON user_sessions(revoked);
        CREATE INDEX IF NOT EXISTS idx_roles_name            ON roles(name);
    """)

    conn.commit()

    # Apply tracked ALTER TABLE migrations
    _run_migrations(conn, c)

    _seed_roles_and_admin(c)

    conn.commit()
    conn.close()
    print("Database initialized.")


def _seed_roles_and_admin(c):
    """Seed system roles, the permission matrix, the dependency-view backfill and
    the superadmin. Shared verbatim by the SQLite and PostgreSQL init paths: `c`
    is any object exposing sqlite3-style ``execute(...).fetchone()`` (a sqlite3
    cursor or a CompatConn), and the SQL it runs is dialect-translated by the
    wrapper. Idempotent — roles guard on existence, permissions use ON CONFLICT,
    the admin is created only when absent."""
    # ── Seed default roles ────────────────────────────────────────────────
    # Every business module. Admin modules (settings/users/roles/audit) are
    # granted explicitly per-role below where relevant.
    MODULES = [
        'dashboard', 'clients', 'projects', 'quotations', 'invoices',
        'inventory', 'purchases', 'suppliers', 'finance', 'expenses',
        'accounting',
        'reports', 'crm', 'planning', 'pos', 'cash', 'manufacturing',
        'assets',
        # Internal comms — view is broad (granted below to every role so
        # everyone can read announcements addressed to them); create/edit/
        # delete are restricted and granted explicitly per role.
        'announcements',
        # NB: 'hr', 'hr_contracts' and 'recruitment' are NOT in this list —
        # they hold sensitive personnel data and are granted explicitly per
        # role below (HR Manager / Recruiter / Manager / Auditor) rather than
        # blanket-granted to Viewer & Auditor like the rest of MODULES.
    ]

    # Permission shorthands: (view, create, edit, delete, approve)
    _V     = (1, 0, 0, 0, 0)   # read-only
    _VC    = (1, 1, 0, 0, 0)   # + create
    _VCE   = (1, 1, 1, 0, 0)   # + edit
    _VCED  = (1, 1, 1, 1, 0)   # + delete
    _VCEA  = (1, 1, 1, 0, 1)   # + approve (no delete)
    _FULL  = (1, 1, 1, 1, 1)   # everything

    default_roles = [
        ('Admin',               'Full access to every module and administration', '#DC2626', 1),
        ('Business Owner',      'Full administration of this install — staff, roles, settings and reports; cannot change which modules are installed', '#0F766E', 1),
        ('Manager',             'Oversee all business operations with approvals',  '#7C3AED', 1),
        ('Finance Manager',     'Full finance, invoicing and expense authority',   '#059669', 1),
        ('Accountant',          'Day-to-day finance, invoices and expenses',       '#10B981', 1),
        ('Sales Manager',       'Lead the sales pipeline, clients and CRM',        '#2563EB', 1),
        ('Sales',               'Handle clients, quotations and CRM entries',      '#3B82F6', 1),
        ('Cashier',             'Operate the POS register and reconcile the cash drawer', '#0EA5E9', 1),
        ('Project Manager',     'Run projects and the planning board',             '#0891B2', 1),
        ('Operations Manager',  'Projects, planning, inventory and procurement',   '#EA580C', 1),
        ('HR Manager',          'People management — employees, departments, leave, contracts, payroll, recruitment','#0D9488', 1),
        ('Recruiter',           'Run the recruitment pipeline — positions, applicants and interviews', '#14B8A6', 1),
        ('Procurement Officer', 'Purchasing, suppliers and stock intake',          '#D97706', 1),
        ('Inventory',           'Stock control and purchase orders',               '#F59E0B', 1),
        ('Production Manager',  'Run manufacturing — BOMs, production orders and material consumption', '#9333EA', 1),
        ('CRM Specialist',      'Manage leads, deals and customer relationships',  '#DB2777', 1),
        ('Auditor',             'Read-only visibility across all data and audit',  '#475569', 1),
        ('Viewer',              'Read-only access to all business modules',        '#6B7280', 1),
    ]
    for name, desc, color, is_sys in default_roles:
        existing = c.execute("SELECT id FROM roles WHERE name=?", (name,)).fetchone()
        if not existing:
            c.execute(
                "INSERT INTO roles (name, description, color, is_system, created_at) VALUES (?,?,?,?,datetime('now'))",
                (name, desc, color, is_sys)
            )

    # The "Business Owner" role is admin-tier: it reaches every administrative
    # surface (users/roles/settings/audit/backups) WITHOUT being a vendor
    # superadmin. The is_admin flag is what elevates it above ordinary RBAC
    # roles (see permissions.require_admin); the module marketplace stays
    # superadmin-only. Set here (not via the roles API) so it can't be granted
    # by a customer.
    c.execute("UPDATE roles SET is_admin=1 WHERE name='Business Owner'")

    def _set_perm(role_name, module, v=0, cr=0, ed=0, dl=0, ap=0):
        row = c.execute("SELECT id FROM roles WHERE name=?", (role_name,)).fetchone()
        if not row:
            return
        c.execute("""
            INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(role_id, module) DO NOTHING
        """, (row[0], module, v, cr, ed, dl, ap))

    # Permission matrix — module → permission tuple. Modules omitted for a role
    # grant no access. These are sensible defaults so admins rarely need to
    # build a custom role from scratch.
    ROLE_PERMS = {
        'Manager': {
            'dashboard': _V, 'clients': _VCEA, 'projects': _VCEA, 'quotations': _VCEA,
            'invoices': _VCEA, 'suppliers': _VCEA, 'crm': _VCEA, 'planning': _VCEA,
            'inventory': _V, 'purchases': _V, 'finance': _V, 'expenses': _V, 'reports': _V,
            'pos': _VCED, 'cash': _VCED, 'manufacturing': _V, 'assets': _V, 'accounting': _V,
        },
        'Finance Manager': {
            'dashboard': _V, 'finance': _FULL, 'expenses': _FULL, 'invoices': _VCEA,
            'reports': _V, 'clients': _V, 'projects': _V, 'quotations': _V, 'purchases': _V,
            'cash': _FULL, 'pos': _V, 'assets': _FULL, 'accounting': _FULL,
        },
        'Accountant': {
            'dashboard': _V, 'clients': _V, 'projects': _V, 'quotations': _V,
            'invoices': _VCE, 'finance': _VCE, 'expenses': _VCE, 'purchases': _V, 'reports': _V,
            'cash': _VCE, 'pos': _V, 'assets': _VCE, 'accounting': _VCE,
        },
        'Sales Manager': {
            'dashboard': _V, 'clients': _VCED, 'quotations': _VCEA, 'invoices': _VCE,
            'crm': _VCEA, 'projects': _V, 'reports': _V, 'pos': _VCED, 'cash': _VCE,
        },
        'Sales': {
            'dashboard': _V, 'clients': _VCE, 'projects': _V, 'quotations': _VCE,
            'invoices': _V, 'crm': _VC, 'pos': _VC,
        },
        'Cashier': {
            'dashboard': _V, 'pos': _VCE, 'cash': _VCE,
            'clients': _VC, 'invoices': _V, 'inventory': _V,
        },
        'Project Manager': {
            'dashboard': _V, 'projects': _VCEA, 'planning': _FULL, 'clients': _V,
            'quotations': _V, 'invoices': _V, 'expenses': _VC, 'reports': _V,
        },
        'Operations Manager': {
            'dashboard': _V, 'projects': _VCE, 'planning': _VCE, 'inventory': _VCE,
            'purchases': _VCE, 'suppliers': _VCE, 'reports': _V, 'pos': _VCED,
            'manufacturing': _VCED, 'cash': _VCE, 'assets': _VCE,
        },
        'HR Manager': {
            'dashboard': _V, 'hr': _FULL, 'hr_contracts': _FULL, 'recruitment': _FULL,
            'hr_activities': _FULL, 'reports': _V,
        },
        'Recruiter': {
            # Read-only on existing employees (so the recruiter can see who
            # they're hiring into), full control over the recruitment pipeline.
            # No payroll / contract access.
            'dashboard': _V, 'recruitment': _FULL, 'hr': _V,
            'hr_activities': _FULL,
        },
        'Procurement Officer': {
            'dashboard': _V, 'purchases': _VCEA, 'suppliers': _VCED, 'inventory': _VCE,
            'expenses': _V, 'manufacturing': _V,
        },
        'Inventory': {
            'dashboard': _V, 'inventory': _VCE, 'purchases': _VCE, 'suppliers': _VCE,
            'manufacturing': _VCE,
        },
        'Production Manager': {
            'dashboard': _V, 'manufacturing': _VCED, 'inventory': _VCE,
            'purchases': _V, 'planning': _V, 'reports': _V,
        },
        'CRM Specialist': {
            'dashboard': _V, 'crm': _VCED, 'clients': _VCE, 'quotations': _V,
        },
    }

    # Admin, Business Owner, Viewer & Auditor span every module uniformly.
    for mod in MODULES:
        _set_perm('Admin',          mod, *_FULL)
        _set_perm('Business Owner', mod, *_FULL)
        _set_perm('Viewer',         mod, *_V)
        _set_perm('Auditor',        mod, *_V)
    _set_perm('Auditor', 'audit', *_V)   # Auditor may also read the audit trail

    # Business Owner is full-admin minus modules — give it the admin-area
    # permissions too so the admin UIs (users/roles/settings/audit) light up.
    # Backend access is governed by require_admin (admin-tier); these rows make
    # the frontend `can()` checks agree.
    for amod in ('settings', 'users', 'roles', 'audit'):
        _set_perm('Business Owner', amod, *_FULL)

    for role_name, perms in ROLE_PERMS.items():
        for mod, tup in perms.items():
            _set_perm(role_name, mod, *tup)

    # HR holds sensitive data (salaries, contracts, applicant CVs, internal
    # touchpoints) — granted explicitly rather than via the blanket Viewer
    # loop, so general read-only roles do not see it.
    for hr_mod in ('hr', 'hr_contracts', 'recruitment', 'hr_activities'):
        _set_perm('Admin',          hr_mod, *_FULL)
        _set_perm('Business Owner', hr_mod, *_FULL)
        _set_perm('Manager',        hr_mod, *_V)
        _set_perm('Auditor',        hr_mod, *_V)

    # Announcements — view broad (every role can see their inbox); publish
    # restricted by default to Admin + Manager. Superadmin can grant create
    # to additional roles via Role Management. `_set_perm` uses ON CONFLICT
    # DO NOTHING, so we insert the elevated permissions FIRST and then fall
    # back to view-only for every other role.
    _set_perm('Manager', 'announcements', *_VCED)
    _set_perm('Business Owner', 'announcements', *_FULL)
    for role_name, _, _, _ in default_roles:
        if role_name in ('Admin', 'Viewer', 'Auditor', 'Manager'):
            continue  # blanket loop above + explicit row already handle these
        _set_perm(role_name, 'announcements', *_V)

    # ── Wire cross-module data dependencies (one-time backfill) ───────────
    # Several screens read data from a *sibling* module. Two failure classes:
    #   • LOAD  — ProjectDetail fetches the inventory list on mount inside a
    #             Promise.all, so a role with projects:view but no
    #             inventory:view gets a hard error opening any project.
    #   • FORM  — the quotation / invoice / purchase / asset / expense editors
    #             populate their selectors from clients, projects, inventory
    #             and suppliers; without view on those the dropdowns are empty
    #             and the record can't be filled in.
    # A role that can reach the owning module must therefore be able to VIEW
    # what that module depends on. We only ADD view; higher permissions are
    # never touched. Guarded by a one-shot flag so it retrofits existing
    # installs exactly once and never overrides an admin's later edits.
    #   trigger 'view'  → dependency fetched on page load (hard error if 403)
    #   trigger 'write' → create/edit form selector (empty if 403)
    if not c.execute(
        "SELECT 1 FROM schema_migrations WHERE name='081_role_dep_view'"
    ).fetchone():
        _dep_rules = [
            ('projects',   'view',  ('inventory',)),
            ('projects',   'write', ('clients',)),
            ('quotations', 'write', ('clients', 'projects', 'inventory')),
            ('invoices',   'write', ('clients', 'projects', 'inventory')),
            ('purchases',  'write', ('suppliers', 'inventory')),
            ('assets',     'write', ('suppliers',)),
            ('expenses',   'write', ('projects',)),
        ]
        for (rid,) in c.execute("SELECT id FROM roles").fetchall():
            # row = (module, can_view, can_create, can_edit)
            perms = {
                row[0]: row
                for row in c.execute(
                    "SELECT module, can_view, can_create, can_edit "
                    "FROM role_permissions WHERE role_id=?", (rid,)
                ).fetchall()
            }
            for module, trigger, deps in _dep_rules:
                p = perms.get(module)
                if not p:
                    continue
                triggered = bool(p[1]) if trigger == 'view' else bool(p[2] or p[3])
                if not triggered:
                    continue
                for dep in deps:
                    c.execute("""
                        INSERT INTO role_permissions
                            (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
                        VALUES (?,?,1,0,0,0,0)
                        ON CONFLICT(role_id, module) DO UPDATE SET can_view=1
                    """, (rid, dep))
        c.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) "
            "VALUES ('081_role_dep_view', datetime('now'))"
        )

    # ── Seed admin user ───────────────────────────────────────────────────
    existing_admin = c.execute(
        "SELECT id FROM users WHERE is_superadmin=1 AND deleted_at IS NULL"
    ).fetchone()
    if not existing_admin:
        import secrets, string
        from auth_utils import hash_password
        _alpha = string.ascii_letters + string.digits + "!@#$%^&*"
        admin_password = ''.join(secrets.choice(_alpha) for _ in range(20))
        admin_role = c.execute("SELECT id FROM roles WHERE name='Admin'").fetchone()
        c.execute(
            "INSERT INTO users "
            "(username, password_hash, full_name, role, role_id, is_active, is_superadmin, must_change_password, created_at) "
            "VALUES (?,?,?,?,?,1,1,1,datetime('now'))",
            ("admin", hash_password(admin_password),
             "System Admin", "admin", admin_role[0] if admin_role else None)
        )
        print(
            f"\n  *** INITIAL ADMIN PASSWORD (shown once — change immediately): "
            f"{admin_password} ***\n"
        )
    else:
        c.execute("""
            UPDATE users SET is_superadmin=1, is_active=1
            WHERE username='admin' AND (is_superadmin IS NULL OR is_superadmin=0)
        """)
        admin_role = c.execute("SELECT id FROM roles WHERE name='Admin'").fetchone()
        if admin_role:
            c.execute(
                "UPDATE users SET role_id=? WHERE username='admin' AND role_id IS NULL",
                (admin_role[0],)
            )


init_db()
