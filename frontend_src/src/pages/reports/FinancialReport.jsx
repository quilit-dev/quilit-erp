import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportFinancial } from '../../api/client';
import { StatCard, LineChart, HBarChart, DonutChart, ExportButtons, fmtMonth } from './charts';

function FinancialReport({ params, t }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportFinancial(params, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params)]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const noData = data.monthly.length === 0;

  const financialCols = [
    { label: 'Month',    value: r => r.month,    align: 'left'  },
    { label: 'Income',   value: r => r.income,   align: 'right' },
    { label: 'Expenses', value: r => r.expenses, align: 'right' },
    { label: 'Profit',   value: r => r.profit,   align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalIncome')}   value={fmt(data.total_income)}   color="green" />
        <StatCard label={t('reports.totalExpenses')} value={fmt(data.total_expenses)} color="red" />
        <StatCard label={t('reports.netProfit')}     value={fmt(data.net_profit)}     color={data.net_profit >= 0 ? 'green' : 'red'}
          sub={data.total_income > 0 ? `${data.margin_pct}% margin` : undefined} />
        <StatCard label={t('reports.totalInvoiced')} value={fmt(data.total_invoiced)} />
        <StatCard label={t('reports.outstanding')}   value={fmt(data.outstanding)}    color={data.outstanding > 0 ? 'red' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.incomeVsExpenses')}</span>
            <ExportButtons
              rows={data.monthly} columns={financialCols}
              baseName="financial_report" pdfTitle={t('reports.financial')} t={t} />

          </div>
          <div className="card-body">
            {noData
              ? <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noData')}</div>
              : <LineChart data={data.monthly} label1={t('reports.income')} label2={t('reports.expenses')} key1="income" key2="expenses" />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.expensesByCategory')}</span></div>
          <div className="card-body" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            {data.by_category.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '20px 0' }}>{t('reports.noData')}</div>
              : <>
                  <DonutChart data={data.by_category} labelKey="category" size={180} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <HBarChart data={data.by_category} labelKey="category" />
                  </div>
                </>
            }
          </div>
        </div>
      </div>

      {data.monthly.length > 0 && (
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.monthlyBreakdown')}</span></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('reports.month')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.income')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.expenses')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.profit')}</th>
                  <th style={{ textAlign: 'right' }}>{t('reports.profitMargin')}</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly.map(row => {
                  const margin = row.income > 0 ? Math.round(row.profit / row.income * 100) : 0;
                  return (
                    <tr key={row.month}>
                      <td className="td-primary">{fmtMonth(row.month)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>{fmt(row.income)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>{fmt(row.expenses)}</td>
                      <td style={{ textAlign: 'right', color: row.profit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmt(row.profit)}</td>
                      <td style={{ textAlign: 'right', color: margin >= 0 ? 'var(--green)' : 'var(--red)' }}>{margin}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── VAT Summary Panel (Lebanon) ────────────────────────────────────────────

export { FinancialReport };
