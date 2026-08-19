import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { useScrollLock } from '../hooks/useScrollLock';
import { getBranchContext, getBranchFilter } from '../api/client';

// ── Icon set ───────────────────────────────────────────────────
// A small, consistent line-icon family (Lucide-style: 24-grid, currentColor
// stroke) used to replace decorative emoji on KPI cards, dashboard chips and the
// reconcile panel for a cleaner, professional look. `<Icon name="…" />` inherits
// the surrounding text colour; unknown names render nothing. Paths are static
// constants (no user input), injected via dangerouslySetInnerHTML to keep the
// map compact.
const ICON_PATHS = {
  'globe':          '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  // Added for the document row actions. A missing name renders an EMPTY
  // button — Icon has no fallback glyph — which is exactly how a blank
  // control shipped next to the PDF link.
  'download':       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  'message-circle': '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  // Paper plane. Channel-neutral on purpose: the Send action covers email AND
  // WhatsApp, so `mail` would misdescribe half of what the button does.
  'send':           '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  'banknote':       '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  'trending-up':    '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  'trending-down':  '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'alert-circle':   '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  'check-circle':   '<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>',
  'receipt':        '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  'clock':          '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'calendar':       '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  'package':        '<path d="M16.5 9.4 7.5 4.2"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'bar-chart':      '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  'target':         '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'award':          '<circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/>',
  'briefcase':      '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  'megaphone':      '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  'landmark':       '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  'building':       '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  'factory':        '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
  'sun':            '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  'shopping-bag':   '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  'clipboard':      '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  'mail':           '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'phone':          '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  'users':          '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'map-pin':        '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  'inbox':          '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'link':           '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'rotate-ccw':     '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  'scale':          '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  'zap':            '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'bell':           '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  'search':         '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'refresh-cw':     '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  'settings':       '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'sliders':        '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  'file-text':      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  'database':       '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  'arrow-left-right': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  'eye':            '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  'shield':         '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'paperclip':      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  'tag':            '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  'pencil':         '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  'file-spreadsheet': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  'ban':            '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  'book-open':      '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  'external-link':  '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  // Open arc — pair with `animation: spin` for in-progress actions.
  'loader':         '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
};

export function Icon({ name, size = 16, strokeWidth = 2, style }) {
  const inner = ICON_PATHS[name];
  if (!inner) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: inner }} />
  );
}

// ── Loading / Error / Empty states ─────────────────────────────
//
// Three primitives that share an editorial language: a thin rotating arc
// with an italic serif caption (Loading), a hairline tinted alert with an
// inline icon (Error), and an editorial empty page anchored by a large
// serif glyph rather than an emoji (Empty). The signatures stay the same
// so existing callers don't change.

export function LoadingSpinner() {
  const { t } = useLocale();
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--text-3)' }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
        strokeWidth="1.75" strokeLinecap="round"
        style={{ animation: 'spin 0.9s linear infinite', display: 'block', margin: '0 auto 14px' }}>
        <path d="M21 12a9 9 0 11-6.219-8.56" />
      </svg>
      <p style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--text-3)',
        letterSpacing: -0.005,
      }}>{t('common.loading')}</p>
    </div>
  );
}

