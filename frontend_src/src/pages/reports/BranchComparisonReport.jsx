import { useState, useEffect } from 'react';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getBranchComparison } from '../../api/client';
import { StatCard } from './charts';

function BranchComparisonReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true); setError(null);
    getBranchComparison(params, ctrl.signal)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false); } });
    return () => ctrl.abort();
  }, [params]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  const rows   = data?.branches || [];
  const totals = data?.totals || { income: 0, expenses: 0, profit: 0, invoiced: 0 };

  return (
    <div className="card">
      <div className="card-body">
        <div className="table-responsive">
          <table className="table">
            <thead>
              <tr>
                <th>{t('nav.branch')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.income')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.expenses')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.profit')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.invoiced')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.name}{r.is_default ? <span className="badge badge-gray" style={{ marginInlineStart: 6 }}>{t('reports.defaultBranch')}</span> : null}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.income)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.expenses)}</td>
                  <td style={{ textAlign: 'end', color: r.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(r.profit)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(r.invoiced)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)' }}>{t('common.noData') || '—'}</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>{t('reports.total')}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.income)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.expenses)}</td>
                  <td style={{ textAlign: 'end', color: totals.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(totals.profit)}</td>
                  <td style={{ textAlign: 'end' }}>{fmt(totals.invoiced)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}


export { BranchComparisonReport };
