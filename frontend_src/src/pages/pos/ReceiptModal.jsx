import { useState } from 'react';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Modal, toast } from '../../components/shared';
import { getInvoice } from '../../api/client';
import { exportInvoicePDF } from '../../utils/exportUtils';

function ReceiptModal({ sale, onClose }) {
  const { t, fmt, fmtDate, tCategory } = useLocale();
  const { settings, displayCurrency, exchangeRate } = useSettings();
  const co = settings || {};
  const [invoicing, setInvoicing] = useState(false);

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

  // The schedule, and whether the first row of it is a deposit.
  //
  // A deposit is seq 1 of the plan and is taken at the till, so printing it
  // again under "instalments" would bill the customer twice for money they
  // have already handed over. But there is only a deposit row when money was
  // actually taken: a sale put wholly on terms starts at seq 1 with a real
  // instalment, and dropping that one hid a payment the customer owes —
  // 161 over two showed a single line of 80.50, so the slip understated the
  // plan by exactly one instalment.
  const plan     = Array.isArray(sale.installments) ? sale.installments : [];
  const deposit  = (sale.paid_now || 0) > 0.005;
  const schedule = deposit ? plan.slice(1) : plan;

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

  /** Print the same A4 document the Invoices screen produces.
   *
   *  A thermal slip and a tax invoice are different documents for different
   *  purposes: the roll is what the customer walks out with, the A4 is what a
   *  business customer files or claims VAT against. Every POS sale already has
   *  a real invoice behind it, so this fetches that record and hands it to the
   *  ordinary invoice exporter rather than re-laying the sale out a second
   *  time — one design, one set of company details, one tax presentation.
   */
  async function printInvoice() {
    if (!sale.invoice_id) return;
    setInvoicing(true);
    try {
      const full = await getInvoice(sale.invoice_id);
      // A till sale usually has no client record. The exporter's generic
      // fallback for that is "No client specified", which reads like a mistake
      // on a document handed to the person who just paid — so name them the
      // way the POS screen already does.
      const billed = full.client_name || sale.client_name
        ? full
        : { ...full, client_name: t('pos.walkIn') };
      await exportInvoicePDF(billed, { displayCurrency, exchangeRate });
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setInvoicing(false);
    }
  }

  // Inline styles only — keeps the receipt visually isolated from the
  // rest of the app's design tokens (light text on dark theme would
  // ruin a printed receipt).
  // Paper width is a SETTING, not a constant. 58mm rolls are as common as 80mm
  // in small shops, and a receipt laid out for 80mm prints clipped or wildly
  // padded on one — a silent, per-customer defect that only shows on real
  // hardware. Anything other than an explicit 58 falls back to 80.
  const paperMm = String(co.pos_receipt_width || '80').trim() === '58' ? 58 : 80;
  // The on-screen preview is scaled to match the paper so what the cashier
  // checks is what the roll produces (~4px per mm at this font size).
  const RECEIPT_WIDTH = paperMm === 58 ? 232 : 320;
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
            width: ${paperMm}mm !important; padding: ${paperMm === 58 ? 3 : 4}mm !important; margin: 0 !important;
            border: none !important; border-radius: 0 !important; box-shadow: none !important;
          }
          @page { margin: 0; size: ${paperMm}mm auto; }
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

          {/* An instalment sale: the customer is walking out with the goods
              owing money, and the receipt is the only thing they take with
              them saying so — and saying when each payment falls due. */}
          {plan.length > 0 && (
            <>
              <Divider />
              {deposit && (
                <Row label={t('installments.deposit')} value={fmt(sale.paid_now)} />
              )}
              <Row label={t('pos.balanceOwed')} value={fmt(sale.balance)} bold />
              <div style={{ fontSize: 10, color: '#555', marginTop: 6, marginBottom: 2 }}>
                {t('installments.title')}
              </div>
              {schedule.map(i => (
                <Row key={i.seq} label={fmtDate(i.due_date)} value={fmt(i.amount)} />
              ))}
            </>
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
        {/* Only offered when the sale actually has an invoice behind it — a
            returned or legacy row may not, and a button that errors is worse
            than one that is absent. */}
        {sale.invoice_id && (
          <button className="btn btn-secondary" onClick={printInvoice} disabled={invoicing}>
            {invoicing ? t('common.loading') : t('pos.printInvoice')}
          </button>
        )}
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
