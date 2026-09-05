// Priority styling + small display atoms shared across the page.

//
// Each priority maps to a single accent colour used everywhere it appears —
// the row-card left rail, the priority chip, and the detail-modal header.
// Keeping these in one place keeps the visual language tight.

export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

export const PRIORITY_STYLE = {
  low:      { color: 'var(--text-2)', bg: 'rgba(100,116,139,.10)', label: 'Low' },
  medium:   { color: 'var(--info-ink)', bg: 'rgba(37,99,235,.10)',   label: 'Medium' },
  high:     { color: '#ea580c', bg: 'rgba(234,88,12,.10)',   label: 'High' },
  critical: { color: 'var(--negate)', bg: 'rgba(220,38,38,.10)',   label: 'Critical' },
};


// ── Small presentational helpers ───────────────────────────────────────────

export function PriorityChip({ priority, t }) {
  const s = PRIORITY_STYLE[priority] || PRIORITY_STYLE.medium;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 9px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '.3px',
      textTransform: 'uppercase',
      background: s.bg, color: s.color,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 50, background: s.color }} />
      {t(`announcements.priority_${priority}`) || s.label}
    </span>
  );
}


export function StatPill({ label, value, color = 'var(--text)' }) {
  return (
    <div className="stat-card" style={{ padding: '12px 14px', minWidth: 0 }}>
      <div className="stat-label">{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 800, color, letterSpacing: '-0.4px',
        marginTop: 2, fontFeatureSettings: '"tnum"',
      }}>{value ?? 0}</div>
    </div>
  );
}

