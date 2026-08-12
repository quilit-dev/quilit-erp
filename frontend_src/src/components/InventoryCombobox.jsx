/**
 * InventoryCombobox
 * A description input that lets the user:
 *  - Type freely (manual item)
 *  - Type to search inventory and pick a matching item (auto-fills the price)
 *
 * It reads `sale_price`, NOT `unit_price`. Inventory has no `unit_price` column —
 * it has `unit_cost` (what you paid) and `sale_price` (what you charge). This
 * component asked for `unit_price`, got undefined, and so never filled a price
 * at all; the invoice form silently kept 0 on every picked item.
 *
 * Props:
 *  value        – current text value
 *  inventory    – [{ id, name, sale_price, price_currency, unit }]
 *  onChange     – (name, price, meta) => void
 *                 price: the item's sale price in ITS OWN currency, or null when
 *                        the user is free-typing (null = do not overwrite)
 *                 meta:  { inventory_id, price_currency, unit } — the id is what
 *                        lets the server link a line back to stock
 */
import { useState, useRef, useEffect } from 'react';

// Convert an inventory sale price into the document's base currency.
//
// Returns null rather than a guess when the conversion cannot be made
// confidently: writing an LBP figure into a USD invoice is worse than leaving
// the field for the user, because it looks like a real price.
export function salePriceInBase(price, from, exchangeRate, baseCode = 'USD') {
  if (price === null || price === undefined || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const base = exchangeRate?.base || baseCode;
  if (!from || from === base) return n;
  const rate = Number(exchangeRate?.rate) || 0;
  // The rest of the app treats rate as secondary-per-base (LBP per USD), so a
  // secondary-currency price divides back into base.
  if (from === exchangeRate?.secondary && rate > 0) return n / rate;
  return null;
}

export default function InventoryCombobox({ value, inventory = [], onChange }) {
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState(value || '');
  const [cursor, setCursor] = useState(-1);
  const wrapRef = useRef(null);

  // keep query in sync when parent resets the form
  useEffect(() => { setQuery(value || ''); }, [value]);

  // close on outside click
  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Show EVERYTHING, scrollable — not the first eight.
  //
  // Capping at 8 meant a catalogue of any size could only be reached by typing
  // the name you were trying to look up, which defeats the point of a picker.
  // The list is virtualised only by a generous cap: 200 rows render fine, and
  // past that the answer is a narrower search, not a longer list.
  const MAX_ROWS = 200;
  const q = query.trim().toLowerCase();
  const matches = q.length === 0
    ? inventory
    : inventory.filter(it =>
        String(it.name || '').toLowerCase().includes(q)
        || String(it.barcode || '').toLowerCase().includes(q)
        || String(it.category || '').toLowerCase().includes(q));
  // A name that STARTS with the query is almost always the one wanted, so it
  // sorts above an incidental mid-string match.
  const ranked = q.length === 0 ? matches : [...matches].sort((a, b) => {
    const as = String(a.name || '').toLowerCase().startsWith(q) ? 0 : 1;
    const bs = String(b.name || '').toLowerCase().startsWith(q) ? 0 : 1;
    return as - bs;
  });
  const filtered = ranked.slice(0, MAX_ROWS);
  const truncated = ranked.length > MAX_ROWS;

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    setOpen(true);
    setCursor(-1);
    // Free typing: no price, and no inventory link — this is a manual line.
    onChange(val, null, null);
  }

  function handlePick(item) {
    setQuery(item.name);
    setOpen(false);
    onChange(item.name, item.sale_price, {
      inventory_id: item.id,
      price_currency: item.price_currency || null,
      unit: item.unit || null,
    });
  }

  // Arrow keys + Enter. On a data-entry screen the hands are already on the
  // keyboard; forcing a mouse for every line is what makes bulk entry slow.
  function handleKeyDown(e) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setCursor(c => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
        if (next < 0) return filtered.length - 1;
        if (next >= filtered.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter' && open && cursor >= 0 && filtered[cursor]) {
      e.preventDefault();
      handlePick(filtered[cursor]);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1 }}>
      <input
        className="form-control"
        placeholder="Description or search inventory…"
        value={query}
        required
        autoComplete="off"
        onChange={handleInput}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        style={{ width: '100%', paddingInlineEnd: 26 }}
      />
      {/* Without this the control looks like a free-text box and nobody
          discovers there is a catalogue behind it. Clicking toggles the full
          list; mousedown (not click) so it beats the input's blur. */}
      <button type="button" tabIndex={-1} aria-label="Browse inventory"
        onMouseDown={(e) => { e.preventDefault(); setOpen(o => !o); }}
        style={{
          position: 'absolute', insetInlineEnd: 4, top: '50%',
          transform: 'translateY(-50%)', background: 'none', border: 0,
          cursor: 'pointer', color: 'var(--text-3)', padding: '2px 4px',
          lineHeight: 1, fontSize: 11,
        }}>
        {open ? '▲' : '▼'}
      </button>

      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--surface-1, #fff)',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 320, overflowY: 'auto',
        }}>
          <div style={{
            padding: '4px 10px 3px',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
            textTransform: 'uppercase', color: 'var(--text-3, #94a3b8)',
            borderBottom: '1px solid var(--border, #e2e8f0)',
          }}>
            Inventory · {ranked.length} item{ranked.length === 1 ? '' : 's'}
          </div>
          {filtered.map((item, idx) => (
            <div
              key={item.id}
              onMouseDown={() => handlePick(item)}   // mousedown fires before blur
              onMouseEnter={() => setCursor(idx)}
              style={{
                padding: '7px 10px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 13,
                borderBottom: '1px solid var(--border, #f1f5f9)',
                transition: 'background 0.1s',
                background: idx === cursor ? 'var(--surface-2, #f8fafc)' : 'transparent',
              }}
            >
              <span style={{ color: 'var(--text-1, #1e293b)', fontWeight: 500,
                             overflow: 'hidden', textOverflow: 'ellipsis',
                             whiteSpace: 'nowrap' }}>
                {item.name}
                {/* Stock is shown because picking the right variant usually
                    depends on what is actually on hand. */}
                <span style={{ color: 'var(--text-3)', fontWeight: 400, marginInlineStart: 6 }}>
                  {Number(item.quantity || 0) <= 0
                    ? '· out of stock'
                    : `· ${Number(item.quantity)} ${item.unit || ''}`.trim()}
                </span>
              </span>
              <span style={{ color: 'var(--text-3, #94a3b8)', fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap' }}>
                {Number(item.sale_price || 0).toFixed(2)}
                {item.price_currency ? ` ${item.price_currency}` : ''}
                {item.unit ? ` / ${item.unit}` : ''}
              </span>
            </div>
          ))}
          {truncated && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-3)',
                          fontStyle: 'italic' }}>
              Showing the first {MAX_ROWS} of {ranked.length} — keep typing to narrow it down.
            </div>
          )}
          {inventory.length === 0 && (
            <div style={{ padding: '8px 10px', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
              No inventory items yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}