export function ErrorAlert({ message, onRetry }) {
  const { t } = useLocale();
  return (
    <div className="alert alert-red">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && <button className="btn btn-sm btn-secondary" onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

// Empty state. Default mark is a thin "+" inside the hairline-dashed
// square the CSS draws — reads as an open slot waiting for data, no
// editorial italic vocabulary. Callers can still pass any glyph via
// `icon` for category-specific empties.
export function EmptyState({ message, icon }) {
  const { t } = useLocale();
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon || '+'}</div>
      <div className="empty-state-title">{t('common.nothingHere')}</div>
      <p>{message || t('common.noDataFound')}</p>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────
//
// Standard dialog frame. The CSS handles the geometry — sticky header +
// scrollable body + sticky footer — so callers should always wrap their
// content in <div className="modal-body"> (and an optional .modal-footer
// for actions). The shared Modal locks the body scroll for as long as it
// is mounted to prevent the page underneath from scrolling when the
// wheel hits the end of the modal content.
export function Modal({ title, onClose, children, size = '' }) {
  useScrollLock(true);
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} style={{ marginInlineStart: 8 }} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Badge helper ───────────────────────────────────────────────
const statusColors = {
  Draft: 'gray', Sent: 'blue', Accepted: 'green', Rejected: 'red',
  Inquiry: 'gray', 'Quotation Sent': 'blue', Approved: 'accent',
  'In Progress': 'blue', Completed: 'green', Invoiced: 'accent',
  Unpaid: 'red', Partial: 'yellow', Paid: 'green',
  // Instalment statuses. Overdue was already translatable but had no colour,
  // so it rendered grey — the one status that most needs to be red.
  Overdue: 'red', Due: 'gray',
  low: 'red', ok: 'green',
  Ordered: 'blue', Received: 'accent', 'Paid (PO)': 'green',
  Voided: 'red', Cancelled: 'red',
  'Pending Approval': 'yellow',
};

export function Badge({ status }) {
  const { tStatus } = useLocale();
  const color = statusColors[status] || 'gray';
  return <span className={`badge badge-${color}`}>{tStatus(status)}</span>;
}

// ── Supplier search-select (type-ahead combobox) ───────────────
// Free-text input with a filtered supplier dropdown — the supplier name is
// stored as text, so an unknown name can still be typed. Shared by the
// Purchase Order form and the Inventory item form. Pass required for forms
// where a supplier is mandatory (purchases); it defaults to optional.
export function SupplierCombobox({ value, suppliers = [], onChange, required = false, placeholder }) {
  const { t } = useLocale();
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState(value || '');
  const wrapRef = useRef(null);

  useEffect(() => { setQuery(value || ''); }, [value]);

  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim().length === 0
    ? suppliers.slice(0, 8)
    : suppliers.filter(s => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        className="form-control"
        placeholder={placeholder || t('purchases.searchSupplierPlaceholder')}
        value={query}
        required={required}
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); setOpen(true); onChange(e.target.value); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--surface-1, #fff)', border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 200, overflowY: 'auto',
        }}>
          <div style={{ padding: '4px 10px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
            textTransform: 'uppercase', color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
            {t('purchases.suppliersDropHeader')}
          </div>
          {filtered.map(s => (
            <div key={s.id}
              onMouseDown={() => { setQuery(s.name); setOpen(false); onChange(s.name); }}
              style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 13,
                borderBottom: '1px solid var(--border, #f1f5f9)', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2, #f8fafc)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontWeight: 500 }}>{s.name}</span>
              {s.contact_name && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{s.contact_name}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Number input that shows a greyed "0" placeholder ───────────
// Drop-in replacement for <input type="number">. A field whose value is the
// default numeric 0 (or null/empty) renders blank with a greyed "0" placeholder
// instead of a literal 0 — so typing "1" gives "1", not "10". A value the user
// actually typed (a string, including "0" or "0.5") shows normally, so decimals
// keep working. All other props (className, min, step, onChange, …) pass through.
/**
 * Makes a field safe to scan into.
 *
 * A USB barcode scanner is a keyboard: it types the code and then sends Enter.
 * Enter in a single-line input inside a <form> with a submit button SUBMITS THE
 * FORM — so scanning a barcode halfway through "Add item" saved the item there
 * and then, before cost, price, category or unit were filled. It did not error
 * and nothing looked wrong; the item was simply created half-empty.
 *
 * Swallow the Enter and the scan just fills the box, which is what the operator
 * expects. Attach to any field a scanner may be pointed at:
 *
 *     <input onKeyDown={swallowScannerEnter} … />
 *
 * Not needed for a field that is NOT inside a submitting form (the inventory
 * search box, for instance) — there, Enter already does nothing.
 */
export function swallowScannerEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    // Stop here rather than advancing focus: after a scan the operator is
    // usually still mid-form, and moving the cursor for them is its own
    // surprise.
  }
}

export function NumberInput({ value, placeholder = '0', ...props }) {
  const blank = value === 0 || value === null || value === undefined || value === '';
  return <input {...props} type="number" placeholder={placeholder} value={blank ? '' : value} />;
}

// ── Select with an inline "Other" entry ────────────────────────
// A drop-in replacement for a <select> whose list can't cover every value.
// Picking the "Other…" option reveals an inline text input so the user can
// type a value that isn't in the list (e.g. a payment method or lead source
// not offered as a preset). Only use this for FREE-TEXT backend fields — never
// for closed enums (e.g. expense category, which maps to GL accounts).
//
//   <SelectOther value={form.x} onChange={v => setForm(f => ({...f, x: v}))}
//     options={[{ value: 'Cash', label: 'Cash' }, ...]} includeNone />
//
// Renders inside conditionally-mounted modals, so its "other mode" resets
// naturally each time the form is opened.
export function SelectOther({
  value, onChange, options = [],
  includeNone = false, noneLabel = '—',
  otherValue = '__other__', otherLabel, placeholder,
  className = 'form-control', required = false,
  labelFn,
}) {
  const { t } = useLocale();
  // labelFn lets callers localise the display label (e.g. categories) while the
  // stored value stays canonical English.
  const norm = (o) => (o && typeof o === 'object' ? o : { value: o, label: labelFn ? labelFn(o) : o });
  const opts = options.map(norm);
  const inList = (v) => opts.some(o => o.value === v);
  const isCustom = value != null && value !== '' && !inList(value);

  const [other, setOther] = useState(isCustom);
  useEffect(() => {
    // Re-sync when the value changes from outside (e.g. opening an edit form).
    // A blank value is left alone so a fresh "Other" pick keeps the input open.
    if (value && inList(value)) setOther(false);
    else if (value && !inList(value)) setOther(true);
  }, [value]);

  const showInput = other || isCustom;

  const onSelect = (e) => {
    const v = e.target.value;
    if (v === otherValue) { setOther(true); onChange(''); }
    else { setOther(false); onChange(v); }
  };

  return (
    <>
      <select
        className={className}
        value={showInput ? otherValue : (value ?? '')}
        onChange={onSelect}
        required={required}
      >
        {includeNone && <option value="">{noneLabel}</option>}
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        <option value={otherValue}>{otherLabel || t('common.otherOption')}</option>
      </select>
      {showInput && (
        <input
          className={className}
          style={{ marginTop: 8 }}
          placeholder={placeholder || t('common.otherSpecify')}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        />
      )}
    </>
  );
}

// ── Branch picker (multi-branch) ───────────────────────────────
// "Branch" == a warehouse/location. Renders a labelled select of branches so a
// create form can target one explicitly. It renders NOTHING for branch-scoped
// users (they have a single home branch and the backend forces writes into it)
// and only appears for GLOBAL users (superadmin / Business Owner) when more than
// one branch exists — so the UI never offers a branch the backend would reject.
//
//   <BranchField value={form.branch_id}
//     onChange={v => setForm(f => ({ ...f, branch_id: v }))} />
//
// `value` is a branch id (number) or '' / null. Defaults to the currently
// focused branch (the sidebar switcher) the first time it mounts on a fresh
// form, so "focus Branch B → add expense" lands in B without extra clicks.
export function BranchField({ value, onChange, label }) {
  const { t } = useLocale();
  const [branches, setBranches] = useState([]);
  const [isGlobal, setIsGlobal] = useState(false);
  useEffect(() => {
    let alive = true;
    getBranchContext()
      .then(data => {
        if (!alive) return;
        const list = (data && data.branches) || [];
        setIsGlobal(!!(data && data.is_global));
        setBranches(list);
        // Seed an empty form with the focused branch, or the default branch.
        if ((value == null || value === '') && data && data.is_global && list.length > 1) {
          const focused = getBranchFilter();
          const def = list.find(b => b.is_default);
          const seed = focused && list.some(b => String(b.id) === String(focused))
            ? focused : (def ? def.id : '');
          if (seed !== '' && seed != null) onChange(seed);
        }
      })
      .catch(() => { /* non-critical */ });
    return () => { alive = false; };
  }, []);

  if (!isGlobal || branches.length <= 1) return null;   // scoped users → no picker
  return (
    <div className="form-group">
      <label className="form-label">{label || t('nav.branch')}</label>
      <select className="form-control" value={value ?? ''}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : '')}>
        {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
  );
}

// ── Expense category badge ─────────────────────────────────────
export const CATEGORY_COLORS = {
  Labour:        { bg: '#EFF6FF', color: '#2563EB' },
  Materials:     { bg: '#ECFDF5', color: '#059669' },
  Equipment:     { bg: '#FFFBEB', color: '#D97706' },
  Transport:     { bg: '#F5F3FF', color: '#7C3AED' },
  Subcontractor: { bg: '#FFF7ED', color: '#EA580C' },
  Permits:       { bg: '#F0FDF4', color: '#16A34A' },
  Purchase:      { bg: '#EEF2FF', color: '#4F46E5' },
  Rent:          { bg: '#FEF2F2', color: '#DC2626' },
  Utilities:     { bg: '#ECFEFF', color: '#0891B2' },
  Salary:        { bg: '#FDF2F8', color: '#DB2777' },
  Subscription:  { bg: '#F0F9FF', color: '#0284C7' },
  Insurance:     { bg: '#F0FDFA', color: '#0D9488' },
  Depreciation:  { bg: '#F3F4F6', color: '#475569' },
  Other:         { bg: '#F9FAFB', color: '#6B7280' },
};

export function CategoryBadge({ category }) {
  const { tCategory } = useLocale();
  const style = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px',
      borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: style.bg, color: style.color,
    }}>
      {tCategory(category)}
    </span>
  );
}

// ── Currency format (static fallback — prefer useLocale().fmt in components) ──
export function fmt(val, currency) {
  const cur = currency || localStorage.getItem('erp_currency') || 'USD';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0 }).format(val || 0);
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Dual-currency display ──────────────────────────────────────
// Shows a base-currency (USD) amount and, when an admin has set a manual
// exchange rate, its secondary-currency (LBP) equivalent. Both pull the rate
// from the SettingsProvider context, so nothing needs prop-drilling.
const _grp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function secondaryAmount(value, exchangeRate) {
  if (!exchangeRate || !exchangeRate.rate) return null;
  return `${_grp.format((Number(value) || 0) * exchangeRate.rate)} ${exchangeRate.secondary}`;
}

