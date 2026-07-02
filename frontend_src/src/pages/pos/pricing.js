// POS pricing helpers — cart pricing, currency formatting, per-unit price.
// Pure functions extracted from POS.jsx; shared by the register + modals.

export const num = (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(v) || 0);

// Round to cents, half-up — mirrors the backend's money() so the figures the
// cashier sees match the persisted receipt to the cent. The epsilon nudge
// avoids binary-float cases like 2.675 rounding down.
export const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// A product may be priced natively in LBP (price_currency='LBP'). The cart and
// the books are USD-functional, so convert the LBP list price to USD at the
// current rate when it enters the cart — that's where the "float" is realised:
// today's rate sets today's USD price. USD-priced items pass through unchanged.
export function productUsdUnitPrice(p, rate) {
  const price = Number(p.sale_price) || 0;
  if (String(p.price_currency || 'USD').toUpperCase() === 'LBP') {
    return rate > 0 ? r2(price / rate) : 0;
  }
  return price;
}

// Shelf price as the cashier should see it: native LBP for LBP-priced items
// (so it matches the price tag), USD otherwise.
export const _lbpGrp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export function formatProductPrice(p, secondary = 'LBP') {
  const v = Number(p.sale_price) || 0;
  if (String(p.price_currency || 'USD').toUpperCase() === 'LBP') {
    return `${_lbpGrp.format(v)} ${secondary}`;
  }
  return `$${v.toFixed(2)}`;
}

// Compute a sale's pricing the same way the backend does: prices are
// VAT-INCLUSIVE, line + order discounts come off the gross, tax is extracted,
// and every line is rounded to cents BEFORE summing (so the subtotal / VAT
// split shown here equals what checkout stores).
export function priceCart(cart, orderDiscount, taxEnabled, rateOf, defaultRate, promoOf = () => 0) {
  // Automatic promo discount for a line = qty × unit × promo% (display only;
  // the server is authoritative on the quantity cap). Added to any manual
  // markdown, capped to the line gross.
  const lineDiscOf = (l) => {
    const g = r2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
    const pct = Number(promoOf(l)) || 0;
    const promo = pct > 0 ? r2(g * pct / 100) : 0;
    return Math.min(g, r2((Number(l.discount) || 0) + promo));
  };
  const grossAfterLine = cart.map(l => {
    const g = r2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
    return Math.max(0, r2(g - lineDiscOf(l)));
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
  const discountTotal = r2(cart.reduce((a, l) => a + lineDiscOf(l), 0) + od);
  return { subtotal: r2(subtotal), taxTotal: r2(taxTotal), total: r2(total), discountTotal, orderDiscount: od };
}

