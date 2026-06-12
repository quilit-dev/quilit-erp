import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useSettings } from '../hooks/useSettings.jsx';
import { useWarehouses } from '../hooks/useWarehouses';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, Badge, ExportButton, toast } from '../components/shared';
import {
  getPosSession, openPosSession, closePosSession, getPosSessions,
  posCheckout, getPosSales, getPosSale, returnPosSale, getPosProducts, getClients,
  getPosCashDrawers,
} from '../api/client';

const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(v) || 0);

// Round to cents, half-up — mirrors the backend's money() so the figures the
// cashier sees match the persisted receipt to the cent. The epsilon nudge
// avoids binary-float cases like 2.675 rounding down.
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Compute a sale's pricing the same way the backend does: prices are
// VAT-INCLUSIVE, line + order discounts come off the gross, tax is extracted,
// and every line is rounded to cents BEFORE summing (so the subtotal / VAT
// split shown here equals what checkout stores).
function priceCart(cart, orderDiscount, taxEnabled, rateOf, defaultRate) {
  const grossAfterLine = cart.map(l => {
    const g = r2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
    return Math.max(0, r2(g - (Number(l.discount) || 0)));
  });
  const grossSum = r2(grossAfterLine.reduce((a, b) => a + b, 0));
  const od = Math.min(Math.max(0, Number(orderDiscount) || 0), grossSum);

  // Distribute the order discount proportionally; the last line absorbs the
  // rounding remainder so the shares sum to exactly `od` — matches the backend.
  const shares = grossAfterLine.map(() => 0);
  if (od > 0 && grossSum > 0) {
    let acc = 0; const last = cart.length - 1;
    grossAfterLine.forEach((g, i) => {
      if (i === last) shares[i] = r2(od - acc);
      else { shares[i] = r2(od * g / grossSum); acc += shares[i]; }
    });
  }

  let subtotal = 0, taxTotal = 0, total = 0;
  cart.forEach((l, i) => {
    const finalGross = Math.max(0, r2(grossAfterLine[i] - shares[i]));
    const r    = taxEnabled ? (rateOf(l.tax_rate_id) || defaultRate) : null;
    const rate = r ? (Number(r.rate) || 0) : 0;
    const tax  = rate ? r2(finalGross * rate / (100 + rate)) : 0;
    subtotal  += r2(finalGross - tax);
    taxTotal  += tax;
    total     += finalGross;
  });
  const discountTotal = r2(cart.reduce((a, l) => a + (Number(l.discount) || 0), 0) + od);
  return { subtotal: r2(subtotal), taxTotal: r2(taxTotal), total: r2(total), discountTotal, orderDiscount: od };
}

