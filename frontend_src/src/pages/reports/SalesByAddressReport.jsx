// Sales by address: where the customers who bought in the period are.
//
// A location is the customer's address as typed (case and stray spaces
// ignored — see backend/location_report.py). The biggest places first, each
// opening onto the customers behind its figure; customers with no address and
// till sales with no customer sit at the bottom, so the gap in the picture is
// visible rather than hidden.
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportSalesByAddress } from '../../api/client';
import { StatCard, HBarChart, ExportButtons } from './charts';

function SalesByAddressReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(() => new Set());

  const start = params?.start, end = params?.end;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getReportSalesByAddress({ start, end })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [start, end]);

  if (loading && !data) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const s = data.summary;
  const placeName = g => (g.kind === 'address' ? g.address : t(`reports.sba.${g.kind}`));
  const rows = data.locations.map(g => ({ ...g, place: placeName(g) }));
  const q = search.trim().toLowerCase();
  const shown = q
    ? rows.filter(g => [g.place, ...g.clients.map(c => c.name)]
        .some(v => (v || '').toLowerCase().includes(q)))
    : rows;
  const top = rows.filter(g => g.kind === 'address' && g.sales > 0).slice(0, 10);

  const toggle = key => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const cols = [
    { label: t('reports.sba.address'),     value: g => g.place,       align: 'left'  },
    { label: t('reports.sba.customers'),   value: g => g.customers,   align: 'right' },
    { label: t('reports.invoiceCount'),    value: g => g.invoices,    align: 'right' },
    { label: t('reports.sba.sales'),       value: g => g.sales,       align: 'right' },
    { label: t('reports.sba.gross'),       value: g => g.gross,       align: 'right' },
    { label: t('reports.sba.share'),       value: g => (g.share == null ? '' : `${g.share}%`), align: 'right' },
    { label: t('reports.sba.collected'),   value: g => g.collected,   align: 'right' },
    { label: t('reports.outstanding'),     value: g => g.outstanding, align: 'right' },
  ];
  // The customer-level sheet: every customer under the place they were counted in.
  const clientRows = shown.flatMap(g => g.clients.map(c => ({ ...c, place: g.place })));
  const clientCols = [
    { label: t('reports.sba.address'),   value: r => r.place,        align: 'left'  },
    { label: t('reports.clientName'),    value: r => r.name,         align: 'left'  },
    { label: t('reports.invoiceCount'),  value: r => r.invoices,     align: 'right' },
    { label: t('reports.sba.sales'),     value: r => r.sales,        align: 'right' },
    { label: t('reports.sba.gross'),     value: r => r.gross,        align: 'right' },
    { label: t('reports.sba.collected'), value: r => r.collected,    align: 'right' },
    { label: t('reports.outstanding'),   value: r => r.outstanding,  align: 'right' },
  ];
  const num = { textAlign: 'right' };

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.sba.locations')} value={s.locations}
          sub={t('reports.sba.customersN', { n: s.customers })} />
        <StatCard label={t('reports.sba.sales')} value={fmt(s.sales)}
          sub={t('reports.sba.grossIs', { amount: fmt(s.gross) })} color="green" />
        <StatCard label={t('reports.sba.collected')} value={fmt(s.collected)} />
        <StatCard label={t('reports.outstanding')} value={fmt(s.outstanding)}
          color={s.outstanding > 0.005 ? 'red' : undefined} />
      </div>

      {Math.abs(s.unlocated_sales) > 0.005 && (
        <div className="alert alert-blue" role="note" style={{ marginBottom: 16, fontSize: 13 }}>
          {t('reports.sba.unlocated', { amount: fmt(s.unlocated_sales) })}
        </div>
      )}

      {top.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header chart-header">
            <h2 className="card-title">{t('reports.sba.topPlaces')}</h2>
          </div>
          <div className="card-body">
            <HBarChart data={top} labelKey="place" valueKey="sales" />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="card-title">{t('reports.sba.title')}</span>
          <input className="form-control" type="search" value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('reports.sba.search')} aria-label={t('reports.sba.search')}
            style={{ maxWidth: 260, marginInlineStart: 'auto' }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('reports.sba.exportPlaces')}</span>
            <ExportButtons rows={shown} columns={cols} baseName="sales_by_address"
              pdfTitle={t('reports.sba.title')} subtitle={`${start} – ${end}`} t={t} />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('reports.sba.exportCustomers')}</span>
            <ExportButtons rows={clientRows} columns={clientCols} baseName="sales_by_address_customers"
              pdfTitle={t('reports.sba.title')} subtitle={`${start} – ${end}`} t={t} />
          </span>
        </div>

        {shown.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            {q ? t('reports.sba.noMatch') : t('reports.sba.empty')}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th style={{ minWidth: 200 }}>{t('reports.sba.address')}</th>
                  <th style={num}>{t('reports.sba.customers')}</th>
                  <th style={num}>{t('reports.invoiceCount')}</th>
                  <th style={num}>{t('reports.sba.sales')}</th>
                  <th style={{ minWidth: 120 }}>{t('reports.sba.share')}</th>
                  <th style={num}>{t('reports.sba.collected')}</th>
                  <th style={num}>{t('reports.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(g => {
                  const expanded = open.has(g.key) || (q && g.clients.length > 0
                    && !g.place.toLowerCase().includes(q));
                  return (
                    <Fragment key={g.key}>
                      <tr className="sba-place" onClick={() => g.clients.length && toggle(g.key)}
                          style={{ cursor: g.clients.length ? 'pointer' : 'default' }}>
                        <td>
                          {g.clients.length > 0 && (
                            <button type="button" className="icon-btn" aria-expanded={!!expanded}
                              aria-label={t('reports.sba.showCustomers')}
                              onClick={e => { e.stopPropagation(); toggle(g.key); }}
                              style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
                              ›
                            </button>
                          )}
                        </td>
                        <td className="td-primary"
                            style={g.kind === 'address' ? undefined : { fontStyle: 'italic', color: 'var(--text-2)' }}>
                          {g.place}
                        </td>
                        <td style={num}>{g.kind === 'walk_in' ? '—' : g.customers}</td>
                        <td style={num}>{g.invoices}</td>
                        <td style={{ ...num, fontWeight: 600 }}>{fmt(g.sales)}</td>
                        <td>
                          {g.share == null ? <span style={{ color: 'var(--text-3)' }}>—</span> : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div className="progress-bar" style={{ flex: 1 }} role="img"
                                   aria-label={`${g.share}%`}>
                                <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, g.share))}%` }} />
                              </div>
                              <span style={{ fontSize: 12, color: 'var(--text-3)', minWidth: 40, textAlign: 'right' }}>{g.share}%</span>
                            </div>
                          )}
                        </td>
                        <td style={{ ...num, color: 'var(--green)' }}>{fmt(g.collected)}</td>
                        <td style={{ ...num, color: g.outstanding > 0.005 ? 'var(--red)' : 'var(--text-3)' }}>{fmt(g.outstanding)}</td>
                      </tr>
                      {expanded && g.clients.map(c => (
                        <tr key={`${g.key}-${c.id}`} className="sba-client" style={{ background: 'var(--surface-2)' }}>
                          <td />
                          <td style={{ paddingInlineStart: 24 }}>
                            <Link to={`/clients/${c.id}`}
                              style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>{c.name}</Link>
                            {c.company && <span style={{ color: 'var(--text-3)', fontSize: 12 }}> · {c.company}</span>}
                            {/* The address as this customer's record has it, when it was
                                typed differently from the name the place is shown under. */}
                            {g.kind === 'address' && c.address && c.address.trim() !== g.address && (
                              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{c.address}</div>
                            )}
                          </td>
                          <td />
                          <td style={num}>{c.invoices}</td>
                          <td style={num}>{fmt(c.sales)}</td>
                          <td />
                          <td style={{ ...num, color: 'var(--green)' }}>{fmt(c.collected)}</td>
                          <td style={{ ...num, color: c.outstanding > 0.005 ? 'var(--red)' : 'var(--text-3)' }}>{fmt(c.outstanding)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
              {!q && (
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td />
                  <td>{t('common.total')}</td>
                  <td style={num}>{s.customers}</td>
                  <td style={num}>{s.invoices}</td>
                  <td style={num}>{fmt(s.sales)}</td>
                  <td />
                  <td style={num}>{fmt(s.collected)}</td>
                  <td style={num}>{fmt(s.outstanding)}</td>
                </tr>
              </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>{t('reports.sba.note')}</p>
    </div>
  );
}

export { SalesByAddressReport };
