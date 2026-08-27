// Which bank account a payment went through.
//
// Shown only for a method that actually goes through one. A cash payment
// belongs to a drawer, not an account, and offering a bank picker beside it
// invites somebody to answer a question that has no answer — which then posts
// notes into a bank balance that has to reconcile against a statement.
//
// It hides itself entirely when no bank accounts have been set up, so a
// business that only takes cash never sees a field it cannot fill. That is
// also why the empty state names where to add one: the alternative is an
// operator staring at a picker with nothing in it.
import { useState, useEffect } from 'react';
import { getBankAccounts } from '../api/client';
import { useLocale } from '../hooks/useLocale.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

// The methods that settle through a bank rather than a till. Kept here rather
// than in each caller so a new method is added in one place.
const THROUGH_A_BANK = ['bank transfer', 'bank', 'cheque', 'check', 'card'];

export function settlesThroughBank(method) {
  return THROUGH_A_BANK.includes(String(method || '').trim().toLowerCase());
}

/** The accounts on file, loaded once per screen that needs them. */
export function useBankAccounts() {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    let alive = true;
    getBankAccounts()
      .then(rows => { if (alive) setAccounts(Array.isArray(rows) ? rows : []); })
      // A user without finance:view gets a 403 and simply no picker, rather
      // than an error on a form about something else.
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return accounts;
}

/**
 * The picker itself. Renders nothing at all unless the method settles through
 * a bank AND there is at least one account to choose.
 */
export default function BankField({ method, value, onChange, accounts,
                                    style, compact = false }) {
  const { t } = useLocale();
  const rows = (accounts || []).filter(a => !a.archived_at && a.is_active !== 0);
  if (!settlesThroughBank(method) || rows.length === 0) return null;

  return (
    <div className="form-group" style={{ margin: 0, ...(style || {}) }}>
      <label className="form-label">{t('banks.field')}</label>
      <SearchSelect
        className="form-control"
        value={value ?? ''}
        onChange={v => onChange(v)}
        placeholder={t('banks.unspecified')}
        options={(rows).map(a => ({ value: a.id, label: `${a.name}${!compact && a.bank_name ? ` · ${a.bank_name}` : ''}
            ${!compact && a.currency && a.currency !== 'USD' ? ` (${a.currency})` : ''}` }))} />
    </div>
  );
}
