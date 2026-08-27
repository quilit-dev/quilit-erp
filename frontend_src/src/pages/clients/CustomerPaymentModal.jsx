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
import { useSettings } from '../../hooks/useSettings.jsx';
import BankField, { useBankAccounts } from '../../components/BankField.jsx';
import { CURRENCIES } from '../settings/ui';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];

export default function CustomerPaymentModal({ client, invoices, onClose, onDone }) {
  const { t, tEnumValue } = useLocale();
  // The rates somebody recorded, per currency. A customer whose account is in
  // euro is paid in euro, and the rate that applies is the euro one — not a
  // number the operator has to remember, and not the pound rate because that
  // happened to be the only one the app could read.
  const { rateFor, rates } = useSettings();
  // Which account the transfer landed in. Blank is fine — the money
  // still reaches the bank, just the general one rather than a named
  // account — so this never blocks taking a payment.
  const banks = useBankAccounts();
  const [bankId, setBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  // The currency this customer settles in, when one is recorded against
  // them. It is a starting point, not a constraint — they can hand over
  // anything and the operator changes it.
  const [ccy, setCcy] = useState(
    CURRENCIES.includes(client?.preferred_currency) ? client.preferred_currency : 'USD');
  const [rate, setRate] = useState('');
  // Follows the currency, and keeps following it until the operator types
  // their own figure — a cashier handed euro at a rate the street agreed on
  // has better information than a table somebody updated on Monday, and the
  // server honours whatever is sent.
  const [rateTouched, setRateTouched] = useState(false);
  useEffect(() => {
    if (rateTouched) return;
    const stored = rateFor(ccy);
    setRate(ccy === 'USD' || !stored ? '' : String(stored));
  }, [ccy, rateTouched, rates]);
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
        bank_account_id: bankId ? Number(bankId) : null,
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
              <SearchSelect
                className="form-control"
                value={ccy}
                onChange={v => setCcy(v)}
                options={(CURRENCIES).map(c => ({ value: c, label: c }))} />
            </div>
            {ccy !== 'USD' && (
              <div className="form-group">
                <label className="form-label">{t('invoices.exchangeRateLabel')}</label>
                <NumberInput className="form-control" min="0.0001" step="any"
                  value={rate}
                  onChange={e => { setRateTouched(true); setRate(e.target.value); }} />
                {/* Which rate this is and when it was set, so an operator can
                    see they are converting at a figure from three weeks ago
                    before they take the money rather than afterwards. */}
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  {rates?.[ccy]?.effective_date && !rateTouched
                    ? t('rates.usingFrom', {
                        date: fmtDate(rates[ccy].effective_date) })
                    : rateFor(ccy) ? '' : t('rates.noneFor', { currency: ccy })}
                </div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">{t('invoices.methodLabel')}</label>
              <SearchSelect
                className="form-control"
                value={method}
                onChange={v => setMethod(v)}
                options={(METHODS).map(m => ({ value: m, label: tEnumValue(m) }))} />
            </div>
            <BankField method={method} value={bankId} onChange={setBankId}
              accounts={banks} />
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
            {/* Terms are agreed in the payment-plan panel on the customer's
                overview, exactly as they are in the panel beside an invoice.
                Taking money and agreeing a schedule are two different acts,
                and doing the second as a side effect of the first is how a
                plan gets agreed that nobody sat down and agreed. */}
            {canPlan && !existing && (
              <div className="form-group form-full">
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {t('clients.planLivesOnOverview')}
                </div>
              </div>
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
