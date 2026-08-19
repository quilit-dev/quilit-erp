import { useState, useEffect } from 'react';
import { LoadingSpinner, ErrorAlert, fmt, fmtDate } from '../../components/shared';
import { getReportInvoiceAging } from '../../api/client';
import { StatCard, AgingBucketBar, ExportButtons } from './charts';

function AgingReport({ t }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    getReportInvoiceAging()
      .then(setData).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error)   return <ErrorAlert message={error} />;
  if (!data)   return null;

  const { summary, invoices } = data;
  const totalUnpaid = Object.values(summary).reduce((s, b) => s + (b.total || 0), 0);
  const totalCount  = Object.values(summary).reduce((s, b) => s + (b.count || 0), 0);

  const bucketLabels = {
    current: { label: t('reports.current'),   color: 'green' },
    '1_30':  { label: t('reports.days1_30'),  color: 'yellow' },
    '31_60': { label: t('reports.days31_60'), color: 'orange' },
    '61_90': { label: t('reports.days61_90'), color: 'red' },
    over_90: { label: t('reports.over90'),    color: 'red' },
  };

  const agingCols = [
    { label: 'Invoice #',    value: r => r.invoice_number,    align: 'left'  },
    { label: 'Client',       value: r => r.client_name || '', align: 'left'  },
    { label: 'Project',      value: r => r.project_name || '',align: 'left'  },
    { label: 'Amount',       value: r => r.amount,            align: 'right' },
    { label: 'Paid',         value: r => r.paid_amount,       align: 'right' },
    { label: 'Remaining',    value: r => r.remaining,         align: 'right' },
    { label: 'Due Date',     value: r => r.due_date || '',    align: 'left'  },
    { label: 'Days Overdue', value: r => r.days_overdue,      align: 'right' },
  ];

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label={t('reports.totalUnpaid')}  value={fmt(totalUnpaid)} color={totalUnpaid > 0 ? 'red' : undefined} />
        <StatCard label={t('reports.invoiceCount2')} value={totalCount} />
        {Object.entries(bucketLabels).map(([k, { label, color }]) => (
          <StatCard key={k} label={label}
            value={fmt(summary[k]?.total || 0)}
            sub={`${summary[k]?.count || 0} invoice${(summary[k]?.count || 0) !== 1 ? 's' : ''}`}
            color={summary[k]?.total > 0 && k !== 'current' ? color : undefined} />
        ))}
      </div>

      {totalUnpaid > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">{t('reports.agingChart')}</span></div>
          <div className="card-body"><AgingBucketBar summary={summary} /></div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">{t('reports.aging')}</span>
          <ExportButtons
            rows={invoices} columns={agingCols}
            baseName="invoice_aging" pdfTitle={t('reports.aging') || 'Invoice Aging'} t={t} />
        </div>
        {invoices.length === 0
          ? <div style={{ padding: '28px', textAlign: 'center', color: 'var(--green)', fontSize: 13 }}>{t('reports.noOverdue')}</div>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('reports.invoiceNumber')}</th>
                    <th>{t('reports.client')}</th>
                    <th>{t('common.project')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                    <th style={{ textAlign: 'right' }}>{t('clients.paid')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.remaining')}</th>
                    <th>{t('reports.dueDate')}</th>
                    <th style={{ textAlign: 'right' }}>{t('reports.daysOverdue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => {
                    const ov = inv.days_overdue || 0;
                    const ovColor = ov === 0 ? 'var(--green)' : ov <= 30 ? 'var(--yellow)' : ov <= 60 ? 'var(--orange, #e67e22)' : 'var(--red)';
                    return (
                      <tr key={inv.row_key || inv.id}>
                        <td className="td-primary">
                          {inv.invoice_number}
                          {inv.plan_note && (
                            <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>
                              {inv.plan_note}
                            </div>
                          )}
                        </td>
                        <td>{inv.client_name || '—'}</td>
                        <td>{inv.project_name || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(inv.amount)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--green)' }}>{fmt(inv.paid_amount)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--red)' }}>{fmt(inv.remaining)}</td>
                        <td style={{ color: ov > 0 ? 'var(--red)' : undefined }}>{fmtDate(inv.due_date)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: ovColor }}>
                          {ov === 0 ? '—' : `+${ov}d`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Expense Analysis Panel ─────────────────────────────────────────────────

export { AgingReport };
