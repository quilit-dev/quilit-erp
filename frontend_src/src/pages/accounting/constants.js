export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const monthStartISO = () => todayISO().slice(0, 7) + '-01';
export const yearStartISO  = () => todayISO().slice(0, 4) + '-01-01';

// Last calendar month's first and last day. Used by the date-range preset
// chips so "Last month" doesn't require the operator to count days.
export function lastMonthRange() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  const start = d.toISOString().slice(0, 10);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    .toISOString().slice(0, 10);
  return [start, lastDay];
}
// Page-size dropdown values — common spreadsheet defaults.
export const PAGE_SIZES = [25, 50, 100, 200];
