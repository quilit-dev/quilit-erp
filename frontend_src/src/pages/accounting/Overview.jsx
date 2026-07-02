import { useState, useEffect } from 'react';
import { getAccountingSummary } from '../../api/client';
import { LoadingSpinner, toast } from '../../components/shared';
import { monthStartISO, todayISO } from './constants';
import { DateRange } from './ui';

// ── Overview ─────────────────────────────────────────────────────────────────
//
// KPIs that follow the operator's date selection — defaults to month-to-date
// for continuity with the previous behaviour but accepts any window. The
// "Total Assets" + balance-sheet ✓ are pinned to the END of the window since
// they are point-in-time figures (a B/S "as of 2026-03-31" is meaningful;
// over a range is not).
function Overview({ t, fmt, fmtDate }) {
  const [start, setStart] = useState(monthStartISO());
  const [end,   setEnd]   = useState(todayISO());
  const [s,     setS]     = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!start || !end || start > end) return;
    setLoading(true);
    getAccountingSummary({ start, end })
      .then(setS)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [start, end]);

  const cards = s ? [
    [t('accounting.totalIncome'),  fmt(s.month_income),  'green'],
    [t('accounting.totalExpense'), fmt(s.month_expense), 'red'],
    [t('accounting.netIncome'),    fmt(s.month_net),     s.month_net >= 0 ? 'green' : 'red'],
    [t('accounting.totalAssets'),  fmt(s.total_assets),  'blue'],
  ] : [];

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header" style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <span className="card-title">{t('accounting.overview')}</span>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {fmtDate(start)} → {fmtDate(end)}
            </div>
          </div>
          <DateRange start={start} end={end} onStart={setStart} onEnd={setEnd} t={t} />
        </div>
      </div>

      {loading || !s ? <LoadingSpinner /> : (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            {cards.map(([label, value, color]) => (
              <div className="stat-card" key={label}>
                <div className="stat-label">{label}</div>
                <div className="stat-value" style={{ color: `var(--${color})` }}>{value}</div>
              </div>
            ))}
          </div>
          <div className="card"><div className="card-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <span>{t('accounting.accounts')}: <strong>{s.accounts}</strong></span>
            <span>{t('accounting.posted')}: <strong>{s.posted_entries}</strong></span>
            <span>{t('accounting.balanceSheet')}:{' '}
              <strong style={{ color: s.balanced ? 'var(--green)' : 'var(--red)' }}>
                {s.balanced ? `✓ ${t('accounting.balanced')}` : `⚠ ${t('accounting.notBalanced')}`}
              </strong>
              <span style={{ marginInlineStart: 6, color: 'var(--text-3)', fontSize: 12 }}>
                ({t('accounting.asOf')} {fmtDate(end)})
              </span>
            </span>
          </div></div>
        </>
      )}
    </>
  );
}

export { Overview };
