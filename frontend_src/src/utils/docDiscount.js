// A discount on a whole invoice or quotation --- the form's mirror of
// backend/doc_discount.py, so the totals shown while typing are the totals the
// server will store. Taken off before VAT and spread across the lines by net;
// each line is taxed on what is left of it.

const cents = v => Math.round((Number(v) || 0) * 100) / 100;

/** How much comes off lines that net to `netSum`. 0 for no discount. */
export function docDiscountTotal(netSum, type, value) {
  const v = Number(value) || 0;
  const s = Math.max(0, Number(netSum) || 0);
  if (!(v > 0) || s <= 0) return 0;
  if (type === 'percent') return cents(s * Math.min(v, 100) / 100);
  if (type === 'amount') return cents(Math.min(v, s));
  return 0;
}

/** `total` spread across `nets` by share, cent-exact, never below zero. */
export function allocateDocDiscount(nets, total) {
  const t = cents(total);
  const ns = (nets || []).map(n => Math.max(0, Number(n) || 0));
  const s = ns.reduce((a, b) => a + b, 0);
  if (t <= 0 || s <= 0) return ns.map(() => 0);
  const shares = ns.map(n => cents(Math.min(n, t * n / s)));
  const residue = cents(t - shares.reduce((a, b) => a + b, 0));
  if (residue && shares.length) {
    let i = 0;
    ns.forEach((n, k) => { if (n > ns[i]) i = k; });
    shares[i] = cents(Math.min(ns[i], shares[i] + residue));
  }
  return shares;
}
