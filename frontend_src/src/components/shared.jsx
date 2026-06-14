import * as XLSX from 'xlsx';
import { useLocale } from '../hooks/useLocale.jsx';
import { useSettings } from '../hooks/useSettings.jsx';
import { useScrollLock } from '../hooks/useScrollLock';

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
  low: 'red', ok: 'green',
  Ordered: 'blue', Received: 'accent', 'Paid (PO)': 'green',
  Voided: 'red', Cancelled: 'red',
};

export function Badge({ status }) {
  const { tStatus } = useLocale();
  const color = statusColors[status] || 'gray';
  return <span className={`badge badge-${color}`}>{tStatus(status)}</span>;
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

// Expense categories offered in the UI. Must stay a subset of the backend
// whitelist in finance.py (_VALID_EXPENSE_CATEGORIES). 'Depreciation' is
// system-generated by Fixed Assets and deliberately omitted from pickers.
export const EXPENSE_CATEGORIES = [
  'Labour', 'Materials', 'Equipment', 'Transport', 'Subcontractor',
  'Permits', 'Rent', 'Utilities', 'Salary', 'Subscription', 'Insurance', 'Other',
];

export function CategoryBadge({ category }) {
  const style = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px',
      borderRadius: 20, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: style.bg, color: style.color,
    }}>
      {category}
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

// Compact, magnitude-abbreviated money for tight spaces like KPI cards. Lebanon's
// currency runs into the billions/trillions of LBP, which blows past a card's
// width as a fully grouped number — so anything from a thousand up is shown as
// 12.3k / 1.2M / 3.4B / 5.6T. Sub-thousand amounts keep their exact grouped
// form. USD gets the same treatment for consistency. Always currency-aware via
// the DisplayCurrencyToggle.
function _compactNum(abs) {
  const pick = abs >= 1e12 ? [1e12, 'T']
             : abs >= 1e9  ? [1e9,  'B']
             : abs >= 1e6  ? [1e6,  'M']
             : abs >= 1e3  ? [1e3,  'k']
             : null;
  if (!pick) return { body: _grp.format(Math.round(abs)), suffix: '' };
  const n = abs / pick[0];
  // More significant digits for smaller leading values; trim trailing zeros.
  const dec = n < 10 ? 2 : n < 100 ? 1 : 0;
  const body = n.toFixed(dec).replace(/\.?0+$/, '');
  return { body, suffix: pick[1] };
}

export function useMoneyCompact() {
  const { exchangeRate, displayCurrency } = useSettings();
  const lbp = displayCurrency === 'LBP' && exchangeRate?.rate;
  return (value) => {
    const base = Number(value) || 0;
    const x = lbp ? base * exchangeRate.rate : base;
    const sign = x < 0 ? '-' : '';
    const { body, suffix } = _compactNum(Math.abs(x));
    const compact = lbp
      ? `${sign}${body}${suffix} ${exchangeRate.secondary}`
      : `${sign}$${body}${suffix}`;
    // Exact value stays available on hover so no precision is lost.
    const full = lbp ? secondaryAmount(base, exchangeRate) : fmt(base);
    return <span title={full}>{compact}</span>;
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
      💱 1 {exchangeRate.base} = {_grp.format(exchangeRate.rate)} {exchangeRate.secondary}
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

export function ExportButton({ data, filename, sheetName }) {
  const { t } = useLocale();
  return (
    <button className="btn btn-secondary btn-sm" onClick={() => exportToExcel(data, filename, sheetName)} title="Export to Excel">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      {t('common.export')}
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
      className={`btn btn-sm ${disabled ? 'btn-secondary' : 'btn-whatsapp'}`}
      aria-disabled={disabled}
      title={disabled
        ? (disabledTitle || t('common.whatsappNoPhone') || 'No phone number on file')
        : (title || t('common.whatsappSend') || 'Send via WhatsApp')}
      onClick={e => { if (disabled) e.preventDefault(); }}
      style={{
        opacity: disabled ? 0.55 : 1,
        cursor:  disabled ? 'not-allowed' : 'pointer',
        background: disabled ? undefined : '#25D366',
        borderColor: disabled ? undefined : '#1FAE54',
        color: disabled ? undefined : '#fff',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        textDecoration: 'none',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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
