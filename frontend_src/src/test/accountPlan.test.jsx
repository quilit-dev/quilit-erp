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
    expect(planSrc).toMatch(/if \(!plan\) return null;/);
  });

  test('the plan belongs to the customer, not to their invoices', () => {
    // Eight payments of 500 is one agreement. Decomposing it onto whichever
    // invoices are open today breaks the moment one is raised or voided.
    expect(planSrc).toMatch(/const plan = data\?\.plan;/);
    expect(planSrc).toMatch(/plan\.installments \|\| \[\]/);
  });

  test('what the account owes beyond the plan is stated, not hidden', () => {
    // An invoice raised after the terms is outstanding and outside them.
    expect(planSrc).toMatch(/const beyond = /);
    expect(planSrc).toMatch(/clients\.owedBeyondPlan/);
  });

  test('the plan can be ended, and says what that does not do', () => {
    expect(planSrc).toMatch(/cancelClientPlan/);
    expect(en.clients.planCancelConfirm).toMatch(/stay exactly as they are/i);
  });

  test('the next payment is called out', () => {
    expect(planSrc).toMatch(/plan\.next_due/);
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
        outstanding: 400,
        plan: {
          id: 1, count: 2, total: 300, paid: 0, remaining: 300,
          next_due: { seq: 1, due_date: '2026-04-01', amount: 150, paid: 0 },
          installments: [
            { seq: 1, due_date: '2026-04-01', amount: 150, paid: 0, status: 'Due' },
            { seq: 2, due_date: '2026-05-01', amount: 150, paid: 0, status: 'Due' },
          ],
        },
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
      expect(container.querySelectorAll('tbody tr').length).toBe(2);
      // 400 owed against 300 scheduled: the 100 outside the plan is stated.
      expect(container.textContent).toMatch(/100/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the plan is visible from where the operator is looking', () => {
  test('the confirmation shows the schedule that was just agreed', () => {
    // Confirming the payment and saying nothing about the plan is how
    // somebody comes away unsure whether the terms were recorded at all.
    expect(modalSrc).toMatch(/result\.plan && \(/);
    expect(modalSrc).toMatch(/result\.plan\.installments\.map/);
    expect(modalSrc).toMatch(/clients\.planAgreed/);
  });

  test('reopening shows the plan that exists, not an empty checkbox', () => {
    // An unticked box reads as "there is no plan", and ticking it only earns
    // a refusal from the server.
    expect(modalSrc).toMatch(/getClientPlan\(client\.id\)/);
    expect(modalSrc).toMatch(/\{existing && \(/);
    expect(modalSrc).toMatch(/clients\.alreadyOnPlan/);
  });

  test('the offer to create one is withdrawn while a plan is live', () => {
    expect(modalSrc).toMatch(/canPlan && !existing && \(/);
    expect(modalSrc).toMatch(/canPlan && !existing && onPlan && \(/);
  });

  test('it says the payment counts towards the plan by itself', () => {
    expect(modalSrc).toMatch(/clients\.planCountsTowards/);
    expect(en.clients.planCountsTowards).toMatch(/automatically/i);
  });

  test('the next payment due is shown on reopening', () => {
    expect(modalSrc).toMatch(/existing\.next_due/);
    expect(modalSrc).toMatch(/clients\.planNextIs/);
  });
});
