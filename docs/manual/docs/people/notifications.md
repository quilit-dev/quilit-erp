# Notifications

The per-user system-event inbox. 14 event types fan out from every module
into one queryable feed.

## Purpose

Notifications are how the system tells you "something happened that you
should know about". Examples.

- Your payment was received
- An invoice is overdue
- Stock is running low
- An approval is waiting on you
- A new announcement arrived

The bell refreshes every 30 seconds; the bell
in the top bar shows the count.

## Personas

| Persona | What they read |
|---|---|
| **Anyone with an account** | Their own notifications |
| **No-one** | Nobody can see others' notifications (privacy by design) |

## Quick reference

- **Types** (14 seeded):
  `announcement`, approval request, asset depreciated, cash variance,
  activity reminder, invoice overdue, invoice paid, low stock,
  payment received, production completed, quotation accepted,
  recruitment hired, recruitment status, task due soon
- **Per-user** — `notifications.user_id` is mandatory
- **Deduplication** — repeating events use a key + lookback to avoid spamming
- **Deliver-at** — supports scheduled delivery (e.g. HR activity reminders)
- **Soft-read** — is read flips; rows are never deleted (retention indefinite)

---

=== "Operator's view"

    ### The bell

    Top right corner — bell icon with a red count badge. Click → dropdown
    list of recent unread notifications.

    Each row: icon (per type), title, body snippet, "X minutes ago", and
    an inline link button.

    ### Reading

    Click a notification → it marks as read AND navigates to the linked
    entity (invoice / approval / etc).

    ### Bulk actions

    Notifications page (full list).

    - **Mark all as read** — flips `is_read=1` for everything
    - Filter by type
    - Filter by read state
    - Date range

=== "Administrator's view"

    ### Permissions

    Self-only. No role grants visibility into another user's notifications
    — that's a privacy boundary the system enforces server-side. Even
    not even the vendor's support account can read another person's.

    ### Source of every notification

    Each `notifications` row carries entity type + entity id so the
    notification deep-links to the source. Examples.

    | Type | entity_type | entity_id | Link target |
    |---|---|---|---|
    | payment received | `invoice` | invoice id | `/invoices` |
    | low stock | inventory | item id | `/inventory` |
    | approval request | approval request | request id | `/approvals` |
    | cash variance | cash reconciliation | rec id | `/cash` |
    | task due soon | planning task | task id | `/planning` |
    | `announcement` | `announcement` | announcement id | `/announcements` |

    ### Deduplication

    The `notify()` helper accepts a dedup hours parameter. With it, the
    helper checks for an existing notification of the same `type` +
    entity id within the lookback window — if one exists, it's a no-op.
    This prevents spam: stock dipping below min_stock 20 times in a day =
    one notification, not twenty.

    ### Deliver at

    deliver at defaults to creation date for immediate delivery. For
    scheduled notifications (HR activity reminders), it's set to "X
    minutes before the event". The unread-count and inbox endpoints
    filter to `deliver_at <= now`.

=== "Auditor's view"

    Notifications are operational — not typically part of a financial
    audit — but useful for.

    ### Verifying approval-request notifications fired

    ### Cash variance notification trail

---

## What's NOT supported

- Per-user notification preferences (mute X type). Currently you receive
  every type you're entitled to.
- Email / SMS delivery channels. Notifications are in-app only.
- Push notifications. Polling-based, 30s cadence.
- Cross-user mention notifications ("@manager please review"). Comments
  fire on announcements + approvals but the mention syntax isn't
  parsed.