export function DualMoney({ value, block = true, style }) {
  const { exchangeRate, displayCurrency } = useSettings();
  const usd = fmt(value);
  const lbp = secondaryAmount(value, exchangeRate);
  // No rate set yet → single-currency display.
  if (!lbp) return <span style={style}>{usd}</span>;
  const showLbp  = displayCurrency === 'LBP';
  const primary  = showLbp ? lbp : usd;
  const secondary = showLbp ? usd : lbp;
  return (
    <span style={style}>
      {primary}
      <span style={{
        display: block ? 'block' : 'inline',
        marginInlineStart: block ? 0 : 6,
        fontSize: '0.82em', fontWeight: 400, color: 'var(--text-3)', whiteSpace: 'nowrap',
      }}>
        ≈ {secondary}
      </span>
    </span>
  );
}

// Single-currency formatter — the counterpart to <DualMoney>. Respects the
// page-header DisplayCurrencyToggle and renders ONE currency at a time (USD or
// LBP), never both. Returns a money(value) -> string function so it works in
// JSX and string-concatenation contexts alike. Falls back to base-currency
// (USD) when no exchange rate is set — the toggle is hidden then anyway, so the
// page simply stays single-currency.
export function useMoney() {
  const { exchangeRate, displayCurrency } = useSettings();
  return (value) => {
    if (displayCurrency === 'LBP' && exchangeRate?.rate) {
      return secondaryAmount(value, exchangeRate);
    }
    return fmt(value);
  };
}

