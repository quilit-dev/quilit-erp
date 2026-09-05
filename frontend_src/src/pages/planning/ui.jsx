import { useLocale } from '../../hooks/useLocale.jsx';

function Badge({ color, children, style }) {
  return (
    <span className={`badge badge-${color}`} style={style}>{children}</span>
  );
}

function ProgressBar({ value, color, style }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', ...style }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color || 'var(--accent)', borderRadius: 3, transition: 'width .3s' }} />
    </div>
  );
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary }) {
  const { t } = useLocale();
  if (!summary) return null;
  const cards = [
    { label: t('planning.activeProjects'), value: summary.active_projects, accent: 'var(--info)' },
    { label: t('planning.totalTasks'),     value: summary.total_tasks,     accent: '#8b5cf6' },
    { label: t('planning.inProgress'),     value: summary.in_progress,     accent: 'var(--caution)' },
    { label: t('planning.overdueTasks'),   value: summary.overdue_tasks,   accent: 'var(--negate)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} className="stat-card" style={{ '--card-accent': c.accent }}>
          <div className="stat-label">{c.label}</div>
          <div className="stat-value">{c.value ?? 0}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Project Form ─────────────────────────────────────────────────────────────


export { Badge, ProgressBar, SummaryCards };
