import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, ExportButton } from '../../components/shared';
import { getCashReconciliations } from '../../api/client';
import { money, VarianceTag } from './ui';
import SearchSelect from '../../components/SearchSelect.jsx';

// ── History view ────────────────────────────────────────────────────────────
function HistoryView({ drawers, openDetail, refreshKey }) {
  const { t, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [date, setDate] = useState('');
  const [drawerId, setDrawerId] = useState('');

  const load = useCallback(() => {
    setError(null);
    const params = {};
    if (date) params.date = date;
    if (drawerId) params.drawer_id = drawerId;
    getCashReconciliations(params).then(setRows).catch(e => setError(e.message));
  }, [date, drawerId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const exportData = (rows || []).map(r => ({
    Drawer:           r.drawer_name,
    Business_Date:    fmtDate(r.business_date),
    Status:           r.status === 'open' ? 'Open' : 'Closed',
    Expected_USD:     r.expected_cash || 0,
    Expected_LBP:     r.expected_cash_lbp || 0,
    Counted_USD:      r.counted_cash || 0,
    Counted_LBP:      r.counted_cash_lbp || 0,
    Variance_USD:     r.variance || 0,
    Variance_LBP:     r.variance_lbp || 0,
  }));

  return (
    <div>
      <div className="cash-filter-bar">
        <span className="cash-filter-bar-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          {t('common.filters') || 'Filters'}
        </span>
        <input type="date" className="form-control" style={{ width: 160 }} value={date}
          onChange={e => setDate(e.target.value)} />
        <SearchSelect
          className="form-control"
          style={{ width: 180 }}
          value={drawerId}
          onChange={v => setDrawerId(v)}
          placeholder={t('cash.drawers')}
          options={(drawers).map(d => ({ value: d.id, label: d.name }))} />
        {rows && (
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)',
            letterSpacing: '0.04em',
          }}>
            {rows.length} {t('cash.reconciliations') || 'reconciliations'}
          </span>
        )}
        {rows && rows.length > 0 && (
          <div style={{ marginInlineStart: 'auto' }}>
            <ExportButton data={exportData} filename="Cash_Reconciliations" sheetName="Reconciliations" />
          </div>
        )}
      </div>
      {error && <ErrorAlert message={error} onRetry={load} />}
      {!rows && !error && <LoadingSpinner />}
      {rows && rows.length === 0 && <EmptyState message={t('cash.noReconciliations')} />}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t('cash.drawer')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.status')}</th>
                <th>{t('cash.expectedCash')} USD</th>
                <th>{t('cash.expectedCash')} LBP</th>
                <th>{t('cash.variance')} USD</th>
                <th>{t('cash.variance')} LBP</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.drawer_name}</td>
                  <td>{fmtDate(r.business_date)}</td>
                  <td>
                    <span className={`badge badge-${r.status === 'open' ? 'green' : 'gray'}`}>
                      {r.status === 'open' ? t('cash.statusOpen') : t('cash.statusClosed')}
                    </span>
                  </td>
                  <td>{money(r.expected_cash, 'USD')}</td>
                  <td>{money(r.expected_cash_lbp, 'LBP')}</td>
                  <td><VarianceTag value={r.variance} currency="USD" /></td>
                  <td><VarianceTag value={r.variance_lbp} currency="LBP" /></td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openDetail(r.id)}>
                      {t('cash.viewDay')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export { HistoryView };
