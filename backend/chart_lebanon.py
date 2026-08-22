"""
The Lebanese statutory chart of accounts (النظام المحاسبي العام).

This is the essential set — the accounts a trading business actually posts to,
plus the headings above them so the tree reads correctly. The published plan
runs to 807 accounts; the rest are seeded from the same source when a business
needs them, and nothing here prevents an accountant adding their own.

Two things to know before reading the mapping at the bottom.

**The digits mean something different from the default chart.** Class 1 is
permanent capital, not assets. Class 4 is third parties — customers AND
suppliers — not revenue. Class 5 is cash and banks, not cost of sales. A
receivable is 4111, not 1100. This is why postings ask for a role rather than a
number (see accounting.code).

**Revenue is split by VAT liability.** 7011 is a sale subject to VAT and 7012 a
sale that is not, where the default chart has one 4000. The role below points at
the VAT-liable account because that is the common case; routing each line by its
own tax status is a refinement worth making later, and is noted as such.

Accounts marked `POSTABLE = False` are headings. 41 is where customers live; the
sale lands in 4111. Posting to a heading double-counts it against its children,
so the seeding marks them and the ledger refuses them.

Names: Arabic exactly as published. English is a translation for the interface
and is not itself statutory — an accountant may prefer different wording, and
changing it breaks nothing.
"""

HEADER, POSTABLE = False, True

