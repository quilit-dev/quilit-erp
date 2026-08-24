// The payment plan this customer's account is on.
//
// A customer owing 4,000 who agreed to eight payments of 500 agreed ONE thing,
// and this is it: eight dates, eight amounts, and how far down them they have
// got. The plan belongs to the customer, not to their invoices — each payment
// against it is an ordinary account payment and lands on whatever is open at
// the time, oldest first.
//
// The plan's balance and the account's balance are shown apart, because they
// are not the same number. An invoice raised after the terms were agreed is
// outstanding and is not part of the plan, and blurring the two is how a
// customer gets chased for a figure nobody agreed to.
import { useState, useEffect, useCallback } from 'react';
import { getClientPlan, cancelClientPlan } from '../../api/client';
import { LoadingSpinner, Badge, ConfirmModal, toast } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import { usePermissions } from '../../hooks/usePermissions';

function AccountPlan({ clientId, refreshKey, onChanged }) {
  const { t, fmt, fmtDate } = useLocale();
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getClientPlan(clientId)
      .then(setData)
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  }, [clientId]);
  // `refreshKey` changes when a payment is recorded, because that is the
  // moment this moves.
  useEffect(() => { load(); }, [load, refreshKey]);

  async function cancel() {
    setConfirming(false);
    setBusy(true);
    try {
      await cancelClientPlan(clientId);
      toast(t('clients.planCancelled'));
      load();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  if (loading && !data) return <LoadingSpinner />;
  const plan = data?.plan;
  if (!plan) return null;             // no plan agreed; nothing to show
  const rows = plan.installments || [];
  // Owed beyond what the plan covers — normally nothing, and worth saying
  // plainly when it is not.
  const beyond = Math.round(
    ((data.outstanding || 0) - plan.remaining) * 100) / 100;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="card-title">{t('installments.title')}</span>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {t('clients.planSummary', {
              count: plan.count,
              total: fmt(plan.total),
              remaining: fmt(plan.remaining),
            })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {plan.next_due && (
            <div style={{ textAlign: 'end', fontSize: 12.5 }}>
              <div style={{ color: 'var(--text-3)' }}>{t('installments.nextDueLabel')}</div>
              <div style={{ fontWeight: 600 }}>
                {fmt(plan.next_due.amount - plan.next_due.paid)}
                {' · '}{fmtDate(plan.next_due.due_date)}
              </div>
            </div>
          )}
          {can('invoices', 'create') && (
            <button className="btn btn-sm btn-secondary" disabled={busy}
              onClick={() => setConfirming(true)}>
              {t('installments.remove')}
            </button>
          )}
        </div>
      </div>

      {beyond > 0.005 && (
        <div style={{ padding: '10px 16px', fontSize: 12.5,
                      color: 'var(--text-2)', background: 'var(--bg)',
                      borderBottom: '1px solid var(--border)' }}>
          {t('clients.owedBeyondPlan', { amount: fmt(beyond) })}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('installments.dueDate')}</th>
              <th className="text-right">{t('common.amount')}</th>
              <th className="text-right">{t('reports.totalPaid')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.seq}>
                <td className="text-mono">{r.seq}</td>
                <td>{fmtDate(r.due_date)}</td>
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

      {confirming && (
        <ConfirmModal
          title={t('installments.remove')}
          message={t('clients.planCancelConfirm')}
          confirmLabel={t('installments.remove')}
          onConfirm={cancel} onCancel={() => setConfirming(false)} />
      )}
    </div>
  );
}

export { AccountPlan };
