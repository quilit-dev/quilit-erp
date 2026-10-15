// Paying off an expense that was recorded as owed: what it cost, what has been
// paid, what is still owed, every payment so far, and a form for the next one.
// The server decides what is allowed (no overpaying, no paying a voided or
// unapproved expense); its refusal is the message shown.
import { useEffect, useState } from 'react';
import { getExpensePayments, addExpensePayment, voidExpensePayment } from '../api/client';
import { Modal, LoadingSpinner, ErrorAlert, NumberInput, ConfirmModal, Badge,
         fmt, fmtDate, toast, SelectOther } from './shared';
import SearchSelect from './SearchSelect.jsx';
import BankField from './BankField.jsx';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions';

const today = () => new Date().toISOString().slice(0, 10);

// The server says "Partially Paid"; the shared badge's colour key is "Partial".
export const paymentBadge = (s) => (s === 'Partially Paid' ? 'Partial' : s);

export default function ExpensePaymentsModal({ expense, onClose, onChanged,
                                              cashDrawers = [], bankAccounts = [] }) {
  const { t, tCategory } = useLocale();
  const { can } = usePermissions();
  const canPay = can('expenses', 'edit');
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState(false);
  const [voidId, setVoidId]   = useState(null);
  const [form, setForm]       = useState({
    amount: '', paid_at: today(), payment_method: expense.payment_method || 'Cash',
    bank_account_id: expense.bank_account_id || '', cash_drawer_id: null, note: '',
  });

  function load() {
    getExpensePayments(expense.id)
      .then(d => {
        setData(d);
        setForm(f => ({ ...f, amount: d.outstanding > 0 ? String(d.outstanding) : '' }));
      })
      .catch(e => setError(e.message));
  }
  useEffect(load, [expense.id]);

  async function handlePay(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await addExpensePayment(expense.id, {
        amount: Number(form.amount),
        paid_at: form.paid_at || null,
        payment_method: form.payment_method || null,
        bank_account_id: form.bank_account_id ? Number(form.bank_account_id) : null,
        cash_drawer_id: form.payment_method === 'Cash' ? form.cash_drawer_id : null,
        note: form.note || null,
      });
      toast(t('expenses.paymentRecorded'));
      setForm(f => ({ ...f, note: '' }));
      load(); onChanged?.();
    } catch (err) { toast(err.message, 'red'); }
    finally { setSaving(false); }
  }

  async function handleVoid() {
    try {
      await voidExpensePayment(expense.id, voidId, null);
      toast(t('expenses.paymentVoided'));
      setVoidId(null);
      load(); onChanged?.();
    } catch (err) { toast(err.message, 'red'); setVoidId(null); }
  }

  const name = expense.payee || expense.description || tCategory(expense.category);

  return (
    <Modal title={t('expenses.paymentsTitle', { name })} onClose={onClose}>
      <div className="modal-body">
        {error ? <ErrorAlert message={error} onRetry={load} /> : !data ? <LoadingSpinner /> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: t('expenses.totalLabelShort'),  value: fmt(data.amount),      color: 'var(--text)' },
                { label: t('expenses.paidLabel'),        value: fmt(data.paid_total),  color: 'var(--green)' },
                { label: t('expenses.outstandingLabel'), value: fmt(data.outstanding),
                  color: data.outstanding > 0 ? 'var(--red)' : 'var(--text-3)' },
              ].map(s => (
                <div key={s.label} className="stat-card" style={{ padding: '10px 14px' }}>
                  <div className="stat-label">{s.label}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {data.payments.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>{t('expenses.noPayments')}</p>
            ) : (
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>{t('expenses.paymentDate')}</th>
                      <th>{t('expenses.paymentMethodLabel')}</th>
                      <th>{t('expenses.paymentNote')}</th>
                      <th style={{ textAlign: 'right' }}>{t('expenses.paymentAmount')}</th>
                      <th style={{ width: 70 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map(p => (
                      <tr key={p.id} style={p.voided_at ? { opacity: 0.5 } : {}}>
                        <td>{fmtDate(p.paid_at)}</td>
                        <td>{p.method || '—'}</td>
                        <td style={{ color: 'var(--text-2)' }}>{p.voided_at ? (p.void_reason || t('expenses.voidedLabel')) : (p.note || '—')}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600,
                                     textDecoration: p.voided_at ? 'line-through' : 'none' }}>{fmt(p.amount)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {!p.voided_at && canPay && (
                            <button type="button" className="btn btn-sm btn-secondary"
                              onClick={() => setVoidId(p.id)}>{t('expenses.voidBtn')}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.outstanding > 0 && canPay && !expense.voided_at ? (
              <form onSubmit={handlePay}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{t('expenses.recordPayment')}</div>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">{t('expenses.paymentAmount')}</label>
                    <NumberInput className="form-control" required step="0.01" min="0.01"
                      max={data.outstanding}
                      value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('expenses.paymentDate')}</label>
                    <input type="date" className="form-control" value={form.paid_at}
                      onChange={e => setForm(f => ({ ...f, paid_at: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
                    <SelectOther
                      value={form.payment_method || ''}
                      onChange={v => setForm(f => ({ ...f, payment_method: v }))}
                      options={[
                        { value: 'Cash',          label: t('expenses.methodCash') },
                        { value: 'Bank Transfer', label: t('expenses.methodBank') },
                        { value: 'Cheque',        label: t('expenses.methodCheque') },
                        { value: 'Card',          label: t('expenses.methodCard') },
                      ]}
                      otherLabel={t('expenses.methodOther')} />
                  </div>
                  <BankField method={form.payment_method}
                    value={form.bank_account_id}
                    onChange={v => setForm(f => ({ ...f, bank_account_id: v }))}
                    accounts={bankAccounts} />
                  {form.payment_method === 'Cash' && cashDrawers.length > 0 && (
                    <div className="form-group">
                      <label className="form-label">{t('expenses.cashDrawerLabel')}</label>
                      <SearchSelect
                        className="form-control"
                        value={form.cash_drawer_id ?? ''}
                        onChange={v => setForm(f => ({ ...f, cash_drawer_id: v ? Number(v) : null }))}
                        placeholder={t('expenses.defaultDrawer')}
                        options={cashDrawers.map(d => ({ value: d.id, label: d.name }))} />
                    </div>
                  )}
                  <div className="form-group form-full">
                    <label className="form-label">{t('expenses.paymentNote')}</label>
                    <input className="form-control" value={form.note}
                      onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? t('common.saving') : t('expenses.recordPayment')}
                  </button>
                </div>
              </form>
            ) : data.outstanding <= 0 ? (
              <Badge status="Paid" />
            ) : null}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
      {voidId && (
        <ConfirmModal message={t('expenses.voidPaymentConfirm')} confirmClass="btn-danger"
          confirmLabel={t('expenses.voidBtn')}
          onConfirm={handleVoid} onCancel={() => setVoidId(null)} />
      )}
    </Modal>
  );
}
