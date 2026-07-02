// Shared leaf pieces for the Cash module: date/money formatting (USD and
// LBP strictly separate), the variance tag, and movement categories.
import { useLocale } from '../../hooks/useLocale.jsx';

export const today = () => new Date().toISOString().slice(0, 10);

import { money } from '../../utils/format';
export { money };

export function VarianceTag({ value, currency }) {
  const { t } = useLocale();
  if (value == null) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const balanced = Math.abs(value) < (currency === 'LBP' ? 1 : 0.01);
  const color = balanced ? 'var(--green)' : 'var(--red)';
  const word = balanced ? t('cash.balanced') : value > 0 ? t('cash.over') : t('cash.short');
  return (
    <span style={{ color, fontWeight: 600 }}>
      {money(value, currency)}{!balanced && ` (${word})`}
    </span>
  );
}

export const CATS = {
  in:  ['Float', 'Sale', 'Transfer In', 'Other'],
  out: ['Payout', 'Bank Deposit', 'Supplier Payment', 'Transfer Out', 'Other'],
};
