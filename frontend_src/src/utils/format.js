// Single home for number/money display formatting.
//
// Money in the *functional currency with the user's display-currency toggle*
// goes through useMoney()/fmt in components/shared — those are context-aware.
// The helpers here are the plain, context-free formatters that pages used to
// re-declare locally (Inventory, Purchases, CRM, Cash…).

// Plain quantity/cost number — always 2 decimals ("1,234.50").
export const fmtNum = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Whole-dollar display for pipeline/deal values ("$12,500"), em-dash when empty.
export function fmtCurr(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// USD and LBP are formatted — and shown — strictly separately. They are never
// added together: a drawer holds two independent physical cash balances.
const _usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
const _lbp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const money = (v, ccy) => ccy === 'LBP'
  ? `${_lbp.format(Number(v) || 0)} LBP`
  : _usd.format(Number(v) || 0);