// A two-button segmented control that flips the app-wide display currency.
// Renders nothing until an admin has set an exchange rate.
export function DisplayCurrencyToggle() {
  const { exchangeRate, displayCurrency, setDisplayCurrency } = useSettings();
  const { t } = useLocale();
  if (!exchangeRate || !exchangeRate.rate) return null;
  const opts = [exchangeRate.base || 'USD', exchangeRate.secondary || 'LBP'];
  return (
    <span
      title={t('common.displayCurrency')}
      style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}
    >
      {opts.map(c => {
        const active = displayCurrency === c;
        return (
          <button
            key={c} type="button" onClick={() => setDisplayCurrency(c)}
            style={{
              padding: '4px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: 'none', lineHeight: 1.6,
              background: active ? 'var(--accent)' : 'var(--surface)',
              color: active ? '#fff' : 'var(--text-2)',
            }}
          >
            {c}
          </button>
        );
      })}
    </span>
  );
}

export function ExchangeRateBadge() {
  const { exchangeRate } = useSettings();
  const { t } = useLocale();
  if (!exchangeRate || !exchangeRate.rate) return null;
  return (
    <span
      title={t('settings.exchangeRate')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
        background: 'var(--accent-light)', color: 'var(--accent)', whiteSpace: 'nowrap',
      }}
    >
      <Icon name="refresh-cw" size={12} />1 {exchangeRate.base} = {_grp.format(exchangeRate.rate)} {exchangeRate.secondary}
    </span>
  );
}

