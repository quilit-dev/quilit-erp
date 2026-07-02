import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert } from '../../components/shared';
import { getCashSummary } from '../../api/client';
import { today, money } from './ui';

// ── Today view ──────────────────────────────────────────────────────────────
// ── Today view ──────────────────────────────────────────────────────────────
//
// KPI strip at the top summarises today across all drawers. Below it, a
// generously-sized card per drawer in a responsive grid — each card has a
// status pill, the expected USD + LBP as side-by-side stat blocks, an
// optional variance row when closed, and a primary action at the foot.
function TodayView({ canCreate, onOpenDay, openDetail, refreshKey }) {
  const { t } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getCashSummary(today()).then(setData).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!data) return <LoadingSpinner />;
  if ((data.drawers || []).length === 0) {
    return (
      <div className="cash-empty-hero">
        <div className="cash-empty-hero-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2"/>
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        </div>
        <div className="cash-empty-hero-title">{t('cash.noDrawersTitle')}</div>
        <p className="cash-empty-hero-sub">{t('cash.noDrawersHint')}</p>
      </div>
    );
  }

  // KPI roll-ups across every drawer for today. Open drawers contribute to
  // "expected on hand"; closed drawers with a non-zero variance contribute
  // to "anomalies"; not-started drawers are flagged separately.
  const drawers = data.drawers;
  const openCount    = drawers.filter(d => d.reconciliation?.status === 'open').length;
  const idleCount    = drawers.filter(d => !d.reconciliation).length;
  const expectedUsd  = drawers.reduce((s, d) => s + (Number(d.reconciliation?.expected_cash)     || 0), 0);
  const expectedLbp  = drawers.reduce((s, d) => s + (Number(d.reconciliation?.expected_cash_lbp) || 0), 0);
  const anomalies    = drawers.filter(d =>
    d.reconciliation?.status === 'closed' &&
    ((Math.abs(Number(d.reconciliation.variance) || 0) > 0.005) ||
     (Math.abs(Number(d.reconciliation.variance_lbp) || 0) > 0.5))
  ).length;

  return (
    <>
      {/* KPI strip — what's happening with cash right now */}
      <div className="cash-kpi-strip">
        <div className="stat-card">
          <div className="stat-label">{t('cash.openDrawers')}</div>
          <div className="stat-value">{openCount} / {drawers.length}</div>
          <div className="stat-sub">{idleCount > 0
            ? t('cash.notStartedCount', { count: idleCount })
            : t('cash.allStarted')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.expectedOnHand')} USD</div>
          <div className="stat-value">{money(expectedUsd, 'USD')}</div>
          <div className="stat-sub">{t('cash.acrossDrawers', { n: drawers.length })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.expectedOnHand')} LBP</div>
          <div className="stat-value">{money(expectedLbp, 'LBP')}</div>
          <div className="stat-sub">{t('cash.acrossDrawers', { n: drawers.length })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('cash.todayAnomalies')}</div>
          <div className="stat-value" style={{
            color: anomalies > 0 ? 'var(--negate)' : 'var(--affirm)',
          }}>
            {anomalies > 0 ? anomalies : '—'}
          </div>
          <div className="stat-sub">
            {anomalies > 0 ? t('cash.varianceFound') : t('cash.noVariance')}
          </div>
        </div>
      </div>

      {/* Drawer cards */}
      <div className="cash-drawers-grid">
        {drawers.map(({ drawer, reconciliation }) => {
          // Card state class drives the accent rail + status badge variant.
          let state = 'idle';
          if (reconciliation?.status === 'open')   state = 'open';
          if (reconciliation?.status === 'closed') state = 'closed';
          const varUsd = Number(reconciliation?.variance) || 0;
          const varLbp = Number(reconciliation?.variance_lbp) || 0;
          const hasVariance = Math.abs(varUsd) > 0.005 || Math.abs(varLbp) > 0.5;
          return (
            <div key={drawer.id} className={`cash-drawer-card is-${state}`}>
              <div className="cash-drawer-head">
                <div className="cash-drawer-name">
                  <span className="cash-drawer-name-icon" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="6" width="20" height="12" rx="2"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  </span>
                  <span className="truncate">{drawer.name}</span>
                </div>
                <span className={`cash-drawer-status ${state}`}>
                  <span className="dot" />
                  {state === 'open'   ? t('cash.statusOpen')
                  : state === 'closed' ? t('cash.statusClosed')
                  : t('cash.notStarted')}
                </span>
              </div>

              <div className="cash-drawer-body">
                {!reconciliation ? (
                  <div style={{ padding: '6px 2px', color: 'var(--text-3)', fontSize: 13, lineHeight: 1.55 }}>
                    {t('cash.notStartedHint')}
                  </div>
                ) : (
                  <>
                    <div className="cash-stat-pair">
                      <div className="cash-stat">
                        <div className="cash-stat-label">USD</div>
                        <div className="cash-stat-value">{money(reconciliation.expected_cash, 'USD')}</div>
                      </div>
                      <div className="cash-stat">
                        <div className="cash-stat-label">LBP</div>
                        <div className="cash-stat-value">{money(reconciliation.expected_cash_lbp, 'LBP')}</div>
                      </div>
                    </div>
                    {reconciliation.status === 'closed' && (
                      <div className={`cash-variance-row ${hasVariance ? 'bad' : 'good'}`}>
                        <span className="cash-variance-label">{t('cash.variance')}</span>
                        <span className="cash-variance-value">
                          {hasVariance
                            ? `${varUsd ? money(varUsd, 'USD') : '—'} · ${varLbp ? money(varLbp, 'LBP') : '—'}`
                            : t('cash.balanced')}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {!!drawer.auto_capture && (
                  <div style={{
                    marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10.5,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    color: 'var(--accent)',
                  }}>
                    ⚡ {t('cash.autoCapture')}
                  </div>
                )}
              </div>

              <div className="cash-drawer-foot">
                {!reconciliation && canCreate && (
                  <button className="btn btn-primary btn-sm" onClick={() => onOpenDay(drawer.id)}>
                    {t('cash.openDay')}
                  </button>
                )}
                {reconciliation && (
                  <button className="btn btn-secondary btn-sm" onClick={() => openDetail(reconciliation.id)}>
                    {t('cash.viewDay')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export { TodayView };
