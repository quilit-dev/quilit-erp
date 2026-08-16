# Backup & recovery

How the system protects business data, and what to do if you need to roll
back.

## Purpose

Everything the ERP knows lives in **one database file**: `%APPDATA%\ERP
System\erp.db`. That's a feature (one thing to back up) and a risk (one
thing to lose). Backups exist so a hardware failure, ransomware, or honest
mistake doesn't end the business.

## Personas

| Persona | Concern |
|---|---|
| **Operator** | "I just need to know it's happening — I shouldn't have to think about it." |
| **Administrator** | "Configure the schedule, the destination, and retention. Verify quickly that backups work." |
| **Auditor** | "Show me proof of backup runs and a successful restore drill." |

## Quick reference

- **Auto-backup**: enabled by default, daily at 02:00 server time
- **Destination**: `%APPDATA%\ERP System\backups\` by default; configurable
  to a USB stick or network share
- **Format**: one file, a complete copy of your data
- **Filename**: `erp-YYYYMMDD-HHMMSS.db`
- **Retention**: last 30 daily snapshots, plus any manual backups you pin
- **Restore**: stop the app, replace the live `erp.db`, restart

## What a backup actually is

Each backup is a single file — a complete copy of everything in the system
at the moment it was taken. Nothing is left out, and nothing else is needed
to restore it.

A backup can be taken while people are working. It does not interrupt
anyone, and it never captures a half-finished transaction.

Old backups are removed automatically once you have more than you asked to
keep, except any you have pinned.

---

=== "Operator's view"

    There's nothing for you to do. The auto-backup runs in the background
    daily. If the administrator configured a USB or network destination,
    they'll handle the off-site copy.

    If you want to manually trigger one (you're about to do something
    risky), ask the administrator. **Don't copy `erp.db` yourself while
    the server is running** — the on-disk file is open. Use the in-app
    "Backup now" button, which uses `VACUUM INTO` (safe).

=== "Administrator's view"

    ### Where to configure

    **Settings → Backups**. The page shows:

    - The current backup destination
    - The retention setting
    - A list of recent backups (with file size + timestamp)
    - A **Backup now** button (manual snapshot)
    - A **Pin** toggle per backup (excludes it from retention deletion)
    - A **Restore** button (admin-only, see below)

    ### Recommended destinations

    | Tier | Where | Why |
    |---|---|---|
    | Always | `%APPDATA%\ERP System\backups\` | The default — survives application crashes. |
    | Strongly recommended | A network share or NAS path | Survives the server PC's disk failure. |
    | Strongly recommended | A USB stick taken off-site weekly | Survives the office burning down. |
    | Optional | A cloud-synced folder (OneDrive, Dropbox, …) | Easy, but check that the sync respects file locking. |

    The principle: **two copies on two different physical devices** is the
    minimum. Three (server + NAS + USB) is comfortable.

    ### Verifying a backup works

    The only fully-trusted verification is a **restore drill**: take a
    backup, restore it onto a test machine, log in, and check that the
    last invoice / journal entry / inventory total looks right. Do this
    once a quarter.

    ### Manual backup checklist (do this before any upgrade)

    1. Settings → Backups → **Backup now**
    2. Pin the snapshot (so retention doesn't sweep it away)
    3. Run the new installer
    4. Verify the new version starts and looks correct
    5. (Optional) Unpin the snapshot after a week of clean operation

=== "Auditor's view"

    ### Evidence that backups happen

    | Source | What it proves |
    |---|---|
    | `backups/` folder listing | Snapshots actually exist on disk, with timestamps |
    | the backup log (in the startup log) | The scheduler ran and what it produced |
    | audit-trail entries for manual backups | Manual backups, with operator id |
    | audit-trail entries for restores | Restore operations, with operator id |

    ### Drill record

    The administrator should keep a log of restore drills:

    | Date | Snapshot tested | Outcome | Operator |
    |---|---|---|---|
    | 2026-04-15 | erp-20260413-0200.db | Restored OK, last invoice INV-2026-0421 visible | Admin |
    | 2026-07-22 | … | … | … |

    The drill itself isn't recorded by the system (it happens on a separate
    machine), but its sign-off should live in the customer's BCP/DR
    documentation.

    ### Controls in place

    - Backups are **atomic snapshots** (via `VACUUM INTO`) — no torn writes.
    - Backup writes happen on a **background thread**, never blocking the
      operational request path.
    - Manual restore is gated by the `admin` capability and recorded in
      the audit trail.
    - The `default.db` shipped with the installer is *not* a backup — it's
      a vendor-controlled seed for first-run, and is never written to.

---

## Restore — when to do it, and when not to

| Situation | Restore is the right answer? |
|---|---|
| The server's hard drive failed | ✅ — restore on a new machine from the latest snapshot |
| Ransomware encrypted `erp.db` | ✅ — restore from an **off-site** backup that wasn't on the same disk |
| Someone accidentally deleted a single client | ❌ — use the **Recycle Bin** to restore it, not the whole database |
| The user wants yesterday's numbers back | ❌ — a manual journal entry adjustment, not a restore |
| A bad upgrade introduced a regression | ✅ — restore the pre-upgrade snapshot you pinned (see the upgrade checklist) |
| "We don't trust the last few hours" | ⚠️ — restore loses every transaction since the snapshot. Have a recovery plan for the customer before pulling the trigger. |

## Manual restore on a fresh machine (worst case)

If the original server is destroyed:

```mermaid
flowchart LR
    NEW[Fresh Windows PC] --> INST[Install ERP System x.y.z]
    INST --> APPD[%APPDATA%\\ERP System\\ created]
    APPD --> COPY[Copy the latest .db snapshot<br/>over %APPDATA%\\erp.db]
    COPY --> START[Start ERP System.exe]
    START --> MIG[Brings the data up to date]
    MIG --> BROWSE[Browse to http://server:8765/]
```

Restore into the **same version or newer** — never into an older one. If
the backup came from an older version, restore it first and then upgrade;
the system brings the data up to date on its own.

## What's deliberately NOT supported

- Restoring to an exact moment. You restore to a backup, so the most you
  can lose is the work done since the last one. Back up more often if that
  matters.
- A second machine kept permanently in sync. Ask your provider if you need it.
- Encrypted backups at rest. The copy is an ordinary file; encrypt the
  destination (BitLocker, encrypted USB, encrypted file share) if you need
  data-at-rest encryption.
