// Removing a report tab is not just deleting a component.
//
// `reports_active` is remembered for the session, so on the day this ships
// every user still has 'financial' stored from their last visit. If the page
// only checks `activeReport === <key>` against the tabs that remain, that
// person opens Reports to a page with no tab highlighted and nothing rendered
// — a blank screen, no error, nothing to click that explains it.
//
// So the tab is gone, and the stored id is validated rather than trusted.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import en from '../locales/en';
import ar from '../locales/ar';
// Imported at the top, not with `await import()` inside a test. Reports pulls
// in all ten report components and the spreadsheet library behind them, and
// paying that cost inside the test body spends the 5s budget on module loading
// -- fine when this file runs alone, a timeout once the whole suite is running
// in parallel. vi.mock is hoisted above this, so the stub is still in place.
import Reports from '../pages/Reports.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'pages', 'Reports.jsx'), 'utf8');

// Every report fires its own request on mount; none of them is what this file
// is about, so they all resolve to nothing.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal();
  const stub = () => Promise.resolve([]);   // most reports read a list
  // These two read a summary object, as the server always sends them.
  const bucket = { count: 0, total: 0 };
  const buckets = { current: bucket, '1_30': bucket, '31_60': bucket, '61_90': bucket, over_90: bucket };
  const shaped = {
    getReportInvoiceAging: () => Promise.resolve({ summary: buckets, invoices: [] }),
    getReportPaymentPlans: () => Promise.resolve({
      summary: { plans: 0, on_track: 0, late: 0, completed: 0, cancelled: 0, covered: 0, scheduled: 0,
                 collected: 0, outstanding: 0, overdue: 0, overdue_installments: 0, due_in_period: 0,
                 scheduled_in_period: 0, collection_rate: null },
      aging: buckets, forecast: [], plans: [] }),
    getReportSalesByAddress: () => Promise.resolve({
      summary: { locations: 0, customers: 0, invoices: 0, sales: 0, gross: 0, collected: 0,
                 outstanding: 0, unlocated_sales: 0 }, locations: [] }),
  };
  return Object.fromEntries(Object.keys(actual).map(k => [k, shaped[k] || stub]));
});

async function mount(url = '/reports') {
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><MemoryRouter initialEntries={[url]}>
        <Reports />
      </MemoryRouter></LocaleProvider></ThemeProvider>));
  });
  return container;
}

const tabs = c => [...c.querySelectorAll('.report-nav-item')].map(b => b.textContent.trim());

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.setItem('erp_lang', 'en');
});

describe('the Financial Summary report is gone', () => {
  test('its component file no longer exists', () => {
    expect(existsSync(join(here, '..', 'pages', 'reports', 'FinancialReport.jsx')))
      .toBe(false);
  });

  test('Reports neither imports nor renders it', () => {
    expect(src).not.toMatch(/FinancialReport/);
    expect(src).not.toMatch(/'financial'/);
  });

  test('no tab offers it', async () => {
    const c = await mount();
    expect(tabs(c).length).toBeGreaterThan(0);
    expect(tabs(c)).not.toContain('Financial Summary');
  });

  test('its strings are gone from both languages', () => {
    // Left behind, they are half a feature for whoever comes next: translated
    // labels for a report that does not exist.
    for (const k of ['financial', 'totalIncome', 'totalExpenses', 'netProfit',
                     'totalInvoiced', 'incomeVsExpenses', 'monthlyBreakdown',
                     'profitMargin']) {
      expect(en.reports[k], `en.reports.${k} still there`).toBeUndefined();
      expect(ar.reports[k], `ar.reports.${k} still there`).toBeUndefined();
    }
  });

  test('the strings the OTHER reports share are untouched', () => {
    // These read like they belonged to the financial report and did not — the
    // aging and expenses reports use them, and taking them would blank a label
    // on a page nobody asked to change.
    for (const k of ['outstanding', 'month', 'income', 'expenses', 'profit',
                     'noData', 'expensesByCategory']) {
      expect(en.reports[k], `en.reports.${k}`).toBeTruthy();
      expect(ar.reports[k], `ar.reports.${k}`).toBeTruthy();
    }
  });
});

describe('a remembered tab that no longer exists', () => {
  test('falls back to a real report instead of a blank page', async () => {
    sessionStorage.setItem('reports_active', JSON.stringify('financial'));
    const c = await mount();
    const active = [...c.querySelectorAll('.report-nav-item.active')];
    expect(active, 'exactly one tab must be selected').toHaveLength(1);
    expect(active[0].textContent.trim()).toBe(en.reports.profitSummary);
  });

  test('and so does any other unknown id', async () => {
    // Whatever the reason — an older build, a hand-edited value — the page
    // must not depend on the stored string being one it knows.
    sessionStorage.setItem('reports_active', JSON.stringify('nonsense'));
    const c = await mount();
    expect(c.querySelectorAll('.report-nav-item.active')).toHaveLength(1);
  });

  test('a tab that DOES still exist is honoured', async () => {
    sessionStorage.setItem('reports_active', JSON.stringify('vat'));
    const c = await mount();
    const active = [...c.querySelectorAll('.report-nav-item.active')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent.trim()).toBe(en.reports.vat);
  });

  test('branches is still recognised while the branch context loads', async () => {
    // It is filtered OUT of the visible tabs for a single-branch user, so
    // validating against the visible list would reject a stored 'branches'
    // and flash a different report — firing its request — before settling.
    expect(src).toMatch(/ALL_REPORTS\.some/);
    expect(src).toMatch(/ALL_REPORTS\.filter/);
  });
});

