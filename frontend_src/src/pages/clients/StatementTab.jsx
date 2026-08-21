// A customer's statement of account.
//
// One chronological run of what they were charged and what they paid, with a
// running balance — the document a customer asks for when they want to know
// why they owe what they owe, and the one an accountant reconciles against.
//
// The opening balance carries in everything before the start date, so a period
// can be looked at on its own without the numbers stopping making sense. The
// server computes all of it; this screen only asks for a window and draws it.
import { useState, useEffect } from 'react';
import { getClientStatement } from '../../api/client';
import { LoadingSpinner, ErrorAlert, EmptyState, fmt, fmtDate } from '../../components/shared';
import { ExportButtons } from '../reports/charts';
import { useLocale } from '../../hooks/useLocale.jsx';

export default function StatementTab({ clientId }) {
  const { t } = useLocale();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getClientStatement(clientId, {
      ...(from ? { start: from } : {}),
      ...(to ? { end: to } : {}),
    })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [clientId, from, to]);

  // The same columns the table draws, so the PDF and the spreadsheet say
  // exactly what the screen says.
  const columns = [
    { label: t('clients.movementDate'), value: r => fmtDate(r.date), align: 'left' },
    { label: t('reports.invoiceNumber'), value: r => r.reference || '', align: 'left' },
    { label: t('common.description'), value: r => r.description || '', align: 'left' },
    { label: t('clients.charged'), value: r => r.charged || 0, align: 'right' },
    { label: t('clients.paid'), value: r => r.paid || 0, align: 'right' },
    { label: t('accounting.balance'), value: r => r.balance || 0, align: 'right' },
  ];

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return null;

  const movements = data.movements || [];

  return (
    <div className="card">
      <div className="card-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div className="search-bar" style={{ margin: 0, flexWrap: 'wrap' }}>
          <span className="card-title" style={{ marginInlineEnd: 'auto' }}>
            {t('clients.statement')}
          </span>
          {/* Explicit widths: .form-control is width:100%, so a control dropped
              into a flex row with nothing constraining it takes the whole line. */}
          <input type="date" className="form-control" style={{ width: 150 }}
            value={from} onChange={e => setFrom(e.target.value)}
            aria-label={t('service.dateFrom')} title={t('service.dateFrom')} />
          <input type="date" className="form-control" style={{ width: 150 }}
            value={to} onChange={e => setTo(e.target.value)}
            aria-label={t('service.dateTo')} title={t('service.dateTo')} />
          {(from || to) && (
            <button type="button" className="btn btn-secondary btn-sm"
              style={{ whiteSpace: 'nowrap' }}
              onClick={() => { setFrom(''); setTo(''); }}>
              ✕ {t('common.clear')}
            </button>
          )}
          <ExportButtons
            rows={movements} columns={columns}
            baseName={`statement_${data.client?.name || clientId}`}
            pdfTitle={t('clients.statementFor', { name: data.client?.name || '' })}
            t={t} />
        </div>
      </div>

      <div className="stats-grid" style={{ padding: '14px 18px 0' }}>
        <StatTile label={t('clients.openingBalance')} value={fmt(data.opening_balance || 0)} />
        <StatTile label={t('clients.charged')} value={fmt(data.total_charged || 0)} />
        <StatTile label={t('clients.paid')} value={fmt(data.total_paid || 0)} color="green" />
        <StatTile label={t('clients.closingBalance')} value={fmt(data.closing_balance || 0)}
          color={(data.closing_balance || 0) > 0 ? 'red' : undefined} />
      </div>

      {movements.length === 0 ? (
        <EmptyState message={t('clients.noMovements')} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('clients.movementDate')}</th>
                <th>{t('reports.invoiceNumber')}</th>
                <th>{t('common.description')}</th>
                <th style={{ textAlign: 'right' }}>{t('clients.charged')}</th>
                <th style={{ textAlign: 'right' }}>{t('clients.paid')}</th>
                <th style={{ textAlign: 'right' }}>{t('accounting.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m, i) => (
                <tr key={`${m.type}-${m.invoice_id}-${i}`}>
                  <td>{fmtDate(m.date)}</td>
                  <td className="td-primary">{m.reference || '—'}</td>
                  <td>{m.description}</td>
                  <td style={{ textAlign: 'right' }}>
                    {m.charged ? fmt(m.charged) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--green)' }}>
                    {m.paid ? fmt(m.paid) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(m.balance || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color: `var(--${color})` } : {}}>{value}</div>
    </div>
  );
}