// ── Open-register panel ─────────────────────────────────────────────────────
function OpenRegisterPanel({ onOpened }) {
  const { t } = useLocale();
  const [floatUsd, setFloatUsd] = useState('0');
  const [floatLbp, setFloatLbp] = useState('0');
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState(false);
  // Cashier picks which warehouse this register sells out of. Auto-selects
  // their default once it loads. Hidden when only one warehouse exists (no
  // choice to make), so the existing single-warehouse UX is unchanged.
  const { warehouses, defaultId } = useWarehouses();
  useEffect(() => {
    if (defaultId && !warehouseId) setWarehouseId(defaultId);
  }, [defaultId, warehouseId]);

  async function open() {
    setBusy(true);
    try {
      await openPosSession({
        opening_float:     parseFloat(floatUsd) || 0,
        opening_float_lbp: parseFloat(floatLbp) || 0,
        warehouse_id:      warehouseId ? parseInt(warehouseId) : null,
      });
      toast(t('pos.sessionOpened'), 'green');
      onOpened();
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 440, margin: '48px auto', overflow: 'hidden' }}>
      {/* Hero header — centred icon, title, prompt. Padded block, hairline
          rule beneath so it reads as a header band rather than crowding
          the form. */}
      <div style={{
        textAlign: 'center',
        padding: '28px 28px 22px',
        borderBottom: '1px solid var(--rule)',
        background: 'var(--surface-2)',
      }}>
        <div style={{
          width: 56, height: 56, margin: '0 auto 14px',
          borderRadius: 999,
          background: 'var(--accent-tint)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M6 7V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/>
            <line x1="6" y1="12" x2="10" y2="12"/>
            <circle cx="17" cy="15" r="1.5"/>
          </svg>
        </div>
        <h3 style={{
          margin: 0,
          fontFamily: 'var(--font-display)', fontWeight: 700,
          fontSize: 19, letterSpacing: '-0.02em', color: 'var(--text)',
        }}>{t('pos.openRegister')}</h3>
        <p style={{
          margin: '6px auto 0', maxWidth: 300,
          color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.5,
        }}>{t('pos.openRegisterPrompt')}</p>
      </div>

      {/* Form body — a real flex column with consistent gaps, so nothing
          stacks flush against its neighbour or the card edge. */}
      <div style={{
        padding: 24,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {warehouses.length > 1 && (
          <div className="form-group">
            <label className="form-label">{t('warehouses.sellingFrom')}</label>
            <select className="form-control" value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}{w.is_default ? ` (${t('warehouses.defaultBadge').toLowerCase()})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">{t('pos.openingFloat')} (USD)</label>
          <input className="form-control" type="number" step="any" min="0" value={floatUsd}
            onChange={e => setFloatUsd(e.target.value)} autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">{t('pos.openingFloat')} (LBP)</label>
          <input className="form-control" type="number" step="any" min="0" value={floatLbp}
            onChange={e => setFloatLbp(e.target.value)} />
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 4 }}
          disabled={busy} onClick={open}>
          {busy ? t('common.saving') : t('pos.openRegister')}
        </button>
      </div>
    </div>
  );
}

// ── Close-register modal ────────────────────────────────────────────────────
function CloseRegisterModal({ session, onClose, onClosed }) {
  const { t, fmt } = useLocale();
  const [countUsd, setCountUsd] = useState('');
  const [countLbp, setCountLbp] = useState('');
  const [busy, setBusy] = useState(false);

  async function close() {
    if (countUsd === '' || isNaN(parseFloat(countUsd))) { toast(t('pos.closingCount'), 'red'); return; }
    setBusy(true);
    try {
      const res = await closePosSession({
        closing_count:     parseFloat(countUsd),
        closing_count_lbp: countLbp === '' ? 0 : parseFloat(countLbp),
      });
      const ok = Math.abs(res.variance) < 0.01 && Math.abs(res.variance_lbp) < 1;
      toast(`${t('pos.sessionClosed')} — ${t('pos.variance')} USD ${fmt(res.variance)}`
            + ` · LBP ${num(res.variance_lbp)}`, ok ? 'green' : 'yellow');
      onClosed();
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('pos.closeRegister')} onClose={onClose}>
      <div className="modal-body">
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
          {t('pos.openingFloat')}: <strong>{fmt(session.opening_float)}</strong>
          {' / '}<strong>{num(session.opening_float_lbp)} LBP</strong>
          {' · '}{t('pos.salesCount')}: <strong>{session.sales_count ?? 0}</strong>
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">{t('pos.closingCount')} (USD)</label>
            <input className="form-control" type="number" step="any" min="0" value={countUsd}
              onChange={e => setCountUsd(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">{t('pos.closingCount')} (LBP)</label>
            <input className="form-control" type="number" step="any" min="0" value={countLbp}
              placeholder="0" onChange={e => setCountLbp(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={close}>
          {busy ? t('common.saving') : t('pos.closeRegister')}
        </button>
      </div>
    </Modal>
  );
}

// ── Receipt modal ───────────────────────────────────────────────────────────
// Designed to look like a real thermal-printer slip: narrow column,
// monospace digits, dotted dividers, condensed item list. Includes
// print-only CSS so the browser's Print dialog produces just the receipt
// strip — no app chrome, no nav, no buttons.

function ReceiptModal({ sale, onClose }) {
  const { t, fmt } = useLocale();
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

// ── Checkout modal ──────────────────────────────────────────────────────────
function CheckoutModal({ pricing, clients, drawers, onClose, onDone }) {
  const { t, fmt } = useLocale();
  const { exchangeRate } = useSettings();
  const [clientId, setClientId] = useState('');
  const [method, setMethod] = useState('Cash');
  const [currency, setCurrency] = useState('USD');
  const [rate, setRate] = useState(exchangeRate?.rate ? String(exchangeRate.rate) : '');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const _defDrawer = drawers.find(d => d.auto_capture) || drawers[0];
  const [drawerId, setDrawerId] = useState(_defDrawer ? String(_defDrawer.id) : '');

  const fxRate = parseFloat(rate) || 0;
  const totalInCurrency = currency === 'LBP' ? pricing.total * (fxRate || 0) : pricing.total;
  const tenderedNum = parseFloat(tendered) || 0;
  const change = method === 'Cash' ? tenderedNum - totalInCurrency : 0;

  async function confirm() {
    if (currency === 'LBP' && fxRate <= 0) { toast(t('pos.exchangeRate'), 'red'); return; }
    if (method === 'Cash' && tenderedNum + 0.01 < totalInCurrency) {
      toast(t('pos.amountTendered'), 'red'); return;
    }
    setBusy(true);
    try {
      const res = await posCheckout({
        client_id: clientId ? Number(clientId) : null,
        items: pricing.items,
        order_discount: pricing.orderDiscount,
        payment_method: method,
        currency,
        exchange_rate: currency === 'LBP' ? fxRate : null,
        amount_tendered: method === 'Cash' ? tenderedNum : totalInCurrency,
        cash_drawer_id: method === 'Cash' && drawerId ? Number(drawerId) : null,
        idempotency_key: crypto.randomUUID(),
      });
      // The checkout endpoint returns only totals + ids. Stitch in the
      // presentation data the receipt needs (line items, client name,
      // payment method, amount tendered) so the receipt doesn't have to
      // make a second roundtrip for what we already know.
      const clientName = clientId
        ? (clients.find(c => String(c.id) === String(clientId))?.name || '')
        : '';
      onDone({
        ...res,
        items:           pricing.items,
        client_name:     clientName,
        payment_method:  method,
        currency,
        exchange_rate:   currency === 'LBP' ? fxRate : null,
        amount_tendered: method === 'Cash' ? tenderedNum : totalInCurrency,
      });
    } catch (e) {
      toast(e.message, 'red');
      setBusy(false);
    }
  }

  return (
    <Modal title={t('pos.checkout')} onClose={onClose}>
      <div className="modal-body">
        <table className="table" style={{ fontSize: 13, marginBottom: 12 }}>
          <tbody>
            <tr><td>{t('pos.subtotal')}</td><td style={{ textAlign: 'end' }}>{fmt(pricing.subtotal)}</td></tr>
            <tr><td>{t('pos.taxTotal')}</td><td style={{ textAlign: 'end' }}>{fmt(pricing.taxTotal)}</td></tr>
            {pricing.discountTotal > 0 && (
              <tr><td>{t('pos.savings')}</td>
                  <td style={{ textAlign: 'end', color: 'var(--green)' }}>−{fmt(pricing.discountTotal)}</td></tr>
            )}
            <tr><td><strong>{t('pos.total')}</strong></td>
                <td style={{ textAlign: 'end' }}><strong>{fmt(pricing.total)}</strong></td></tr>
          </tbody>
        </table>
        <div className="form-grid">
          <div className="form-group form-full">
            <label className="form-label">{t('pos.customer')}</label>
            <select className="form-control" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">{t('pos.walkIn')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pos.paymentMethod')}</label>
            <select className="form-control" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="Cash">{t('pos.cash')}</option>
              <option value="Card">{t('pos.card')}</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t('pos.currency')}</label>
            <select className="form-control" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="USD">{exchangeRate?.base || 'USD'}</option>
              {exchangeRate?.rate ? <option value="LBP">{exchangeRate.secondary || 'LBP'}</option> : null}
            </select>
          </div>
          {method === 'Cash' && drawers.length > 0 && (
            <div className="form-group form-full">
              <label className="form-label">{t('pos.cashDrawer')}</label>
              <select className="form-control" value={drawerId}
                onChange={e => setDrawerId(e.target.value)}>
                {drawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          {currency === 'LBP' && (
            <div className="form-group form-full">
              <label className="form-label">{t('pos.exchangeRate')}</label>
              <input className="form-control" type="number" step="any" min="0" value={rate}
                onChange={e => setRate(e.target.value)} />
            </div>
          )}
          {method === 'Cash' && (
            <div className="form-group form-full">
              <label className="form-label">
                {t('pos.amountTendered')} ({currency}) — {t('pos.total')}: {num(totalInCurrency)}
              </label>
              <input className="form-control" type="number" step="any" min="0" value={tendered}
                onChange={e => setTendered(e.target.value)} autoFocus />
            </div>
          )}
        </div>
        {method === 'Cash' && tendered !== '' && (
          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600,
                        color: change < 0 ? 'var(--red)' : 'var(--green)' }}>
            {t('pos.change')}: {num(change)} {currency}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={confirm}>
          {busy ? t('common.saving') : t('pos.completeSale')}
        </button>
      </div>
    </Modal>
  );
}

// ── Custom-line name input with inventory autocomplete ─────────────────────
// A custom line is normally a free-text service entry, but cashiers often
// type the first letters of an *existing* inventory item before remembering
// to add it from the product list. This combobox:
//   • debounces a server-side product search as the user types
//   • lets them pick a match with ↑/↓/Enter (mouse also works)
//   • on pick, mutates the line into a proper inventory-backed line — sets
//     inventory_id, unit_price (sale_price), stock, line_type and keeps the
//     existing tax_rate_id only if the cashier hadn't overridden it
function CustomLineNameCombobox({ line, taxEnabled, defaultRate, onPatch, placeholder }) {
  const [open,     setOpen]     = useState(false);
  const [matches,  setMatches]  = useState([]);
  const [active,   setActive]   = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // close on outside click
  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // debounced product lookup — empty input → no suggestions
  useEffect(() => {
    const term = (line.name || '').trim();
    if (term.length < 1) { setMatches([]); return; }
    const tm = setTimeout(() => {
      getPosProducts(term)
        .then(rows => setMatches((rows || []).slice(0, 8)))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(tm);
  }, [line.name]);

  // reset the highlight when the result set changes
  useEffect(() => { setActive(0); }, [matches]);

  function pick(p) {
    onPatch({
      name:         p.name,
      inventory_id: p.id,
      unit_price:   Number(p.sale_price) || Number(line.unit_price) || 0,
      stock:        Number(p.quantity) || 0,
      line_type:    'product',
      // Preserve the cashier's tax-rate choice if they already changed it;
      // otherwise fall back to the default rate (matches addProduct flow).
      tax_rate_id:  line.tax_rate_id ?? (defaultRate ? defaultRate.id : null),
    });
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open || matches.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); pick(matches[active]); }
    else if (e.key === 'Escape')    { setOpen(false); }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className="form-control"
        style={{ height: 30 }}
        placeholder={placeholder}
        value={line.name || ''}
        autoComplete="off"
        onChange={e => { onPatch({ name: e.target.value }); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          marginTop: 2, maxHeight: 240, overflowY: 'auto',
        }}>
          {matches.map((m, i) => (
            <div
              key={m.id}
              onMouseDown={() => pick(m)}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '6px 10px', cursor: 'pointer', fontSize: 12,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: i === active ? 'var(--surface-2)' : 'transparent',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11, marginInlineStart: 6 }}>
                  {Number(m.quantity || 0)}{m.unit ? ' ' + m.unit : ''} in stock
                </span>
              </span>
              <span style={{ fontWeight: 600, fontSize: 12 }}>
                ${Number(m.sale_price || 0).toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Register view (search + cart) ───────────────────────────────────────────
function RegisterView({ session, onClose, onSold }) {
  const { t, fmt } = useLocale();
  const { settings, taxRates } = useSettings();
  const [search, setSearch] = useState('');
  // Two product pools — browse (loaded once on mount, used when search
  // is empty) and results (debounced search). Keeping them separate lets
  // category filtering work over the browse pool without nuking search.
  const [browsePool, setBrowsePool] = useState([]);
  const [results, setResults] = useState([]);
  const [category, setCategory] = useState('');     // '' = All
  const [cart, setCart] = useState([]);
  const [orderDiscount, setOrderDiscount] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [clients, setClients] = useState([]);
  const [drawers, setDrawers] = useState([]);
  const [closing, setClosing] = useState(false);
  const keyRef = useRef(0);

  const taxEnabled = settings?.tax_enabled === '1' && taxRates.length > 0;
  // Settings → "Enable per-line discounts" — gates the small Disc input
  // on each cart line. priceCart already respects line.discount, so the
  // setting only controls UI visibility (and whether the cashier can
  // actually edit the field).
  const discountEnabled = settings?.show_discount_col === '1';
  const defaultRate = taxRates.find(r => r.is_default);
  const rateOf = (id) => taxRates.find(r => r.id === id);
  // POS lines default to the Zero-rated tax — the cashier picks VAT per line
  // when it applies. Every other module keeps the standard default rate
  // (the is_default, e.g. VAT 11%). Falls back to the standard default if no
  // zero-rated rate is configured.
  const posDefaultRate = taxRates.find(r => r.tax_type === 'zero') || defaultRate;

  useEffect(() => {
    getClients().then(setClients).catch(() => {});
    getPosCashDrawers().then(setDrawers).catch(() => {});
    // Prime the browse grid with the first page of products so the
    // cashier sees something to tap without having to type anything.
    getPosProducts('').then(setBrowsePool).catch(() => setBrowsePool([]));
  }, []);

  // Debounced product search.
  useEffect(() => {
    const term = search.trim();
    if (!term) { setResults([]); return; }
    const tm = setTimeout(() => {
      getPosProducts(term).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(tm);
  }, [search]);

  // The visible product list — search results when the cashier is
  // searching, otherwise the browse pool filtered by the active category.
  const visibleProducts = search.trim()
    ? results
    : (category
        ? browsePool.filter(p => (p.category || '') === category)
        : browsePool);

  // Distinct categories derived from the browse pool, sorted by frequency
  // so the most-used categories appear first.
  const categories = (() => {
    const counts = new Map();
    for (const p of browsePool) {
      const k = (p.category || '').trim();
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  })();

  function addProduct(p) {
    setCart(prev => {
      const ex = prev.find(l => l.inventory_id === p.id);
      if (ex) return prev.map(l => l === ex ? { ...l, quantity: l.quantity + 1 } : l);
      return [...prev, {
        key: ++keyRef.current, name: p.name, inventory_id: p.id,
        quantity: 1, unit_price: Number(p.sale_price) || 0, discount: 0,
        tax_rate_id: posDefaultRate ? posDefaultRate.id : null,
        line_type: 'product', stock: Number(p.quantity) || 0,
      }];
    });
  }

  function addCustomLine() {
    setCart(prev => [...prev, {
      key: ++keyRef.current, name: '', inventory_id: null,
      quantity: 1, unit_price: 0, discount: 0,
      tax_rate_id: posDefaultRate ? posDefaultRate.id : null,
      line_type: 'service', stock: null,
    }]);
  }

  const setLine = (key, patch) =>
    setCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  const removeLine = (key) => setCart(prev => prev.filter(l => l.key !== key));

  // Increase / decrease a line's quantity by `delta`. Removes the line
  // entirely when the count would drop below 1 (faster than tapping the
  // X icon for a tap-on-tap-off mistake).
  const bumpQty = (key, delta) => {
    setCart(prev => prev
      .map(l => l.key === key ? { ...l, quantity: (Number(l.quantity) || 0) + delta } : l)
      .filter(l => Number(l.quantity) > 0));
  };

  function onSearchKeyDown(e) {
    if (e.key === 'Enter' && visibleProducts.length > 0) {
      e.preventDefault();
      addProduct(visibleProducts[0]);
      setSearch('');
      setResults([]);
    }
  }

  const pricing = priceCart(cart, orderDiscount, taxEnabled, rateOf, posDefaultRate);

  const checkoutItems = cart.map(l => ({
    name: l.name || t('pos.customLineName'),
    inventory_id: l.inventory_id,
    quantity: Number(l.quantity) || 0,
    unit_price: Number(l.unit_price) || 0,
    discount: Number(l.discount) || 0,
    tax_rate_id: taxEnabled ? (l.tax_rate_id ?? (posDefaultRate ? posDefaultRate.id : null)) : null,
    line_type: l.line_type,
  }));

  const cartValid = cart.length > 0 &&
    cart.every(l => (l.name || l.inventory_id) && Number(l.quantity) > 0) &&
    pricing.total > 0;

  // Initial for the cashier monogram (first letter of full name).
  const cashierInitial = (session.cashier_name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="pos-workspace-shell">
      {closing && (
        <CloseRegisterModal session={session} onClose={() => setClosing(false)}
          onClosed={() => { setClosing(false); onClose(); }} />
      )}
      {checkout && (
        <CheckoutModal
          pricing={{ ...pricing, items: checkoutItems }}
          clients={clients}
          drawers={drawers}
          onClose={() => setCheckout(false)}
          onDone={(res) => { setCheckout(false); setCart([]); setOrderDiscount(''); onSold(res); }}
        />
      )}

      {/* ── Session bar ──────────────────────────────────────────── */}
      <div className="pos-session-bar">
        <div className="pos-session-bar-info">
          <div className="pos-session-cashier">
            <div className="pos-session-cashier-avatar">{cashierInitial}</div>
            <div>
              <div className="pos-session-cashier-name">{session.cashier_name}</div>
              <div className="pos-session-cashier-role">{t('pos.cashier')}</div>
            </div>
          </div>
          <div className="pos-session-stat">
            <span className="pos-session-stat-label">{t('pos.salesCount')}</span>
            <span className="pos-session-stat-value">{session.sales_count ?? 0}</span>
          </div>
          <div className="pos-session-stat">
            <span className="pos-session-stat-label">{t('pos.sessionTotal')}</span>
            <span className="pos-session-stat-value">{fmt(session.sales_total ?? 0)}</span>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setClosing(true)}>
          {t('pos.closeRegister')}
        </button>
      </div>

      {/* ── Workspace grid ───────────────────────────────────────── */}
      <div className="pos-workspace">

        {/* Products column */}
        <div className="pos-products-section">
          {/* Search */}
          <div className="pos-search-row">
            <span className="pos-search-icon" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </span>
            <input
              className="pos-search-input"
              autoFocus
              value={search}
              placeholder={t('pos.searchProducts')}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          {/* Category pills — only shown when not searching, and only if
              the browse pool has more than one distinct category. */}
          {!search.trim() && categories.length > 1 && (
            <div className="pos-categories">
              <button
                className={`pos-category-pill${category === '' ? ' active' : ''}`}
                onClick={() => setCategory('')}>
                {t('pos.allProducts')}
                <span className="pos-category-pill-count">{browsePool.length}</span>
              </button>
              {categories.map(c => (
                <button key={c.name}
                  className={`pos-category-pill${category === c.name ? ' active' : ''}`}
                  onClick={() => setCategory(c.name)}>
                  {c.name}
                  <span className="pos-category-pill-count">{c.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Product grid */}
          <div className="pos-products-grid">
            {visibleProducts.length === 0 ? (
              <div className="pos-products-empty">
                <div className="pos-products-empty-icon" aria-hidden>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                    <line x1="12" y1="22.08" x2="12" y2="12"/>
                  </svg>
                </div>
                <div className="pos-products-empty-title">{t('pos.noProducts')}</div>
                <p>{t('pos.searchProducts')}</p>
              </div>
            ) : (
              visibleProducts.map(p => {
                const stock = Number(p.quantity) || 0;
                const stockClass = stock <= 0 ? 'out' : (stock < 5 ? 'low' : '');
                const monogram = (p.name || '?').trim().charAt(0).toUpperCase();
                return (
                  <button key={p.id} className="pos-product-tile" onClick={() => addProduct(p)}>
                    <span className="pos-product-tile-monogram" aria-hidden>{monogram}</span>
                    <span className="pos-product-tile-name">{p.name}</span>
                    <span className="pos-product-tile-foot">
                      <span className="pos-product-tile-price">{fmt(p.sale_price)}</span>
                      <span className={`pos-product-tile-stock ${stockClass}`}>
                        <span className="pos-product-tile-stock-dot" />
                        {num(stock)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Custom-line trigger sits as a quiet ghost action at the
              bottom of the products column. */}
          <div className="pos-products-foot">
            <button className="btn btn-ghost btn-sm" onClick={addCustomLine}>
              {t('pos.customLine')}
            </button>
          </div>
        </div>

        {/* Cart column */}
        <div className="pos-cart-panel">
          <div className="pos-cart-header">
            <span className="pos-cart-header-title">{t('pos.cart')}</span>
            <span className="pos-cart-line-count">
              {cart.length} {t('pos.qty').toLowerCase()}
            </span>
          </div>

          {cart.length === 0 ? (
            <div className="pos-cart-empty">
              <div className="pos-cart-empty-icon" aria-hidden>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="21" r="1"/>
                  <circle cx="20" cy="21" r="1"/>
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                </svg>
              </div>
              <div className="pos-cart-empty-title">{t('pos.cart')}</div>
              <p>{t('pos.cartEmpty')}</p>
            </div>
          ) : (
            <div className="pos-cart-list">
              {cart.map(l => {
                const qty   = Number(l.quantity) || 0;
                const unit  = Number(l.unit_price) || 0;
                const disc  = Number(l.discount) || 0;
                const gross = Math.max(0, qty * unit - disc);
                const overstock = l.stock != null && qty > l.stock;
                return (
                  <div key={l.key} className="pos-cart-line">
                    <div className="pos-cart-line-body">
                      {l.inventory_id ? (
                        <div className="pos-cart-line-name">{l.name}</div>
                      ) : (
                        <CustomLineNameCombobox
                          line={l}
                          taxEnabled={taxEnabled}
                          defaultRate={posDefaultRate}
                          placeholder={t('pos.customLineName')}
                          onPatch={(patch) => setLine(l.key, patch)}
                        />
                      )}
                      <div className="pos-cart-line-meta">
                        {num(qty)} × {fmt(unit)}
                        {disc > 0 && (
                          <span style={{ color: 'var(--affirm)', marginInlineStart: 8 }}>
                            − {fmt(disc)}
                          </span>
                        )}
                        {overstock && (
                          <span className="alert">{t('pos.insufficientStock')}</span>
                        )}
                      </div>
                    </div>

                    <div className="pos-cart-line-right">
                      <div className="pos-qty-control" role="group" aria-label={t('pos.qty')}>
                        <button type="button" className="pos-qty-btn"
                          onClick={() => bumpQty(l.key, -1)}
                          aria-label="−">−</button>
                        <input className="pos-qty-value"
                          type="number" min="1" step="1"
                          value={qty}
                          onChange={e => setLine(l.key, { quantity: e.target.value })}
                          onFocus={e => e.target.select()} />
                        <button type="button" className="pos-qty-btn"
                          onClick={() => bumpQty(l.key, +1)}
                          aria-label="+">+</button>
                      </div>
                      {discountEnabled && (
                        <input type="number"
                          className="pos-cart-line-disc"
                          min="0" step="0.01"
                          placeholder={t('pos.discount')}
                          title={t('pos.discount')}
                          value={l.discount}
                          onChange={e => setLine(l.key, { discount: e.target.value })}
                          onFocus={e => e.target.select()} />
                      )}
                      <div className="pos-cart-line-total">{fmt(gross)}</div>
                      <button type="button" className="pos-cart-line-remove"
                        onClick={() => removeLine(l.key)}
                        aria-label={t('common.delete')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2.4"
                          strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/>
                          <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Sticky summary + charge button */}
          <div className="pos-cart-summary">
            <div className="pos-cart-discount-row">
              <label htmlFor="pos-order-discount">{t('pos.orderDiscount')}</label>
              <input id="pos-order-discount"
                className="pos-cart-discount-input"
                type="number" step="any" min="0"
                value={orderDiscount}
                placeholder="0"
                onChange={e => setOrderDiscount(e.target.value)} />
            </div>
            <div className="pos-cart-summary-row">
              <span>{t('pos.subtotal')}</span>
              <span>{fmt(pricing.subtotal)}</span>
            </div>
            {taxEnabled && (
              <div className="pos-cart-summary-row tax">
                <span>{t('pos.taxTotal')}</span>
                <span>{fmt(pricing.taxTotal)}</span>
              </div>
            )}
            {pricing.discountTotal > 0 && (
              <div className="pos-cart-summary-row savings">
                <span>{t('pos.savings')}</span>
                <span>−{fmt(pricing.discountTotal)}</span>
              </div>
            )}
            <div className="pos-cart-summary-total">
              <span className="pos-cart-summary-total-label">{t('pos.total')}</span>
              <span className="pos-cart-summary-total-value">{fmt(pricing.total)}</span>
            </div>
            <button className="pos-charge-btn"
              disabled={!cartValid}
              onClick={() => setCheckout(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2" y="5" width="20" height="14" rx="2"/>
                <line x1="2" y1="10" x2="22" y2="10"/>
              </svg>
              {t('pos.checkout')}
              <span className="pos-charge-btn-amount">· {fmt(pricing.total)}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Sessions view ───────────────────────────────────────────────────────────
function SessionsView() {
  const { t, fmt, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getPosSessions().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!rows) return <LoadingSpinner />;
  if (rows.length === 0) return <EmptyState message={t('pos.noSessions')} />;

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>{t('pos.cashier')}</th>
            <th>{t('common.status')}</th>
            <th>{t('pos.openingFloat')}</th>
            <th>{t('pos.expectedCash')}</th>
            <th>{t('pos.closingCount')}</th>
            <th>{t('pos.variance')}</th>
            <th>{t('common.date')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td>{s.cashier_name}</td>
              <td>
                <span className={`badge badge-${s.status === 'open' ? 'green' : 'gray'}`}>{s.status}</span>
              </td>
              <td>{fmt(s.opening_float)}</td>
              <td>{s.expected_cash != null ? fmt(s.expected_cash) : '—'}</td>
              <td>{s.closing_count != null ? fmt(s.closing_count) : '—'}</td>
              <td style={{ color: s.variance == null ? undefined
                            : Math.abs(s.variance) < 0.01 ? 'var(--green)' : 'var(--red)' }}>
                {s.variance != null ? fmt(s.variance) : '—'}
              </td>
              <td>{fmtDate(s.opened_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sale detail modal ───────────────────────────────────────────────────────
function SaleDetailModal({ saleId, canReturn, onClose, onReturned }) {
  const { t, fmt, fmtDate } = useLocale();
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  const [confirmReturn, setConfirmReturn] = useState(false);

  useEffect(() => {
    getPosSale(saleId).then(setSale).catch(e => setError(e.message));
  }, [saleId]);

  async function doReturn() {
    try {
      await returnPosSale(saleId);
      toast(t('pos.saleReturned'), 'green');
      onReturned();
    } catch (e) {
      toast(e.message, 'red');
      setConfirmReturn(false);
    }
  }

  return (
    <Modal title={`${t('pos.saleNumber')} ${sale?.invoice_number || ''}`} onClose={onClose}>
      <div className="modal-body">
        {error && <ErrorAlert message={error} />}
        {!sale && !error && <LoadingSpinner />}
        {sale && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
              {sale.client_name || t('pos.walkIn')} · {fmtDate(sale.created_at)} · {sale.cashier_name}
              {' · '}<Badge status={sale.status === 'returned' ? 'Rejected' : 'Paid'} />
            </div>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr><th>{t('pos.customLineName')}</th><th>{t('pos.qty')}</th>
                    <th>{t('pos.price')}</th><th>{t('pos.discount')}</th>
                    <th style={{ textAlign: 'end' }}>{t('pos.total')}</th></tr>
              </thead>
              <tbody>
                {sale.items.map(it => {
                  const gross = Math.max(0, (Number(it.quantity) || 0) * (Number(it.unit_price) || 0)
                                            - (Number(it.discount) || 0));
                  return (
                    <tr key={it.id}>
                      <td>{it.name}</td>
                      <td>{num(it.quantity)}</td>
                      <td>{fmt(it.unit_price)}</td>
                      <td>{Number(it.discount) > 0 ? `−${fmt(it.discount)}` : '—'}</td>
                      <td style={{ textAlign: 'end' }}>{fmt(gross)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('pos.subtotal')}</span><span>{fmt(sale.subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)' }}>
                <span>{t('pos.taxTotal')}</span><span>{fmt(sale.tax_total)}</span>
              </div>
              {sale.discount_total > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green)' }}>
                  <span>{t('pos.savings')}</span><span>−{fmt(sale.discount_total)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{t('pos.total')}</span><span>{fmt(sale.amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-3)', marginTop: 6 }}>
                <span>{t('pos.cogs')}</span><span>{fmt(sale.cogs_total)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600,
                            color: sale.margin >= 0 ? 'var(--green)' : 'var(--red)' }}>
                <span>{t('pos.margin')}</span><span>{fmt(sale.margin)}</span>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {sale && canReturn && sale.status !== 'returned' && (
          <button className="btn btn-danger" onClick={() => setConfirmReturn(true)}>
            {t('pos.processReturn')}
          </button>
        )}
      </div>
      {confirmReturn && (
        <ConfirmModal
          title={t('pos.processReturn')}
          message={t('pos.returnConfirm')}
          confirmLabel={t('pos.processReturn')}
          confirmClass="btn-danger"
          onCancel={() => setConfirmReturn(false)}
          onConfirm={doReturn}
        />
      )}
    </Modal>
  );
}

// ── History view ────────────────────────────────────────────────────────────
function HistoryView({ canReturn }) {
  const { t, fmt, fmtDate } = useLocale();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    getPosSales().then(setRows).catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorAlert message={error} onRetry={load} />;
  if (!rows) return <LoadingSpinner />;
  if (rows.length === 0) return <EmptyState message={t('pos.noSales')} />;

  // Flat shape — keys become Excel column headers when XLSX.json_to_sheet
  // serialises this. Use the same column order the table uses.
  const exportData = rows.map(s => ({
    Sale:          s.invoice_number,
    Customer:      s.client_name || 'Walk-in',
    Cashier:       s.cashier_name || '',
    Payment:       s.payment_method || '',
    Total_USD:     s.total_usd || 0,
    Total_LBP:     s.total_lbp || 0,
    Discount:      s.discount_total || 0,
    COGS:          s.cogs_total || 0,
    Status:        s.status === 'returned' ? 'Returned' : 'Paid',
    Date:          fmtDate(s.created_at),
  }));

  return (
    <div className="card">
      {openId && (
        <SaleDetailModal
          saleId={openId} canReturn={canReturn}
          onClose={() => setOpenId(null)}
          onReturned={() => { setOpenId(null); load(); }}
        />
      )}
      <div className="card-header" style={{ justifyContent: 'flex-end' }}>
        <ExportButton data={exportData} filename="POS_Sales" sheetName="Sales" />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('pos.saleNumber')}</th>
            <th>{t('pos.customer')}</th>
            <th>{t('pos.cashier')}</th>
            <th>{t('pos.paymentMethod')}</th>
            <th>{t('pos.total')}</th>
            <th>{t('pos.status')}</th>
            <th>{t('common.date')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td>{s.invoice_number}</td>
              <td>{s.client_name || t('pos.walkIn')}</td>
              <td>{s.cashier_name}</td>
              <td>{s.payment_method}</td>
              <td>{fmt(s.total_usd)}</td>
              <td><Badge status={s.status === 'returned' ? 'Rejected' : 'Paid'} /></td>
              <td>{fmtDate(s.created_at)}</td>
              <td>
                <button className="btn btn-secondary btn-sm" onClick={() => setOpenId(s.id)}>
                  {t('pos.viewSale')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function POS() {
  const { t } = useLocale();
  const { can } = usePermissions();
  const [view, setView] = useState('register');
  const [session, setSession] = useState(undefined);   // undefined = loading, null = none
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);

  const canCreate = can('pos', 'create');
  const canReturn = can('pos', 'edit');

  const loadSession = useCallback(() => {
    setError(null);
    getPosSession()
      .then(s => setSession(s || null))
      .catch(e => { setError(e.message); setSession(null); });
  }, []);
  useEffect(() => { loadSession(); }, [loadSession]);

  const tabs = [
    { key: 'register', label: t('pos.register') },
    { key: 'sessions', label: t('pos.sessions') },
    { key: 'history',  label: t('pos.history') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>{t('pos.title')}</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map(tb => (
            <button key={tb.key}
              className={`btn btn-sm ${view === tb.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView(tb.key)}>
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadSession} />}

      {receipt && <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} />}

      {view === 'register' && (
        session === undefined ? <LoadingSpinner />
        : !canCreate ? <EmptyState message={t('pos.needOpenSession')} icon="🔒" />
        : session === null ? <OpenRegisterPanel onOpened={loadSession} />
        : <RegisterView
            session={session}
            onClose={loadSession}
            onSold={(res) => { setReceipt(res); loadSession(); }}
          />
      )}

      {view === 'sessions' && <SessionsView />}
      {view === 'history'  && <HistoryView canReturn={canReturn} />}
    </div>
  );
}
