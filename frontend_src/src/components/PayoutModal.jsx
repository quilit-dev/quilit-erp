// How a payment going OUT was made.
//
// Marking a supplier invoice paid, or a payroll run paid, used to be a single
// click that said nothing about how the money left. So it left the till: both
// paths credited cash, and on a chart that keeps the till and the bank apart
// that is simply false — the drawer was short by every transfer it never made.
//
// One click is still one dialog, not a form. Method, and the account when the
// method uses one; nothing else, because nothing else is being decided here.
// Both answers are optional in the API, so a user who does not know can press
// straight through and get the old behaviour rather than a blocked screen.
import { useState } from 'react';
import { Modal } from './shared';
import BankField, { useBankAccounts } from './BankField.jsx';
import { useLocale } from '../hooks/useLocale.jsx';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card'];

export default function PayoutModal({ title, summary, confirmLabel,
                                      busy, onConfirm, onClose }) {
  const { t, tEnumValue } = useLocale();
  const accounts = useBankAccounts();
  const [method, setMethod] = useState('Bank Transfer');
  const [bankId, setBankId] = useState('');

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        {summary && (
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
            {summary}
          </p>
        )}
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
            <select className="form-control" value={method}
              onChange={e => { setMethod(e.target.value); setBankId(''); }}>
              {METHODS.map(m => (
                <option key={m} value={m}>{tEnumValue(m)}</option>
              ))}
            </select>
          </div>
          <BankField method={method} value={bankId} onChange={setBankId}
            accounts={accounts} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy}
          onClick={() => onConfirm({
            payment_method: method,
            bank_account_id: bankId ? Number(bankId) : null,
          })}>
          {busy ? t('common.saving') : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
