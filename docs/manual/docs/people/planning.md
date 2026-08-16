# Planning

A visual plan of the work: a timeline, tasks, milestones and calendar
events. Projects tracks the money; Planning tracks the schedule.

## Purpose

Where the [Projects](../sales/projects.md) module (Sales chapter) is the
**commercial** project — budget, materials, invoicing — the Planning module
is the **operational** project: who does what when. Gantt board, task
ownership, milestone tracking, and calendar events for everyone.

They share milestones; everything else is separate.

## Personas

| Persona | What they do here |
|---|---|
| **Project Manager** | Plans tasks, assigns ownership, tracks progress |
| **Assignee** | Marks tasks Done, comments on progress |
| **Manager** | Sees team workload at a glance |
| **Anyone** | Reads / creates calendar events |

## Quick reference

- **Planning project** — separate from projects (sales-side); same client linkage
- **Task status**: `To Do`, `In Progress`, `Done`
- **Task priority**: `Low`, `Normal`, `High`, `Urgent`
- **Milestone**: name + due date + optional reached at
- **Event**: a title, a start, an optional end or all-day flag, and who is attending
- **Dependencies**: a task can wait on one or more other tasks

---

=== "Operator's view"

    ### Planning a project

    Planning → **+ New planning project**.

    | Field | Notes |
    |---|---|
    | Name | |
    | Description | |
    | Client | Optional — which client |
    | Color | Used in Gantt + calendar |
    | Start, End | |
    | Status | Active by default |

    Save. Now add tasks and milestones.

    ### Adding tasks

    Project detail → **Tasks** tab → **+ Add task**.

    | Field | Notes |
    |---|---|
    | Name | |
    | Description | |
    | Assigned to | Who is doing it |
    | Start, End | Drives Gantt position |
    | Status | To Do / In Progress / Done |
    | Priority | Low / Normal / High / Urgent |
    | Progress | 0-100% |
    | Milestone | Optional — which milestone |
    | Depends on | Tasks that must finish first — the timeline draws arrows between them |
    | Color | Inherits project unless overridden |

    ### Marking progress

    Click a task → drag the progress slider, or change status. Done = 100%
    auto.

    ### Milestones

    Project detail → **Milestones** tab → **+ Add milestone** with a due
    date. When reached, the operator clicks **Mark reached** to set
    reached at.

    Upcoming milestones surface on the Dashboard's "Upcoming milestones"
    KPI tile.

    ### Calendar events

    Planning → **Calendar** tab. Add events for the team.

    | Field | Notes |
    |---|---|
    | Title | |
    | Description | |
    | Start date, End date | |
    | Start time, End time | Optional |
    | All day | Toggle |
    | Color | |
    | Attendees | The people invited |

    Events show on the dashboard's "Upcoming Agenda" panel for everyone.

=== "Administrator's view"

    ### Permissions

    | Role | view | create | edit | delete |
    |---|---|---|---|---|
    | Project Manager | ✅ | ✅ | ✅ | ✅ |
    | Operations Manager | ✅ | ✅ | ✅ | ✗ |
    | Sales | ✅ | ✗ | ✗ | ✗ |
    | Anyone with `planning` view | ✅ | ✗ | ✗ | ✗ |

    ### Calendar events visibility

    Events are visible to everyone with `planning` view permission. To
    restrict, an attendees-only event filter would need a vendor extension.

=== "Auditor's view"

    Planning is operational; not typically part of a financial audit. For
    HR reporting, useful queries.

---
