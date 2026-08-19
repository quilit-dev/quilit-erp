// The payment plan panel on an invoice.
//
// A plan is a schedule against ONE invoice, not a set of invoices — the customer
// keeps a single document and the agreement lives beside it. Which instalments
// are settled is computed by the server from the invoice's own payments, so this
// screen never tracks allocation itself and cannot drift from the balance shown
// directly above it.
//
// Recording a payment is deliberately NOT part of this panel: payments are taken
// in the form above, oldest instalment first. Offering a "pay" button per row
// would imply an earmarking the backend does not do.
import { useState } from 'react';
import { createPaymentPlan, deletePaymentPlan } from '../../api/client';
import { Badge, fmt, fmtDate, toast, NumberInput, ConfirmModal } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export default function PaymentPlan({ invoice, canEdit, onChange }) {
  const { t } = useLocale();
  const plan = invoice.installments || [];

  const [open,     setOpen]     = useState(false);
  const [busy,     setBusy]     = useState(false);
  const [confirm,  setConfirm]  = useState(false);
  const [form,     setForm]     = useState({
    count: '', start_date: today(), frequency: 'monthly', first_amount: '',
  });

  const total = Number(invoice.amount) || 0;
  const paid  = Number(invoice.total_paid) || 0;
  // Renegotiating after money has arrived would re-interpret what was already
  // settled — three of twelve silently becoming one of four. The server refuses
  // it; saying so up front is kinder than a 409.
  const locked = paid > 0.005;

  async function save(e) {
    e.preventDefault();
    const count = Number(form.count);
    if (!count || count < 1) { toast(t('installments.needCount'), 'red'); return; }
    setBusy(true);
    try {
      await createPaymentPlan(invoice.id, {
        count,
        start_date:   form.start_date,
        frequency:    form.frequency,
        first_amount: form.first_amount === '' ? null : Number(form.first_amount),
      });
      toast(t('installments.saved'), 'green');
      setOpen(false);
      onChange?.();
    } catch (err) {
      toast(err.message || t('installments.saveFailed'), 'red');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirm(false);
    setBusy(true);
    try {
      await deletePaymentPlan(invoice.id);
      toast(t('installments.removed'), 'green');
      onChange?.();
    } catch (err) {
      toast(err.message || t('installments.removeFailed'), 'red');
    } finally {
      setBusy(false);
    }
  }

  // The instalment worth putting in front of whoever is chasing payment: the
  // oldest one still owing.
  const next = invoice.next_due;

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('installments.title')}</span>
        {plan.length > 0 && next && (
          <span style={{ fontSize: 12, color: next.status === 'Overdue' ? 'var(--red)' : 'var(--text-3)' }}>
            {t('installments.nextDue', {
              date: fmtDate(next.due_date), amount: fmt(next.remaining),
            })}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {canEdit && plan.length === 0 && !open && (
            <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
              {t('installments.setUp')}
            </button>
          )}
          {canEdit && plan.length > 0 && !locked && !open && (
            <>
              <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
                {t('installments.change')}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}
                disabled={busy}>
                {t('installments.remove')}
              </button>
            </>
          )}
        </div>
      </div>

      {plan.length === 0 && !open && (
        <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('installments.none')}</p>
      )}

      {open && (
        <form onSubmit={save}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
          <div className="form-group" style={{ margin: 0, width: 110 }}>
            <label className="form-label">{t('installments.count')} *</label>
            <NumberInput className="form-control" min="1" step="1" required
              value={form.count}
              onChange={e => setForm(f => ({ ...f, count: e.target.value }))} />
          </div>
          <div className="form-group" style={{ margin: 0, width: 150 }}>
            <label className="form-label">{t('installments.firstDue')} *</label>
            <input type="date" className="form-control" required value={form.start_date}
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
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--text-3)' }}>
            {t('installments.splitHint', { total: fmt(total) })}
          </div>
        </form>
      )}

      {plan.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('installments.dueDate')}</th>
              <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
              <th style={{ textAlign: 'right' }}>{t('clients.paid')}</th>
              <th style={{ textAlign: 'right' }}>{t('invoices.remaining')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.map(row => (
              <tr key={row.seq}>
                <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{row.seq}</td>
                <td>{fmtDate(row.due_date)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(row.amount)}</td>
                <td style={{ textAlign: 'right', color: 'var(--green)' }}>{fmt(row.paid)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(row.remaining)}</td>
                <td>
                  <Badge status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {plan.length > 0 && locked && (
        <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
          {t('installments.lockedHint')}
        </p>
      )}

      {confirm && (
        <ConfirmModal
          message={t('installments.removeConfirm')}
          onConfirm={remove}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
