import { useState, useEffect, useRef } from 'react';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useLocale } from '../../hooks/useLocale.jsx';
import { useSettings } from '../../hooks/useSettings.jsx';
import { Modal, toast, NumberInput } from '../../components/shared';
import { getPosProducts, getClients, getPosCashDrawers, getActivePromotions } from '../../api/client';
import { num, r2, productUsdUnitPrice, _lbpGrp, formatProductPrice, priceCart } from './pricing';
import { CloseRegisterModal } from './CloseRegisterModal';
import { CheckoutModal } from './CheckoutModal';
import { CustomLineNameCombobox } from './CustomLineNameCombobox';

// Group variant SKUs under one tile per product; simple items (no product_id)
// stay as their own tile. Preserves first-seen order.
//
// Outside the component because the scanner path groups a freshly-fetched set
// of rows rather than whatever is currently on screen.
function tilesFor(rows) {
  const byProduct = new Map();
  const tiles = [];
  for (const p of rows || []) {
    if (p.product_id == null) { tiles.push({ kind: 'item', item: p }); continue; }
    let g = byProduct.get(p.product_id);
    if (!g) {
      g = { kind: 'group', product_id: p.product_id,
            name: p.product_name || p.name, category: p.category, variants: [] };
      byProduct.set(p.product_id, g);
      tiles.push(g);
    }
    g.variants.push(p);
  }
  return tiles;
}

