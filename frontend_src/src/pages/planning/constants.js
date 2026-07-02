// Shared Planning reference values, badge/colour maps, enum + date helpers.
// Extracted so the orchestrator, views, forms and panels share them without
// duplication or a circular import.

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
export const PROJ_STATUSES = ['Active', 'On Hold', 'Completed', 'Cancelled'];

export const STATUS_BADGE = {
  'To Do':       'blue',
  'In Progress': 'yellow',
  'Review':      'purple',
  'Done':        'green',
  'Blocked':     'red',
};
export const PRIORITY_BADGE = {
  Low:      'blue',
  Medium:   'yellow',
  High:     'orange',
  Critical: 'red',
};
export const PROJECT_COLORS = [
  '#4f8ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];

// Maps for translating the English values stored in DB / used as keys
export const STATUS_KEY = {
  'To Do':       'planning.statusTodo',
  'In Progress': 'planning.statusInProgress',
  'Review':      'planning.statusReview',
  'Done':        'planning.statusDone',
  'Blocked':     'planning.statusBlocked',
};
export const PRIORITY_KEY = {
  Low:      'planning.priorityLow',
  Medium:   'planning.priorityMedium',
  High:     'planning.priorityHigh',
  Critical: 'planning.priorityCritical',
};
export const PROJ_STATUS_KEY = {
  Active:      'planning.projectActive',
  'On Hold':   'planning.projectOnHold',
  Completed:   'planning.projectCompleted',
  Cancelled:   'planning.projectCancelled',
};

// Translate an enum value, falling back to the raw value if it has no key
export function tEnum(t, map, val) {
  return map[val] ? t(map[val]) : (val ?? '');
}

// Gantt constants
export const DAY_W  = 30;   // px per day
export const ROW_H  = 40;   // px per row
export const LEFT_W = 230;  // px for sticky left column

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function toDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? null : d;
}
export function toIso(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}
export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
export function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
export function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export const EVENT_COLORS = [
  '#4f8ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];
