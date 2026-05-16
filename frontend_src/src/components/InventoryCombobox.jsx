/**
 * InventoryCombobox
 * A description input that lets the user:
 *  - Type freely (manual item)
 *  - Type to search inventory and pick a matching item (auto-fills unit_price)
 *
 * Props:
 *  value        – current text value
 *  inventory    – array of inventory items [{ id, name, unit_price, unit }]
 *  onChange     – (name, unit_price) => void  called on pick or free-type
 */
import { useState, useRef, useEffect } from 'react';

export default function InventoryCombobox({ value, inventory = [], onChange }) {
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState(value || '');
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

  const filtered = query.trim().length === 0
    ? inventory.slice(0, 8)                                     // show first 8 when empty
    : inventory.filter(it =>
        it.name.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 8);

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    setOpen(true);
    onChange(val, null);   // null price = don't overwrite what user typed
  }

  function handlePick(item) {
    setQuery(item.name);
    setOpen(false);
    onChange(item.name, item.unit_price);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') setOpen(false);
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
        style={{ width: '100%' }}
      />

      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--surface-1, #fff)',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 220, overflowY: 'auto',
        }}>
          <div style={{
            padding: '4px 10px 3px',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
            textTransform: 'uppercase', color: 'var(--text-3, #94a3b8)',
            borderBottom: '1px solid var(--border, #e2e8f0)',
          }}>
            Inventory
          </div>
          {filtered.map(item => (
            <div
              key={item.id}
              onMouseDown={() => handlePick(item)}   // mousedown fires before blur
              style={{
                padding: '7px 10px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 13,
                borderBottom: '1px solid var(--border, #f1f5f9)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2, #f8fafc)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ color: 'var(--text-1, #1e293b)', fontWeight: 500 }}>
                {item.name}
              </span>
              <span style={{ color: 'var(--text-3, #94a3b8)', fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap' }}>
                ${Number(item.unit_price || 0).toFixed(2)}
                {item.unit ? ` / ${item.unit}` : ''}
              </span>
            </div>
          ))}
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
