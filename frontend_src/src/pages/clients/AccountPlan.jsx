// The payment plan panel on a customer's account.
//
// Deliberately the same panel as the one beside an invoice: same header, same
// Set up / Change / Remove, same four-box form, same table. An operator who has
// put one invoice on terms already knows how to put an account on terms, and a
// second shape for the same idea would only be a second thing to learn.
//
// What differs is what the schedule is against. An invoice plan splits ONE
// document; this splits the whole account balance, and each payment made
// afterwards is an ordinary account payment landing on whatever is open at the
// time, oldest first. So the plan's balance and the account's balance are shown
// apart — an invoice raised after the terms were agreed is outstanding and is
// not part of the plan, and blurring the two is how a customer gets chased for
// a figure nobody agreed to.
//
// Recording a payment is NOT part of this panel, for the same reason it is not
// part of the invoice one: a "pay" button per row would imply an earmarking the
// server does not do.
import { useState, useEffect, useCallback } from 'react';
import { getClientPlan, createClientPlan, cancelClientPlan } from '../../api/client';
import { LoadingSpinner, Badge, ConfirmModal, NumberInput, toast }
  from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import { usePermissions } from '../../hooks/usePermissions';

const today = () => new Date().toISOString().slice(0, 10);

function AccountPlan({ clientId, client, refreshKey, onChanged }) {
  const { t, fmt, fmtDate } = useLocale();
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Prefilled from the terms recorded against this customer, so the shape they
  // usually agree to is already in the boxes.
  const [form, setForm] = useState({
    count: client?.default_installment_count ?? '',
    start_date: today(),
    frequency: client?.default_installment_frequency || 'monthly',
    first_amount: '',
  });

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

  const plan = data?.plan;
  const rows = plan?.installments || [];
  const next = plan?.next_due;
  // Renegotiating after money has arrived would re-interpret what was already
  // settled — three of eight silently becoming one of four. The server refuses
  // it; saying so up front is kinder than a 400.
  const locked = (plan?.paid || 0) > 0.005;
  // Whose account may go on terms at all. A plan on ONE invoice is always
  // available to anybody; the whole account is a standing credit arrangement
  // and the customer's own setting decides it.
  const allowed = !!client?.allow_installments;
  const canEdit = can('invoices', 'create');
  const outstanding = data?.outstanding || 0;
  // Owed beyond what the plan covers — normally nothing, and worth saying
  // plainly when it is not.
  const beyond = plan
    ? Math.round((outstanding - plan.remaining) * 100) / 100
    : 0;

  async function save(e) {
    e.preventDefault();
    const count = Number(form.count);
    if (!count || count < 1) { toast(t('installments.needCount'), 'red'); return; }
    setBusy(true);
    try {
      await createClientPlan(clientId, {
        count,
        start_date: form.start_date,
        frequency: form.frequency,
        first_amount: form.first_amount === '' ? null : Number(form.first_amount),
      }, !!plan);                       // replacing terms nobody has paid yet
      toast(t('installments.saved'), 'green');
      setOpen(false);
      load();
      onChanged?.();
    } catch (err) {
      toast(err.message || t('installments.saveFailed'), 'red');
    } finally { setBusy(false); }
  }

  async function cancel() {
    setConfirming(false);
    setBusy(true);
    try {
      await cancelClientPlan(clientId);
      toast(t('installments.removed'), 'green');
      load();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'red');
    } finally { setBusy(false); }
  }

  if (loading && !data) return <LoadingSpinner />;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span className="card-title">{t('installments.title')}</span>
        {plan && next && (
          <span style={{ fontSize: 12,
                         color: next.status === 'Overdue' ? 'var(--red)' : 'var(--text-3)' }}>
            {t('installments.nextDue', {
              date: fmtDate(next.due_date), amount: fmt(next.remaining),
            })}
          </span>
        )}
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
          {canEdit && allowed && !plan && !open && (
            <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
              {t('installments.setUp')}
            </button>
          )}
          {canEdit && plan && !locked && !open && (
            <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
              {t('installments.change')}
            </button>
          )}
          {/* Cancelling stays available once payments have arrived, unlike
              changing: a customer who has stopped paying has to be takeable
              off terms, and the payments already made are untouched by it. */}
          {canEdit && plan && !open && (
            <button className="btn btn-sm btn-danger" disabled={busy}
              onClick={() => setConfirming(true)}>
              {t('installments.remove')}
            </button>
          )}
        </div>
      </div>

      <div className="card-body">
        {!plan && !open && (
          <p style={{ color: 'var(--text-3)', fontSize: 13, margin: 0 }}>
            {/* Not an error — either nobody has agreed terms, or somebody
                decided this customer may not have them, and the message says
                where that is changed. */}
            {allowed ? t('clients.notOnPlan') : t('installments.notApproved')}
          </p>
        )}

        {plan && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
            {t('clients.planSummary', {
              count: plan.count,
              total: fmt(plan.total),
              remaining: fmt(plan.remaining),
            })}
          </div>
        )}

        {beyond > 0.005 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 10 }}>
            {t('clients.owedBeyondPlan', { amount: fmt(beyond) })}
          </div>
        )}

        {open && (
          <form onSubmit={save}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8,
                     alignItems: 'flex-end', marginBottom: 14 }}>
            <div className="form-group" style={{ margin: 0, width: 110 }}>
              <label className="form-label">{t('installments.count')} *</label>
              <NumberInput className="form-control" min="1" step="1" required
                value={form.count}
                onChange={e => setForm(f => ({ ...f, count: e.target.value }))} />
            </div>
            <div className="form-group" style={{ margin: 0, width: 150 }}>
              <label className="form-label">{t('installments.firstDue')} *</label>
              <input type="date" className="form-control" required
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
            </div>
            <div className="form-group" style={{ margin: 0, width: 130 }}>
              <label className="form-label">{t('installments.frequency')}</label>
              <select className="form-control" value={form.frequency}
                onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}>
                <option value="monthly">{t('installments.monthly')}</option>
                <option value="quarterly">{t('installments.quarterly')}</option>
                <option value="yearly">{t('installments.yearly')}</option>
              </select>
            </div>
            <div className="form-group" style={{ margin: 0, width: 140 }}>
              <label className="form-label">{t('installments.deposit')}</label>
              <NumberInput className="form-control" min="0" step="0.01"
                value={form.first_amount}
                placeholder={t('installments.depositHint')}
                onChange={e => setForm(f => ({ ...f, first_amount: e.target.value }))} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t('installments.saving') : t('installments.save')}
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--text-3)' }}>
              {/* The account balance, not one document — which is the whole
                  difference between this panel and the invoice one. */}
              {t('clients.planSplitHint', { total: fmt(outstanding) })}
            </div>
          </form>
        )}

        {plan && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('installments.dueDate')}</th>
                  <th className="text-right">{t('common.amount')}</th>
                  <th className="text-right">{t('clients.paid')}</th>
                  <th className="text-right">{t('invoices.remaining')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.seq}>
                    <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{r.seq}</td>
                    <td>{fmtDate(r.due_date)}</td>
                    <td className="text-right">{fmt(r.amount)}</td>
                    <td className="text-right" style={{ color: 'var(--green)' }}>
                      {fmt(r.paid)}
                    </td>
                    <td className="text-right" style={{ fontWeight: 600 }}>
                      {fmt(r.remaining)}
                    </td>
                    <td><Badge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {plan && locked && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, marginBottom: 0 }}>
            {t('installments.lockedHint')}
          </p>
        )}
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
