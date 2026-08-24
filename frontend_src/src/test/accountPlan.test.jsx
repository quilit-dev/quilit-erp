// Seeing the dates a customer agreed to, on their own page.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import planSrc from '../pages/clients/AccountPlan.jsx?raw';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import detailSrc from '../pages/ClientDetail.jsx?raw';
import apiSrc from '../api/client.js?raw';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the agreed dates are visible on the client', () => {
  test('the API call and the screen exist and are mounted', () => {
    expect(apiSrc).toMatch(/getClientPlan/);
    expect(apiSrc).toMatch(/\/api\/clients\/\$\{id\}\/plan/);
    expect(detailSrc).toMatch(/<AccountPlan clientId=\{id\}/);
  });

  test('it refreshes when a payment is recorded', () => {
    // Agreeing terms is the moment it becomes worth looking at, so a stale
    // panel is the same as no panel.
    expect(detailSrc).toMatch(/setPlanKey\(k => k \+ 1\)/);
    expect(planSrc).toMatch(/\[load, refreshKey\]/);
  });

  test('a customer with no plan sees nothing rather than an empty table', () => {
    expect(planSrc).toMatch(/if \(!rows\.length\) return null;/);
  });

  test('each date names the invoices it pays off', () => {
    // One agreed payment can finish a bill and start the next, so "which of
    // mine is this" has to be answerable here.
    expect(planSrc).toMatch(/r\.invoices\.map/);
    expect(planSrc).toMatch(/\/invoices\?focus=\$\{inv\.invoice_id\}/);
  });

  test('the next payment is called out', () => {
    expect(planSrc).toMatch(/data\.next_due/);
    expect(planSrc).toMatch(/installments\.nextDueLabel/);
  });
});

describe('the operator sees the terms before agreeing to them', () => {
  test('the modal previews the actual dates and amounts', () => {
    // A count and a frequency are not something a customer can say yes to.
    expect(modalSrc).toMatch(/function schedulePreview/);
    expect(modalSrc).toMatch(/planPreview\.map/);
    expect(modalSrc).toMatch(/clients\.planWillBe/);
  });

  test('the preview uses the same rounding rule as the server', () => {
    // Equal payments with the last carrying the residue. Anything else and
    // the preview and the schedule disagree by a cent.
    expect(modalSrc).toMatch(/i === n - 1/);
    expect(modalSrc).toMatch(/total - each \* \(n - 1\)/);
  });

  test('a plan starting on the 31st does not skip February', () => {
    expect(modalSrc).toMatch(/Math\.min\(day, last\)/);
  });

  test('the preview only appears for a customer allowed to have one', () => {
    expect(modalSrc).toMatch(/\(canPlan && onPlan\)/);
  });
});

describe('translation', () => {
  test('the new keys resolve in both languages', () => {
    for (const k of ['clients.planSummary', 'clients.covers',
                     'clients.planWillBe', 'clients.planCoversHint',
                     'installments.nextDueLabel']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the interpolated keys name their parameters', () => {
    for (const [key, args] of [
      ['clients.planSummary', ['count', 'total', 'remaining']],
      ['clients.planWillBe', ['count', 'amount']],
    ]) {
      for (const dict of [en, ar]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)]
          .map(m => m[1]).sort();
        expect(named, key).toEqual([...args].sort());
      }
    }
  });

  test('the Arabic is actually Arabic', () => {
    for (const k of ['planSummary', 'covers', 'planWillBe', 'planCoversHint']) {
      expect(/[؀-ۿ]/.test(ar.clients[k]), k).toBe(true);
    }
  });
});

describe('it mounts', () => {
  test('renders without throwing when there is no plan', async () => {
    const { AccountPlan } = await import('../pages/clients/AccountPlan.jsx');
    let container;
    await act(async () => {
      ({ container } = render(
        <ThemeProvider><LocaleProvider><MemoryRouter>
          <AccountPlan clientId={1} refreshKey={0} />
        </MemoryRouter></LocaleProvider></ThemeProvider>));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(container).toBeTruthy();
  });

  test('renders a real schedule', async () => {
    const { AccountPlan } = await import('../pages/clients/AccountPlan.jsx');
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        count: 2, total: 300, paid: 0, remaining: 300,
        next_due: { due_date: '2026-04-01', amount: 150, paid: 0 },
        installments: [
          { due_date: '2026-04-01', amount: 150, paid: 0, status: 'Due',
            invoices: [{ invoice_id: 7, invoice_number: 'INV-1' }] },
          { due_date: '2026-05-01', amount: 150, paid: 0, status: 'Due',
            invoices: [{ invoice_id: 7, invoice_number: 'INV-1' },
                       { invoice_id: 8, invoice_number: 'INV-2' }] },
        ],
      }),
      text: () => Promise.resolve(''),
      headers: { get: () => 'application/json' },
    });
    try {
      let container;
      await act(async () => {
        ({ container } = render(
          <ThemeProvider><LocaleProvider><MemoryRouter>
            <AccountPlan clientId={1} refreshKey={1} />
          </MemoryRouter></LocaleProvider></ThemeProvider>));
        await new Promise(r => setTimeout(r, 0));
      });
      expect(container.textContent).toContain('INV-1');
      expect(container.textContent).toContain('INV-2');
      expect(container.querySelectorAll('tbody tr').length).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
