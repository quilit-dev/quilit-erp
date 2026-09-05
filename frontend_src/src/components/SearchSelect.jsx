/**
 * A dropdown you can type into.
 *
 * It began as a filter for the four lists that grow without bound — inventory,
 * clients, projects, the chart of accounts — where a nine-hundred-row `<select>`
 * meant scrolling. It is now every dropdown in the app, because a native select
 * hands its list to the operating system: square corners, system font, no hover
 * styling, opening next to a designed panel on the field beside it. The closed
 * controls always matched to the pixel; only what opened gave it away.
 *
 * The filter box appears only when there is enough to filter. Below the
 * threshold the panel is just a styled list, because a search box over three
 * payment methods is a box nobody types in.
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
import {
  useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocale } from '../hooks/useLocale.jsx';

const norm = (s) => String(s ?? '').toLowerCase();

const MIN_WIDTH = 200;

// Only what to assume on the very first frame, when the panel is not in the
// document yet and there is nothing to measure. It is corrected before the
// browser paints, so it is never seen — but it used to be the ONLY height this
// component ever knew, which is what put a four-row payment-method list 300px
// above its own field with a gap of empty page between them.
const FIRST_GUESS_H = 300;

/** Where to put the panel, in viewport coordinates.
 *
 *  `panelH` must be the panel's REAL height. Flipping subtracts it from the
 *  top of the field, so a guessed height that is too large lifts the panel by
 *  the guess while it renders at its own size — leaving it floating well above
 *  the control it belongs to. The same guess also decides whether to flip at
 *  all, so a short list would jump upwards out of space it fitted in perfectly
 *  well.
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
export function place(rect, panelH, rtl) {
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  const flip = below < panelH && above > below;
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), window.innerWidth - 16);
  const start = rtl ? rect.right - width : rect.left;
  return {
    width,
    left: Math.min(Math.max(8, start), window.innerWidth - width - 8),
    // Anchored by the edge that touches the field: `top` under it, `bottom`
    // over it. A flipped panel positioned by `top` has to be told how tall it
    // is, and it was told 300 whatever it actually was — so a three-row page
    // size picker opened 194px above its own control with a strip of empty
    // page in between. Pinning the far edge instead lets it grow from the
    // field, and the height stops mattering at all.
    top:    flip ? undefined : rect.bottom + 4,
    bottom: flip ? Math.max(8, window.innerHeight - rect.top + 4) : undefined,
    flip,
    maxHeight: Math.max(120, (flip ? above : below) - 12),
  };
}

// Below this many rows the whole list is on screen at once, so a filter box
// would be a control that never earns its keystroke.
const SEARCH_FROM = 8;

export default function SearchSelect({
  value,
  onChange,
  options = [],
  placeholder,            // the blank row's text, like <option value="">
  emptyText,              // shown when a query matches nothing
  searchable,             // default: only once the list is long enough
  disabled = false,
  required = false,
  // A <select> has a blank row only when one was written into it, so this
  // follows the placeholder that stands in for `<option value="">`. Defaulting
  // it on gave a page-size picker a "—" row that meant nothing and, chosen,
  // meant nothing twice.
  allowBlank,
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

  const canSearch = searchable ?? options.length >= SEARCH_FROM;
  const blankRow = allowBlank ?? !!placeholder;

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
    // Measure the panel whenever it is on screen; the constant is a first
    // frame only.
    const h = panelRef.current?.offsetHeight || FIRST_GUESS_H;
    setPos(place(el.getBoundingClientRect(), h, rtl));
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

  // The panel is attached to the field either way now, so what is left to get
  // right is only WHETHER to flip: a short list with 200px under it fits
  // below, and the first-frame estimate of 300 would send it above for no
  // reason. Once the panel is in the document its height can be measured, so
  // the decision is made again with the real number.
  //
  // `placedH` is what stops this looping: repositioning re-renders, the effect
  // runs again, measures the same height and returns. It only acts when the
  // panel's height is not the one the current placement assumed.
  const placedH = useRef(0);
  useLayoutEffect(() => {
    if (!open) { placedH.current = 0; return; }
    const h = panelRef.current?.offsetHeight;
    if (!h || Math.abs(h - placedH.current) < 1) return;
    placedH.current = h;
    reposition();
    // `matches.length` and `canSearch` are what change the panel's height:
    // rows, and whether a search box sits above them. `pos` is here because
    // the first placement is what puts the panel on screen to be measured.
  }, [open, pos, matches.length, canSearch, reposition]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open, canSearch]);

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
            position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left,
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
          {canSearch && (
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
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            style={{ overflowY: 'auto', padding: 4 }}
          >
            {blankRow && !query && (
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
