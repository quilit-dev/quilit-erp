// A customer's statement of account.
//
// One chronological run of what they were charged and what they paid, with a
// running balance — the document a customer asks for when they want to know
// why they owe what they owe, and the one an accountant reconciles against.
//
// The opening balance carries in everything before the start date, so a period
// can be looked at on its own without the numbers stopping making sense. The
// server computes all of it; this screen only asks for a window and draws it.
import { Fragment, useState, useEffect } from 'react';
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
  // What each invoice was for. `details` opens every invoice (and puts the
  // items in the PDF and the spreadsheet); a click opens just one.
  const [details, setDetails] = useState(false);
  const [openRows, setOpenRows] = useState(() => new Set());
  const toggleRow = (key) => setOpenRows(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

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
  const qtyOf = v => String(+Number(v || 0).toFixed(3));
  // With details on, each invoice is followed by one row per item, so the
  // exported statement shows what was bought under every charge. Item rows
  // carry their figures in the description and leave the money columns empty:
  // the charged, paid and balance columns stay what they were, and still add up.
  const exportRows = details
    ? movements.flatMap(m => [m, ...((m.type === 'invoice' && m.lines) || []).map(l => ({
        date: null, reference: '', charged: null, paid: null, balance: null, __item: true,
        description: `    • ${l.name} — ${qtyOf(l.quantity)}${l.unit ? ` ${l.unit}` : ''} × ${fmt(l.unit_price)}`
          + (l.discount > 0 ? ` − ${fmt(l.discount)}` : '')
          + ` = ${fmt(l.net)}` + (l.tax > 0 ? ` (+ ${t('clients.vat')} ${fmt(l.tax)})` : ''),
      }))])
    : movements;
  // An item row fills only the description (column 2); the rest stay blank.
  const exportColumns = columns.map((c, idx) => ({
    ...c, value: r => (r.__item ? (idx === 2 ? r.description : '') : c.value(r)),
  }));

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
          {/* The PDF carries what the tiles above show --- the period and the
              two balances --- so a statement handed to a customer answers the
              question it was asked for without the screen beside it. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                          cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={details}
              onChange={e => setDetails(e.target.checked)} />
            {t('clients.showInvoiceDetails')}
          </label>
          <ExportButtons
            rows={exportRows} columns={exportColumns}
            baseName={`statement_${data.client?.name || clientId}${details ? '_detailed' : ''}`}
            pdfTitle={t('clients.statementFor', { name: data.client?.name || '' })}
            pdfClient={data.client}
            subtitle={(from || to)
              ? `${from ? fmtDate(from) : '…'} – ${to ? fmtDate(to) : '…'}`
              : ''}
            meta={{
              [t('clients.openingBalance')]: fmt(data.opening_balance || 0),
              [t('clients.closingBalance')]: fmt(data.closing_balance || 0),
            }}
            totals={{
              label: t('common.total'),
              columns: [null, null, null, data.total_charged || 0, data.total_paid || 0,
                        data.closing_balance || 0],
            }}
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
              {movements.map((m, i) => {
                const key = `${m.type}-${m.invoice_id}-${i}`;
                const lines = (m.type === 'invoice' && m.lines) || [];
                const open = lines.length > 0 && (details || openRows.has(key));
                return (
                <Fragment key={key}>
                <tr onClick={lines.length ? () => toggleRow(key) : undefined}
                    style={lines.length ? { cursor: 'pointer' } : undefined}
                    aria-expanded={lines.length ? open : undefined}
                    title={lines.length ? t('clients.clickForItems') : undefined}>
                  <td>{fmtDate(m.date)}</td>
                  <td className="td-primary">
                    {lines.length > 0 && <span style={{ color: 'var(--text-3)', marginInlineEnd: 4 }}>{open ? '▾' : '▸'}</span>}
                    {m.reference || '—'}
                  </td>
                  <td>{m.description}</td>
                  <td style={{ textAlign: 'right' }}>
                    {m.charged ? fmt(m.charged) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--green)' }}>
                    {m.paid ? fmt(m.paid) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(m.balance || 0)}</td>
                </tr>
                {open && (
                  <tr>
                    <td></td>
                    <td colSpan={5} style={{ background: 'var(--surface-2)', padding: '8px 12px' }}>
                      <table style={{ fontSize: 12, background: 'var(--surface)' }}>
                        <thead>
                          <tr>
                            <th>{t('clients.item')}</th>
                            <th style={{ textAlign: 'right' }}>{t('clients.qty')}</th>
                            <th style={{ textAlign: 'right' }}>{t('clients.unitPrice')}</th>
                            <th style={{ textAlign: 'right' }}>{t('clients.discount')}</th>
                            <th style={{ textAlign: 'right' }}>{t('clients.amount')}</th>
                            <th style={{ textAlign: 'right' }}>{t('clients.vat')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l, j) => (
                            <tr key={j}>
                              <td>{l.name}</td>
                              <td style={{ textAlign: 'right' }}>{qtyOf(l.quantity)}{l.unit ? ` ${l.unit}` : ''}</td>
                              <td style={{ textAlign: 'right' }}>{fmt(l.unit_price)}</td>
                              <td style={{ textAlign: 'right' }}>{l.discount > 0 ? fmt(l.discount) : '—'}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(l.net)}</td>
                              <td style={{ textAlign: 'right' }}>{l.tax > 0 ? fmt(l.tax) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
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
