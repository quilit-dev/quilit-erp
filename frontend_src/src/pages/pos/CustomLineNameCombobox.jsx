import { useState, useEffect, useRef } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { toast } from '../../components/shared';
import { getPosProducts } from '../../api/client';
import { productUsdUnitPrice, formatProductPrice } from './pricing';

function CustomLineNameCombobox({ line, taxEnabled, defaultRate, onPatch, placeholder }) {
  const { t } = useLocale();
  const { exchangeRate } = useSettings();
  const fxRate = Number(exchangeRate?.rate) || 0;
  const [open,     setOpen]     = useState(false);
  const [matches,  setMatches]  = useState([]);
  const [active,   setActive]   = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // close on outside click
  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // debounced product lookup — empty input → no suggestions
  useEffect(() => {
    const term = (line.name || '').trim();
    if (term.length < 1) { setMatches([]); return; }
    const tm = setTimeout(() => {
      getPosProducts(term)
        .then(rows => setMatches((rows || []).slice(0, 8)))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(tm);
  }, [line.name]);

  // reset the highlight when the result set changes
  useEffect(() => { setActive(0); }, [matches]);

  function pick(p) {
    if (String(p.price_currency || 'USD').toUpperCase() === 'LBP' && fxRate <= 0) {
      toast(t('pos.exchangeRate'), 'red');
      return;
    }
    onPatch({
      name:         p.name,
      inventory_id: p.id,
      unit_price:   productUsdUnitPrice(p, fxRate) || Number(line.unit_price) || 0,
      stock:        Number(p.quantity) || 0,
      line_type:    'product',
      // Preserve the cashier's tax-rate choice if they already changed it;
      // otherwise fall back to the default rate (matches addProduct flow).
      tax_rate_id:  line.tax_rate_id ?? (defaultRate ? defaultRate.id : null),
    });
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open || matches.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); pick(matches[active]); }
    else if (e.key === 'Escape')    { setOpen(false); }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className="form-control"
        style={{ height: 30 }}
        placeholder={placeholder}
        value={line.name || ''}
        autoComplete="off"
        onChange={e => { onPatch({ name: e.target.value }); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 240, overflowY: 'auto',
        }}>
          {matches.map((m, i) => (
            <div
              key={m.id}
              onMouseDown={() => pick(m)}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '6px 10px', cursor: 'pointer', fontSize: 12,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: i === active ? 'var(--surface-2)' : 'transparent',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11, marginInlineStart: 6 }}>
                  {Number(m.quantity || 0)}{m.unit ? ' ' + m.unit : ''} in stock
                </span>
              </span>
              <span style={{ fontWeight: 600, fontSize: 12 }}>
                {formatProductPrice(m, exchangeRate?.secondary)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



export { CustomLineNameCombobox };
