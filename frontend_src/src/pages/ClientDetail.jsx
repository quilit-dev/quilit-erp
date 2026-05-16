import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getClient, getDocumentContent } from '../api/client';
import {
  LoadingSpinner, ErrorAlert, Badge, fmt, fmtDate, toast,
} from '../components/shared';
import { useLocale } from '../hooks/useLocale.jsx';

function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color: `var(--${color})` } : {}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SectionTable({ columns, rows, emptyMsg }) {
  const { t } = useLocale();
  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        {emptyMsg || t('clients.noRecordsFound')}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c.key} className={c.primary ? 'td-primary' : ''}>
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ClientDetail() {
  const { t } = useLocale();
  const { id }    = useParams();
  const navigate  = useNavigate();
  const [client,    setClient]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [tab,       setTab]       = useState('overview');

  const TABS = [
    { key: 'overview',   label: t('clients.overview') },
    { key: 'projects',   label: t('nav.projects') },
    { key: 'quotations', label: t('nav.quotations') },
    { key: 'invoices',   label: t('nav.invoices') },
  ];

  useEffect(() => {
    setLoading(true);
    getClient(id)
      .then(setClient)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (tab === 'quotations' || tab === 'invoices') {
      getClient(id).then(setClient).catch(() => {});
    }
  }, [tab, id]);

  async function openDocument(docId) {
    try {
      const doc = await getDocumentContent(docId);
      const w = window.open('', '_blank');
      w.document.write(doc.html_content);
      w.document.close();
    } catch (e) { toast(e.message, 'red'); }
  }

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} onRetry={() => { setError(null); setLoading(true); getClient(id).then(setClient).catch(e => setError(e.message)).finally(() => setLoading(false)); }} />;
  if (!client) return null;

  const { stats } = client;

  const quotDocMap = Object.fromEntries(
    (client.documents || []).filter(d => d.record_type === 'quotation').map(d => [d.record_id, d])
  );
  const invDocMap = Object.fromEntries(
    (client.documents || []).filter(d => d.record_type === 'invoice').map(d => [d.record_id, d])
  );

  return (
    <div>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => navigate('/clients')}
        style={{ marginBottom: 12 }}
      >
        {t('clients.backToClients')}
      </button>

      <div className="page-header">
        <div>
          <h1 className="page-title">{client.name}</h1>
          <p className="page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {client.company && <span>🏢 {client.company}</span>}
            <span className="badge badge-gray">{client.type}</span>
            {client.email && <span>✉ {client.email}</span>}
            {client.phone && <span>📞 {client.phone}</span>}
          </p>
        </div>
      </div>

      {/* KPI row */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <StatCard label={t('nav.projects')}        value={stats.project_count}        sub={t('common.total')} />
        <StatCard label={t('nav.quotations')}      value={stats.quotation_count}      sub={t('clients.totalQuoted', { amount: fmt(stats.total_quoted) })} />
        <StatCard label={t('clients.totalInvoiced')} value={fmt(stats.total_invoiced)} />
        <StatCard label={t('clients.totalPaid')}   value={fmt(stats.total_paid)}      color="green" />
        <StatCard label={t('clients.outstanding')} value={fmt(stats.outstanding)}     color={stats.outstanding > 0 ? 'red' : undefined} />
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(tb => (
          <button key={tb.key} className={`tab-btn${tab === tb.key ? ' active' : ''}`} onClick={() => setTab(tb.key)}>
            {tb.label}
            {tb.key === 'projects'   && client.projects.length   > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{client.projects.length}</span>}
            {tb.key === 'quotations' && client.quotations.length > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{client.quotations.length}</span>}
            {tb.key === 'invoices'   && client.invoices.length   > 0 && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{client.invoices.length}</span>}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">{t('clients.contactInfo')}</span></div>
            <div className="card-body">
              {[
                [t('clients.name'),    client.name],
                [t('clients.company'), client.company],
                [t('clients.type'),    client.type],
                [t('clients.email'),   client.email],
                [t('clients.phone'),   client.phone],
                [t('clients.address'), client.address],
                [t('clients.since'),   fmtDate(client.created_at)],
              ].filter(([, v]) => v).map(([label, val]) => (
                <div key={label} style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 13 }}>
                  <span style={{ minWidth: 80, color: 'var(--text-3)', fontWeight: 500 }}>{label}</span>
                  <span style={{ color: 'var(--text)' }}>{val}</span>
                </div>
              ))}
              {client.notes && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 6, fontSize: 13, color: 'var(--text-2)' }}>
                  {client.notes}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">{t('clients.recentActivity')}</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              {[
                ...client.invoices.slice(0, 3).map(i => ({ date: i.created_at, label: t('clients.invoiceLabel', { number: i.invoice_number }), value: fmt(i.amount), color: 'blue' })),
                ...client.quotations.slice(0, 3).map(q => ({ date: q.created_at, label: t('clients.quotationLabel', { number: q.quote_number }), value: fmt(q.total), color: 'accent' })),
              ]
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 6)
                .map((item, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{item.label}</div>
                      <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{fmtDate(item.date)}</div>
                    </div>
                    <span style={{ color: `var(--${item.color})`, fontWeight: 600 }}>{item.value}</span>
                  </div>
                ))
              }
              {client.invoices.length === 0 && client.quotations.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('clients.noActivity')}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Projects */}
      {tab === 'projects' && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('clients.projectsCount', { count: client.projects.length })}</span></div>
          <SectionTable
            emptyMsg={t('clients.noProjectsForClient')}
            columns={[
              { key: 'name',           label: t('projects.name'),      primary: true, render: p => <Link to={`/projects/${p.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{p.name}</Link> },
              { key: 'status',         label: t('projects.status'),    render: p => <Badge status={p.status} /> },
              { key: 'location',       label: t('projects.location'),  render: p => p.location || '—' },
              { key: 'estimated_cost', label: t('clients.estimated'),  render: p => fmt(p.estimated_cost) },
              { key: 'actual_cost',    label: t('clients.actual'),     render: p => fmt(p.actual_cost) },
              { key: 'start_date',     label: t('clients.start'),      render: p => fmtDate(p.start_date) },
              { key: 'end_date',       label: t('clients.end'),        render: p => fmtDate(p.end_date) },
            ]}
            rows={client.projects}
          />
        </div>
      )}

      {/* Quotations */}
      {tab === 'quotations' && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('clients.quotationsCount', { count: client.quotations.length })}</span></div>
          <SectionTable
            emptyMsg={t('clients.noQuotationsForClient')}
            columns={[
              { key: 'quote_number', label: '#',                      primary: true },
              { key: 'status',       label: t('common.status'),       render: q => <Badge status={q.status} /> },
              { key: 'project_name', label: t('quotations.project'),  render: q => q.project_name || '—' },
              { key: 'total',        label: t('quotations.total'),    render: q => fmt(q.total) },
              { key: 'created_at',   label: t('common.date'),         render: q => fmtDate(q.created_at) },
              { key: 'pdf',          label: '',                        render: q => quotDocMap[q.id]
                  ? <button className="btn btn-sm btn-secondary" onClick={() => openDocument(quotDocMap[q.id].id)}>View PDF</button>
                  : null },
            ]}
            rows={client.quotations}
          />
        </div>
      )}

      {/* Invoices — paid_amount is now computed by backend via invoice_payments JOIN */}
      {tab === 'invoices' && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('clients.invoicesCount', { count: client.invoices.length })}</span></div>
          <SectionTable
            emptyMsg={t('clients.noInvoicesForClient')}
            columns={[
              { key: 'invoice_number', label: '#',                       primary: true },
              { key: 'status',         label: t('common.status'),        render: i => <Badge status={i.status} /> },
              { key: 'project_name',   label: t('quotations.project'),   render: i => i.project_name || '—' },
              { key: 'amount',         label: t('common.amount'),        render: i => fmt(i.amount) },
              { key: 'paid_amount',    label: t('clients.paid'),         render: i => fmt(i.paid_amount) },
              { key: 'due_date',       label: t('clients.due'),          render: i => fmtDate(i.due_date) },
              { key: 'pdf',            label: '',                         render: i => invDocMap[i.id]
                  ? <button className="btn btn-sm btn-secondary" onClick={() => openDocument(invDocMap[i.id].id)}>View PDF</button>
                  : null },
            ]}
            rows={client.invoices}
          />
        </div>
      )}

    </div>
  );
}
