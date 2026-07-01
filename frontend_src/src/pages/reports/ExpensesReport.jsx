import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, fmt } from '../../components/shared';
import { getReportExpenses } from '../../api/client';
import { StatCard, HBarChart, VBarChart, DonutChart, ExportButtons, CHART_COLORS } from './charts';

function ExpensesReport({ params, t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [groupBy, setGroupBy] = useState('category');
  const abortRef = useRef(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportExpenses({ ...params, group_by: groupBy }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), groupBy]);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const expenseCols = [
    { label: 'Group',   value: r => r.group_name, align: 'left'  },
    { label: 'Amount',  value: r => r.total,      align: 'right' },
    { label: 'Count',   value: r => r.count,      align: 'right' },
    { label: 'Share %', value: r => r.pct,        align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalExpensesLabel')} value={fmt(data.total)}   color="red" />
        <StatCard label={t('common.total')}               value={data.count}        sub="records" />
        <StatCard label={t('reports.avgExpense')}         value={fmt(data.average)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{t('reports.expenseBreakdown')}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="form-control" style={{ width: 130, fontSize: 12 }}
                value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="category">{t('reports.byCategory')}</option>
                <option value="project">{t('reports.byProject')}</option>
                <option value="month">{t('reports.byMonth')}</option>
              </select>
              <ExportButtons
                rows={data.breakdown} columns={expenseCols}
                baseName="expense_analysis" pdfTitle={t('reports.expenseAnalysis') || 'Expense Analysis'} t={t} />
            </div>
          </div>
          <div className="card-body">
            {data.breakdown.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noExpenses')}</div>
              : groupBy === 'month'
                ? <VBarChart data={data.breakdown} labelKey="group_name" valueKey="total" color="#C0392B" />
                : <HBarChart data={data.breakdown} labelKey="group_name" valueKey="total"
                    colorFn={i => CHART_COLORS[i % CHART_COLORS.length]} />
            }
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">{t('reports.expensesByCategory')}</span></div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'center' }}>
            {data.breakdown.length > 0
              ? <DonutChart data={data.breakdown} size={200} />
              : <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '20px 0' }}>{t('reports.noExpenses')}</div>
            }
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">{t('reports.expensesReport')}</span></div>
        {data.breakdown.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('reports.noExpenses')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.groupName')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.amount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.count')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.share')}</th>
                    <th>Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((row, i) => (
                    <tr key={i}>
                      <td className="td-primary">{row.group_name}</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontWeight: 600 }}>{fmt(row.total)}</td>
                      <td style={{ textAlign: 'right' }}>{row.count}</td>
                      <td style={{ textAlign: 'right' }}>{row.pct}%</td>
                      <td style={{ paddingRight: 20 }}>
                        <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden', minWidth: 60 }}>
                          <div style={{ width: `${row.pct}%`, height: '100%', background: CHART_COLORS[i % CHART_COLORS.length], borderRadius: 4 }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Sales Pipeline Panel ───────────────────────────────────────────────────

export { ExpensesReport };
