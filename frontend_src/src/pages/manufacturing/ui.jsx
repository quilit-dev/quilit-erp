import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { DisplayCurrencyToggle, fmt, secondaryAmount, NumberInput } from '../../components/shared';
import SearchSelect from '../../components/SearchSelect.jsx';

const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(v) || 0);

// Single-currency money display — shows USD or LBP based on the page-header
// DisplayCurrencyToggle. Replaces DualMoney here so the user sees one figure
// at a time instead of "USD ≈ LBP" stacked together.
function Money({ value }) {
  const { exchangeRate, displayCurrency } = useSettings();
  if (displayCurrency === 'LBP' && exchangeRate?.rate) {
    return <span>{secondaryAmount(value, exchangeRate)}</span>;
  }
  return <span>{fmt(value)}</span>;
}

const OUTPUT_TYPES = ['finished', 'semi_finished'];

const ORDER_STATUS = {
  Draft:         { bg: '#F3F4F6', color: '#6B7280' },
  Confirmed:     { bg: '#EFF6FF', color: '#2563EB' },
  'In Progress': { bg: '#FFFBEB', color: '#D97706' },
  Completed:     { bg: '#ECFDF5', color: '#059669' },
  Cancelled:     { bg: '#FEF2F2', color: '#DC2626' },
};

function StatusPill({ status }) {
  const { t } = useLocale();
  const s = ORDER_STATUS[status] || ORDER_STATUS.Draft;
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 9px', borderRadius: 20, fontSize: 11,
      fontWeight: 600, whiteSpace: 'nowrap', background: s.bg, color: s.color,
    }}>{t(`manufacturing.st_${status.replace(/ /g, '')}`)}</span>
  );
}

function TypeTag({ type }) {
  const { t } = useLocale();
  if (!type) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10,
      background: 'var(--surface-2)', color: 'var(--text-3)',
    }}>{t(`manufacturing.ptype_${type}`)}</span>
  );
}

// ── Cost input with optional USD/LBP entry toggle ───────────────────────────
function CostInput({ valueUsd, onChange, placeholder }) {
  const { exchangeRate } = useSettings();
  const lbp = exchangeRate?.rate || 0;
  const [cur, setCur] = useState('USD');
  const [raw, setRaw] = useState(valueUsd == null ? '' : String(valueUsd));

  function emit(rawVal, currency) {
    const n = Number(rawVal || 0);
    onChange(currency === 'LBP' && lbp ? n / lbp : n);
  }
  function handle(v) { setRaw(v); emit(v, cur); }
  function switchCur(next) {
    const usd = cur === 'LBP' && lbp ? Number(raw || 0) / lbp : Number(raw || 0);
    const shown = next === 'LBP' && lbp ? Math.round(usd * lbp) : usd;
    setCur(next);
    setRaw(usd ? String(shown) : '');
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <NumberInput className="form-control" step="any" min="0"
        value={raw} placeholder={placeholder} onChange={e => handle(e.target.value)} />
      {lbp > 0 && (
        <SearchSelect
          className="form-control"
          style={{ width: 70, flexShrink: 0 }}
          value={cur}
          onChange={v => switchCur(v)}
          options={[{ value: 'USD', label: 'USD' }, { value: 'LBP', label: 'LBP' }]} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BOM MODAL — create / edit / new version
// ════════════════════════════════════════════════════════════════════════════

export { num, OUTPUT_TYPES, ORDER_STATUS, Money, StatusPill, TypeTag, CostInput };
