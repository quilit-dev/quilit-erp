"""Arabic re-rendering of backend-generated notification messages.

Every notification is stored with its English ``title``/``body`` (the canonical
fallback) plus a stable ``msg_key`` and JSON ``params``. The notifications list
endpoint calls :func:`localize` to re-render the text in the viewer's language
when a template exists; anything missing (unknown key, unknown language, a param
that isn't supplied) falls back to the stored English, so a row can never render
blank.

Templates use ``str.format`` placeholders and may carry format specs that mirror
the English f-strings (e.g. ``{amount:,.2f}``). ``title`` is required; omit
``body`` to keep the stored English body — used where the body is conditional or
is free-form user content (announcements, planning events, cash-variance bits).
"""
import json

# msg_key → Arabic template. Keep in sync with the notify(msg=...) call sites.
AR = {
    # ── CRM ──────────────────────────────────────────────────────────────────
    "lead_converted":   {"title": "تحويل عميل محتمل: {name}",
                         "body": "تم التحويل بنجاح إلى العميل رقم {client_id}"},
    "deal_won":         {"title": "صفقة رابحة: {title}",
                         "body": "تهانينا! تم تعليم الصفقة كرابحة."},
    "deal_lost":        {"title": "صفقة خاسرة: {title}",
                         "body": "السبب: {reason}"},

    # ── Inventory / stock ──────────────────────────────────────────────────────
    "low_stock":           {"title": "تنبيه مخزون منخفض: {name}",
                            "body": "بقي {qty} {unit} فقط (الحد الأدنى: {min})"},
    "low_stock_warehouse": {"title": "مخزون منخفض في {code}: {name}",
                            "body": "بقي {qty} {unit} في {wh} (الحد الأدنى: {min})"},
    "purchase_received":   {"title": "تم استلام أمر الشراء {po}",
                            "body": "{product} من {supplier} — {qty} وحدة، ${total:,.2f}"},
    "production_completed": {"title": "اكتمل الإنتاج: {order}"},

    # ── Warehouse transfers ────────────────────────────────────────────────────
    "transfer_dispatched": {"title": "تحويل وارد {number}",
                            "body": "{from_code} → {to_code} · {count} صنف قيد النقل"},
    "transfer_received":   {"title": "تم استلام التحويل {number}"},
    "transfer_cancelled":  {"title": "أُلغي التحويل {number}"},
    "transfer_rolled_back": {"title": "تم التراجع عن التحويل {number}"},

    # ── Sales / billing ────────────────────────────────────────────────────────
    "quotation_accepted": {"title": "تم قبول عرض السعر: {number}",
                           "body": "الإجمالي ${amount:,.2f} — جاهز للفوترة."},
    "invoice_paid":       {"title": "تم سداد الفاتورة {number} بالكامل",
                           "body": "{client} — ${amount:,.2f} مستلمة عبر {method}"},
    "payment_received":   {"title": "تم استلام دفعة على {number}",
                           "body": "{client} — ${amount:,.2f} عبر {method} · ${remaining:,.2f} متبقٍ"},
    "invoice_overdue":    {"title": "الفاتورة {number} متأخرة",
                           "body": "{client} — ${amount:,.2f} مستحقة، متأخرة {days} يوم"},

    # ── Instalments ─ an invoice plan and an account plan, each before
    # its date and after it.
    "installment_due_today": {
        "title": "قسط {seq} من {doc} مستحق اليوم",
        "body": "{who} — ${amount:,.2f} مستحقة اليوم"},
    "installment_due_soon": {
        "title": "قسط {seq} من {doc} يستحق قريباً",
        "body": "{who} — ${amount:,.2f} مستحقة في {date} ، بعد {days} يوم"},
    "installment_overdue": {
        "title": "قسط {seq} من {doc} متأخر",
        "body": "{who} — ${amount:,.2f} مستحقة في {date}، متأخرة {days} يوم"},
    "account_plan_due_today": {
        "title": "قسط {seq} من جدول حساب {who} مستحق اليوم",
        "body": "{who} — ${amount:,.2f} مستحقة اليوم"},
    "account_plan_due_soon": {
        "title": "قسط {seq} من جدول حساب {who} يستحق قريباً",
        "body": "{who} — ${amount:,.2f} مستحقة في {date}، بعد {days} يوم"},
    "account_plan_overdue": {
        "title": "قسط {seq} من جدول حساب {who} متأخر",
        "body": "{who} — ${amount:,.2f} مستحقة في {date}، متأخرة {days} يوم"},

    # ── Planning + reminders (titles only; bodies are user content) ────────────
    "task_due_soon":       {"title": "مهمة مستحقة قريباً: {name}",
                            "body": "{project} — {label}"},
    "planning_event":      {"title": "📅 {title}"},
    "hr_activity_reminder": {"title": "⏰ تذكير: {subject}"},
    "announcement_comment": {"title": "💬 تعليق جديد على إعلانك"},

    # ── HR — leave + payroll + contracts ───────────────────────────────────────
    "leave_requested":  {"title": "طلب إجازة: {name}",
                         "body": "{leave_type} — {days} يوم · {start} → {end}"},
    "leave_approved":   {"title": "تمت الموافقة على طلب إجازتك",
                         "body": "{leave_type} · {start} → {end}{note}"},
    "leave_rejected":   {"title": "تم رفض طلب إجازتك",
                         "body": "{leave_type} · {start} → {end}{note}"},
    "payroll_approved": {"title": "تمت الموافقة على مسيّر الرواتب — {start} → {end}",
                         "body": "{count} موظف · جاهز للدفع."},
    "payroll_paid_employee": {"title": "تم دفع راتبك",
                              "body": "{start} → {end} · {amount:,.2f} {currency}"},
    "payroll_paid_manager":  {"title": "تم دفع الرواتب — {start} → {end}",
                              "body": "صُرف ${total:,.2f} على {count} موظف."},
    "contract_expiring": {"title": "عقد قارب على الانتهاء: {emp}",
                          "body": "{number} — ينتهي خلال {days} يوم ({date})"},

    # ── Recruitment ────────────────────────────────────────────────────────────
    "recruitment_status": {"title": "تغيّرت حالة المتقدّم: {name}",
                           "body": "{old} → {new}"},
    "recruitment_hired":  {"title": "تعيين جديد: {name}",
                           "body": "مرحباً بانضمامك! يبدأ التهيئة في {date}."},

    # ── Finance — cash, assets, recurring ──────────────────────────────────────
    "cash_variance":     {"title": "فرق نقدي بتاريخ {date}"},
    "asset_depreciated": {"title": "تم ترحيل الإهلاك لـ {target}",
                          "body": "${amount:,.2f} على {assets} أصل، و{periods} فترة تم تسويتها."},
    "recurring_generated_one":   {"title": "تم توليد مصروف متكرر: {name}",
                                  "body": "{count} دفعة · ${total:,.2f} مُرحّلة إلى المصاريف"},
    "recurring_generated_batch": {"title": "تم ترحيل المصاريف المتكررة ({count} دفعة)",
                                  "body": "تمت معالجة {templates} قالب لتواريخ الاستحقاق حتى {date}."},

    # ── Accounting (lazy system gen) ───────────────────────────────────────────
    "fx_rate_stale":  {"title": "سعر صرف USD ↔ LBP قديم",
                       "body": "آخر سعر عمره {age} يوم (1 USD = {rate:,.0f} LBP). عيّن سعراً جديداً في الإعدادات."},
    "period_unlocked": {"title": "الفترة {period} غير مقفلة",
                        "body": "اقفل الشهر من المحاسبة ← أقفال الفترات لمنع القيود بأثر رجعي."},

    # ── Approval workflow ──────────────────────────────────────────────────────
    "approval_request":  {"title": "مطلوب موافقة: {label}",
                          "body": '"{policy}" — الخطوة {step} بانتظار مراجعتك.'},
    "approval_approved": {"title": "تمت الموافقة: {label}",
                          "body": 'تمت الموافقة على طلبك "{policy}".'},
    "approval_rejected": {"title": "مرفوض: {label}",
                          "body": 'تم رفض طلبك "{policy}". {comment}'},
}

_TABLES = {"ar": AR}


def localize(row, lang):
    """Return ``(title, body)`` for a notification ``row`` in ``lang``.

    Falls back to the row's stored English ``title``/``body`` for an unknown
    language, a row without a ``msg_key``, a key with no template, or any
    formatting error (e.g. a param the template expects but the row didn't store).
    """
    title = row.get("title")
    body = row.get("body")
    table = _TABLES.get((lang or "").lower())
    if not table:
        return title, body
    tpl = table.get(row.get("msg_key")) if row.get("msg_key") else None
    if not tpl:
        return title, body

    params = row.get("params")
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except Exception:
            params = {}
    if not isinstance(params, dict):
        params = {}

    try:
        title = tpl["title"].format(**params)
    except Exception:
        pass  # keep stored English title
    if "body" in tpl:
        try:
            body = tpl["body"].format(**params)
        except Exception:
            pass  # keep stored English body
    return title, body
