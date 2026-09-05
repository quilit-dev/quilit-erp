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
//
// `maxAmount` adds ONE more field, and only where the amount is genuinely a
// question: a purchase can now take a deposit and a balance, so "how much"
// has an answer other than "all of it". Without it the dialog is exactly what
// it was.
import { useState } from 'react';
import { Modal } from './shared';
import BankField, { useBankAccounts } from './BankField.jsx';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Card'];

export default function PayoutModal({ title, summary, confirmLabel,
                                      busy, onConfirm, onClose,
                                      maxAmount, amountLabel }) {
  const { t, tEnumValue } = useLocale();
  const accounts = useBankAccounts();
  const [method, setMethod] = useState('Bank Transfer');
  const [bankId, setBankId] = useState('');
  // Defaults to the whole outstanding balance: paying in full is much the
  // commoner case, and a part payment is then one edit rather than always
  // typing the number.
  const [amount, setAmount] = useState(maxAmount != null ? String(maxAmount) : '');
  const asks = maxAmount != null;
  const value = Number(amount);
  // Over the balance is refused by the server too; catching it here means the
  // user is told before the money is committed rather than after.
  const bad = asks && (!Number.isFinite(value) || value <= 0 || value > maxAmount + 0.005);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        {summary && (
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 14 }}>
            {summary}
          </p>
        )}
        <div className="form-grid">
          {asks && (
            <div className="form-group">
              <label className="form-label" htmlFor="payout-amount">
                {amountLabel || t('common.amount')}
              </label>
              <input id="payout-amount" className="form-control" type="number"
                step="0.01" min="0" max={maxAmount}
                value={amount} onChange={e => setAmount(e.target.value)} />
              {bad && (
                <p style={{ fontSize: 12, color: 'var(--negate-ink)', marginTop: 4 }}>
                  {t('purchases.payAmountRange', { max: maxAmount })}
                </p>
              )}
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('expenses.paymentMethodLabel')}</label>
            <SearchSelect
              className="form-control"
              value={method}
              onChange={v => { setMethod(v); setBankId(''); }}
              options={(METHODS).map(m => ({ value: m, label: tEnumValue(m) }))} />
          </div>
          <BankField method={method} value={bankId} onChange={setBankId}
            accounts={accounts} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || bad}
          onClick={() => onConfirm({
            payment_method: method,
            bank_account_id: bankId ? Number(bankId) : null,
            ...(asks ? { amount: value } : {}),
          })}>
          {busy ? t('common.saving') : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
