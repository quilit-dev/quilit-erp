# Announcements

Internal top-down communications. The owner / manager broadcasts a message
to all staff, a role, or a named list. Recipients see it in their
notifications and can acknowledge / comment.

## Purpose

Announcements answer "I need to tell everyone (or a specific group)
something important". Use cases.

- Policy changes ("Casual Friday policy update effective Monday")
- Operational notices ("Office closed for inventory count Saturday")
- Holiday wishes
- Required-acknowledgement notices ("Please confirm you've read the new
  expense policy")

The system tracks **who's received**, **who's read**, and (if required)
**who's acknowledged**.

## Personas

| Persona | What they do here |
|---|---|
| **Owner / Manager** | Authors and publishes |
| **Employee** | Reads inbox, acknowledges, comments |
| **Auditor** | Verifies required acknowledgements were collected |

## Quick reference

- **Priority**: `low`, `medium`, `high`
- **Audience**: `all`, roles, users
- **Requires ack**: optional boolean
- **Pinned**: pinned announcements stay at top of inbox
- **Expires at**: optional; auto-archives after
- **Recipients**: snapshotted at publish (not dynamic — new users added
  later don't auto-receive past announcements)

---

=== "Operator's view (Author)"

    ### Composing

    Announcements → **+ New announcement**.

    | Field | Notes |
    |---|---|
    | Title | One-liner |
    | Body | Rich text |
    | Priority | low / medium / high (affects sort order) |
    | Audience | `all`, roles (pick role names), users (pick specific users) |
    | Requires acknowledgement | Toggle |
    | Pinned | Toggle |
    | Publish at | Now (default) or scheduled |
    | Expires at | Optional |

    Save. The system computes the recipients list at publish and inserts
    one announcement recipients row per user. Each user gets a
    notification of type `announcement`.

    ### Reading reach

    Open a published announcement → **Reach** tab.

    | Stat | Source |
    |---|---|
    | Recipients | Count of announcement recipients |
    | Read | Rows where `read_at IS NOT NULL` |
    | Acknowledged | Rows where `acknowledged_at IS NOT NULL` (only if requires ack) |

=== "Operator's view (Reader)"

    ### Your inbox

    Announcements → **Inbox** tab. Sorted by:
    1. Pinned first
    2. Then priority desc (high → low)
    3. Then published at desc

    Click an announcement → marks read at. If requires ack, an
    **Acknowledge** button appears — click it to set acknowledged at.

    ### Commenting

    Public discussion thread per announcement. Anyone with view access
    can comment (announcement comments).

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Anyone authenticated | ✅ inbox (own recipient rows) | ✗ | ✗ | ✗ |
    | Authors (per the role config) | ✅ all | ✅ | ✅ (own) | ✅ (own) |
    | Administrator | ✅ all | ✅ | ✅ | ✅ |

    The "anyone can read" privilege is **scoped to their recipient
    rows** — you can't peek at other people's announcements. The
    [global search](../reference/index.md) honours this too.

    ### Targeted audiences

    | audience_type | audience_payload |
    |---|---|
    | `all` | (none) — every active user gets a recipient row |
    | Roles | The roles you chose to send it to |
    | People | Any individuals you picked as well |

=== "Auditor's view"

    ### Required-acknowledgement compliance

    Anyone with `pending > 0` for a still-active announcement is yet to
    sign.

    ### Read rate per audience

---
