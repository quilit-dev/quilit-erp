// Take one payment against a customer and let it find their bills.
//
// A customer hands over money for "the account", not for invoice #114. The
// server settles their oldest invoices first and splits the payment into one
// row per invoice it touches.
//
// The table below the amount is a PREVIEW, worked out here from the same
// oldest-first rule so the operator can see what they are about to do. The
// server's answer is what actually happens, and it is shown afterwards — the
// preview is a courtesy, not the decision.
import { useState, useMemo, useEffect } from 'react';
import { recordCustomerPayment, issuePaymentVoucher,
         getClientPlan } from '../../api/client';
import { printPaymentVoucher } from '../../utils/receiptVoucher';
import { Modal, NumberInput, fmt, fmtDate, toast } from '../../components/shared';
import { CURRENCIES } from '../settings/ui';
import { useLocale } from '../../hooks/useLocale.jsx';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];

export default function CustomerPaymentModal({ client, invoices, onClose, onDone }) {
  const { t, tEnumValue } = useLocale();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  // The currency this customer settles in, when one is recorded against
  // them. It is a starting point, not a constraint — they can hand over
  // anything and the operator changes it.
  const [ccy, setCcy] = useState(
    CURRENCIES.includes(client?.preferred_currency) ? client.preferred_currency : 'USD');
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  // Putting whatever is left after this payment on agreed dates. Offered only
  // to a customer approved for it: a plan on ONE invoice is a negotiation
  // about one document and anybody may have one, but the whole account going
  // on terms is a standing credit arrangement.
  const canPlan = !!client?.allow_installments;
  // Whether they are already on one. Without this an unticked box reads as
  // "there is no plan" every time the modal is opened, which is backwards —
  // and ticking it only earns a refusal from the server.
  const [existing, setExisting] = useState(null);
  useEffect(() => {
    let alive = true;
    getClientPlan(client.id)
      .then(r => { if (alive) setExisting(r?.plan || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [client.id]);

  // What the customer is being asked to agree to, worked out as they type.
  // The same rule the server applies — equal payments with the last carrying
  // the rounding — so the preview and the schedule cannot disagree.
  function schedulePreview(total, count, freq, startISO) {
    const n = Math.max(1, Math.floor(Number(count) || 0));
    if (!(total > 0.005)) return [];
    const step = { monthly: 1, quarterly: 3, yearly: 12 }[freq] || 1;
    const each = Math.round((total / n) * 100) / 100;
    const start = startISO ? new Date(`${startISO}T00:00:00`) : new Date();
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const d = new Date(start);
      // Clamped to the end of the month, as the server does: a plan starting
      // on the 31st must not skip February.
      const day = start.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + step * i);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      const amount = i === n - 1
        ? Math.round((total - each * (n - 1)) * 100) / 100
        : each;
      out.push({ due: d.toISOString().slice(0, 10), amount });
    }
    return out;
  }
  const [onPlan, setOnPlan] = useState(false);
  const [planCount, setPlanCount] = useState(
    client?.default_installment_count ? String(client.default_installment_count) : '4');
  const [planFreq, setPlanFreq] = useState(
    client?.default_installment_frequency || 'monthly');
  const [planStart, setPlanStart] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [printing, setPrinting] = useState(false);

  // Same rule the server uses: oldest first, by due date then id. Drafts and
  // voided invoices are not owed and never appear.
  const owing = useMemo(() => (invoices || [])
    .filter(i => !i.voided_at && i.status !== 'Pending Approval')
    .map(i => ({
      ...i,
      due: Math.round(((i.amount || 0) - (i.paid_amount || 0)) * 100) / 100,
    }))
    .filter(i => i.due > 0.005)
    .sort((a, b) => String(a.due_date || a.created_at || '')
      .localeCompare(String(b.due_date || b.created_at || '')) || a.id - b.id),
    [invoices]);

  const totalOwed = owing.reduce((s, i) => s + i.due, 0);

  const preview = useMemo(() => {
    let left = Number(amount) || 0;
    return owing.map(i => {
      const take = Math.min(left, i.due);
      left = Math.round((left - take) * 100) / 100;
      return { ...i, applied: take };
    }).filter(i => i.applied > 0.005);
  }, [amount, owing]);

  const over = (Number(amount) || 0) > totalOwed + 0.005;
  // What the schedule would actually cover: everything still owed once
  // this payment has been applied.
  const remainingAfter = Math.max(0,
    Math.round((totalOwed - (Number(amount) || 0)) * 100) / 100);

  const planPreview = (canPlan && onPlan)
    ? schedulePreview(remainingAfter, planCount, planFreq, planStart)
    : [];

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await recordCustomerPayment(client.id, {
        amount: Number(amount),
        method,
        currency: ccy,
        exchange_rate: rate === '' ? null : Number(rate),
        note: note.trim() || null,
        idempotency_key: `cust-${client.id}-${Date.now()}`,
        ...(onPlan && canPlan ? {
          installment_plan: {
            count:      Number(planCount),
            frequency:  planFreq,
            start_date: planStart || null,
          },
        } : {}),
      });
      setResult(res);
      toast(res.message);
      onDone?.();
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setSaving(false);
    }
  }

  // The customer is standing there waiting for the slip. The number comes
  // from the server and is the same on every reprint, so pressing this twice
  // hands out one receipt printed twice — not two receipts.
  async function printVoucher() {
    setPrinting(true);
    try {
      const voucher = await issuePaymentVoucher(result.payment_id);
      await printPaymentVoucher(voucher);
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setPrinting(false);
    }
  }

  // Once it has happened, show what actually happened rather than the preview.
  if (result) {
    return (
      <Modal title={t('clients.paymentRecorded')} onClose={onClose}>
        <div className="modal-body">
          <p style={{ fontSize: 14, marginBottom: 14 }}>{result.message}</p>

          {/* The schedule that was just agreed. Confirming the payment and
              saying nothing about the plan is how somebody comes away unsure
              whether the terms were recorded at all. */}
          {result.plan && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                {t('clients.planAgreed', {
                  count: result.plan.count, total: fmt(result.plan.total),
                })}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('installments.dueDate')}</th>
                    <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.plan.installments.map(i => (
                    <tr key={i.seq}>
                      <td className="text-mono">{i.seq}</td>
                      <td>{fmtDate(i.due_date)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {t('clients.planOnAccountHint')}
              </div>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>{t('reports.invoiceNumber')}</th>
                <th style={{ textAlign: 'right' }}>{t('clients.applied')}</th>
                <th style={{ textAlign: 'right' }}>{t('invoices.remaining')}</th>
              </tr>
            </thead>
            <tbody>
              {(result.allocated || []).map(a => (
                <tr key={a.invoice_id}>
                  <td className="td-primary">{a.invoice_number}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(a.applied)}</td>
                  <td style={{ textAlign: 'right',
                               color: a.settled ? 'var(--green)' : 'var(--red)' }}>
                    {a.settled ? t('clients.settled') : fmt(a.now_owing)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.still_outstanding > 0.005 && (
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>
              {t('clients.stillOutstanding', { amount: fmt(result.still_outstanding) })}
            </p>
          )}
        </div>
        <div className="modal-footer">
          {result.payment_id && (
            <button className="btn btn-secondary" onClick={printVoucher} disabled={printing}>
              {printing ? t('common.saving') : `🧾 ${t('invoices.receiptVoucher')}`}
            </button>
          )}
          <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('invoices.recordPayment')} onClose={onClose} size="modal-lg">
      <form onSubmit={submit}>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
            {t('clients.owesTotal', { name: client.name, amount: fmt(totalOwed) })}
          </p>

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">{t('invoices.paymentAmount')} *</label>
              <NumberInput className="form-control" min="0.01" step="0.01" required
                value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('invoices.paymentCurrency')}</label>
              <select className="form-control" value={ccy}
                onChange={e => setCcy(e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {ccy !== 'USD' && (
              <div className="form-group">
                <label className="form-label">{t('invoices.exchangeRateLabel')}</label>
                <NumberInput className="form-control" min="0.0001" step="any"
                  value={rate} onChange={e => setRate(e.target.value)} />
              </div>
            )}
            <div className="form-group">
              <label className="form-label">{t('invoices.methodLabel')}</label>
              <select className="form-control" value={method}
                onChange={e => setMethod(e.target.value)}>
                {METHODS.map(m => <option key={m} value={m}>{tEnumValue(m)}</option>)}
              </select>
            </div>
            <div className="form-group form-full">
              <label className="form-label">{t('invoices.noteOptional')}</label>
              <input className="form-control" value={note}
                onChange={e => setNote(e.target.value)} />
            </div>

            {/* The rest of the account, on agreed dates. Shown only to a
                customer approved for it — the setting on their record. */}
            {/* Already on one: say so, and say what this payment does to it.
                An empty checkbox offering to create a second is worse than
                nothing — the server refuses it and the operator learns
                nothing about the plan that exists. */}
            {existing && (
              <div className="form-group form-full">
                <div style={{ padding: '10px 12px', borderRadius: 6,
                              background: 'var(--bg)', fontSize: 13 }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>
                    {t('clients.alreadyOnPlan', {
                      count: existing.count, remaining: fmt(existing.remaining),
                    })}
                  </div>
                  {existing.next_due && (
                    <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                      {t('clients.planNextIs', {
                        amount: fmt(existing.next_due.amount - existing.next_due.paid),
                        date: fmtDate(existing.next_due.due_date),
                      })}
                    </div>
                  )}
                  <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>
                    {t('clients.planCountsTowards')}
                  </div>
                </div>
              </div>
            )}
            {canPlan && !existing && (
              <div className="form-group form-full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13.5 }}>
                  <input type="checkbox" checked={onPlan}
                    onChange={e => setOnPlan(e.target.checked)} />
                  {t('clients.planTheRest')}
                </label>
                {onPlan && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                    {t('clients.planTheRestHint', { amount: fmt(remainingAfter) })}
                  </div>
                )}
              </div>
            )}
            {canPlan && !existing && onPlan && (
              <>
                <div className="form-group">
                  <label className="form-label">{t('installments.count')}</label>
                  <NumberInput className="form-control" min="1" step="1"
                    value={planCount} onChange={e => setPlanCount(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('installments.frequency')}</label>
                  <select className="form-control" value={planFreq}
                    onChange={e => setPlanFreq(e.target.value)}>
                    <option value="monthly">{t('installments.monthly')}</option>
                    <option value="quarterly">{t('installments.quarterly')}</option>
                    <option value="yearly">{t('installments.yearly')}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{t('installments.firstDue')}</label>
                  <input type="date" className="form-control" value={planStart}
                    onChange={e => setPlanStart(e.target.value)} />
                </div>
                {/* The agreement itself, in the words it will be explained in.
                    A count and a frequency are not something a customer can
                    say yes to; four dates and four amounts are. */}
                {planPreview.length > 0 && (
                  <div className="form-group form-full">
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                      {t('clients.planWillBe', {
                        count: planPreview.length, amount: fmt(remainingAfter),
                      })}
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>{t('installments.dueDate')}</th>
                          <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planPreview.map((p, i) => (
                          <tr key={p.due}>
                            <td className="text-mono">{i + 1}</td>
                            <td>{fmtDate(p.due)}</td>
                            <td style={{ textAlign: 'right' }}>{fmt(p.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                      {t('clients.planAccountHint')}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {over && (
            <div style={{ display: 'flex', gap: 10, padding: '12px 14px',
                          background: '#fef3c7', border: '1px solid #f59e0b',
                          borderRadius: 8, marginTop: 14 }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <span style={{ fontSize: 13, color: '#78350f' }}>
                {t('clients.overpaymentWarning', { amount: fmt(totalOwed) })}
              </span>
            </div>
          )}

          {preview.length > 0 && !over && (
            <>
              <div style={{ marginTop: 18, paddingTop: 14,
                            borderTop: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {t('clients.willSettle')}
                </span>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {t('clients.oldestFirst')}
                </div>
              </div>
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>{t('reports.invoiceNumber')}</th>
                    <th>{t('invoices.dueDate')}</th>
                    <th style={{ textAlign: 'right' }}>{t('invoices.remaining')}</th>
                    <th style={{ textAlign: 'right' }}>{t('clients.applied')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map(i => (
                    <tr key={i.id}>
                      <td className="td-primary">{i.invoice_number}</td>
                      <td>{i.due_date ? fmtDate(i.due_date) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(i.due)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(i.applied)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary"
            disabled={saving || over || !amount}>
            {saving ? t('invoices.recording') : t('invoices.recordBtn')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
