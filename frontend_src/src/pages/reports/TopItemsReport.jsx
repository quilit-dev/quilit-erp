// Top selling items: what sells, what it earns, and what sits on the shelf.
//
// Sales come from every invoice in the range, till sales included, net of VAT
// and of every discount, with credit notes taken off. Cost, profit and margin
// only appear for users allowed to see cost --- the server leaves them out
// otherwise, so this screen simply shows what it is given.
import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, fmt, fmtDate } from '../../components/shared';
import { getReportTopItems } from '../../api/client';
import { StatCard, HBarChart, ExportButtons, CHART_COLORS } from './charts';
import SearchSelect from '../../components/SearchSelect.jsx';

const qtyFmt = v => String(+Number(v || 0).toFixed(3));

function TopItemsReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [sort, setSort]       = useState('quantity');
  const [limit, setLimit]     = useState(25);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportTopItems({ ...params, sort, limit }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), sort, limit]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const cost = data.show_cost;
  const items = data.items || [];
  const sorts = [
    ['quantity', t('reports.topByQuantity')],
    ['revenue',  t('reports.topBySales')],
    ...(cost ? [['profit', t('reports.topByProfit')]] : []),
  ];
  const chartKey = sort === 'quantity' ? 'net_quantity' : sort === 'profit' ? 'profit' : 'net_sales';
  const chartData = items.slice(0, 10).map(r => ({ group_name: r.name, total: r[chartKey] || 0 }));
  const range = `${fmtDate(data.start)} → ${fmtDate(data.end)}`;

  const cols = [
    { label: '#',                              value: (r, i) => i + 1,              align: 'right' },
    { label: t('reports.item'),                value: r => r.name,                  align: 'left'  },
    { label: t('reports.category'),            value: r => r.category || '',        align: 'left'  },
    { label: t('reports.qtySold'),             value: r => r.net_quantity,          align: 'right' },
    { label: t('reports.qtyReturned'),         value: r => r.quantity_returned,     align: 'right' },
    { label: t('reports.netSales'),            value: r => r.net_sales,             align: 'right' },
    ...(cost ? [
      { label: t('reports.cost'),              value: r => r.cost ?? '',            align: 'right' },
      { label: t('reports.profit'),            value: r => r.profit ?? '',          align: 'right' },
      { label: t('reports.marginPct'),         value: r => r.margin_pct ?? '',      align: 'right' },
    ] : []),
    { label: t('reports.sharePct'),            value: r => r.share_pct,             align: 'right' },
    { label: t('reports.invoicesCount'),       value: r => r.documents,             align: 'right' },
  ];
  const rows = items.map((r, i) => ({ ...r, __i: i }));
  const exportCols = cols.map(c => ({ ...c, value: r => c.value(r, r.__i) }));

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.itemsSold')} value={data.totals.items} />
        <StatCard label={t('reports.unitsSold')} value={qtyFmt(data.totals.quantity)} />
        <StatCard label={t('reports.netSales')}  value={fmt(data.totals.sales)} color="green"
          sub={data.totals.returns > 0 ? `${t('reports.returnsLabel')}: −${fmt(data.totals.returns)}` : null} />
        {cost && (
          <StatCard label={t('reports.goodsProfit')} value={fmt(data.totals.profit)}
            sub={data.totals.margin_pct != null ? `${data.totals.margin_pct}% ${t('reports.margin')}` : null} />
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header chart-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 className="card-title">{t('reports.topItems')}</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {sorts.map(([k, label]) => (
              <button key={k} className={`btn btn-sm ${sort === k ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSort(k)}>{label}</button>
            ))}
            <SearchSelect className="form-control" style={{ width: 100, fontSize: 12 }} value={limit}
              onChange={v => setLimit(Number(v))}
              options={[10, 25, 50, 100].map(n => ({ value: n, label: t('reports.topN', { n }) }))} />
            <ExportButtons rows={rows} columns={exportCols} baseName="top_selling_items"
              pdfTitle={t('reports.topItems')} subtitle={range} t={t} />
          </div>
        </div>
        <div className="card-body">
          {chartData.length === 0
            ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noSalesInRange')}</div>
            : <HBarChart data={chartData} colorFn={i => CHART_COLORS[i % CHART_COLORS.length]}
                formatValue={sort === 'quantity' ? qtyFmt : undefined} />}
        </div>
        {items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th>{t('reports.item')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.qtySold')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.netSales')}</th>
                  {cost && <th style={{ textAlign: 'right' }}>{t('reports.cost')}</th>}
                  {cost && <th style={{ textAlign: 'right' }}>{t('reports.profit')}</th>}
                  {cost && <th style={{ textAlign: 'right' }}>{t('reports.marginPct')}</th>}
                  <th style={{ textAlign: 'right' }}>{t('reports.sharePct')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.invoicesCount')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={`${r.inventory_id ?? r.name}-${i}`}>
                    <td style={{ color: 'var(--text-3)' }}>{i + 1}</td>
                    <td className="td-primary">
                      {r.name}
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {[r.category, r.kind === 'service' ? t('reports.serviceLine') : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {qtyFmt(r.net_quantity)}{r.unit ? ` ${r.unit}` : ''}
                      {r.quantity_returned > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>
                          {t('reports.returnedN', { n: qtyFmt(r.quantity_returned) })}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(r.net_sales)}</td>
                    {/* A service has no cost of goods: "—", not a 100% margin. */}
                    {cost && (
                      <td style={{ textAlign: 'right' }} title={r.cost_estimated ? t('reports.costEstimatedHint') : undefined}>
                        {r.cost == null ? '—' : <>{fmt(r.cost)}{r.cost_estimated ? ' *' : ''}</>}
                      </td>
                    )}
                    {cost && (
                      <td style={{ textAlign: 'right', fontWeight: 600,
                                   color: r.profit == null ? 'var(--text-3)' : r.profit < 0 ? 'var(--red)' : 'var(--green)' }}>
                        {r.profit == null ? '—' : fmt(r.profit)}
                      </td>
                    )}
                    {cost && <td style={{ textAlign: 'right' }}>{r.margin_pct != null ? `${r.margin_pct}%` : '—'}</td>}
                    <td style={{ textAlign: 'right' }}>{r.share_pct}%</td>
                    <td style={{ textAlign: 'right' }}>{r.documents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cost && items.some(r => r.cost_estimated) && (
              <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-3)' }}>
                * {t('reports.costEstimatedHint')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header chart-header">
          <span className="card-title">
            {t('reports.notSold')} {data.unsold_count > 0 && `(${data.unsold_count})`}
          </span>
        </div>
        {data.unsold.length === 0
          ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.everythingSold')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.item')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.onHand')}</th>
                    {cost && <th style={{ textAlign: 'right' }}>{t('reports.stockValue')}</th>}
                    <th style={{ textAlign: 'right' }}>{t('reports.lastSold')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unsold.map(r => (
                    <tr key={r.inventory_id}>
                      <td className="td-primary">
                        {r.name}
                        {r.category && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.category}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{qtyFmt(r.on_hand)}{r.unit ? ` ${r.unit}` : ''}</td>
                      {cost && <td style={{ textAlign: 'right' }}>{fmt(r.stock_value)}</td>}
                      <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>
                        {r.last_sold ? fmtDate(r.last_sold) : t('reports.neverSold')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.unsold_count > data.unsold.length && (
                <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-3)' }}>
                  {t('reports.showingOf', { shown: data.unsold.length, total: data.unsold_count })}
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

export { TopItemsReport };