// ── Excel export ───────────────────────────────────────────────
export function exportToExcel(data, filename, sheetName = 'Sheet1') {
  if (!data || data.length === 0) { alert('No data to export.'); return; }
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/**
 * `data` exports what the caller already holds. `fetchData` is for screens that
 * only hold ONE PAGE: they pass an async function that fetches every matching
 * row, so the export stays the whole filtered set rather than silently
 * shrinking to whatever happened to be on screen — an export that quietly drops
 * rows is worse than one that fails.
 */
export function ExportButton({ data, fetchData, filename, sheetName }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!fetchData) { exportToExcel(data, filename, sheetName); return; }
    setBusy(true);
    try {
      exportToExcel(await fetchData(), filename, sheetName);
    } catch (e) {
      toast(e?.message || 'Export failed', 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn btn-secondary btn-sm" onClick={run} disabled={busy} title="Export to Excel">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      {busy ? t('common.exporting') : t('common.export')}
    </button>
  );
}

// ── WhatsApp share ─────────────────────────────────────────────────────────
// Normalise a free-text phone number into wa.me's expected digits-only form.
// Defaults to Lebanon (+961) for local numbers entered without a country code:
//   08-prefixed mobile / 8-digit number  →  961XXXXXXXX
//   01-prefixed landline                 →  9611XXXXXXX
//   '+' or '00' prefix is treated as international and kept verbatim
// Returns null when the input doesn't contain enough digits to be useful.
export function normaliseWhatsAppNumber(raw, { defaultCountry = '961' } = {}) {
  if (!raw) return null;
  const s = String(raw).trim();
  // International formats are kept as-is (digits only).
  if (s.startsWith('+'))  return s.slice(1).replace(/\D/g, '') || null;
  if (s.startsWith('00')) return s.slice(2).replace(/\D/g, '') || null;
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  // Already includes a country code (>= 10 digits and not starting with 0).
  if (digits.length >= 10 && !digits.startsWith('0')) return digits;
  // Lebanese-style local number: drop a leading 0 then prepend the country code.
  const local = digits.replace(/^0+/, '');
  if (!local) return null;
  return defaultCountry + local;
}

export function WhatsAppShareButton({ phone, message, label, title, disabledTitle }) {
  const { t } = useLocale();
  const num = normaliseWhatsAppNumber(phone);
  const txt = label || t('common.whatsapp') || 'WhatsApp';
  const disabled = !num;
  const href = num ? `https://wa.me/${num}?text=${encodeURIComponent(message || '')}` : '#';
  return (
    <a
      href={href}
      target={disabled ? undefined : '_blank'}
      rel="noopener noreferrer"
      className="btn btn-sm btn-secondary"
      aria-disabled={disabled}
      title={disabled
        ? (disabledTitle || t('common.whatsappNoPhone') || 'No phone number on file')
        : (title || t('common.whatsappSend') || 'Send via WhatsApp')}
      onClick={e => { if (disabled) e.preventDefault(); }}
      style={{
        opacity: disabled ? 0.55 : 1,
        cursor:  disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 9px', fontSize: 12, lineHeight: 1.4,
        textDecoration: 'none',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24"
        fill={disabled ? 'currentColor' : '#25D366'} aria-hidden="true">
        <path d="M20.52 3.48A11.84 11.84 0 0012.04 0C5.5 0 .2 5.3.2 11.86c0 2.09.55 4.13 1.6 5.93L0 24l6.36-1.67a11.84 11.84 0 005.67 1.45h.01c6.55 0 11.85-5.31 11.85-11.85 0-3.17-1.23-6.15-3.37-8.45zM12.04 21.5h-.01a9.66 9.66 0 01-4.92-1.35l-.35-.21-3.78.99 1.01-3.68-.23-.38a9.7 9.7 0 1117.99-5.01c0 5.36-4.36 9.64-9.71 9.64zm5.32-7.21c-.29-.15-1.72-.85-1.99-.94-.27-.1-.46-.15-.66.14-.2.3-.76.94-.93 1.13-.17.2-.35.22-.64.07-.29-.15-1.23-.45-2.34-1.45-.86-.77-1.45-1.71-1.62-2-.17-.3-.02-.45.13-.6.13-.13.29-.34.43-.5.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.66-1.6-.9-2.18-.24-.57-.48-.5-.66-.51l-.56-.01c-.2 0-.5.07-.77.36-.27.3-1.03 1-1.03 2.44s1.06 2.84 1.2 3.04c.15.2 2.07 3.17 5.03 4.45.7.3 1.25.48 1.68.62.71.23 1.35.2 1.86.12.57-.08 1.72-.7 1.96-1.38.24-.68.24-1.26.17-1.38-.07-.12-.27-.2-.56-.34z"/>
      </svg>
      {txt}
    </a>
  );
}

// ── Confirm modal ──────────────────────────────────────────────
export function ConfirmModal({
  message,
  onConfirm, onCancel,
  title,
  confirmLabel,
  confirmClass = 'btn-primary',
  confirmDisabled = false,
}) {
  const { t } = useLocale();
  const resolvedTitle = title || t('common.confirmAction');
  const resolvedConfirm = confirmLabel || t('common.confirm');
  const resolvedMessage = message || 'Are you sure you want to proceed?';
  // Render the message inline (<p>) for plain strings, but use a block <div>
  // for ReactNode payloads so callers can pass nested block elements without
  // tripping the "<p> cannot contain <p>" HTML warning.
  const isPlain = typeof resolvedMessage === 'string';
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && !confirmDisabled && onCancel()}>
      <div className="modal" style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: confirmClass === 'btn-danger' ? 'var(--red-light)' : 'var(--accent-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {confirmClass === 'btn-danger'
                ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              }
            </div>
            <span className="modal-title">{resolvedTitle}</span>
          </div>
        </div>
        <div className="modal-body">
          {isPlain
            ? <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>{resolvedMessage}</p>
            : <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>{resolvedMessage}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={confirmDisabled}>{t('common.cancel')}</button>
          <button className={`btn ${confirmClass}`} onClick={onConfirm} disabled={confirmDisabled}>{resolvedConfirm}</button>
        </div>
      </div>
    </div>
  );
}

// ── Sortable table header ──────────────────────────────────────
export function SortableTh({ label, sortKey, currentKey, currentDir, onSort, style }) {
  const active = sortKey === currentKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
        color: active ? 'var(--accent)' : undefined, ...style,
      }}
      title={`Sort by ${label}`}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <span style={{ opacity: active ? 1 : 0.3 }}>
          {active
            ? (currentDir === 'asc'
              ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="18 15 12 9 6 15"/></svg>
              : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>)
            : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="16 10 12 6 8 10"/><polyline points="8 14 12 18 16 14"/></svg>
          }
        </span>
      </span>
    </th>
  );
}

