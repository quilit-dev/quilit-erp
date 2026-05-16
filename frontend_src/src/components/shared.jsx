import * as XLSX from 'xlsx';
import { useLocale } from '../hooks/useLocale.jsx';

// ── Loading / Error states ─────────────────────────────────────
export function LoadingSpinner() {
  const { t } = useLocale();
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--text-3)' }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
        strokeWidth="2.5" style={{ animation: 'spin 0.8s linear infinite', display: 'block', margin: '0 auto 12px' }}>
        <path d="M21 12a9 9 0 11-6.219-8.56" />
      </svg>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <p style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('common.loading')}</p>
    </div>
  );
}

export function ErrorAlert({ message, onRetry }) {
  const { t } = useLocale();
  return (
    <div className="alert alert-red">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && <button className="btn btn-sm btn-secondary" onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

export function EmptyState({ message, icon = '📭' }) {
  const { t } = useLocale();
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <div className="empty-state-title">{t('common.nothingHere')}</div>
      <p>{message || t('common.noDataFound')}</p>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────
export function Modal({ title, onClose, children, size = '' }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} style={{ marginLeft: 8 }}>
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
};

export function Badge({ status }) {
  const { tStatus } = useLocale();
  const color = statusColors[status] || 'gray';
  return <span className={`badge badge-${color}`}>{tStatus(status)}</span>;
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

// ── Confirm modal ──────────────────────────────────────────────
export function ConfirmModal({
  message,
  onConfirm, onCancel,
  title,
  confirmLabel,
  confirmClass = 'btn-primary',
}) {
  const { t } = useLocale();
  const resolvedTitle = title || t('common.confirmAction');
  const resolvedConfirm = confirmLabel || t('common.confirm');
  const resolvedMessage = message || 'Are you sure you want to proceed?';
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
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
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>{resolvedMessage}</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button className={`btn ${confirmClass}`} onClick={onConfirm}>{resolvedConfirm}</button>
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
