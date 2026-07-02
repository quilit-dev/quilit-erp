export const WAREHOUSE_TYPES = ['Main', 'Branch', 'Production', 'Damaged', 'Transit', 'Returns'];
export const TYPE_COLOR = {
  Main:       'var(--blue)',
  Branch:     'var(--accent)',
  Production: 'var(--purple)',
  Damaged:    'var(--red)',
  Transit:    'var(--yellow)',
  Returns:    'var(--text-3)',
};

export const STATUS_BADGE = {
  Draft:       'badge-yellow',
  'In Transit':'badge-blue',
  Completed:   'badge-green',
  Cancelled:   'badge-red',
};

// Backend statuses are bare English strings — map them through the locale so
// Arabic users see translated labels. Falls back to the raw value if a
// status without a translation slips through (defensive).
export function statusLabel(t, raw) {
  const key = {
    'Draft':      'statusDraft',
    'In Transit': 'statusInTransit',
    'Completed':  'statusCompleted',
    'Cancelled':  'statusCancelled',
  }[raw];
  return key ? t(`warehouses.${key}`) : raw;
}
