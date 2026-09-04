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
import { createPaymentPlan, editPaymentPlan, deletePaymentPlan } from '../../api/client';
import { Badge, fmt, fmtDate, toast, NumberInput, ConfirmModal } from '../../components/shared';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';

const today = () => new Date().toISOString().slice(0, 10);

// One month on, clamped to the end of the target month, so a plan running from
// the 31st does not skip February. Only used to suggest a date for a row the
// user has just added; the server imposes no spacing of its own.
//
// Worked out on the calendar fields directly rather than through a Date. A date
// input holds a plain calendar day with no timezone, and round-tripping one
// through `toISOString` converts local midnight to UTC — east of Greenwich that
// lands on the day BEFORE, so stepping from the 15th suggested the 14th.
export function nextMonth(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return today();
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const year = mo === 12 ? y + 1 : y;
  const month = mo === 12 ? 1 : mo + 1;
  const last = new Date(year, month, 0).getDate();   // day 0 of the next month
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

// A cent of rounding is not a mismatch; a dollar is. The same tolerance the
// server applies, so Save is never enabled for something it would refuse.
const CENT = 0.005;

export default function PaymentPlan({ invoice, canEdit, onChange }) {
  const { t } = useLocale();
  const plan = invoice.installments || [];

  const [open,     setOpen]     = useState(false);
  const [busy,     setBusy]     = useState(false);
  const [confirm,  setConfirm]  = useState(false);
  // The schedule being edited, or null. Rows money has already reached are
  // marked `settled` and rendered read-only: the server refuses to change them,
  // and a box you can type into but not save is worse than no box.
  const [draft,    setDraft]    = useState(null);
  // Prefilled from the terms recorded against this customer, so the shape
  // they usually agree to is already in the boxes.
  const [form,     setForm]     = useState({
    count:      invoice.client_installment_count ?? '',
    start_date: today(),
    frequency:  invoice.client_installment_frequency || 'monthly',
    first_amount: '',
  });

  // Whether this customer may be put on a plan at all. The server refuses it
  // A plan on ONE invoice is always available. Splitting a single document
  // into agreed dates is how anybody sells anything of size, and gating it per
  // customer got in the way of ordinary trade.
  //
  // The customer's "allow instalments" setting governs something else: whether
  // their whole ACCOUNT may go on terms, which is a standing credit
  // arrangement. That lives on Record Payment.

  const total = Number(invoice.amount) || 0;
  const paid  = Number(invoice.total_paid) || 0;
  // Whether the plan may be REBUILT from a count and a frequency. Once money
  // has arrived that would re-interpret what was already settled — three of
  // twelve silently becoming one of four — so the server refuses it, and saying
  // so up front is kinder than a 409. Editing the rows is a different question
  // and stays available: see the Edit schedule button below.
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

  function startEdit() {
    setDraft(plan.map(r => ({
      due_date: String(r.due_date).slice(0, 10),
      amount:   String(r.amount),
      note:     r.note || '',
      settled:  Number(r.paid) > CENT,
    })));
  }

  const setRow  = (i, patch) =>
    setDraft(d => d.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const addRow  = () => setDraft(d => [...d, {
    due_date: nextMonth(d.length ? d[d.length - 1].due_date : today()),
    amount: '', note: '', settled: false,
  }]);
  const dropRow = (i) => setDraft(d => d.filter((_, n) => n !== i));

  // What the draft comes to, against what it has to come to. Shown live so
  // somebody moving money between rows can watch the plan close, rather than
  // finding out from a rejection.
  const drafted = (draft || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const gap     = total - drafted;

  async function saveEdit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await editPaymentPlan(invoice.id, {
        installments: draft.map(r => ({
          due_date: r.due_date,
          amount:   Number(r.amount),
          note:     r.note || null,
        })),
      });
      toast(t('installments.editSaved'), 'green');
      setDraft(null);
      onChange?.();
    } catch (err) {
      toast(err.message || t('installments.editFailed'), 'red');
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
          {/* Offered whether or not money has arrived. It is the only way to
              renegotiate a running plan: rebuilding one from a count and a
              frequency would re-read what the customer has already settled. */}
          {canEdit && plan.length > 0 && !open && !draft && (
            <button className="btn btn-sm btn-secondary" onClick={startEdit}>
              {t('installments.edit')}
            </button>
          )}
          {canEdit && plan.length > 0 && !locked && !open && !draft && (
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
        <p style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {/* Not an error — a decision somebody made about this customer, and
              the message says where to change it. */}
          {t('installments.none')}
        </p>
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
            <SearchSelect
              className="form-control"
              value={form.frequency}
              onChange={v => setForm(f => ({ ...f, frequency: v }))}
              options={[{ value: 'monthly', label: t('installments.monthly') }, { value: 'quarterly', label: t('installments.quarterly') }, { value: 'yearly', label: t('installments.yearly') }]} />
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

      {draft && (
        <form onSubmit={saveEdit}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('installments.dueDate')}</th>
                <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{i + 1}</td>
                  <td>
                    <input type="date" className="form-control" required
                      style={{ width: 150 }}
                      value={row.due_date} disabled={row.settled}
                      title={row.settled ? t('installments.settledRow') : undefined}
                      onChange={e => setRow(i, { due_date: e.target.value })} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <NumberInput className="form-control" min="0" step="0.01" required
                      style={{ width: 120, textAlign: 'right' }}
                      value={row.amount} disabled={row.settled}
                      title={row.settled ? t('installments.settledRow') : undefined}
                      onChange={e => setRow(i, { amount: e.target.value })} />
                  </td>
                  <td>
                    {!row.settled && draft.length > 1 && (
                      <button type="button" className="btn btn-sm btn-secondary"
                        title={t('installments.removeRow')}
                        onClick={() => dropRow(i)}>&times;</button>
                    )}
                    {row.settled && (
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {t('installments.settledRow')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                        flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={addRow}>
              {t('installments.addRow')}
            </button>
            <span style={{ fontSize: 12 }}>
              {t('installments.scheduled')}: <strong>{fmt(drafted)}</strong>
              {' / '}{fmt(total)}
            </span>
            <span style={{ fontSize: 12,
                           color: Math.abs(gap) <= CENT ? 'var(--green)' : 'var(--red)' }}>
              {Math.abs(gap) <= CENT
                ? t('installments.matches')
                : gap > 0 ? t('installments.shortBy', { amount: fmt(gap) })
                          : t('installments.overBy', { amount: fmt(-gap) })}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="submit" className="btn btn-primary"
                disabled={busy || Math.abs(gap) > CENT}>
                {busy ? t('installments.saving') : t('installments.save')}
              </button>
              <button type="button" className="btn btn-secondary"
                onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
            </div>
            <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--text-3)' }}>
              {t('installments.editHint', { total: fmt(total) })}
            </div>
          </div>
        </form>
      )}

      {plan.length > 0 && !draft && (
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

      {plan.length > 0 && locked && !draft && (
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
