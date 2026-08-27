/**
 * A dropdown you can type into.
 *
 * The four lists this exists for — inventory, clients, projects, the chart of
 * accounts — are the ones that grow without bound. A business with nine hundred
 * products had a nine-hundred-row `<select>`, and picking from it meant
 * scrolling. Everything else in the app stays a plain select: a filter box over
 * five payment methods is more machinery than the problem needs.
 *
 * The API is deliberately the shape of the `<select>` it replaces — `value` and
 * an `onChange` handed the same string a `<select>` would give — so a call site
 * changes by swapping the element and mapping its rows, not by rethinking its
 * state.
 *
 * The panel is rendered through a PORTAL, positioned from the trigger's
 * bounding rect. `.modal` is `overflow: hidden` and `.modal-body` scrolls
 * inside it, so a panel that lived in the normal flow would be clipped at the
 * edge of the dialog — which is exactly where most of these fields are.
 *
 * Matching is case- and position-insensitive on both the label and the hint, so
 * "ink" finds "Ink Tube" and "4111" finds an account whose code that is. The
 * same rule the server-side search now follows.
 */
import { useState, useRef, useEffect, useMemo, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { useLocale } from '../hooks/useLocale.jsx';

const norm = (s) => String(s ?? '').toLowerCase();

const MIN_WIDTH = 200;

/** Where to put the panel, in viewport coordinates.
 *
 *  Flipped above the field when there is more room there — a picker near the
 *  bottom of a dialog would otherwise open into a few pixels of space.
 *
 *  Width follows the trigger so the two read as one control, but never goes
 *  below a readable minimum. When that minimum makes the panel WIDER than the
 *  field, the extra has to grow away from the field's start edge — which is the
 *  right-hand side in Arabic. Anchoring `left` in both directions leaves an
 *  RTL panel hanging off the wrong end of its own field.
 *
 *  Clamped to the viewport last, so a field near either edge of the window
 *  still opens something entirely on screen. */
function place(rect, panelH, rtl) {
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  const flip = below < panelH && above > below;
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), window.innerWidth - 16);
  const start = rtl ? rect.right - width : rect.left;
  return {
    width,
    left: Math.min(Math.max(8, start), window.innerWidth - width - 8),
    top: flip ? Math.max(8, rect.top - panelH - 4) : rect.bottom + 4,
    maxHeight: Math.max(120, (flip ? above : below) - 12),
  };
}

export default function SearchSelect({
  value,
  onChange,
  options = [],
  placeholder,            // the blank row's text, like <option value="">
  emptyText,              // shown when a query matches nothing
  disabled = false,
  required = false,
  allowBlank = true,
  className = 'form-control',
  style,
  id,
  title,
  'aria-label': ariaLabel,
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState(null);

  const btnRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const selected = useMemo(
    () => options.find(o => String(o.value) === String(value ?? '')) || null,
    [options, value]);

  const matches = useMemo(() => {
    const q = norm(query).trim();
    if (!q) return options;
    // Every word has to appear somewhere, in the label or the hint. Typing
    // "ink 12" finds "Ink Tube" with code 12 without demanding their order.
    const words = q.split(/\s+/);
    return options.filter((o) => {
      const hay = `${norm(o.label)} ${norm(o.hint)}`;
      return words.every(w => hay.includes(w));
    });
  }, [options, query]);

  const reposition = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const rtl = (document.documentElement.dir || '').toLowerCase() === 'rtl';
    setPos(place(el.getBoundingClientRect(), 300, rtl));
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    reposition();
    // `true` so a scroll inside .modal-body — not just the window — moves it.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  // Keep the highlighted row on a row that still exists after filtering.
  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.children?.[cursor];
    // Optional call: jsdom has no scrollIntoView, and neither does every
    // browser this might run in. Keeping the highlight visible is a nicety;
    // throwing over it would take the whole dropdown down.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, open]);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(opt) {
    onChange(opt ? String(opt.value) : '');
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[cursor]) pick(matches[cursor]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const shown = selected ? selected.label : (placeholder || '—');

  return (
    <>
      {/* A button, not an input: the closed state is a value someone chose, and
          a text box that discards what you type when it closes is a lie. */}
      <button
        type="button"
        ref={btnRef}
        id={id}
        title={title}
        aria-label={ariaLabel}
        className={className}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required={required || undefined}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          textAlign: 'start', cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          ...style,
        }}
      >
        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: selected ? 'var(--text)' : 'var(--text-3)',
          fontWeight: selected ? 500 : 400,
        }}>{shown}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.5" aria-hidden="true"
             style={{ color: 'var(--text-3)', flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed', top: pos.top, left: pos.left,
            width: pos.width, maxHeight: pos.maxHeight,
            // Above .modal (1000), because most of these sit inside one.
            zIndex: 1200,
            display: 'flex', flexDirection: 'column',
            background: 'var(--surface)',
            border: '1px solid var(--rule-strong)',
            borderRadius: 'var(--field-radius, 8px)',
            boxShadow: 'var(--shadow-lg)',
            overflow: 'hidden',
          }}
        >
          <input
            ref={inputRef}
            className="form-control"
            value={query}
            placeholder={t('common.search')}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            style={{
              border: 'none', borderBottom: '1px solid var(--rule)',
              borderRadius: 0, boxShadow: 'none', flexShrink: 0,
            }}
          />
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            style={{ overflowY: 'auto', padding: 4 }}
          >
            {allowBlank && !query && (
              <Row
                onPick={() => pick(null)}
                active={!selected}
                highlighted={false}
                label={placeholder || '—'}
                muted
              />
            )}
            {matches.map((o, i) => (
              <Row
                key={o.value}
                onPick={() => pick(o)}
                active={selected && String(selected.value) === String(o.value)}
                highlighted={i === cursor}
                onHover={() => setCursor(i)}
                label={o.label}
                hint={o.hint}
              />
            ))}
            {matches.length === 0 && (
              <div style={{ padding: '10px 10px', fontSize: 13,
                            color: 'var(--text-3)' }}>
                {emptyText || t('common.noResults')}
              </div>
            )}
          </div>
        </div>,
        document.body)}
    </>
  );
}

function Row({ label, hint, active, highlighted, muted, onPick, onHover }) {
  return (
    <div
      role="option"
      aria-selected={!!active}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      onMouseEnter={onHover}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
        fontSize: 13.5,
        background: highlighted ? 'var(--surface-2)' : 'transparent',
        color: muted ? 'var(--text-3)' : 'var(--text)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                     whiteSpace: 'nowrap' }}>{label}</span>
      {hint && (
        <span className="text-mono" style={{ fontSize: 11.5, color: 'var(--text-3)',
                                             flexShrink: 0 }}>{hint}</span>
      )}
    </div>
  );
}
