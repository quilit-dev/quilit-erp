import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocale } from '../hooks/useLocale.jsx';
import { usePermissions } from '../hooks/usePermissions.js';
import { useSettings } from '../hooks/useSettings.jsx';
import { LoadingSpinner, ErrorAlert, EmptyState, Modal, ConfirmModal, Badge, toast } from '../components/shared';
import {
  getPosSession, openPosSession, closePosSession, getPosSessions,
  posCheckout, getPosSales, getPosSale, returnPosSale, getPosProducts, getClients,
  getPosCashDrawers,
} from '../api/client';

const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(v) || 0);

// Compute a sale's pricing the same way the backend does: prices are
// VAT-INCLUSIVE, line + order discounts come off the gross, tax is extracted.
function priceCart(cart, orderDiscount, taxEnabled, rateOf, defaultRate) {
  const grossAfterLine = cart.map(l => {
    const g = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
    return Math.max(0, g - (Number(l.discount) || 0));
  });
  const grossSum = grossAfterLine.reduce((a, b) => a + b, 0);
  const od = Math.min(Math.max(0, Number(orderDiscount) || 0), grossSum);
  let subtotal = 0, taxTotal = 0, total = 0;
  cart.forEach((l, i) => {
    const share = grossSum > 0 ? od * grossAfterLine[i] / grossSum : 0;
    const finalGross = Math.max(0, grossAfterLine[i] - share);
    const r = taxEnabled ? (rateOf(l.tax_rate_id) || defaultRate) : null;
    const tax = r ? finalGross * (Number(r.rate) || 0) / (100 + (Number(r.rate) || 0)) : 0;
    subtotal += finalGross - tax;
    taxTotal += tax;
    total    += finalGross;
  });
  const discountTotal = cart.reduce((a, l) => a + (Number(l.discount) || 0), 0) + od;
  return { subtotal, taxTotal, total, discountTotal, orderDiscount: od };
}

