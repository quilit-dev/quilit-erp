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
import { useState, useMemo } from 'react';
import { recordCustomerPayment } from '../../api/client';
import { Modal, NumberInput, fmt, fmtDate, toast } from '../../components/shared';
import { CURRENCIES } from '../settings/ui';
import { useLocale } from '../../hooks/useLocale.jsx';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card', 'Other'];

export default function CustomerPaymentModal({ client, invoices, onClose, onDone }) {
  const { t, tEnumValue } = useLocale();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [ccy, setCcy] = useState('USD');
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

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
