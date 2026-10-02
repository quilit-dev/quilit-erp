import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportProfitSummary } from '../../api/client';
import { StatCard, ExportButtons } from './charts';

/**
 * Profit summary — one row per month (or week).
 *
 * The owner's one-glance report: how much was sold and where (till, invoice,
 * service job), what it cost, what was spent, the net, and how much of it is
 * still owed. Sales come from the documents; cost, expenses and salaries from
 * the ledger --- see report_profit_summary on the server for why.
 */

// Short month names so a year of rows reads as a calendar, not as ISO keys.
function periodLabel(row, group) {
  if (group === 'week') {
    const s = new Date(row.start + 'T00:00:00');
    const e = new Date(row.end + 'T00:00:00');
    const f = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${f(s)} – ${f(e)}`;
  }
  const d = new Date(row.start + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const COST = { ...NUM, color: 'var(--red)' };
const SUB = { display: 'block', fontSize: 10.5, color: 'var(--text-3)', fontWeight: 400 };

/** An amount, red when negative --- a loss should never need reading twice. */
function Money({ v, strong }) {
  const n = Number(v) || 0;
  return (
    <span style={{ color: n < 0 ? 'var(--red)' : undefined, fontWeight: strong ? 700 : undefined }}>
      {fmt(n)}
    </span>
  );
}

/** Amount with its count underneath: "1,250.00 / 12 sales". */
function Channel({ amount, count, t }) {
  return (
    <>
      {count ? fmt(amount) : <span style={{ color: 'var(--text-3)' }}>—</span>}
      {count > 0 && <span style={SUB}>{t('reports.psCount', { n: count })}</span>}
    </>
  );
}

function ProfitSummaryReport({ params, t }) {
  const [group, setGroup]     = useState('month');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportProfitSummary({ ...params, group }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), group]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const rows = data.rows || [];
  const tot  = data.totals || {};
  const showPurchases = !data.branch_scoped;
  // The longest sales bar is the busiest period; the rest are drawn against it.
  const maxSales = Math.max(1, ...rows.map(r => Number(r.sales) || 0));
  const pct = v => (v == null ? '—' : `${Number(v).toFixed(1)}%`);

  // ── Exports: Excel carries every figure; the PDF the ones that fit A4. ──
  const label = r => (r.period === 'Total' ? t('common.total') : periodLabel(r, data.group));
  const xlsCols = [
    { label: t('reports.psPeriod'),        value: label },
    { label: t('reports.psPosCount'),      value: r => r.pos_count,      align: 'right' },
    { label: t('reports.psPos'),           value: r => r.pos_sales,      align: 'right' },
    { label: t('reports.psInvoiceCount'),  value: r => r.invoice_count,  align: 'right' },
    { label: t('reports.psInvoices'),      value: r => r.invoice_sales,  align: 'right' },
    { label: t('reports.psServiceCount'),  value: r => r.service_count,  align: 'right' },
    { label: t('reports.psServices'),      value: r => r.service_sales,  align: 'right' },
    { label: t('reports.psSalesCount'),    value: r => r.sales_count,    align: 'right' },
    { label: t('reports.psSales'),         value: r => r.sales,          align: 'right' },
    { label: t('reports.psCost'),          value: r => r.cost,           align: 'right' },
    { label: t('reports.psGross'),         value: r => r.gross_profit,   align: 'right' },
    { label: t('reports.psMargin'),        value: r => r.gross_margin_pct, align: 'right' },
    { label: t('reports.psExpenses'),      value: r => r.expenses,       align: 'right' },
    { label: t('reports.psSalaries'),      value: r => r.salaries,       align: 'right' },
    { label: t('reports.psNet'),           value: r => r.net_profit,     align: 'right' },
    { label: t('reports.psUncollected'),   value: r => r.uncollected,    align: 'right' },
    { label: t('reports.psCash'),          value: r => r.cash_profit,    align: 'right' },
    ...(showPurchases ? [
      { label: t('reports.psPurchaseCount'), value: r => r.purchases_count, align: 'right' },
      { label: t('reports.psPurchases'),     value: r => r.purchases,       align: 'right' },
    ] : []),
  ];
  const pdfCols = [
    { label: t('reports.psPeriod'),      value: label, width: '13%' },
    { label: t('reports.psSalesCount'),  value: r => r.sales_count,  align: 'right' },
    { label: t('reports.psSales'),       value: r => r.sales,        align: 'right' },
    { label: t('reports.psCost'),        value: r => r.cost,         align: 'right' },
    { label: t('reports.psGross'),       value: r => r.gross_profit, align: 'right' },
    { label: '%',                        value: r => pct(r.gross_margin_pct), align: 'right' },
    { label: t('reports.psExpenses'),    value: r => r.expenses,     align: 'right' },
    { label: t('reports.psSalaries'),    value: r => r.salaries,     align: 'right' },
    { label: t('reports.psNet'),         value: r => r.net_profit,   align: 'right' },
    { label: t('reports.psUncollected'), value: r => r.uncollected,  align: 'right' },
    { label: t('reports.psCash'),        value: r => r.cash_profit,  align: 'right' },
  ];
  // The totals ride as a last row in Excel, and as the PDF's own total line.
  const pdfTotals = { label: t('common.total'),
    columns: Object.fromEntries(pdfCols.slice(1).map((c, i) => [i + 1, c.value(tot)])) };

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <StatCard label={t('reports.psSales')} value={fmt(tot.sales || 0)}
          sub={t('reports.psSalesSub', { n: tot.sales_count || 0 })} />
        <StatCard label={t('reports.psGross')} value={fmt(tot.gross_profit || 0)}
          sub={t('reports.psMarginSub', { p: pct(tot.gross_margin_pct) })} />
        <StatCard label={t('reports.psNet')} value={fmt(tot.net_profit || 0)}
          color={(tot.net_profit || 0) < 0 ? 'red' : 'green'} />
        <StatCard label={t('reports.psCash')} value={fmt(tot.cash_profit || 0)}
          sub={t('reports.psUncollectedSub', { v: fmt(tot.uncollected || 0) })} />
      </div>

      <div className="card">
        <div className="card-header chart-header">
          <h2 className="card-title">{t('reports.profitSummary')}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="seg" role="group" aria-label={t('reports.psGroupBy')}
                 style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {['month', 'week'].map(g => (
                <button key={g} type="button"
                  className={`btn btn-sm ${group === g ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ borderRadius: 0 }}
                  aria-pressed={group === g}
                  onClick={() => setGroup(g)}>
                  {g === 'month' ? t('reports.psMonthly') : t('reports.psWeekly')}
                </button>
              ))}
            </div>
            <ExportButtons
              rows={[...rows, tot]} columns={xlsCols}
              pdfRows={rows} pdfColumns={pdfCols} totals={pdfTotals}
              baseName={`profit_summary_${data.start}_${data.end}`}
              pdfTitle={t('reports.profitSummary')}
              subtitle={`${data.start} → ${data.end}`}
              t={t} />
          </div>
        </div>

        <div className="table-wrap">
          <table style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th rowSpan={2}>{t('reports.psPeriod')}</th>
                <th colSpan={4} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                  {t('reports.psSales')}
                </th>
                <th rowSpan={2} style={NUM}>{t('reports.psCost')}</th>
                <th rowSpan={2} style={NUM}>{t('reports.psGross')}</th>
                <th rowSpan={2} style={NUM}>%</th>
                <th rowSpan={2} style={NUM}>{t('reports.psExpenses')}</th>
                <th rowSpan={2} style={NUM}>{t('reports.psSalaries')}</th>
                <th rowSpan={2} style={NUM}>{t('reports.psNet')}</th>
                <th rowSpan={2} style={NUM}>{t('reports.psUncollected')}</th>
                <th rowSpan={2} style={NUM}>{t('reports.psCash')}</th>
                {showPurchases && <th rowSpan={2} style={{ ...NUM, color: 'var(--text-3)' }}
                  title={t('reports.psPurchasesHint')}>{t('reports.psPurchases')}</th>}
              </tr>
              <tr>
                <th style={NUM}>{t('reports.psPos')}</th>
                <th style={NUM}>{t('reports.psInvoices')}</th>
                <th style={NUM}>{t('reports.psServices')}</th>
                <th style={{ ...NUM, minWidth: 130 }}>{t('common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const share = (Number(r.sales) || 0) / maxSales * 100;
                return (
                  <tr key={r.period}>
                    <td className="td-primary" style={{ whiteSpace: 'nowrap' }}>{periodLabel(r, data.group)}</td>
                    <td style={NUM}><Channel amount={r.pos_sales} count={r.pos_count} t={t} /></td>
                    <td style={NUM}><Channel amount={r.invoice_sales} count={r.invoice_count} t={t} /></td>
                    <td style={NUM}><Channel amount={r.service_sales} count={r.service_count} t={t} /></td>
                    {/* The total, over a bar scaled to the busiest period. */}
                    <td style={{ ...NUM, fontWeight: 600,
                      background: share > 0
                        ? `linear-gradient(to left, var(--accent-soft, rgba(46,125,50,.16)) ${share}%, transparent ${share}%)`
                        : undefined }}>
                      {fmt(r.sales)}
                      {r.sales_count > 0 && <span style={SUB}>{t('reports.psCount', { n: r.sales_count })}</span>}
                    </td>
                    <td style={COST}>{r.cost ? fmt(r.cost) : '—'}</td>
                    <td style={NUM}><Money v={r.gross_profit} /></td>
                    <td style={{ ...NUM, color: 'var(--text-3)' }}>{pct(r.gross_margin_pct)}</td>
                    <td style={COST}>{r.expenses ? fmt(r.expenses) : '—'}</td>
                    <td style={COST}>{r.salaries ? fmt(r.salaries) : '—'}</td>
                    <td style={{ ...NUM,
                      background: r.net_profit > 0 ? 'var(--affirm-soft, rgba(46,125,50,.12))'
                                : r.net_profit < 0 ? 'var(--danger-soft, rgba(192,57,43,.10))' : undefined }}>
                      <Money v={r.net_profit} strong />
                    </td>
                    <td style={{ ...NUM, color: r.uncollected ? 'var(--caution-ink, #b26a00)' : 'var(--text-3)' }}>
                      {r.uncollected ? fmt(r.uncollected) : '—'}
                    </td>
                    <td style={NUM}><Money v={r.cash_profit} /></td>
                    {showPurchases && (
                      <td style={{ ...NUM, color: 'var(--text-3)' }}>
                        {r.purchases_count ? fmt(r.purchases) : '—'}
                        {r.purchases_count > 0 && <span style={SUB}>{t('reports.psCount', { n: r.purchases_count })}</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--text-1)' }}>
                <td>{t('common.total')}</td>
                <td style={NUM}><Channel amount={tot.pos_sales} count={tot.pos_count} t={t} /></td>
                <td style={NUM}><Channel amount={tot.invoice_sales} count={tot.invoice_count} t={t} /></td>
                <td style={NUM}><Channel amount={tot.service_sales} count={tot.service_count} t={t} /></td>
                <td style={NUM}>{fmt(tot.sales || 0)}
                  <span style={SUB}>{t('reports.psCount', { n: tot.sales_count || 0 })}</span></td>
                <td style={COST}>{fmt(tot.cost || 0)}</td>
                <td style={NUM}><Money v={tot.gross_profit} strong /></td>
                <td style={NUM}>{pct(tot.gross_margin_pct)}</td>
                <td style={COST}>{fmt(tot.expenses || 0)}</td>
                <td style={COST}>{fmt(tot.salaries || 0)}</td>
                <td style={NUM}><Money v={tot.net_profit} strong /></td>
                <td style={NUM}>{fmt(tot.uncollected || 0)}</td>
                <td style={NUM}><Money v={tot.cash_profit} strong /></td>
                {showPurchases && <td style={NUM}>{fmt(tot.purchases || 0)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={{ padding: '10px 16px', fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
          {t('reports.psFootnote')}
        </div>
      </div>
    </div>
  );
}

export { ProfitSummaryReport };
