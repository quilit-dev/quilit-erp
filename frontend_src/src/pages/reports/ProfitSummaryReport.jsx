import { useState, useRef, useId } from 'react';
import { LoadingSpinner, ErrorAlert, fmt, exportPeriodRange } from '../../components/shared';
import { getReportProfitSummary } from '../../api/client';
import { StatCard, ExportButtons } from './charts';

/**
 * Profit summary — choose from-to, generate, read it in columns.
 *
 * One row per month (or week, or the whole period as a single row), and a
 * column for each figure: sales by where they happened (till, invoice, service
 * job) with their counts, total sales, cost of goods, gross profit and margin,
 * expenses, salaries, net profit, what is still owed, the cash profit after
 * it, and purchases for reference. Sales come from the documents; cost,
 * expenses and salaries from the ledger --- see report_profit_summary on the
 * server for why.
 */

const PRESETS = ['this_month', 'last_month', 'this_year', 'last_year'];
const GROUPS  = ['month', 'week', 'total'];

/** A row's period as a reader names it: "Sep 2026", "Sep 28 – Oct 4", or the range. */
function periodLabel(row, group) {
  const d = s => new Date(String(s).slice(0, 10) + 'T00:00:00');
  const short = x => d(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (group === 'total') {
    const full = x => d(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return `${full(row.start)} – ${full(row.end)}`;
  }
  if (group === 'week') return `${short(row.start)} – ${short(row.end)}`;
  return d(row.start).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const NUM  = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const COST = { ...NUM, color: 'var(--red)' };
const SUB  = { display: 'block', fontSize: 10.5, color: 'var(--text-3)', fontWeight: 400 };

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

function ProfitSummaryReport({ t }) {
  const initial = exportPeriodRange('this_month');
  const [from, setFrom]       = useState(initial.from);
  const [to, setTo]           = useState(initial.to);
  const [group, setGroup]     = useState('month');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);
  const fromId = useId(), toId = useId();

  function generate(f = from, tt = to, g = group) {
    if (!f || !tt) { setError(t('reports.psPickBoth')); return; }
    if (f > tt)    { setError(t('common.exportFromAfterTo')); return; }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportProfitSummary({ start: f, end: tt, group: g }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
  }
  function preset(p) {
    const r = exportPeriodRange(p);
    setFrom(r.from); setTo(r.to);
    generate(r.from, r.to);
  }
  function regroup(g) {
    setGroup(g);
    if (data) generate(from, to, g);       // already generated: redo it the new way
  }

  const rows = data?.rows || [];
  const tot  = data?.totals || {};
  const showPurchases = data && !data.branch_scoped;
  const maxSales = Math.max(1, ...rows.map(r => Number(r.sales) || 0));
  const pct = v => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
  const range = data ? t('reports.psPeriodRange', { from: data.start, to: data.end }) : '';

  // ── Exports. Excel: every figure, counts in their own columns. PDF: the same
  // columns as the screen, channels included, in small type to fit A4. ──
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
    { label: t('reports.psPeriod'),      value: label },
    { label: t('reports.psPos'),         value: r => r.pos_sales,     align: 'right' },
    { label: t('reports.psInvoices'),    value: r => r.invoice_sales, align: 'right' },
    { label: t('reports.psServices'),    value: r => r.service_sales, align: 'right' },
    { label: t('reports.psSalesCount'),  value: r => r.sales_count,   align: 'right' },
    { label: t('reports.psSales'),       value: r => r.sales,         align: 'right' },
    { label: t('reports.psCost'),        value: r => r.cost,          align: 'right' },
    { label: t('reports.psGross'),       value: r => r.gross_profit,  align: 'right' },
    { label: '%',                        value: r => pct(r.gross_margin_pct), align: 'right' },
    { label: t('reports.psExpenses'),    value: r => r.expenses,      align: 'right' },
    { label: t('reports.psSalaries'),    value: r => r.salaries,      align: 'right' },
    { label: t('reports.psNet'),         value: r => r.net_profit,    align: 'right' },
    { label: t('reports.psUncollected'), value: r => r.uncollected,   align: 'right' },
    { label: t('reports.psCash'),        value: r => r.cash_profit,   align: 'right' },
    ...(showPurchases ? [
      { label: t('reports.psPurchases'), value: r => r.purchases,     align: 'right' },
    ] : []),
  ];
  // One row for the whole period needs no separate totals line.
  const pdfTotals = data && data.group !== 'total' ? { label: t('common.total'),
    columns: Object.fromEntries(pdfCols.slice(1).map((c, i) => [i + 1, c.value(tot)])) } : null;
  const xlsRows = data && data.group !== 'total' ? [...rows, tot] : rows;

  return (
    <div>
      {/* The period: from, to, how to split it, and Generate. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" htmlFor={fromId}>{t('common.exportFrom')}</label>
            <input id={fromId} type="date" className="form-control" value={from}
              onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" htmlFor={toId}>{t('common.exportTo')}</label>
            <input id={toId} type="date" className="form-control" value={to}
              onChange={e => setTo(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <span className="form-label">{t('reports.psRows')}</span>
            <div role="group" aria-label={t('reports.psRows')}
                 style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {GROUPS.map(g => (
                <button key={g} type="button" aria-pressed={group === g}
                  className={`btn btn-sm ${group === g ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ borderRadius: 0 }} disabled={loading}
                  onClick={() => regroup(g)}>
                  {t(`reports.psRows_${g}`)}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn btn-primary" disabled={loading}
            onClick={() => generate()}>
            {loading ? t('reports.psGenerating') : t('reports.psGenerate')}
          </button>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginInlineStart: 'auto' }}>
            {PRESETS.map(p => (
              <button key={p} type="button" className="btn btn-sm btn-secondary"
                disabled={loading} onClick={() => preset(p)}>
                {t(`common.exportPeriod_${p}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <ErrorAlert message={error} />}
      {loading && <LoadingSpinner />}
      {!loading && !data && !error && (
        <div className="card"><div className="card-body" style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {t('reports.psChoosePeriod')}
        </div></div>
      )}

      {!loading && data && (
        <>
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
              <div>
                <h2 className="card-title">{t('reports.profitSummary')}</h2>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 2 }}>{range}</div>
              </div>
              <ExportButtons
                rows={xlsRows} columns={xlsCols}
                pdfRows={rows} pdfColumns={pdfCols} totals={pdfTotals} pdfDense
                baseName={`profit_summary_${data.start}_to_${data.end}`}
                pdfTitle={t('reports.profitSummary')}
                subtitle={range}
                t={t} />
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
                          background: share > 0 && data.group !== 'total'
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
                {data.group !== 'total' && (
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
                )}
              </table>
            </div>
            <div style={{ padding: '10px 16px', fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
              {t('reports.psFootnote')}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export { ProfitSummaryReport };
