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
- **Per-user** — every notification belongs to one person
- **Deduplication** — repeating events use a key + lookback to avoid spamming
- **Deliver-at** — supports scheduled delivery (e.g. HR activity reminders)
- **Soft-read** — read state flips; nothing is ever deleted

---

=== "Operator's view"

    ### The bell

    Top right corner — bell icon with a red count badge. Click → dropdown
    list of recent unread notifications.

    Each one shows: an icon, a title, a snippet, "X minutes ago", and
    an inline link button.

    ### Reading

    Click a notification → it marks as read AND navigates to the linked
    entity (invoice / approval / etc).

    ### Bulk actions

    Notifications page (full list).

    - **Mark all as read** — flips everything to read for everything
    - Filter by type
    - Filter by read state
    - Date range

=== "Administrator's view"

    ### Permissions

    Self-only. No role grants visibility into another user's notifications
    — that's a privacy boundary the system enforces server-side. Even
    not even the vendor's support account can read another person's.

    ### Source of every notification

    Each notification records what it is about, so the
    notification deep-links to the source. Examples.

    | Type | Related to | Which record | Opens |
    |---|---|---|---|
    | payment received | `invoice` | invoice id | `/invoices` |
    | low stock | inventory | item id | `/inventory` |
    | approval request | approval request | request id | `/approvals` |
    | cash variance | cash reconciliation | rec id | `/cash` |
    | task due soon | planning task | task id | `/planning` |
    | `announcement` | `announcement` | announcement id | `/announcements` |

    ### Deduplication

    The same alert about the same record is only sent once within a set
    window. This is what stops the noise: an item dipping below its
    minimum twenty times in a day produces one notification, not twenty.

    ### Deliver at

    Most notifications appear immediately. Scheduled ones — an HR activity
    reminder, say — carry a time to appear, set to a chosen number of
    minutes before the event, and stay hidden until then.

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