function RegisterView({ session, amending, onCancelAmend, onClose, onSold }) {
  const { t, fmt, tCategory } = useLocale();
  const { settings, taxRates, exchangeRate } = useSettings();
  const fxRate = Number(exchangeRate?.rate) || 0;
  const [search, setSearch] = useState('');
  // Two product pools — browse (loaded once on mount, used when search
  // is empty) and results (debounced search). Keeping them separate lets
  // category filtering work over the browse pool without nuking search.
  const [browsePool, setBrowsePool] = useState([]);
  const [results, setResults] = useState([]);
  const [category, setCategory] = useState('');     // '' = All
  const [variantPicker, setVariantPicker] = useState(null);  // open product group
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

  // Display-currency toggle: the books stay in USD, but the cashier can flip the
  // whole register to show LBP (USD × rate) so they can read a price to a
  // Lebanese customer and take LBP cash without doing the maths in their head.
  // Display-only — the sale is still recorded in USD; LBP tender is handled at
  // checkout. Only offered once an exchange rate exists.
  const secondary = exchangeRate?.secondary || 'LBP';
  const showCurrencyToggle = fxRate > 0;
  const [posDisplay, setPosDisplay] = usePersistedState('pos.displayCurrency', 'USD');
  const inLbp = posDisplay === 'LBP' && fxRate > 0;
  const posMoney = (usd) => inLbp
    ? `${_lbpGrp.format(Math.round((Number(usd) || 0) * fxRate))} ${secondary}`
    : fmt(usd);
  const tilePrice = (p) => inLbp
    ? `${_lbpGrp.format(Math.round(productUsdUnitPrice(p, fxRate) * fxRate))} ${secondary}`
    : formatProductPrice(p, secondary);

  // Live promotions the register auto-applies (display only — checkout is the
  // authority on the quantity cap). Matched per cart line by item or category.
  const [activePromos, setActivePromos] = useState([]);
  const promoFor = (l) => {
    if (!l || l.inventory_id == null) return null;
    let best = null;
    for (const p of activePromos) {
      const hit = p.scope_type === 'all'
        || (p.scope_type === 'item' && String(p.scope_value) === String(l.inventory_id))
        || (p.scope_type === 'category' && l.category && p.scope_value === l.category);
      if (hit && (!best || p.discount_value > best.discount_value)) best = p;
    }
    return best;
  };
  const promoOf = (l) => promoFor(l)?.discount_value || 0;

  useEffect(() => {
    getClients().then(setClients).catch(() => {});
    getPosCashDrawers().then(setDrawers).catch(() => {});
    getActivePromotions().then(p => setActivePromos(Array.isArray(p) ? p : [])).catch(() => {});
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

  const displayTiles = tilesFor(visibleProducts);

  // Tapping a tile: a simple item or single-variant product adds straight to the
  // cart; a multi-variant product opens the size/colour picker first.
  function openTile(tile) {
    if (tile.kind === 'item') { addProduct(tile.item); return; }
    if (tile.variants.length === 1) { addProduct(tile.variants[0]); return; }
    setVariantPicker(tile);
  }

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
    // LBP-priced items need a configured rate to convert to the USD cart line.
    if (String(p.price_currency || 'USD').toUpperCase() === 'LBP' && fxRate <= 0) {
      toast(t('pos.exchangeRate'), 'red');
      return;
    }
    setCart(prev => {
      const ex = prev.find(l => l.inventory_id === p.id);
      if (ex) return prev.map(l => l === ex ? { ...l, quantity: l.quantity + 1 } : l);
      return [...prev, {
        key: ++keyRef.current, name: p.name, inventory_id: p.id,
        quantity: 1, unit_price: productUsdUnitPrice(p, fxRate), discount: 0,
        tax_rate_id: posDefaultRate ? posDefaultRate.id : null,
        line_type: 'product', stock: Number(p.quantity) || 0,
        category: p.category || null,   // for category-scoped promo matching
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

  // Correcting a sale opens the register holding what was sold. The lines
  // come from `pos_sale_items`, which is the receipt-native view: the price
  // there is VAT-INCLUSIVE and the discount is the one that was applied, which
  // is exactly the shape a cart line takes. Seeding from `invoice_items`
  // instead would put the ex-VAT unit price into a VAT-inclusive box and quietly
  // reprice the whole sale.
  //
  // Keyed on the sale id so re-rendering does not keep resetting a cart the
  // cashier is in the middle of editing.
  const seededFor = useRef(null);
  useEffect(() => {
    if (!amending) { seededFor.current = null; return; }
    if (seededFor.current === amending.id) return;
    seededFor.current = amending.id;
    setCart((amending.items || []).map(it => ({
      key: ++keyRef.current,
      name: it.name,
      inventory_id: it.inventory_id,
      quantity: Number(it.quantity) || 0,
      unit_price: Number(it.unit_price) || 0,
      discount: Number(it.discount) || 0,
      tax_rate_id: taxEnabled ? (it.tax_rate_id ?? (posDefaultRate ? posDefaultRate.id : null)) : null,
      line_type: it.line_type || (it.inventory_id != null ? 'product' : 'service'),
      stock: null,
      category: it.category || null,
    })));
    setOrderDiscount('');
  }, [amending, taxEnabled, posDefaultRate]);

  async function onSearchKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = search.trim();
    if (!term) return;

    // A scanner types the whole barcode in a few milliseconds and sends Enter
    // straight after it. The debounce has not fired yet, so what is on screen
    // is still empty — acting on it did nothing at all, and the cashier had to
    // press Enter a second time once the results caught up. Resolve the term
    // now instead of waiting for a timer.
    let tiles = displayTiles;
    if (tiles.length === 0) {
      const rows = await getPosProducts(term).catch(() => []);
      if (!rows.length) return;      // nothing matches; leave the term to edit
      setResults(rows);
      tiles = tilesFor(rows);
    }

    // A scan resolves to a single variant row → add it directly even when it
    // belongs to a product group; otherwise act on the top tile.
    if (tiles.length === 1 && tiles[0].kind === 'group'
        && tiles[0].variants.length === 1) {
      addProduct(tiles[0].variants[0]);
    } else {
      openTile(tiles[0]);
    }
    setSearch('');
    setResults([]);
  }

  const pricing = priceCart(cart, orderDiscount, taxEnabled, rateOf, posDefaultRate, promoOf);

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
          amending={amending}
          defaultCurrency={inLbp ? 'LBP' : 'USD'}
          onClose={() => setCheckout(false)}
          onDone={(res) => { setCheckout(false); setCart([]); setOrderDiscount(''); onSold(res); }}
        />
      )}
      {variantPicker && (
        <Modal title={variantPicker.name} onClose={() => setVariantPicker(null)}>
          <div className="modal-body">
            <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 12px' }}>
              {t('pos.pickVariant')}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {variantPicker.variants.map(v => {
                const stock = Number(v.quantity) || 0;
                const out = stock <= 0;
                return (
                  <button key={v.id} type="button" disabled={out}
                    className={`btn ${out ? 'btn-secondary' : 'btn-primary'}`}
                    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, opacity: out ? 0.5 : 1 }}
                    onClick={() => { addProduct(v); setVariantPicker(null); }}>
                    <span style={{ fontWeight: 600 }}>{v.variant_label || v.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 400 }}>
                      {tilePrice(v)} · {t('pos.inStock', { count: stock })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {showCurrencyToggle && (
            <div role="group" aria-label={t('common.displayCurrency')}
              style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {['USD', secondary].map(cur => {
                const on = (cur === 'USD') === (posDisplay === 'USD');
                return (
                  <button key={cur} type="button"
                    onClick={() => setPosDisplay(cur === 'USD' ? 'USD' : 'LBP')}
                    style={{ border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 13, fontWeight: 700,
                      background: on ? 'var(--accent)' : 'transparent', color: on ? '#fff' : 'var(--text-2)' }}>
                    {cur}
                  </button>
                );
              })}
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => setClosing(true)}>
            {t('pos.closeRegister')}
          </button>
        </div>
      </div>

      {amending && (
        <div className="alert alert-warning"
             style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 10, flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
          <span>
            <strong>{t('pos.correctingSale')} {amending.invoice_number}</strong>
            {' — '}{t('pos.correctingHint')}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={onCancelAmend}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* ── Workspace grid ───────────────────────────────────────── */}
      <div className="pos-workspace">

        {/* Products column */}
        <div className="pos-products-section">
          {/* Search + a prominent always-visible custom-item action */}
          <div className="pos-search-row" style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
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
            <button type="button" className="btn btn-primary"
              onClick={addCustomLine}
              style={{ whiteSpace: 'nowrap', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}
              title={t('pos.customLineHint')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              {t('pos.customItem')}
            </button>
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
                  {tCategory(c.name)}
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
              displayTiles.map(tile => {
                if (tile.kind === 'group') {
                  const stock = tile.variants.reduce((s, v) => s + (Number(v.quantity) || 0), 0);
                  const stockClass = stock <= 0 ? 'out' : (stock < 5 ? 'low' : '');
                  const monogram = (tile.name || '?').trim().charAt(0).toUpperCase();
                  const rep = tile.variants[0];
                  return (
                    <button key={`p${tile.product_id}`} className="pos-product-tile" onClick={() => openTile(tile)}>
                      <span className="pos-product-tile-monogram" aria-hidden>{monogram}</span>
                      <span className="pos-product-tile-name">{tile.name}</span>
                      <span className="pos-product-tile-foot">
                        <span className="pos-product-tile-price">
                          {t('pos.variantCount', { count: tile.variants.length })}
                        </span>
                        <span className={`pos-product-tile-stock ${stockClass}`}>
                          <span className="pos-product-tile-stock-dot" />
                          {num(stock)}
                        </span>
                      </span>
                    </button>
                  );
                }
                const p = tile.item;
                const stock = Number(p.quantity) || 0;
                const stockClass = stock <= 0 ? 'out' : (stock < 5 ? 'low' : '');
                const monogram = (p.name || '?').trim().charAt(0).toUpperCase();
                return (
                  <button key={p.id} className="pos-product-tile" onClick={() => addProduct(p)}>
                    <span className="pos-product-tile-monogram" aria-hidden>{monogram}</span>
                    <span className="pos-product-tile-name">{p.name}</span>
                    <span className="pos-product-tile-foot">
                      <span className="pos-product-tile-price">{tilePrice(p)}</span>
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

          {/* The custom-item action now lives prominently next to the search
              bar (see above), so no quiet ghost trigger is needed here. */}
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
                const promo = promoFor(l);
                const promoDisc = promo ? r2(qty * unit * promo.discount_value / 100) : 0;
                const gross = Math.max(0, qty * unit - disc - promoDisc);
                const overstock = l.stock != null && qty > l.stock;
                return (
                  <div key={l.key} className="pos-cart-line">
                    <div className="pos-cart-line-body">
                      {l.inventory_id ? (
                        <div className="pos-cart-line-name">
                          {l.name}
                          {promo && (
                            <span style={{ display: 'inline-block', marginInlineStart: 6, padding: '1px 6px',
                              borderRadius: 10, fontSize: 10, fontWeight: 700,
                              background: '#ECFDF5', color: '#059669' }}>
                              {promo.name} −{promo.discount_value}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          <CustomLineNameCombobox
                            line={l}
                            taxEnabled={taxEnabled}
                            defaultRate={posDefaultRate}
                            placeholder={t('pos.customLineName')}
                            onPatch={(patch) => setLine(l.key, patch)}
                          />
                          {/* Unregistered item → cashier types the price. */}
                          <NumberInput
                            className="form-control"
                            style={{ height: 30, marginTop: 4, maxWidth: 130 }}
                            min="0" step="0.01"
                            placeholder={t('pos.customPricePlaceholder')}
                            value={l.unit_price}
                            onChange={e => setLine(l.key, { unit_price: e.target.value })}
                            onFocus={e => e.target.select()} />
                        </>
                      )}
                      <div className="pos-cart-line-meta">
                        {num(qty)} × {posMoney(unit)}
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
                        <NumberInput className="pos-qty-value"
                          min="1" step="1"
                          value={qty}
                          onChange={e => setLine(l.key, { quantity: e.target.value })}
                          onFocus={e => e.target.select()} />
                        <button type="button" className="pos-qty-btn"
                          onClick={() => bumpQty(l.key, +1)}
                          aria-label="+">+</button>
                      </div>
                      {discountEnabled && (
                        <NumberInput
                          className="pos-cart-line-disc"
                          min="0" step="0.01"
                          placeholder={t('pos.discount')}
                          title={t('pos.discount')}
                          value={l.discount}
                          onChange={e => setLine(l.key, { discount: e.target.value })}
                          onFocus={e => e.target.select()} />
                      )}
                      <div className="pos-cart-line-total">{posMoney(gross)}</div>
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
              <NumberInput id="pos-order-discount"
                className="pos-cart-discount-input"
                step="any" min="0"
                value={orderDiscount}
                placeholder="0"
                onChange={e => setOrderDiscount(e.target.value)} />
            </div>
            <div className="pos-cart-summary-row">
              <span>{t('pos.subtotal')}</span>
              <span>{posMoney(pricing.subtotal)}</span>
            </div>
            {taxEnabled && (
              <div className="pos-cart-summary-row tax">
                <span>{t('pos.taxTotal')}</span>
                <span>{posMoney(pricing.taxTotal)}</span>
              </div>
            )}
            {pricing.discountTotal > 0 && (
              <div className="pos-cart-summary-row savings">
                <span>{t('pos.savings')}</span>
                <span>−{posMoney(pricing.discountTotal)}</span>
              </div>
            )}
            <div className="pos-cart-summary-total">
              <span className="pos-cart-summary-total-label">{t('pos.total')}</span>
              <span className="pos-cart-summary-total-value">
                {posMoney(pricing.total)}
                {inLbp && <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--text-3)' }}>≈ {fmt(pricing.total)}</span>}
              </span>
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
              {amending ? t('pos.saveCorrection') : t('pos.checkout')}
              <span className="pos-charge-btn-amount">· {posMoney(pricing.total)}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}


export { RegisterView };
