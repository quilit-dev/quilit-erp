import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportClients } from '../../api/client';
import { StatCard, HBarChart, ExportButtons } from './charts';

function ClientsReport({ params, t }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportClients(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;

  const activeClients = data.filter(c => c.total_paid > 0);
  const totalPaid     = data.reduce((s, c) => s + (c.total_paid || 0), 0);
  const totalOutstanding = data.reduce((s, c) => s + (c.outstanding || 0), 0);
  const top10 = data.slice(0, 10);

  const clientCols = [
    { label: 'Client',         value: r => r.name,             align: 'left'  },
    { label: 'Company',        value: r => r.company || '',    align: 'left'  },
    { label: 'Type',           value: r => r.type || '',       align: 'left'  },
    { label: 'Projects',       value: r => r.project_count,    align: 'right' },
    { label: 'Invoices',       value: r => r.invoice_count,    align: 'right' },
    { label: 'Quotes',         value: r => r.quote_count,      align: 'right' },
    { label: 'Total Invoiced', value: r => r.total_invoiced,   align: 'right' },
    { label: 'Total Paid',     value: r => r.total_paid,       align: 'right' },
    { label: 'Outstanding',    value: r => r.outstanding,      align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('nav.clients')}           value={data.length}           sub={t('common.total')} />
        <StatCard label="Active Clients"             value={activeClients.length}  color="green" />
        <StatCard label={t('reports.totalPaid')}     value={fmt(totalPaid)}        color="green" />
        <StatCard label={t('reports.outstanding')}   value={fmt(totalOutstanding)} color={totalOutstanding > 0 ? 'red' : undefined} />
      </div>

      {top10.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">{t('reports.topByRevenue')}</span></div>
          <div className="card-body">
            <HBarChart data={top10} labelKey="name" valueKey="total_paid" />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.clients')}</span>
          <ExportButtons
            rows={data} columns={clientCols}
            baseName="client_revenue" pdfTitle={t('reports.clientRevenue') || 'Client Revenue'} t={t} />
        </div>
        {data.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noClients')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.clientName')}</th>
                    <th>{t('reports.company')}</th>
                    <th>{t('reports.type')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.projectCount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.invoiceCount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('clients.totalInvoiced')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.totalPaid')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.outstanding')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(c => (
                    <tr key={c.id}>
                      <td className="td-primary">
                        <Link to={`/clients/${c.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{c.name}</Link>
                      </td>
                      <td>{c.company || '—'}</td>
                      <td><span className="badge badge-gray">{c.type || '—'}</span></td>
                      <td style={{ textAlign: 'right' }}>{c.project_count}</td>
                      <td style={{ textAlign: 'right' }}>{c.invoice_count}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(c.total_invoiced)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(c.total_paid)}</td>
                      <td style={{ textAlign: 'right', color: c.outstanding > 0 ? 'var(--red)' : 'var(--text-3)' }}>{fmt(c.outstanding)}</td>
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

// ── Invoice Aging Panel ────────────────────────────────────────────────────

export { ClientsReport };
