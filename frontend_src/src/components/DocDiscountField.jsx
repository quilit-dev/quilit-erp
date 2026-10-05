import { useId } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { NumberInput } from './shared';

/**
 * "Discount on the whole document": none, a percentage, or a fixed amount.
 * The arithmetic lives in utils/docDiscount.js and on the server; this is
 * only the control. `locked` shows what was given without letting it change
 * (an invoice that has taken payment).
 */
export default function DocDiscountField({ type, value, onChange, locked = false, currencyLabel = '$' }) {
  const { t } = useLocale();
  const id = useId();
  const kinds = [
    { k: '',        label: t('docDiscount.none') },
    { k: 'percent', label: '%' },
    { k: 'amount',  label: currencyLabel },
  ];
  if (locked) {
    return type ? (
      <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
        {t('docDiscount.label')}: {type === 'percent' ? `${Number(value)}%` : `${currencyLabel}${Number(value).toFixed(2)}`}
      </div>
    ) : null;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <label htmlFor={id} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
        {t('docDiscount.label')}
      </label>
      <div role="group" aria-label={t('docDiscount.kind')}
           style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {kinds.map(({ k, label }) => (
          <button key={k || 'none'} type="button" aria-pressed={(type || '') === k}
            className={`btn btn-sm ${(type || '') === k ? 'btn-primary' : 'btn-ghost'}`}
            style={{ borderRadius: 0, minWidth: 40 }}
            onClick={() => onChange(k, k ? value : '')}>
            {label}
          </button>
        ))}
      </div>
      {type && (
        <NumberInput id={id} className="form-control" style={{ width: 110, textAlign: 'right' }}
          min="0" step="0.01" max={type === 'percent' ? 100 : undefined}
          placeholder={type === 'percent' ? '10' : '100.00'}
          value={value} onChange={e => onChange(type, e.target.value)} />
      )}
    </div>
  );
}
