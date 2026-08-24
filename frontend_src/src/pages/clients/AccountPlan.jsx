// The dates this customer agreed to clear their account on.
//
// The schedule is stored against each invoice, because that is what arrears
// reporting, the statement and the invoice screen all read. Nobody who agreed
// terms thinks in those terms though — they agreed four payments, and this is
// where they see four payments.
//
// A date that covers more than one invoice says so. "You owe 250 on 1 April"
// is the answer to the usual question; "which of my bills is that" is the
// follow-up, and it is right there rather than three screens away.
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getClientPlan } from '../../api/client';
import { LoadingSpinner, Badge, toast } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

function AccountPlan({ clientId, refreshKey }) {
  const { t, fmt, fmtDate } = useLocale();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getClientPlan(clientId)
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [clientId]);
  // `refreshKey` changes when a payment is recorded, because agreeing terms
  // is the moment this becomes worth looking at.
  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading && !data) return <LoadingSpinner />;
  const rows = data?.installments || [];
  if (!rows.length) return null;      // no plan agreed; nothing to show

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="card-title">{t('installments.title')}</span>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {t('clients.planSummary', {
              count: data.count,
              total: fmt(data.total),
              remaining: fmt(data.remaining),
            })}
          </div>
        </div>
        {data.next_due && (
          <div style={{ textAlign: 'end', fontSize: 12.5 }}>
            <div style={{ color: 'var(--text-3)' }}>{t('installments.nextDueLabel')}</div>
            <div style={{ fontWeight: 600 }}>
              {fmt(data.next_due.amount - data.next_due.paid)} · {fmtDate(data.next_due.due_date)}
            </div>
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('installments.dueDate')}</th>
              <th>{t('clients.covers')}</th>
              <th className="text-right">{t('common.amount')}</th>
              <th className="text-right">{t('reports.totalPaid')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.due_date}>
                <td className="text-mono">{i + 1}</td>
                <td>{fmtDate(r.due_date)}</td>
                <td>
                  {/* Which bills this date pays off. One agreed payment can
                      finish an invoice and start the next, so a date often
                      covers two. */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {r.invoices.map(inv => (
                      <Link key={inv.invoice_id} to={`/invoices?focus=${inv.invoice_id}`}
                        style={{ color: 'var(--accent)', fontSize: 12 }}>
                        {inv.invoice_number}
                      </Link>
                    ))}
                  </div>
                </td>
                <td className="text-right">{fmt(r.amount)}</td>
                <td className="text-right" style={{ color: 'var(--text-3)' }}>
                  {r.paid > 0.005 ? fmt(r.paid) : '—'}
                </td>
                <td><Badge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { AccountPlan };
