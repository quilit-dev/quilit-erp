// Per-row action dropdown (edit / pay / export / WhatsApp / void).
import { useState, useRef, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { WhatsAppShareButton } from '../../components/shared';

// Pre-built WhatsApp message for an invoice — bilingual short form so the
// client immediately sees what they're being sent before opening the file.
function _waMessage(inv) {
  const who = inv.client_name ? `, ${inv.client_name}` : '';
  const total = `$${Number(inv.amount || 0).toFixed(2)}`;
  const due   = inv.due_date ? ` due ${inv.due_date}` : '';
  return `Hello${who}, here is invoice ${inv.invoice_number} for ${total}${due}. Thank you!`;
}

// ── Per-row action dropdown ───────────────────────────────────────────────
function ActionMenu({ inv, exporting, onEdit, onPay, onExport, onVoid, onUnvoid }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 180);
    }
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const isVoided    = inv.payment_status === 'Void' || !!inv.voided_at;
  const isPaid      = inv.payment_status === 'Paid';
  const isExporting = !!exporting;

  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'flex-end' }}>
      {!isVoided && (
        <WhatsAppShareButton phone={inv.client_phone} message={_waMessage(inv)} />
      )}
      {isVoided ? (
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('invoices.voidedLabel')}</span>
      ) : !isPaid ? (
        <button className="btn btn-sm btn-success" style={{ whiteSpace: 'nowrap' }} onClick={onPay}>
          💵 {t('invoices.recordPayment')}
        </button>
      ) : (
        <button className="btn btn-sm btn-secondary" style={{ whiteSpace: 'nowrap' }} onClick={onPay}>
          {t('invoices.historyBtn')}
        </button>
      )}

      <div ref={ref} style={{ position: 'relative' }}>
        <button
          ref={btnRef}
          className="btn btn-sm btn-secondary"
          title="More actions"
          onClick={() => setOpen(o => !o)}
          style={{ padding: '0 7px', letterSpacing: 1, fontWeight: 700 }}
        >
          ⋯
        </button>

        {open && (
          <div style={{
            position: 'fixed',
            left: (() => {
              if (!btnRef.current) return 4;
              const r   = btnRef.current.getBoundingClientRect();
              const mw  = 178;
              let left  = r.right - mw;     // right-align menu with button
              if (left < 4) left = r.left;  // if off left edge, left-align instead
              if (left + mw > window.innerWidth - 4) left = window.innerWidth - mw - 4; // clamp right
              return Math.max(4, left);
            })(),
            ...(dropUp
              ? { bottom: (() => {
                  if (!btnRef.current) return 0;
                  const r = btnRef.current.getBoundingClientRect();
                  return window.innerHeight - r.top + 4;
                })() }
              : { top: (() => {
                  if (!btnRef.current) return 0;
                  const r = btnRef.current.getBoundingClientRect();
                  return r.bottom + 4;
                })() }
            ),
            zIndex: 9999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
            minWidth: 178, padding: '4px 0', whiteSpace: 'nowrap',
          }}>
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              style={{ ...menuItemStyle, opacity: isVoided ? 0.4 : 1, cursor: isVoided ? 'not-allowed' : 'pointer' }}
              disabled={isVoided}
            >
              ✏️ {t('common.edit')} {isVoided ? `(${t('invoices.voidedLabel')})` : ''}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('excel'); }}
              style={{ ...menuItemStyle, color: '#166534', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'excel' ? '⏳ Exporting…' : '📊 Export XLS'}
            </button>

            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('pdf'); }}
              style={{ ...menuItemStyle, color: '#991b1b', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'pdf' ? '⏳ Exporting…' : '📄 Export PDF'}
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            {isVoided ? (
              <button
                onClick={() => { setOpen(false); onUnvoid(); }}
                style={{ ...menuItemStyle, color: '#166534' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px', marginInlineEnd: 6 }}><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>{t('invoices.unvoidInvoiceTitle')}
              </button>
            ) : (
              <button
                onClick={() => { setOpen(false); onVoid(); }}
                style={{ ...menuItemStyle, color: '#92400e' }}
              >
                🚫 {t('invoices.voidInvoiceTitle')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const menuItemStyle = {
  display: 'block', width: '100%', padding: '7px 14px',
  background: 'none', border: 'none', textAlign: 'left',
  fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};

export { ActionMenu };
