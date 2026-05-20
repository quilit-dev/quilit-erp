import sqlite3, os

DB_PATH = os.environ.get("DB_PATH", "erp.db")

def _configure(conn):
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -8000")
    return conn

def get_db():
    conn = _configure(sqlite3.connect(DB_PATH, check_same_thread=False))
    try:
        yield conn
    finally:
        conn.close()


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

    conn.commit()


# ── Base schema ───────────────────────────────────────────────────────────────

def init_db():
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

    # ── Seed default roles ────────────────────────────────────────────────
    # Every business module. Admin modules (settings/users/roles/audit) are
    # granted explicitly per-role below where relevant.
    MODULES = [
        'dashboard', 'clients', 'projects', 'quotations', 'invoices',
        'inventory', 'purchases', 'suppliers', 'finance', 'expenses',
        'reports', 'crm', 'planning', 'pos', 'cash', 'manufacturing',
        'assets',
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
        ('Manager',             'Oversee all business operations with approvals',  '#7C3AED', 1),
        ('Finance Manager',     'Full finance, invoicing and expense authority',   '#059669', 1),
        ('Accountant',          'Day-to-day finance, invoices and expenses',       '#10B981', 1),
        ('Sales Manager',       'Lead the sales pipeline, clients and CRM',        '#2563EB', 1),
        ('Sales',               'Handle clients, quotations and CRM entries',      '#3B82F6', 1),
        ('Cashier',             'Operate the POS register and reconcile the cash drawer', '#0EA5E9', 1),
        ('Project Manager',     'Run projects and the planning board',             '#0891B2', 1),
        ('Operations Manager',  'Projects, planning, inventory and procurement',   '#EA580C', 1),
        ('HR Manager',          'People management — employees, departments, leave','#0D9488', 1),
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
            'pos': _VCED, 'cash': _VCED, 'manufacturing': _V, 'assets': _V,
        },
        'Finance Manager': {
            'dashboard': _V, 'finance': _FULL, 'expenses': _FULL, 'invoices': _VCEA,
            'reports': _V, 'clients': _V, 'projects': _V, 'quotations': _V, 'purchases': _V,
            'cash': _FULL, 'pos': _V, 'assets': _FULL,
        },
        'Accountant': {
            'dashboard': _V, 'clients': _V, 'projects': _V, 'quotations': _V,
            'invoices': _VCE, 'finance': _VCE, 'expenses': _VCE, 'purchases': _V, 'reports': _V,
            'cash': _VCE, 'pos': _V, 'assets': _VCE,
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
            'dashboard': _V, 'hr': _FULL, 'reports': _V,
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

    # Admin & Viewer & Auditor span every module uniformly.
    for mod in MODULES:
        _set_perm('Admin',   mod, *_FULL)
        _set_perm('Viewer',  mod, *_V)
        _set_perm('Auditor', mod, *_V)
    _set_perm('Auditor', 'audit', *_V)   # Auditor may also read the audit trail

    for role_name, perms in ROLE_PERMS.items():
        for mod, tup in perms.items():
            _set_perm(role_name, mod, *tup)

    # HR holds sensitive data (salaries) — granted explicitly rather than via
    # the blanket Viewer loop, so general read-only roles do not see it.
    _set_perm('Admin',   'hr', *_FULL)
    _set_perm('Manager', 'hr', *_V)
    _set_perm('Auditor', 'hr', *_V)

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

    conn.commit()
    conn.close()
    print("Database initialized.")

init_db()
