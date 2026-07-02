// ─── Helpers ────────────────────────────────────────────────────────────────

export function fmtCurr(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function isOverdue(due) {
  if (!due) return false;
  return new Date(due + 'T00:00:00') < new Date(new Date().toDateString());
}

// ─── Status → badge color maps ───────────────────────────────────────────────

export const LEAD_STATUS_BADGE = {
  New: 'blue', Contacted: 'yellow', Qualified: 'green',
  Proposal: 'accent', Negotiation: 'orange', Won: 'green', Lost: 'red',
};
export const DEAL_STAGE_BADGE = {
  Qualification: 'blue', Proposal: 'accent', Negotiation: 'orange',
  Won: 'green', Lost: 'red',
};
export const ACT_TYPE_BADGE = {
  call: 'blue', email: 'accent', meeting: 'green', task: 'yellow', note: 'gray',
};
export const ACT_ICON = { call: '📞', email: '✉️', meeting: '🤝', task: '✅', note: '📝' };

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

export const PIPELINE_STAGES = ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'];
export const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
export const LEAD_SOURCES  = ['web', 'referral', 'cold_call', 'social', 'other'];
export const ACT_TYPES = ['call', 'email', 'meeting', 'task', 'note'];
export const DEAL_STAGES = ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'];
