import { useData } from '../../hooks/useData';
import { LoadingSpinner, ErrorAlert } from '../../components/shared';
import { getCRMDashboard } from '../../api/client';
import { fmtCurr, isOverdue, DEAL_STAGE_BADGE, ACT_ICON, PIPELINE_STAGES } from './constants';

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashboardTab({ t }) {
  const { data, loading, error, reload } = useData(getCRMDashboard);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={reload} />;
  if (!data)   return null;

  const stageMap = Object.fromEntries((data.pipeline_by_stage || []).map(r => [r.stage, r]));
  const stageAccent = { Qualification: 'var(--blue)', Proposal: 'var(--accent)', Negotiation: 'var(--orange)', Won: 'var(--green)', Lost: 'var(--red)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="stat-card" style={{ '--card-accent': 'var(--blue)' }}>
          <div className="stat-label">{t('crm.openLeads')}</div>
          <div className="stat-value" style={{ color: 'var(--blue)' }}>{data.open_leads}</div>
          <div className="stat-sub">{t('crm.totalLeads')}: {data.total_leads}</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--accent)' }}>
          <div className="stat-label">{t('crm.pipelineValue')}</div>
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{fmtCurr(data.pipeline_value)}</div>
          <div className="stat-sub">{data.open_deals} {t('crm.openDeals').toLowerCase()}</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--green)' }}>
          <div className="stat-label">{t('crm.wonDeals')}</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>{fmtCurr(data.won_deals_value)}</div>
          <div className="stat-sub">{t('crm.conversionRate')}: {data.conversion_rate}%</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': data.overdue_activities > 0 ? 'var(--red)' : 'var(--green)' }}>
          <div className="stat-label">{t('crm.overdueActivities')}</div>
          <div className="stat-value" style={{ color: data.overdue_activities > 0 ? 'var(--red)' : 'var(--text)' }}>{data.overdue_activities}</div>
          <div className="stat-sub">{t('crm.activitiesToday')}: {data.activities_today}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Pipeline by stage */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontWeight: 700, fontSize: 13 }}>{t('crm.pipelineByStage')}</span>
          </div>
          <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {PIPELINE_STAGES.map(stage => {
              const s = stageMap[stage];
              return (
                <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`badge badge-${DEAL_STAGE_BADGE[stage]}`}>{stage}</span>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-3)' }}>
                    {s ? `${s.count} deal${s.count !== 1 ? 's' : ''}` : '—'}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: s ? stageAccent[stage] : 'var(--text-3)' }}>
                    {s ? fmtCurr(s.total_value) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent activities */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontWeight: 700, fontSize: 13 }}>{t('crm.recentActivities')}</span>
          </div>
          <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!data.recent_activities.length && (
              <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>{t('crm.noActivities')}</p>
            )}
            {data.recent_activities.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>{ACT_ICON[a.type] || '📌'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.subject}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.client_name || a.lead_name || '—'}</div>
                </div>
                {a.done_at && <span className="badge badge-green" style={{ fontSize: 10 }}>✓</span>}
                {!a.done_at && a.due_date && isOverdue(a.due_date) && <span className="badge badge-red" style={{ fontSize: 10 }}>Late</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { DashboardTab };
