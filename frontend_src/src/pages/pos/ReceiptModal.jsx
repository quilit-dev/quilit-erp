import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Modal } from '../../components/shared';

function ReceiptModal({ sale, onClose }) {
  const { t, fmt, tCategory } = useLocale();
  const { settings } = useSettings();
  const co = settings || {};

  const now = new Date();
  const dateStr = now.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  const items   = Array.isArray(sale.items) ? sale.items : [];
  const showTax = (sale.tax_total || 0) > 0.005;
  const showDiscount = (sale.discount_total || 0) > 0.005;
  // Cash sales show "Tender / Change"; non-cash skip those rows.
  const isCash  = (sale.payment_method || 'Cash').toLowerCase() === 'cash';

  function doPrint() {
    // Add a "printing" class to body so the print-only CSS in this modal
    // hides everything except the receipt strip. The class is cleared by
    // the afterprint event so subsequent app rendering stays normal.
    document.body.classList.add('pos-receipt-printing');
    const cleanup = () => {
      document.body.classList.remove('pos-receipt-printing');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    // Safety net for browsers that don't fire afterprint reliably.
    setTimeout(cleanup, 1500);
  }

  // Inline styles only — keeps the receipt visually isolated from the
  // rest of the app's design tokens (light text on dark theme would
  // ruin a printed receipt).
  const RECEIPT_WIDTH = 320;     // px on screen ~= 80mm thermal paper
  const MONO = '"JetBrains Mono", "Courier New", ui-monospace, monospace';

  return (
    <Modal title={t('pos.receipt')} onClose={onClose}>
      <style>{`
        /* Print-only: show ONLY the receipt strip. The modal renders inline
           inside #root (not a body-level portal), so hiding body's direct
           children would hide the receipt too. Instead we hide everything via
           visibility, then re-show the receipt subtree and pull it to the page
           origin — this works regardless of how deeply the modal is nested.
           The .pos-receipt-printing class is added by doPrint(). */
        @media print {
          body.pos-receipt-printing * { visibility: hidden !important; }
          body.pos-receipt-printing .pos-receipt,
          body.pos-receipt-printing .pos-receipt * { visibility: visible !important; }
          body.pos-receipt-printing .pos-receipt {
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 80mm !important; padding: 4mm !important; margin: 0 !important;
            border: none !important; border-radius: 0 !important; box-shadow: none !important;
          }
          @page { margin: 0; size: 80mm auto; }
        }
      `}</style>

      <div className="modal-body" style={{ background: 'var(--bg)' }}>
        <div className="pos-receipt" style={{
          width: RECEIPT_WIDTH, margin: '0 auto',
          background: '#fff', color: '#111',
          fontFamily: MONO, fontSize: 12, lineHeight: 1.45,
          padding: '14px 16px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}>
          {/* Header — company info */}
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '.5px' }}>
              {(co.company_name || 'My Company').toUpperCase()}
            </div>
            {(co.company_address || co.company_city) && (
              <div style={{ fontSize: 10.5, color: '#555' }}>
                {[co.company_address, co.company_city, co.company_country].filter(Boolean).join(', ')}
              </div>
            )}
            {co.company_phone && (
              <div style={{ fontSize: 10.5, color: '#555' }}>Tel: {co.company_phone}</div>
            )}
            {co.company_tax_number && (
              <div style={{ fontSize: 10.5, color: '#555' }}>VAT #: {co.company_tax_number}</div>
            )}
          </div>

          {/* Sale meta */}
          <Divider />
          <Row label={t('pos.receiptNumber') || 'Receipt'} value={sale.invoice_number} bold />
          <Row label={t('common.date') || 'Date'} value={dateStr} />
          {sale.client_name && <Row label={t('pos.customer') || 'Customer'} value={sale.client_name} />}

          {/* Items */}
          <Divider />
          {items.length === 0 ? (
            <div style={{ textAlign: 'center', fontSize: 11, color: '#888', padding: '6px 0' }}>
              {t('pos.noItems') || 'No items'}
            </div>
          ) : items.map((it, i) => {
            const qty = Number(it.quantity) || 0;
            const price = Number(it.unit_price) || 0;
            const lineTotal = qty * price - (Number(it.discount) || 0);
            return (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ fontWeight: 600, color: '#111' }}>
                  {it.name || t('pos.customLineName')}
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 11, color: '#444',
                }}>
                  <span>{qty} × {price.toFixed(2)}</span>
                  <span>{lineTotal.toFixed(2)}</span>
                </div>
                {(Number(it.discount) || 0) > 0 && (
                  <div style={{ fontSize: 10, color: '#15803d', textAlign: 'end' }}>
                    {t('pos.lineDiscount') || 'Disc'}: −{Number(it.discount).toFixed(2)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Totals */}
          <Divider />
          <Row label={t('pos.subtotal')} value={fmt(sale.subtotal)} />
          {showTax       && <Row label={t('pos.taxTotal')} value={fmt(sale.tax_total)} />}
          {showDiscount  && <Row label={t('pos.savings')} value={'−' + fmt(sale.discount_total)} hint />}
          <DividerDouble />
          <Row label={t('pos.total')} value={fmt(sale.total)} bold size={14} />

          {/* Payment */}
          <Divider />
          <Row label={t('pos.paymentMethod') || 'Payment'} value={sale.payment_method || 'Cash'} />
          {isCash && sale.amount_tendered != null && (
            <Row label={t('pos.amountTendered') || 'Tendered'}
                 value={fmt(sale.amount_tendered)} />
          )}
          {isCash && (sale.change_given || 0) > 0 && (
            <Row label={t('pos.change')}
                 value={fmt(sale.change_given)} bold />
          )}

          {/* Footer */}
          <Divider />
          <div style={{ textAlign: 'center', fontSize: 10.5, color: '#555', lineHeight: 1.5 }}>
            {co.footer_text || 'Thank you for your business!'}
          </div>
          {showTax && (
            <div style={{ textAlign: 'center', fontSize: 9, color: '#888', marginTop: 3 }}>
              {t('pos.taxIncluded')}
            </div>
          )}
        </div>
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={doPrint}>{t('pos.printReceipt')}</button>
        <button className="btn btn-primary" onClick={onClose}>{t('pos.newSale')}</button>
      </div>
    </Modal>
  );
}

// ── Receipt building blocks ───────────────────────────────────────────────
// Small inline helpers so the receipt JSX above stays scannable.

function Divider() {
  return <div style={{ borderTop: '1px dashed #999', margin: '6px 0' }} />;
}
function DividerDouble() {
  return (
    <div style={{
      borderTop: '1px solid #000', borderBottom: '1px solid #000',
      height: 3, margin: '5px 0',
    }} />
  );
}
function Row({ label, value, bold, hint, size = 12 }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      fontSize: size, color: hint ? '#15803d' : '#111',
      fontWeight: bold ? 700 : 400,
      padding: '1px 0',
    }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}


export { ReceiptModal };
