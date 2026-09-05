import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, Badge, fmt } from '../../components/shared';
import { getReportPipeline } from '../../api/client';
import { StatCard, HBarChart, VBarChart, ExportButtons, fmtCountAbbr, CHART_COLORS } from './charts';

function PipelineReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportPipeline(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const STATUS_COLORS = {
    Draft: 'var(--text-3)', Sent: '#2E86C1', Accepted: '#27AE60',
    Rejected: '#C0392B', Invoiced: '#8E44AD',
  };

  const pipelineCols = [
    { label: 'Status', value: r => r.status, align: 'left'  },
    { label: 'Count',  value: r => r.count,  align: 'right' },
    { label: 'Value',  value: r => r.value,  align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalQuotes')}     value={data.total_count}         />
        <StatCard label={t('reports.totalQuoteValue')} value={fmt(data.total_value)}    color="green" />
        <StatCard label={t('reports.convertedQuotes')} value={data.converted_count}     color="green" />
        <StatCard label={t('reports.conversionRate')}  value={`${data.conversion_rate}%`}
          color={data.conversion_rate >= 50 ? 'green' : data.conversion_rate >= 25 ? undefined : 'red'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.byStatusCount')}</span>
            <ExportButtons
              rows={data.by_status} columns={pipelineCols}
              baseName="sales_pipeline" pdfTitle={t('reports.pipeline') || 'Sales Pipeline'} t={t} />
          </div>
          <div className="card-body">
            {data.by_status.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noPipeline')}</div>
              : <HBarChart data={data.by_status} labelKey="status" valueKey="count"
                  formatValue={fmtCountAbbr}
                  colorFn={(i, d) => STATUS_COLORS[d.status] || CHART_COLORS[i % CHART_COLORS.length]} />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.monthlyVolume')}</span></div>
          <div className="card-body">
            {data.monthly.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noPipeline')}</div>
              : <VBarChart data={data.monthly} labelKey="month" valueKey="count" color="#2E86C1" />
            }
          </div>
        </div>
      </div>

      {data.by_status.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 16 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">{t('reports.byStatus')} — Value</span></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.status')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.count')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.value')}</th>
                    <th style={{ textAlign: 'right' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_status.map(row => (
                    <tr key={row.status}>
                      <td><Badge status={row.status} /></td>
                      <td style={{ textAlign: 'right' }}>{row.count}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(row.value)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {data.total_count > 0 ? Math.round(row.count / data.total_count * 100) : 0}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {data.top_clients.length > 0 && (
            <div className="card">
              <div className="card-header"><span className="card-title">{t('reports.topClients')}</span></div>
              <div className="card-body">
                <HBarChart data={data.top_clients} labelKey="client_name" valueKey="value" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN REPORTS PAGE
// ═══════════════════════════════════════════════════════════════════════════
// ── Branch comparison (multi-branch) ────────────────────────────────────────
// Super Admin's side-by-side P&L per branch for the selected range. Reuses the
// standard date range. Only mounted when the user can reach >1 branch.

export { PipelineReport };
