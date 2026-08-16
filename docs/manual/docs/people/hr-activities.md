# HR Activities

Per-employee personal calendar. Notes, calls, meetings, interviews — with
optional reminders that fire as notifications.

## Purpose

HR Activities answers "what's on my plate today?" for any employee. It's
separate from CRM activities (which are customer-facing) despite the
similar shape.

| Module | Subject | Who reads |
|---|---|---|
| crm activities | Customers, leads, deals | Sales reps |
| HR activities | Internal — own employees, applicants | Anyone with a personal calendar |

## Personas

| Persona | What they do here |
|---|---|
| **Employee** | Logs their own meetings, notes, todos |
| **HR Manager** | Reviews team workload, attaches interviews to applicants |
| **Recruiter** | Schedules interviews; each one creates an HR activities row |
| **Manager** | Reads direct reports' upcoming activities |

## Quick reference

- **Activity types**: `Call`, `Meeting`, `Note`, `Interview`, `Task`
- **Status**: `Planned`, `Done`, `Cancelled`
- **Owner**: `hr_employees.id` of the activity owner (one owner per activity)
- **Linked to**: optional applicant id (recruitment) or employee id (HR target)
- **Reminders**: reminder lead time — fires a notification ahead of scheduled time

---

=== "Operator's view"

    ### Adding an activity

    HR Activities → **+ Add activity** OR from any employee/applicant
    detail page.

    | Field | Notes |
    |---|---|
    | Owner | Defaults to logged-in user's employee record |
    | Type | Call / Meeting / Note / Interview / Task |
    | Subject | One-liner |
    | Description | Long-form |
    | Scheduled at | Date + time |
    | Duration (min) | E.g. 60 |
    | Location | Free text |
    | Reminder | Minutes before to ping; 0 disables |
    | Linked employee | Optional — about another employee |
    | Linked applicant | Optional — interviewing this applicant |

    Save. Lands as **Planned**. Reminder is scheduled if requested.

    ### Marking done

    Open the activity → **Mark done** with optional completed notes.

    ### Reminders

    reminder lead time minutes before scheduled time, the system
    fires a notification of type activity reminder. The
    reminder notif id field links to the spawned notification.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Anyone with HR activities view | ✅ (own) | ✅ | ✅ (own) | ✗ |
    | HR Manager | ✅ all | ✅ | ✅ | ✅ |

    The "own" filter means an employee can only see activities where
    owner id matches their employee id. HR Manager bypasses.

    ### Reminder scheduling

    A background thread checks for activities with scheduled time minus
    reminder lead time ≤ now AND `reminder_notif_id IS NULL`. For
    each, it spawns a notification and records its id back on the
    activity.

=== "Auditor's view"

    Activities are operational — not typically part of a financial audit.
    Cross-reference for HR controls.

---
