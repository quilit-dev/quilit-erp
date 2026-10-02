import { useState, useRef, useId } from 'react';
import { LoadingSpinner, ErrorAlert, fmt, exportPeriodRange } from '../../components/shared';
import { getReportProfitSummary } from '../../api/client';
import { StatCard, ExportButtons } from './charts';

/**
 * Profit summary — a from-to statement.
 *
 * Choose the period, press Generate, and the whole range is summarised as one
 * statement: sales by where they happened (till, invoice, service job) with
 * how many of each, the cost of the goods sold, gross profit, expenses,
 * salaries, net profit, what is still owed on those sales, and the cash profit
 * after it. Sales come from the documents; cost, expenses and salaries from
 * the ledger --- see report_profit_summary on the server for why.
 */

const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const PRESETS = ['this_month', 'last_month', 'this_year', 'last_year'];

/** The statement as lines: what the screen shows and both exports print. */
function statementLines(tot, t) {
  const sales = Number(tot.sales) || 0;
  const share = v => (sales ? `${((Number(v) || 0) / sales * 100).toFixed(1)}%` : '');
  const L = (key, label, amount, o = {}) => ({ key, label, amount: Number(amount) || 0,
                                                pct: o.pct ?? share(amount), ...o });
  return [
    { key: 'h_sales', label: t('reports.psSales'), heading: true },
    L('pos',      t('reports.psPos'),      tot.pos_sales,     { count: tot.pos_count, indent: true }),
    L('invoices', t('reports.psInvoices'), tot.invoice_sales, { count: tot.invoice_count, indent: true }),
    L('services', t('reports.psServices'), tot.service_sales, { count: tot.service_count, indent: true }),
    L('sales',    t('reports.psTotalSales'), sales,           { count: tot.sales_count, total: true }),
    L('cost',     t('reports.psCost'),     -(Number(tot.cost) || 0), { pct: share(tot.cost), cost: true }),
    L('gross',    t('reports.psGross'),    tot.gross_profit,  { total: true }),
    L('expenses', t('reports.psExpenses'), -(Number(tot.expenses) || 0), { pct: share(tot.expenses), cost: true }),
    L('salaries', t('reports.psSalaries'), -(Number(tot.salaries) || 0), { pct: share(tot.salaries), cost: true }),
    L('net',      t('reports.psNet'),      tot.net_profit,    { total: true, result: true }),
    L('uncollected', t('reports.psUncollectedLine'), -(Number(tot.uncollected) || 0),
      { pct: share(tot.uncollected), cost: true }),
    L('cash',     t('reports.psCash'),     tot.cash_profit,   { total: true }),
    ...(tot.purchases == null ? [] : [
      { key: 'h_ref', label: t('reports.psForReference'), heading: true },
      L('purchases', t('reports.psPurchases'), tot.purchases,
        { count: tot.purchases_count, pct: '', indent: true, muted: true }),
    ]),
  ];
}

function ProfitSummaryReport({ t }) {
  const initial = exportPeriodRange('this_month');
  const [from, setFrom]       = useState(initial.from);
  const [to, setTo]           = useState(initial.to);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);
  const fromId = useId(), toId = useId();

  function generate(f = from, tt = to) {
    if (!f || !tt) { setError(t('reports.psPickBoth')); return; }
    if (f > tt)    { setError(t('common.exportFromAfterTo')); return; }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportProfitSummary({ start: f, end: tt, group: 'total' }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
  }
  function preset(p) {
    const r = exportPeriodRange(p);
    setFrom(r.from); setTo(r.to);
    generate(r.from, r.to);
  }

  const tot = data ? (data.rows?.[0] || data.totals || {}) : null;
  const lines = tot ? statementLines(tot, t) : [];
  const period = data ? t('reports.psPeriodRange', { from: data.start, to: data.end }) : '';

  // Exports carry the statement exactly as it reads on screen.
  const exportable = lines.filter(l => !l.heading);
  const columns = [
    { label: t('reports.psItem'),      value: l => l.label },
    { label: t('reports.psCountCol'),  value: l => (l.count == null ? '' : l.count), align: 'right' },
    { label: t('reports.psAmount'),    value: l => l.amount, align: 'right' },
    { label: t('reports.psPctOfSales'), value: l => l.pct || '', align: 'right' },
  ];

  return (
    <div>
      {/* The period: from, to, a few shortcuts, and Generate. */}
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

      {!loading && tot && (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <StatCard label={t('reports.psTotalSales')} value={fmt(tot.sales || 0)}
              sub={t('reports.psSalesSub', { n: tot.sales_count || 0 })} />
            <StatCard label={t('reports.psGross')} value={fmt(tot.gross_profit || 0)}
              sub={t('reports.psMarginSub', { p: tot.gross_margin_pct == null ? '—' : `${tot.gross_margin_pct}%` })} />
            <StatCard label={t('reports.psNet')} value={fmt(tot.net_profit || 0)}
              color={(tot.net_profit || 0) < 0 ? 'red' : 'green'} />
            <StatCard label={t('reports.psCash')} value={fmt(tot.cash_profit || 0)}
              sub={t('reports.psUncollectedSub', { v: fmt(tot.uncollected || 0) })} />
          </div>

          <div className="card" style={{ maxWidth: 820 }}>
            <div className="card-header chart-header">
              <div>
                <h2 className="card-title">{t('reports.profitSummary')}</h2>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 2 }}>{period}</div>
              </div>
              <ExportButtons
                rows={exportable} columns={columns}
                baseName={`profit_summary_${data.start}_to_${data.end}`}
                pdfTitle={t('reports.profitSummary')}
                subtitle={period}
                t={t} />
            </div>
            <div className="table-wrap">
              <table style={{ fontSize: 13.5 }}>
                <thead>
                  <tr>
                    <th>{t('reports.psItem')}</th>
                    <th style={NUM}>{t('reports.psCountCol')}</th>
                    <th style={NUM}>{t('reports.psAmount')}</th>
                    <th style={{ ...NUM, color: 'var(--text-3)' }}>{t('reports.psPctOfSales')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => l.heading ? (
                    <tr key={l.key}>
                      <td colSpan={4} style={{ fontWeight: 700, fontSize: 11.5, letterSpacing: 0.4,
                        textTransform: 'uppercase', color: 'var(--text-3)', paddingTop: 14 }}>
                        {l.label}
                      </td>
                    </tr>
                  ) : (
                    <tr key={l.key} style={l.total ? { borderTop: '1.5px solid var(--text-1)' } : undefined}>
                      <td style={{ paddingInlineStart: l.indent ? 24 : undefined,
                        fontWeight: l.total ? 700 : 400, color: l.muted ? 'var(--text-3)' : undefined }}>
                        {l.label}
                      </td>
                      <td style={{ ...NUM, color: 'var(--text-3)' }}>{l.count == null ? '' : l.count}</td>
                      <td style={{ ...NUM, fontWeight: l.total ? 700 : 400,
                        color: l.muted ? 'var(--text-3)'
                             : (l.cost || l.amount < 0) ? 'var(--red)' : undefined,
                        background: l.result
                          ? (l.amount >= 0 ? 'var(--affirm-soft, rgba(46,125,50,.12))'
                                           : 'var(--danger-soft, rgba(192,57,43,.10))')
                          : undefined }}>
                        {fmt(l.amount)}
                      </td>
                      <td style={{ ...NUM, color: 'var(--text-3)' }}>{l.pct}</td>
                    </tr>
                  ))}
                </tbody>
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

export { ProfitSummaryReport, statementLines };
