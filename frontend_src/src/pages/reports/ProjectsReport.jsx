import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LoadingSpinner, ErrorAlert, Badge, fmt } from '../../components/shared';
import { getReportProjects } from '../../api/client';
import { StatCard, ExportButtons } from './charts';

function ProjectsReport({ params, t }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportProjects({ ...params, ...(statusFilter ? { status: statusFilter } : {}) }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), statusFilter]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;

  const profitable = data.filter(p => p.profit > 0).length;
  const atLoss     = data.filter(p => p.profit < 0).length;
  const totalRev   = data.reduce((s, p) => s + (p.expected_revenue || 0), 0);
  const totalExp   = data.reduce((s, p) => s + (p.actual_expenses || 0), 0);

  const STATUSES = ['', 'Inquiry', 'Quotation Sent', 'Approved', 'In Progress', 'Completed', 'Invoiced'];

  const projectCols = [
    { label: 'Project',          value: r => r.name,                  align: 'left'  },
    { label: 'Client',           value: r => r.client_name || '',     align: 'left'  },
    { label: 'Status',           value: r => r.status,                align: 'left'  },
    { label: 'Expected Revenue', value: r => r.expected_revenue || 0, align: 'right' },
    { label: 'Estimated Cost',   value: r => r.estimated_cost || 0,   align: 'right' },
    { label: 'Actual Expenses',  value: r => r.actual_expenses || 0,  align: 'right' },
    { label: 'Collected',        value: r => r.collected || 0,        align: 'right' },
    { label: 'Profit',           value: r => r.profit || 0,           align: 'right' },
    { label: 'Margin %',         value: r => r.margin_pct || 0,       align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('common.total')}          value={data.length}       sub={t('nav.projects')} />
        <StatCard label={t('reports.profitableLabel')} value={profitable}      color="green" />
        <StatCard label={t('reports.lossLabel')}     value={atLoss}            color={atLoss > 0 ? 'red' : undefined} />
        <StatCard label={t('reports.expectedRevenue')} value={fmt(totalRev)}   color="green" />
        <StatCard label={t('reports.actualExpenses')} value={fmt(totalExp)}    color="red" />
        <StatCard label={t('reports.projectProfit')} value={fmt(totalRev - totalExp)} color={totalRev - totalExp >= 0 ? 'green' : 'red'} />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.projects')}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="form-control" style={{ width: 160, fontSize: 12 }}
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              {STATUSES.map(s => (
                <option key={s} value={s}>{s || t('reports.allStatuses')}</option>
              ))}
            </select>
            <ExportButtons
              rows={data} columns={projectCols}
              baseName="project_profitability" pdfTitle={t('reports.projectProfit') || 'Project Profitability'} t={t} />
          </div>
        </div>
        {data.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noProjects')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.projectName')}</th>
                    <th>{t('reports.client')}</th>
                    <th>{t('reports.status')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.expectedRevenue')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.actualExpenses')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.collected')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.projectProfit')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.margin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(p => (
                    <tr key={p.id}>
                      <td className="td-primary">
                        <Link to={`/projects/${p.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{p.name}</Link>
                      </td>
                      <td>{p.client_name || '—'}</td>
                      <td><Badge status={p.status} /></td>
                      <td style={{ textAlign: 'right' }}>{fmt(p.expected_revenue)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(p.actual_expenses)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }}>{fmt(p.collected)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: p.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {p.profit >= 0 ? '+' : ''}{fmt(p.profit)}
                      </td>
                      <td style={{ textAlign: 'right', color: p.margin_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {p.margin_pct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Client Revenue Panel ───────────────────────────────────────────────────

export { ProjectsReport };
