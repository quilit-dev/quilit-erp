// Per-row action dropdown (edit / pay / export / void).
//
// Sending lives on the row's own Send button, not in here.
import { useState, useRef, useEffect } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { Icon } from '../../components/shared';
import { SendDocumentButton } from '../../components/SendDocument';

// ── Per-row action dropdown ───────────────────────────────────────────────
function ActionMenu({ inv, exporting, onEdit, onPay, onExport, onVoid, onUnvoid }) {
  const { t, lang } = useLocale();
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
      {!isVoided && <SendDocumentButton entityType="invoice" doc={inv} />}
      {isVoided ? (
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>{t('invoices.voidedLabel')}</span>
      ) : !isPaid ? (
        <button className="btn btn-sm btn-success"
          style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={onPay}>
          <Icon name="banknote" size={14} />
          {t('invoices.recordPayment')}
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
              <Icon name="pencil" size={14} />
              <span>{t('common.edit')}{isVoided ? ` (${t('invoices.voidedLabel')})` : ''}</span>
            </button>

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('excel'); }}
              style={{ ...menuItemStyle, color: '#166534', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'excel'
                ? <><Icon name="loader" size={14} style={SPIN} /><span>Exporting…</span></>
                : <><Icon name="file-spreadsheet" size={14} /><span>Export XLS</span></>}
            </button>

            {/* Browser-rendered from the HTML/CSS template in exportUtils.js —
                opens the print dialog, where the operator chooses Save as PDF. */}
            <button
              disabled={isExporting || isVoided}
              onClick={() => { setOpen(false); onExport('pdf'); }}
              style={{ ...menuItemStyle, color: '#991b1b', opacity: (isExporting || isVoided) ? 0.4 : 1 }}
            >
              {exporting === 'pdf'
                ? <><Icon name="loader" size={14} style={SPIN} /><span>Exporting…</span></>
                : <><Icon name="file-text" size={14} /><span>Export PDF</span></>}
            </button>

            {/* No WhatsApp / email entries here. The Send button on the row
                covers both channels and shows what will actually be sent, so
                duplicating them in this menu gave the same row three ways to
                send one document. */}

            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            {isVoided ? (
              <button
                onClick={() => { setOpen(false); onUnvoid(); }}
                style={{ ...menuItemStyle, color: '#166534' }}
              >
                <Icon name="rotate-ccw" size={14} />
                <span>{t('invoices.unvoidInvoiceTitle')}</span>
              </button>
            ) : (
              <button
                onClick={() => { setOpen(false); onVoid(); }}
                style={{ ...menuItemStyle, color: '#92400e' }}
              >
                <Icon name="ban" size={14} />
                <span>{t('invoices.voidInvoiceTitle')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Flex + gap keeps the leading icon and its label on one baseline, and mirrors
// correctly in RTL (a physical `textAlign: left` would not).
const menuItemStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%', padding: '7px 14px',
  background: 'none', border: 'none', textAlign: 'start',
  fontSize: 13, cursor: 'pointer', color: 'var(--text)',
};

// Spin the loader arc while an export is running (keyframes live in index.css).
const SPIN = { animation: 'spin .7s linear infinite' };

export { ActionMenu };