// ── Open-register panel ─────────────────────────────────────────────────────
function OpenRegisterPanel({ onOpened }) {
  const { t } = useLocale();
  const [floatUsd, setFloatUsd] = useState('0');
  const [floatLbp, setFloatLbp] = useState('0');
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      await openPosSession({
        opening_float:     parseFloat(floatUsd) || 0,
        opening_float_lbp: parseFloat(floatLbp) || 0,
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
    <div className="card" style={{ maxWidth: 420, margin: '40px auto', padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>🧾</div>
      <h3 style={{ margin: '0 0 6px' }}>{t('pos.openRegister')}</h3>
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 16 }}>{t('pos.openRegisterPrompt')}</p>
      <div className="form-group" style={{ textAlign: 'start' }}>
        <label className="form-label">{t('pos.openingFloat')} (USD)</label>
        <input className="form-control" type="number" step="any" min="0" value={floatUsd}
          onChange={e => setFloatUsd(e.target.value)} autoFocus />
      </div>
      <div className="form-group" style={{ textAlign: 'start' }}>
        <label className="form-label">{t('pos.openingFloat')} (LBP)</label>
        <input className="form-control" type="number" step="any" min="0" value={floatLbp}
          onChange={e => setFloatLbp(e.target.value)} />
      </div>
      <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={open}>
        {busy ? t('common.saving') : t('pos.openRegister')}
      </button>
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
function ReceiptModal({ sale, onClose }) {
  const { t, fmt } = useLocale();
  return (
    <Modal title={t('pos.receipt')} onClose={onClose}>
      <div className="modal-body">
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 28 }}>✅</div>
          <div style={{ fontWeight: 700 }}>{t('pos.saleCompleted')}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{sale.invoice_number}</div>
        </div>
        <table className="table" style={{ fontSize: 13 }}>
          <tbody>
            <tr><td>{t('pos.subtotal')}</td><td style={{ textAlign: 'end' }}>{fmt(sale.subtotal)}</td></tr>
            <tr><td>{t('pos.taxTotal')}</td><td style={{ textAlign: 'end' }}>{fmt(sale.tax_total)}</td></tr>
            {sale.discount_total > 0 && (
              <tr><td>{t('pos.savings')}</td>
                  <td style={{ textAlign: 'end', color: 'var(--green)' }}>−{fmt(sale.discount_total)}</td></tr>
            )}
            <tr><td><strong>{t('pos.total')}</strong></td>
                <td style={{ textAlign: 'end' }}><strong>{fmt(sale.total)}</strong></td></tr>
            <tr><td>{t('pos.change')}</td><td style={{ textAlign: 'end' }}>{num(sale.change_given)}</td></tr>
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', marginTop: 6 }}>
          {t('pos.taxIncluded')}
        </p>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={() => window.print()}>{t('pos.printReceipt')}</button>
        <button className="btn btn-primary" onClick={onClose}>{t('pos.newSale')}</button>
      </div>
    </Modal>
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
      onDone(res);
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
  const [results, setResults] = useState([]);
  const [cart, setCart] = useState([]);
  const [orderDiscount, setOrderDiscount] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [clients, setClients] = useState([]);
  const [drawers, setDrawers] = useState([]);
  const [closing, setClosing] = useState(false);
  const keyRef = useRef(0);

  const taxEnabled = settings?.tax_enabled === '1' && taxRates.length > 0;
  const defaultRate = taxRates.find(r => r.is_default);
  const rateOf = (id) => taxRates.find(r => r.id === id);

  useEffect(() => {
    getClients().then(setClients).catch(() => {});
    getPosCashDrawers().then(setDrawers).catch(() => {});
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

  function addProduct(p) {
    setCart(prev => {
      const ex = prev.find(l => l.inventory_id === p.id);
      if (ex) return prev.map(l => l === ex ? { ...l, quantity: l.quantity + 1 } : l);
      return [...prev, {
        key: ++keyRef.current, name: p.name, inventory_id: p.id,
        quantity: 1, unit_price: Number(p.sale_price) || 0, discount: 0,
        tax_rate_id: defaultRate ? defaultRate.id : null,
        line_type: 'product', stock: Number(p.quantity) || 0,
      }];
    });
  }

  function addCustomLine() {
    setCart(prev => [...prev, {
      key: ++keyRef.current, name: '', inventory_id: null,
      quantity: 1, unit_price: 0, discount: 0,
      tax_rate_id: defaultRate ? defaultRate.id : null,
      line_type: 'service', stock: null,
    }]);
  }

  const setLine = (key, patch) =>
    setCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  const removeLine = (key) => setCart(prev => prev.filter(l => l.key !== key));

  function onSearchKeyDown(e) {
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      addProduct(results[0]);
      setSearch('');
      setResults([]);
    }
  }

  const pricing = priceCart(cart, orderDiscount, taxEnabled, rateOf, defaultRate);

  const checkoutItems = cart.map(l => ({
    name: l.name || t('pos.customLineName'),
    inventory_id: l.inventory_id,
    quantity: Number(l.quantity) || 0,
    unit_price: Number(l.unit_price) || 0,
    discount: Number(l.discount) || 0,
    tax_rate_id: taxEnabled ? l.tax_rate_id : null,
    line_type: l.line_type,
  }));

  const cartValid = cart.length > 0 &&
    cart.every(l => (l.name || l.inventory_id) && Number(l.quantity) > 0) &&
    pricing.total > 0;

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
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

      {/* Product search */}
      <div className="card" style={{ flex: '1 1 320px', minWidth: 300, padding: 14 }}>
        <input
          className="form-control" autoFocus value={search}
          placeholder={t('pos.searchProducts')}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        <div style={{ marginTop: 10, maxHeight: 420, overflowY: 'auto' }}>
          {search.trim() && results.length === 0 && (
            <p style={{ color: 'var(--text-3)', fontSize: 13, padding: 8 }}>{t('pos.noProducts')}</p>
          )}
          {results.map(p => (
            <button key={p.id} className="pos-product-row" onClick={() => addProduct(p)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
                borderRadius: 8, marginBottom: 6, background: 'var(--surface)', cursor: 'pointer',
                textAlign: 'start',
              }}>
              <span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11, display: 'block' }}>
                  {num(p.quantity)} {p.unit || ''} {t('pos.inStock')}
                </span>
              </span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{fmt(p.sale_price)}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={addCustomLine}>
          {t('pos.customLine')}
        </button>
      </div>

      {/* Cart */}
      <div className="card" style={{ flex: '2 1 420px', minWidth: 320, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('pos.cart')}</h3>
        {cart.length === 0 && (
          <p style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('pos.cartEmpty')}</p>
        )}
        {cart.length > 0 && (
          <table className="table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>{t('pos.customLineName')}</th>
                <th style={{ width: 64 }}>{t('pos.qty')}</th>
                <th style={{ width: 84 }}>{t('pos.price')}</th>
                <th style={{ width: 84 }}>{t('pos.discount')}</th>
                {taxEnabled && <th style={{ width: 104 }}>{t('pos.lineTax')}</th>}
                <th style={{ width: 84, textAlign: 'end' }}>{t('pos.total')}</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {cart.map(l => {
                const gross = Math.max(0, (Number(l.quantity) || 0) * (Number(l.unit_price) || 0)
                                          - (Number(l.discount) || 0));
                return (
                  <tr key={l.key}>
                    <td>
                      {l.inventory_id
                        ? <span style={{ fontWeight: 600 }}>{l.name}</span>
                        : <CustomLineNameCombobox
                            line={l}
                            taxEnabled={taxEnabled}
                            defaultRate={defaultRate}
                            placeholder={t('pos.customLineName')}
                            onPatch={(patch) => setLine(l.key, patch)}
                          />}
                    </td>
                    <td>
                      <input className="form-control" style={{ height: 30 }} type="number"
                        step="any" min="0" value={l.quantity}
                        onChange={e => setLine(l.key, { quantity: e.target.value })} />
                      {l.stock != null && Number(l.quantity) > l.stock && (
                        <span style={{ color: 'var(--red)', fontSize: 10 }}>{t('pos.insufficientStock')}</span>
                      )}
                    </td>
                    <td>
                      <input className="form-control" style={{ height: 30 }} type="number"
                        step="any" min="0" value={l.unit_price}
                        onChange={e => setLine(l.key, { unit_price: e.target.value })} />
                    </td>
                    <td>
                      <input className="form-control" style={{ height: 30 }} type="number"
                        step="any" min="0" value={l.discount}
                        onChange={e => setLine(l.key, { discount: e.target.value })} />
                    </td>
                    {taxEnabled && (
                      <td>
                        <select className="form-control" style={{ height: 30 }}
                          value={l.tax_rate_id ?? ''}
                          onChange={e => setLine(l.key, { tax_rate_id: e.target.value ? Number(e.target.value) : null })}>
                          {taxRates.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td style={{ textAlign: 'end' }}>{fmt(gross)}</td>
                    <td>
                      <button className="icon-btn" onClick={() => removeLine(l.key)} title={t('common.delete')}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        fontSize: 13, marginBottom: 6 }}>
            <span>{t('pos.orderDiscount')}</span>
            <input className="form-control" type="number" step="any" min="0"
              style={{ height: 30, width: 120, textAlign: 'end' }}
              value={orderDiscount} placeholder="0"
              onChange={e => setOrderDiscount(e.target.value)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>{t('pos.subtotal')}</span><span>{fmt(pricing.subtotal)}</span>
          </div>
          {taxEnabled && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-3)' }}>
              <span>{t('pos.taxTotal')}</span><span>{fmt(pricing.taxTotal)}</span>
            </div>
          )}
          {pricing.discountTotal > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--green)' }}>
              <span>{t('pos.savings')}</span><span>−{fmt(pricing.discountTotal)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 700, marginTop: 4 }}>
            <span>{t('pos.total')}</span><span>{fmt(pricing.total)}</span>
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }}
            disabled={!cartValid} onClick={() => setCheckout(true)}>
            {t('pos.checkout')}
          </button>
        </div>
      </div>

      {/* Session strip */}
      <div className="card" style={{ flex: '1 1 100%', padding: '10px 14px', display: 'flex',
                                      justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {t('pos.cashier')}: <strong>{session.cashier_name}</strong>
          {' · '}{t('pos.salesCount')}: <strong>{session.sales_count ?? 0}</strong>
          {' · '}{t('pos.sessionTotal')}: <strong>{fmt(session.sales_total ?? 0)}</strong>
        </span>
        <button className="btn btn-secondary btn-sm" onClick={() => setClosing(true)}>
          {t('pos.closeRegister')}
        </button>
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

  return (
    <div className="card">
      {openId && (
        <SaleDetailModal
          saleId={openId} canReturn={canReturn}
          onClose={() => setOpenId(null)}
          onReturned={() => { setOpenId(null); load(); }}
        />
      )}
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
