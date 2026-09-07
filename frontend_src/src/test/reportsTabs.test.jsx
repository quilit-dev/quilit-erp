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
import { render, screen, act } from '@testing-library/react';
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
  const stub = () => Promise.resolve([]);   // every report tolerates an empty list
  return Object.fromEntries(Object.keys(actual).map(k => [k, stub]));
});

async function mount() {
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><MemoryRouter>
        <Reports />
      </MemoryRouter></LocaleProvider></ThemeProvider>));
  });
  return container;
}

const tabs = c => [...c.querySelectorAll('.tab-btn')].map(b => b.textContent.trim());

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
    const active = [...c.querySelectorAll('.tab-btn.active')];
    expect(active, 'exactly one tab must be selected').toHaveLength(1);
    expect(active[0].textContent.trim()).toBe(en.reports.projects);
  });

  test('and so does any other unknown id', async () => {
    // Whatever the reason — an older build, a hand-edited value — the page
    // must not depend on the stored string being one it knows.
    sessionStorage.setItem('reports_active', JSON.stringify('nonsense'));
    const c = await mount();
    expect(c.querySelectorAll('.tab-btn.active')).toHaveLength(1);
  });

  test('a tab that DOES still exist is honoured', async () => {
    sessionStorage.setItem('reports_active', JSON.stringify('vat'));
    const c = await mount();
    const active = [...c.querySelectorAll('.tab-btn.active')];
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
    const active = [...c.querySelectorAll('.tab-btn.active')];
    expect(active).toHaveLength(1);
    expect(active[0].textContent.trim()).toBe(en.reports.projects);
  });
});