// ── Pagination controls ────────────────────────────────────────
export function Pagination({ page, totalPages, pageSize, pageSizes, totalRows, setPage, setPageSize }) {
  const { t } = useLocale();
  if (totalRows === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end   = Math.min(page * pageSize, totalRows);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: 8, padding: '10px 16px',
      borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text-3)',
    }}>
      <span style={{ fontWeight: 500 }}>{t('common.showing')} <strong style={{ color: 'var(--text-2)' }}>{start}–{end}</strong> {t('common.of')} <strong style={{ color: 'var(--text-2)' }}>{totalRows}</strong></span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-3)' }}>
          {t('common.rows')}
          <select
            className="form-control"
            style={{ width: 64, height: 28, fontSize: 12, padding: '0 6px' }}
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
          >
            {pageSizes.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 3 }}>
          <button className="btn btn-sm btn-secondary btn-icon" disabled={page <= 1} onClick={() => setPage(1)} title="First">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
          </button>
          <button className="btn btn-sm btn-secondary btn-icon" disabled={page <= 1} onClick={() => setPage(p => p - 1)} title="Previous">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span style={{ padding: '0 8px', lineHeight: '28px', fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600 }}>
            {page} / {totalPages}
          </span>
          <button className="btn btn-sm btn-secondary btn-icon" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} title="Next">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <button className="btn btn-sm btn-secondary btn-icon" disabled={page >= totalPages} onClick={() => setPage(totalPages)} title="Last">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toast notifications ────────────────────────────────────────
let toastFn = null;
export function setToastFn(fn) { toastFn = fn; }
export function toast(msg, type = 'green') {
  if (toastFn) toastFn(msg, type);
}
