import { useState, useEffect, useCallback } from 'react';
import { usePersistedState } from '../hooks/usePersistedState';
import { useLocale } from '../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, useMoney, DisplayCurrencyToggle, ExchangeRateBadge, Icon } from '../components/shared';
import {
  getFinanceRangeSummary, getFinanceRangeMonthly, getFinanceRangeDetail,
  getBusinessSignals,
} from '../api/client';

// Charts/helpers, the smart-insights engine, and the modals extracted into
// ./finance/ — this file is the orchestrator (range state + data fetch + layout).
import {
  getRange, fmtMonth, CHART_COLORS, useAbbr,
  FinanceLineChart, ProfitBarChart, DonutChart, KpiCard,
} from './finance/charts';
import { generateInsights, SmartInsightsPanel } from './finance/insights';
import { MonthDrillModal, ReconciliationModal, exportExcel } from './finance/modals';

export default function Finance() {
  const { t } = useLocale();
  const money = useMoney();
  const abbr = useAbbr();
  const [preset, setPreset] = usePersistedState('finance.preset', 'month');
  const [custom, setCustom] = usePersistedState('finance.custom', { start: '', end: '' });
  const [summary, setSummary] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [hoveredRow, setHoveredRow] = useState(null);
  const [drillMonth, setDrillMonth]   = useState(null);
  const [drillData,  setDrillData]    = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [showRecon, setShowRecon]     = useState(false);

  // The cross-module scan behind the insight panel. One request: the server
  // aggregates in SQL across every module this user may see, which is both
  // faster than the six calls this used to make and able to reach modules the
  // Finance page never loads — stock, service, projects, the pipeline.
  const [signals, setSignals] = useState({});

  const range = getRange(preset, custom);

  const load = useCallback(async () => {
    if (preset === 'custom' && (!custom.start || !custom.end)) return;
    setLoading(true); setError(null);
    try {
      const params = { start: range.start, end: range.end, ...(range.prevStart ? { prev_start: range.prevStart, prev_end: range.prevEnd } : {}) };
      const [sumData, monData] = await Promise.all([
        getFinanceRangeSummary(params),
        getFinanceRangeMonthly({ start: range.start, end: range.end }),
      ]);
      setSummary(sumData); setMonthly(monData);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [preset, custom.start, custom.end]);

  useEffect(() => { load(); }, [load]);

  // Re-scanned when the reporting window moves, because half the signals are
  // period-relative — what was billed, what was quoted, what payroll cost
  // against it. A failure leaves the panel with the finance-only rules rather
  // than blanking the page: the scan is context, not the report.
  useEffect(() => {
    let cancelled = false;
    getBusinessSignals({ start: range.start, end: range.end })
      .then(s => { if (!cancelled) setSignals(s || {}); })
      .catch(() => { if (!cancelled) setSignals({}); });
    return () => { cancelled = true; };
  }, [range.start, range.end]);

  async function openDrill(ym) {
    const [y, mo] = ym.split('-').map(Number);
    const start = `${ym}-01`;
    const lastDay = new Date(y, mo, 0).getDate();
    const end = `${ym}-${String(lastDay).padStart(2, '0')}`;
    setDrillMonth({ ym, label: fmtMonth(ym), start, end });
    setDrillData(null);
    setDrillLoading(true);
    try {
      const data = await getFinanceRangeDetail({ start, end });
      setDrillData(data);
    } catch { /* detail stays null */ }
    finally { setDrillLoading(false); }
  }

  const insights = generateInsights(summary, monthly, signals, abbr, t);
  const margin = summary?.income > 0 ? (summary.profit / summary.income * 100).toFixed(1) : null;
  const prev = summary?.prev || {};

  const handleExportExcel = async () => {
    setExportLoading(true);
    try {
      const detail = await getFinanceRangeDetail({ start: range.start, end: range.end });
      exportExcel([
        { name: 'Monthly Summary', rows: (monthly || []).map(m => ({ Month: m.month, Income: m.income.toFixed(2), Expenses: m.expenses.toFixed(2), Profit: m.profit.toFixed(2), 'Margin %': m.income > 0 ? ((m.profit / m.income) * 100).toFixed(1) : '0.0' })) },
        { name: 'Income', rows: (detail.income_records || []).map(r => ({ Date: r.date?.slice(0, 10), Amount: r.amount, Method: r.method, Invoice: r.invoice_number, Client: r.client_name, Note: r.note || '' })) },
        { name: 'Expenses', rows: (detail.expense_records || []).map(r => ({ Date: r.date, Amount: r.amount, Category: r.category, Description: r.description || '', Project: r.project_name || '' })) },
      ], `Finance_${range.start}_to_${range.end}`);
    } catch (e) { alert('Export failed: ' + e.message); }
    finally { setExportLoading(false); }
  };

  const PRESETS = [
    { key: 'month',   label: t('finance.thisMonth') },
    { key: '3months', label: t('finance.last3Months') },
    { key: 'year',    label: t('finance.thisYear') },
    { key: 'custom',  label: t('finance.custom') },
  ];

  const periodLabel = preset === 'custom'
    ? (custom.start && custom.end ? `${custom.start} → ${custom.end}` : t('finance.customRange'))
    : PRESETS.find(p => p.key === preset)?.label;

  return (
    <div>{/* full width — every other page fills the content area; the old
            maxWidth:1200 left a dead right margin on large screens */}
      <style>{`
        @media print { .no-print { display: none !important; } body { background: #fff; } }
        @keyframes fadeSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .fin-card { animation: fadeSlideUp .35s ease both; }
      `}</style>

      {/* Header */}
      <div className="page-header no-print" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{t('finance.title')}</h1>
          <p className="page-subtitle">{periodLabel} · {t('finance.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ExchangeRateBadge />
          <DisplayCurrencyToggle />
          <button className="btn btn-outline btn-sm" onClick={() => setShowRecon(true)}>
<Icon name="search" size={14} />{t('finance.reconcile')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleExportExcel} disabled={exportLoading}>
            ↓ {exportLoading ? t('finance.exportingLabel') : t('finance.exportExcel')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            ↓ PDF
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRESETS.map(p => (
          <button key={p.key}
            className={`btn btn-sm ${preset === p.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPreset(p.key)}
            style={{ transition: 'all .15s' }}
          >
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" className="form-control" style={{ width: 148 }} value={custom.start} onChange={e => setCustom(c => ({ ...c, start: e.target.value }))} />
            <span style={{ color: 'var(--text-3)', fontSize: 13 }}>→</span>
            <input type="date" className="form-control" style={{ width: 148 }} value={custom.end} onChange={e => setCustom(c => ({ ...c, end: e.target.value }))} />
          </>
        )}
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading ? <LoadingSpinner /> : (
        <>
          {/* KPI tiles — Workspace pattern. Each tile is its own .stat-card
              surface (the previous code double-wrapped it in .fin-card,
              which produced a card-inside-a-card). Colour props point at
              the system's semantic tokens so the tiles inherit the plum +
              affirm + negate palette instead of hardcoded Material hexes. */}
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 24 }}>
            {[
              { label: t('finance.totalIncome'),
                value: money(summary?.income || 0),
                color: 'var(--affirm)',
                icon: 'banknote',
                change: prev.income_change,
                sub: t('finance.incomePeriod') },
              { label: t('finance.totalExpenses'),
                value: money(summary?.expenses || 0),
                color: 'var(--negate)',
                icon: 'receipt',
                change: prev.expenses_change != null ? -prev.expenses_change : null,
                sub: t('finance.allCosts') },
              { label: t('finance.netProfit'),
                value: money(summary?.profit || 0),
                color: (summary?.profit || 0) >= 0 ? 'var(--accent)' : 'var(--negate)',
                icon: 'bar-chart',
                change: prev.profit_change,
                sub: t('finance.incomeMinus') },
              { label: t('finance.profitMargin'),
                value: margin !== null ? `${margin}%` : '—',
                color: 'var(--accent)',
                icon: 'target',
                change: prev.margin_change,
                sub: t('finance.netOverIncome') },
            ].map((kpi, i) => (
              <div key={kpi.label}
                style={{
                  /* fadeSlideUp staggered entrance — keep the per-tile
                     animation delay from the previous layout. */
                  animation: 'fadeSlideUp .35s ease both',
                  animationDelay: `${i * 0.07}s`,
                }}>
                <KpiCard {...kpi} />
              </div>
            ))}
          </div>

          {/* Charts row 1: Line chart full width */}
          <div className="card fin-card" style={{ animationDelay: '0.35s', marginBottom: 16 }}>
            <div className="card-header">
              <span className="card-title">{t('finance.incomeVsExpenses')}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverForDetails')}</span>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <FinanceLineChart data={monthly} />
            </div>
          </div>

          {/* Charts row 2: Bar + Donut */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div className="card fin-card" style={{ animationDelay: '0.4s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.monthlyProfit')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverForDetails')}</span>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <ProfitBarChart data={monthly} />
              </div>
            </div>
            <div className="card fin-card" style={{ animationDelay: '0.45s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.expenseBreakdown')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('finance.hoverSlices')}</span>
              </div>
              <div style={{ padding: '16px 20px' }}>
                <DonutChart data={summary?.by_category} />
              </div>
            </div>
          </div>

          {/* Monthly table */}
          {monthly?.length > 0 && (
            <div className="card fin-card" style={{ animationDelay: '0.5s', marginBottom: 24 }}>
              <div className="card-header">
                <span className="card-title">{t('finance.monthlyBreakdown')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{monthly.length} {t('finance.months')}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('finance.month')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.income')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.expenses')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.profit')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.margin')}</th>
                      <th style={{ textAlign: 'right' }}>{t('finance.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...monthly].reverse().map((m, idx) => {
                      const mgn = m.income > 0 ? ((m.profit / m.income) * 100).toFixed(1) : null;
                      const best = monthly.length > 1 ? monthly.reduce((a, b) => b.profit > a.profit ? b : a) : null;
                      const isBest = best && m.month === best.month;
                      const isH = hoveredRow === idx;
                      return (
                        <tr key={m.month}
                          onMouseEnter={() => setHoveredRow(idx)}
                          onMouseLeave={() => setHoveredRow(null)}
                          onClick={() => openDrill(m.month)}
                          style={{ background: isH ? 'var(--accent-light)' : 'transparent', transition: 'background .15s', cursor: 'pointer' }}
                        >
                          <td className="td-primary" style={{ fontWeight: isBest ? 700 : 500 }}>
                            {fmtMonth(m.month)}
                            {isBest && <span style={{ fontSize: 10, background: '#FEF9C3', color: '#92400E', borderRadius: 4, padding: '1px 5px', marginLeft: 6 }}>{t('finance.bestLabel')}</span>}
                            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6, opacity: isH ? 1 : 0, transition: 'opacity .15s' }}>↗ details</span>
                          </td>
                          <td style={{ textAlign: 'right', color: '#059669', fontWeight: 600 }}>{money(m.income)}</td>
                          <td style={{ textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>{money(m.expenses)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: m.profit >= 0 ? '#059669' : '#DC2626' }}>{money(m.profit)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--text-3)' }}>{mgn !== null ? `${mgn}%` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '2px 8px', background: m.profit >= 0 ? '#ECFDF5' : '#FEF2F2', color: m.profit >= 0 ? '#059669' : '#DC2626' }}>
                              {m.profit >= 0 ? t('finance.profitLabel') : t('finance.lossLabel')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {monthly.length > 1 && (() => {
                    const totI = monthly.reduce((s, m) => s + m.income, 0);
                    const totE = monthly.reduce((s, m) => s + m.expenses, 0);
                    const totP = totI - totE;
                    const totM = totI > 0 ? ((totP / totI) * 100).toFixed(1) : null;
                    return (
                      <tfoot>
                        <tr style={{ background: 'var(--surface-2)' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 12, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.5px', borderTop: '2px solid var(--border)' }}>{t('common.total')}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#059669', borderTop: '2px solid var(--border)' }}>{money(totI)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: '#DC2626', borderTop: '2px solid var(--border)' }}>{money(totE)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 800, color: totP >= 0 ? '#059669' : '#DC2626', borderTop: '2px solid var(--border)' }}>{money(totP)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--text-3)', borderTop: '2px solid var(--border)' }}>{totM !== null ? `${totM}%` : '—'}</td>
                          <td style={{ borderTop: '2px solid var(--border)' }} />
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
            </div>
          )}

          {/* Expense categories */}
          {summary?.by_category?.length > 0 && (
            <div className="card fin-card" style={{ animationDelay: '0.55s' }}>
              <div className="card-header">
                <span className="card-title">{t('finance.expensesByCategory')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('common.total')}: {money(summary.expenses)}</span>
              </div>
              <div style={{ padding: '4px 0' }}>
                {summary.by_category.map((c, i) => {
                  const pct = summary.expenses > 0 ? (c.total / summary.expenses) * 100 : 0;
                  return (
                    <div key={c.category} style={{
                      display: 'grid', gridTemplateColumns: '20px 140px 1fr 90px 52px',
                      alignItems: 'center', gap: 12, padding: '11px 20px',
                      borderBottom: i < summary.by_category.length - 1 ? '1px solid var(--border)' : 'none',
                      transition: 'background .15s',
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = '#F9FAFB'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: CHART_COLORS[i % CHART_COLORS.length], display: 'block' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{c.category}</span>
                      <div style={{ background: 'var(--bg)', borderRadius: 99, height: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: CHART_COLORS[i % CHART_COLORS.length], transition: 'width .6s ease' }} />
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--text)', textAlign: 'right', fontWeight: 700 }}>{money(c.total)}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'right' }}>{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Smart Insights Panel — placed at the bottom of the module ── */}
          <SmartInsightsPanel insights={insights} scanned={signals.scanned} />

          {!summary && !loading && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-3)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{t('finance.noDataForPeriod')}</p>
              <p style={{ fontSize: 13 }}>{t('finance.tryDifferentRange')}</p>
            </div>
          )}
        </>
      )}

      {drillMonth && (
        <MonthDrillModal
          month={drillMonth.ym}
          label={drillMonth.label}
          data={drillData}
          loading={drillLoading}
          onClose={() => { setDrillMonth(null); setDrillData(null); }}
        />
      )}
      {showRecon   && <ReconciliationModal onClose={() => setShowRecon(false)} />}
    </div>
  );
}