describe('the default landing tab', () => {
  test('is the first real report for someone with nothing stored', async () => {
    const c = await mount();
    const active = [...c.querySelectorAll('.report-nav-item.active')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent.trim()).toBe(en.reports.profitSummary);
  });
});


// ── The navigator that replaced the two rows of tabs ──────────────────────
describe('the report navigator', () => {
  const headings = c => [...c.querySelectorAll('.report-nav .report-nav-heading')].map(h => h.textContent.trim());

  test('groups the reports by the question they answer', async () => {
    const c = await mount();
    expect(headings(c)).toEqual(expect.arrayContaining([
      en.reports.group.sales, en.reports.group.receivables, en.reports.group.inventory, en.reports.group.tax]));
    const receivables = [...c.querySelectorAll('.report-nav-group')]
      .find(g => g.querySelector('.report-nav-heading').textContent.trim() === en.reports.group.receivables);
    expect([...receivables.querySelectorAll('.report-nav-item')].map(b => b.textContent.trim()))
      .toEqual([en.reports.aging, en.reports.pp.title]);
  });

  test('the open report is marked for assistive technology and says what it answers', async () => {
    const c = await mount('/reports?report=aging');
    expect(c.querySelector('[aria-current="page"]').textContent.trim()).toBe(en.reports.aging);
    expect(c.querySelector('#report-title').textContent).toBe(en.reports.aging);
    expect(c.textContent).toContain(en.reports.desc.aging);
  });

  test('a link opens its report', async () => {
    const c = await mount('/reports?report=plans');
    expect(c.querySelector('.report-nav-item.active').textContent.trim()).toBe(en.reports.pp.title);
  });

  test('clicking a report opens it', async () => {
    const c = await mount();
    const vat = [...c.querySelectorAll('.report-nav-item')].find(b => b.textContent.trim() === en.reports.vat);
    await act(async () => { fireEvent.click(vat); });
    expect(c.querySelector('#report-title').textContent).toBe(en.reports.vat);
  });

  test('the search narrows the list, and says so when nothing matches', async () => {
    const c = await mount();
    const box = c.querySelector('.report-nav-find');
    await act(async () => { fireEvent.change(box, { target: { value: 'instalment' } }); });
    expect(tabs(c)).toEqual([en.reports.pp.title]);
    await act(async () => { fireEvent.change(box, { target: { value: 'zzzz' } }); });
    expect(tabs(c)).toEqual([]);
    expect(c.textContent).toContain(en.reports.noReportFound);
  });

  test('the period controls appear only on reports that use a period', async () => {
    const dated = await mount('/reports?report=aging');
    expect(dated.querySelector('.report-period')).not.toBeNull();
    const snapshot = await mount('/reports?report=whValuation');
    expect(snapshot.querySelector('.report-period')).toBeNull();
  });

  test('on a phone the reports are offered in one picker showing the open one', async () => {
    const c = await mount('/reports?report=vat');
    const picker = c.querySelector('.report-picker');
    expect(picker).not.toBeNull();
    expect(picker.textContent).toContain(en.reports.vat);
  });

  test('the Profit Summary keeps its own dates: no shared period above it', async () => {
    const c = await mount('/reports?report=profit');
    expect(c.querySelector('#report-title').textContent).toBe(en.reports.profitSummary);
    expect(c.querySelector('.report-period')).toBeNull();
  });
});

// ── Folding the report list away on a laptop ──────────────────────────────
describe('the report list folds away', () => {
  const nav = c => c.querySelector('#report-nav');

  const atWidth = async (w) => {
    const before = window.innerWidth;
    localStorage.removeItem('reports_nav_open');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    try { return await mount(); }
    finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: before }); }
  };

  test('starts folded on a laptop screen', async () => {
    const c = await atWidth(1366);
    expect(nav(c).hidden).toBe(true);
    expect(c.querySelector('.report-nav-rail')).not.toBeNull();
  });

  test('starts open on a large monitor', async () => {
    const c = await atWidth(1920);
    expect(nav(c).hidden).toBe(false);
  });

  test('can be folded and opened again, and remembers the choice', async () => {
    localStorage.setItem('reports_nav_open', '1');
    const c = await mount();
    expect(nav(c).hidden).toBe(false);

    await act(async () => { fireEvent.click(c.querySelector('.report-nav-collapse')); });
    expect(nav(c).hidden).toBe(true);
    expect(c.querySelector('.reports-layout').classList.contains('nav-collapsed')).toBe(true);
    expect(localStorage.getItem('reports_nav_open')).toBe('0');

    await act(async () => { fireEvent.click(c.querySelector('.report-show-list')); });
    expect(nav(c).hidden).toBe(false);
    expect(localStorage.getItem('reports_nav_open')).toBe('1');
  });

  test('the rail at the edge opens it too', async () => {
    localStorage.setItem('reports_nav_open', '0');
    const c = await mount();
    await act(async () => { fireEvent.click(c.querySelector('.report-nav-rail')); });
    expect(nav(c).hidden).toBe(false);
  });
});