# (code, arabic, english, type, subtype, normal_balance, postable)
ACCOUNTS = [
    # ── Class 1 — Permanent capital ─────────────────────────────────────────
    ("1",    "حسابات الرساميل الدائمة", "Permanent capital accounts",
     "Equity", "Capital", "credit", HEADER),
    ("10",   "رأس المال", "Capital", "Equity", "Capital", "credit", HEADER),
    ("101",  "رأس مال الشركة", "Share capital", "Equity", "Capital", "credit", HEADER),
    ("1013", "رأس المال المكتتب المستدعى والمدفوع",
     "Subscribed capital, called and paid", "Equity", "Capital", "credit", POSTABLE),
    ("109",  "الحساب الشخصي لصاحب المؤسسة", "Owner's current account",
     "Equity", "Capital", "credit", POSTABLE),
    ("11",   "الاحتياطات", "Reserves", "Equity", "Reserves", "credit", HEADER),
    ("111",  "احتياطي قانوني", "Legal reserve", "Equity", "Reserves", "credit", POSTABLE),
    ("12",   "نتائج سابقة مدورة", "Retained earnings brought forward",
     "Equity", "Retained Earnings", "credit", HEADER),
    ("121",  "نتائج سابقة مدورة دائنة", "Retained earnings — credit balance",
     "Equity", "Retained Earnings", "credit", POSTABLE),
    ("125",  "نتائج سابقة مدورة مدينة", "Accumulated losses — debit balance",
     "Equity", "Retained Earnings", "debit", POSTABLE),
    ("13",   "النتيجة الصافية للدورة المالية", "Net result for the period",
     "Equity", "Result", "credit", HEADER),
    ("138",  "نتيجة الدورة- أرباح", "Result for the period — profit",
     "Equity", "Result", "credit", POSTABLE),
    ("139",  "نتيجة الدورة- خسائر", "Result for the period — loss",
     "Equity", "Result", "debit", POSTABLE),

    # ── Class 2 — Fixed assets ──────────────────────────────────────────────
    ("2",    "حسابات الأصول الثابتة", "Fixed asset accounts",
     "Asset", "Non-Current Asset", "debit", HEADER),
    ("22",   "أصول ثابتة مادية", "Tangible fixed assets",
     "Asset", "Non-Current Asset", "debit", HEADER),
    ("28",   "استھلاكات الأصول الثابتة", "Accumulated depreciation",
     "Asset", "Contra Asset", "credit", HEADER),
    ("282",  "استھلاكات الأصول الثابتة المادية",
     "Accumulated depreciation — tangible fixed assets",
     "Asset", "Contra Asset", "credit", POSTABLE),

    # ── Class 3 — Inventory ─────────────────────────────────────────────────
    ("3",    "المخزون وقيد الصنع", "Inventory and work in progress",
     "Asset", "Current Asset", "debit", HEADER),
    ("37",   "البضائع (المعدة للبيع)", "Merchandise held for sale",
     "Asset", "Current Asset", "debit", POSTABLE),

    # ── Class 4 — Third parties ─────────────────────────────────────────────
    ("4",    "حسابات الذمم", "Third-party accounts",
     "Liability", "Current Liability", "credit", HEADER),
    ("40",   "الموردون", "Suppliers", "Liability", "Current Liability", "credit", HEADER),
    ("401",  "ذمم دائنة (موردو الإستثمار)", "Trade payables — operating suppliers",
     "Liability", "Current Liability", "credit", HEADER),
    ("4011", "فواتير موردو الاستثمار", "Operating supplier invoices",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("41",   "الزبائن", "Customers", "Asset", "Current Asset", "debit", HEADER),
    ("411",  "فواتير الزبائن", "Customer invoices", "Asset", "Current Asset", "debit", HEADER),
    ("4111", "زبائن عاديون", "Ordinary customers", "Asset", "Current Asset", "debit", POSTABLE),
    ("42",   "المستخدمون", "Employees", "Liability", "Current Liability", "credit", HEADER),
    ("421",  "المستخدمون- أجور مستحقة", "Employees — wages payable",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("43",   "مؤسسات الضمان الإجتماعي", "Social security institutions",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("44",   "الدولة والمؤسسات العامة", "State and public institutions",
     "Liability", "Current Liability", "credit", HEADER),
    ("442",  "ضريبة القيمة المضافة", "Value added tax",
     "Liability", "Current Liability", "credit", HEADER),
    ("4425", "ض.ق.م. المتوجبة الدفع/القبض", "VAT payable / receivable",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("4426", "ض.ق.م. المستحقة الحسم على الاعباء", "Deductible VAT on charges (input)",
     "Asset", "Current Asset", "debit", POSTABLE),
    ("4427", "ض.ق.م. المتوجبة الدفع على الايرادات", "VAT due on revenue (output)",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("47",   "حسابات التسوية", "Adjustment accounts",
     "Asset", "Current Asset", "debit", HEADER),
    ("472",  "أعباء محتسبة مسبقا (أعباء مدفوعة مقدما)", "Prepaid expenses",
     "Asset", "Current Asset", "debit", POSTABLE),
    ("473",  "ايرادات محتسبة مسبقا (ايرادات مقبوضة مقدما)", "Deferred income",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("475",  "فروقات صرف- خصوم", "Exchange differences — liabilities",
     "Liability", "Current Liability", "credit", POSTABLE),
    ("476",  "فروقات صرف- أصول", "Exchange differences — assets",
     "Asset", "Current Asset", "debit", POSTABLE),

    # ── Class 5 — Financial ─────────────────────────────────────────────────
    ("5",    "الحسابات المالية", "Financial accounts",
     "Asset", "Current Asset", "debit", HEADER),
    ("51",   "المؤسسات المالية", "Financial institutions",
     "Asset", "Current Asset", "debit", HEADER),
    ("512",  "بنوك", "Banks", "Asset", "Current Asset", "debit", POSTABLE),
    ("53",   "الصندوق", "Cash", "Asset", "Current Asset", "debit", HEADER),
    ("531",  "صندوق النقدي", "Cash on hand", "Asset", "Current Asset", "debit", POSTABLE),
    ("58",   "التحويلات الداخلية", "Internal transfers",
     "Asset", "Current Asset", "debit", POSTABLE),

    # ── Class 6 — Charges ───────────────────────────────────────────────────
    ("6",    "حسابات الأعباء", "Charge accounts", "Expense", "Operating Expense", "debit", HEADER),
    ("60",   "مشتريات البضاعة وقيمة التغيير في المخزون",
     "Merchandise purchases and inventory movement",
     "Expense", "Cost of Sales", "debit", HEADER),
    ("601",  "مشتريات البضاعة", "Merchandise purchases",
     "Expense", "Cost of Sales", "debit", HEADER),
    ("6011", "مشتريات البضاعة", "Merchandise purchases",
     "Expense", "Cost of Sales", "debit", POSTABLE),
    ("6018", "نفقات إضافية على شراء البضائع والعبوات",
     "Incidental costs on purchases", "Expense", "Cost of Sales", "debit", POSTABLE),
    ("605",  "قيمة التغيير في مخزون البضاعة", "Change in merchandise inventory",
     "Expense", "Cost of Sales", "debit", POSTABLE),
    ("62",   "أعباء خارجية أخرى", "Other external charges",
     "Expense", "Operating Expense", "debit", POSTABLE),
    ("63",   "أعباء المستخدمين", "Personnel charges",
     "Expense", "Operating Expense", "debit", HEADER),
    ("631",  "أجور ورواتب", "Wages and salaries",
     "Expense", "Operating Expense", "debit", POSTABLE),
    ("64",   "ضرائب ورسوم ومدفوعات مماثلة", "Taxes, duties and similar payments",
     "Expense", "Operating Expense", "debit", POSTABLE),
    ("65",   "مخصصات الإستھلاكات والمؤونات للإستثمار",
     "Depreciation and provision charges", "Expense", "Operating Expense", "debit", HEADER),
    ("651",  "مخصصات الإستھلاكات", "Depreciation charges",
     "Expense", "Operating Expense", "debit", HEADER),
    ("6512", "أصول ثابتة مادية", "Tangible fixed assets",
     "Expense", "Operating Expense", "debit", POSTABLE),
    ("66",   "أعباء إدارية عادية أخرى", "Other ordinary administrative charges",
     "Expense", "Operating Expense", "debit", HEADER),
    ("661",  "أعباء إدارية أخرى", "Other administrative charges",
     "Expense", "Operating Expense", "debit", POSTABLE),
    ("67",   "الأعباء المالية", "Financial charges",
     "Expense", "Other Expense", "debit", HEADER),
    ("675",  "فروقات صرف سلبية", "Negative exchange differences (FX loss)",
     "Expense", "Other Expense", "debit", POSTABLE),
    ("69",   "الضرائب على الأرباح", "Taxes on profits",
     "Expense", "Other Expense", "debit", POSTABLE),

    # ── Class 7 — Revenue ───────────────────────────────────────────────────
    ("7",    "حسابات الإيرادات", "Revenue accounts", "Income", "Operating Income", "credit", HEADER),
    ("70",   "مبيعات البضاعة", "Merchandise sales", "Income", "Operating Income", "credit", HEADER),
    ("701",  "فواتير مبيعات", "Sales invoices", "Income", "Operating Income", "credit", HEADER),
    ("7011", "مبيعات خاضعة لضريبة القيمة المضافة", "Sales subject to VAT",
     "Income", "Operating Income", "credit", POSTABLE),
    ("7012", "مبيعات غير خاضعة لضريبة القيمة المضافة", "Sales not subject to VAT",
     "Income", "Operating Income", "credit", POSTABLE),
    ("709",  "حسومات ممنوحة", "Discounts granted", "Income", "Operating Income", "debit", POSTABLE),
    ("71",   "المنتجات المباعة", "Products sold", "Income", "Operating Income", "credit", HEADER),
    ("713",  "ايرادات خدمات", "Service revenue", "Income", "Operating Income", "credit", HEADER),
    ("7131", "خدمات خاضعة لضريبة القيمة المضافة", "Services subject to VAT",
     "Income", "Operating Income", "credit", POSTABLE),
    ("7132", "خدمات غير خاضعة لضريبة القيمة المضافة", "Services not subject to VAT",
     "Income", "Operating Income", "credit", POSTABLE),
    ("76",   "إيرادات أخرى ناتجة عن الإستثمار", "Other operating income",
     "Income", "Operating Income", "credit", POSTABLE),
    ("77",   "الإيرادات المالية", "Financial income", "Income", "Other Income", "credit", HEADER),
    ("775",  "فروقات صرف إيجابية", "Positive exchange differences (FX gain)",
     "Income", "Other Income", "credit", POSTABLE),
    ("78",   "إيرادات خارج الإستثمار", "Non-operating income",
     "Income", "Other Income", "credit", POSTABLE),
]

# Sub-accounts this system opens, not published in the plan. The plan is a
# framework and a business is expected to open its own detail — but these are
# OURS, not the ministry's, and an accountant should see them as such.
#
# Cash is split by currency because the code keeps each currency's cash on its
# own line (IAS 21: a monetary balance in a non-functional currency is revalued
# separately, and merging them hides the exposure). The plan has no such split,
# so 531 gets children.
LOCAL_SUBACCOUNTS = [
    ("5311", "صندوق النقدي - ل.ل.", "Cash on hand — LBP",
     "Asset", "Current Asset", "debit", POSTABLE),
    ("5312", "صندوق النقدي - د.أ.", "Cash on hand — USD",
     "Asset", "Current Asset", "debit", POSTABLE),
    ("5313", "صندوق النقدي - يورو", "Cash on hand — EUR",
     "Asset", "Current Asset", "debit", POSTABLE),
]

# Which account plays which part, for a tenant on this chart.
#
# `cogs` points at merchandise purchases. In this tradition cost of sales is not
# a running account: purchases accumulate in 60 and the change in inventory
# (605) adjusts it at period end. Posting cost of goods to 6011 keeps the
# perpetual behaviour the system already has while landing it where a Lebanese
# accountant expects to find it.
#
# `revenue` and `service_revenue` point at the VAT-LIABLE accounts, which is the
# common case. Routing an exempt sale to 7012/7132 by its own tax status is a
# refinement the tax engine has the information for and does not do yet.
ROLES = {
    "cash":              "5312",   # functional currency
    "bank":              "512",    # 53 الصندوق is notes; 512 بنوك is the bank
    "cash_lbp":          "5311",
    "cash_eur":          "5313",
    "receivable":        "4111",
    "inventory":         "37",
    "prepaid":           "472",
    "accumulated_dep":   "282",
    "payable":           "4011",
    "vat_control":       "4425",
    "vat_input":         "4426",
    "vat_output":        "4427",
    "deferred_revenue":  "473",
    "retained_earnings": "121",
    "revenue":           "7011",
    "service_revenue":   "7131",
    "fx_gain":           "775",
    "cogs":              "6011",
    "salaries":          "631",
    "depreciation":      "6512",
    "other_expense":     "661",
    "cash_short_over":   "661",
    "fx_loss":           "675",
}


def parent_of(code: str):
    """The heading a code sits under: 4111 -> 411 -> 41 -> 4."""
    return code[:-1] if len(code) > 1 else None


def all_accounts():
    """The published accounts plus the sub-accounts this system opens."""
    return ACCOUNTS + LOCAL_SUBACCOUNTS


def install(db, *, force=False):
    """Put a tenant on this chart: seed the accounts, re-point the roles.

    Refuses on a tenant that has already posted, unless forced. Switching the
    roles mid-life does not corrupt anything — old entries keep pointing at the
    accounts they were posted to, which is exactly right — but the tenant then
    has balances spread across two charts and no statement that reads correctly.
    Moving a live business needs the accounting ceremony: close the old chart at
    a cutover date and bring the balances across as an opening entry. That is a
    decision with an accountant in the room, not a side effect of a function
    call.

    Idempotent: re-running adds nothing and re-points the same roles.
    """
    from utils import _now

    posted = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entry_lines").fetchone()["n"]
    if posted and not force:
        raise ValueError(
            f"This tenant has {posted} posted journal lines. Switching charts "
            "now would leave its balances split across two of them. Do the "
            "cutover properly — close the current chart and bring the balances "
            "across as an opening entry — or pass force=True if this is a "
            "sandbox.")

    now = _now()
    for code, ar, en, atype, subtype, normal, postable in all_accounts():
        db.execute(
            "INSERT OR IGNORE INTO chart_of_accounts "
            "(code, name, name_ar, type, subtype, normal_balance, parent_code, "
            " is_system, is_active, is_postable, created_at) "
            "VALUES (?,?,?,?,?,?,?,1,1,?,?)",
            (code, en, ar, atype, subtype, normal, parent_of(code),
             1 if postable else 0, now))

    # Retire the default chart's accounts. They are not deleted: an account is
    # the thing historical entries point at, and this system never removes one.
    # Deactivating keeps the ledger readable while stopping a Lebanese business
    # being offered 1100 Accounts Receivable alongside 4111 زبائن عاديون.
    # Reversible by flipping is_active back.
    ours = {a[0] for a in all_accounts()}
    for row in db.execute("SELECT code FROM chart_of_accounts").fetchall():
        if row["code"] not in ours:
            db.execute("UPDATE chart_of_accounts SET is_active=0 WHERE code=?",
                       (row["code"],))

    for role, code in ROLES.items():
        db.execute(
            "INSERT INTO account_roles (role, code, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(role) DO UPDATE SET code=excluded.code, "
            "updated_at=excluded.updated_at",
            (role, code, now))
    return len(all_accounts())
