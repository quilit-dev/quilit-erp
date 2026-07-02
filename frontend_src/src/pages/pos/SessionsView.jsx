import { useState, useEffect, useCallback } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState } from '../../components/shared';
import { getPosSessions } from '../../api/client';

function SessionsView() {
  const { t, fmt, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getPosSessions().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!rows) return <LoadingSpinner />;
  if (rows.length === 0) return <EmptyState message={t('pos.noSessions')} />;

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>{t('pos.cashier')}</th>
            <th>{t('common.status')}</th>
            <th>{t('pos.openingFloat')}</th>
            <th>{t('pos.expectedCash')}</th>
            <th>{t('pos.closingCount')}</th>
            <th>{t('pos.variance')}</th>
            <th>{t('common.date')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td>{s.cashier_name}</td>
              <td>
                <span className={`badge badge-${s.status === 'open' ? 'green' : 'gray'}`}>{s.status}</span>
              </td>
              <td>{fmt(s.opening_float)}</td>
              <td>{s.expected_cash != null ? fmt(s.expected_cash) : '—'}</td>
              <td>{s.closing_count != null ? fmt(s.closing_count) : '—'}</td>
              <td style={{ color: s.variance == null ? undefined
                            : Math.abs(s.variance) < 0.01 ? 'var(--green)' : 'var(--red)' }}>
                {s.variance != null ? fmt(s.variance) : '—'}
              </td>
              <td>{fmtDate(s.opened_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export { SessionsView };
