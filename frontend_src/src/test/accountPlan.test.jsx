// Seeing the dates a customer agreed to, on their own page.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import planSrc from '../pages/clients/AccountPlan.jsx?raw';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import invoicePlanSrc from '../pages/invoices/PaymentPlan.jsx?raw';
import detailSrc from '../pages/ClientDetail.jsx?raw';
import apiSrc from '../api/client.js?raw';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the agreed dates are visible on the client', () => {
  test('the API call and the screen exist and are mounted', () => {
    expect(apiSrc).toMatch(/getClientPlan/);
    expect(apiSrc).toMatch(/\/api\/clients\/\$\{id\}\/plan/);
    expect(detailSrc).toMatch(/<AccountPlan clientId=\{id\} client=\{client\}/);
  });

  test('it refreshes when a payment is recorded', () => {
    // Agreeing terms is the moment it becomes worth looking at, so a stale
    // panel is the same as no panel.
    expect(detailSrc).toMatch(/setPlanKey\(k => k \+ 1\)/);
    expect(planSrc).toMatch(/\[load, refreshKey\]/);
  });

  test('a customer with no plan is offered one, as an invoice is', () => {
    // The invoice panel says there is no plan and offers to set one up. An
    // account panel that simply vanished would leave the operator hunting for
    // where terms are agreed — which is exactly what happened.
    expect(planSrc).toMatch(/clients\.notOnPlan/);
    expect(planSrc).toMatch(/installments\.setUp/);
    expect(en.clients.notOnPlan).toMatch(/not on a payment plan/i);
  });

  test('a customer nobody approved is told where that is decided', () => {
    expect(planSrc).toMatch(/installments\.notApproved/);
  });

  test('the plan belongs to the customer, not to their invoices', () => {
    // Eight payments of 500 is one agreement. Decomposing it onto whichever
    // invoices are open today breaks the moment one is raised or voided.
    expect(planSrc).toMatch(/const plan = data\?\.plan;/);
    expect(planSrc).toMatch(/plan\?\.installments \|\| \[\]/);
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
    expect(planSrc).toMatch(/plan\?\.next_due/);
    expect(planSrc).toMatch(/installments\.nextDue/);
  });
});

describe('it is the same panel as the one beside an invoice', () => {
  test('same header, same three buttons', () => {
    for (const k of ['installments.title', 'installments.setUp',
                     'installments.change', 'installments.remove']) {
      expect(planSrc, k).toContain(`t('${k}')`);
      expect(invoicePlanSrc, k).toContain(`t('${k}')`);
    }
  });

  test('same four boxes, in the same order', () => {
    for (const k of ['installments.count', 'installments.firstDue',
                     'installments.frequency', 'installments.deposit']) {
      expect(planSrc, k).toContain(`t('${k}')`);
    }
    expect(planSrc).toMatch(/onSubmit=\{save\}/);
  });

  test('same table, down to the columns', () => {
    for (const k of ['installments.dueDate', 'common.amount', 'clients.paid',
                     'invoices.remaining', 'common.status']) {
      expect(planSrc, k).toContain(`t('${k}')`);
      expect(invoicePlanSrc, k).toContain(`t('${k}')`);
    }
  });

  test('terms cannot be restated once money has arrived', () => {
    // Three of eight silently becoming one of four. The invoice panel locks
    // for the same reason, and the server refuses it either way.
    expect(planSrc).toMatch(/const locked = \(plan\?\.paid \|\| 0\) > 0\.005/);
    expect(planSrc).toMatch(/plan && !locked && !open && \(/);
    expect(planSrc).toMatch(/installments\.lockedHint/);
  });

  test('but ending them stays possible, which is the one deliberate difference',
    () => {
      // A customer who has stopped paying has to be takeable off terms, and
      // the payments already made are untouched by it.
      expect(planSrc).toMatch(/canEdit && plan && !open && \(/);
      expect(planSrc).toMatch(/cancelClientPlan/);
    });

  test('the schedule is against the account balance, not one document', () => {
    expect(planSrc).toMatch(/clients\.planSplitHint/);
    expect(en.clients.planSplitHint).toMatch(/whole account balance/i);
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
          <AccountPlan clientId={1} client={{ allow_installments: 1 }} refreshKey={0} />
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
          next_due: { seq: 1, due_date: '2026-04-01', amount: 150, paid: 0, remaining: 150 },
          installments: [
            { seq: 1, due_date: '2026-04-01', amount: 150, paid: 0, remaining: 150, status: 'Due' },
            { seq: 2, due_date: '2026-05-01', amount: 150, paid: 0, remaining: 150, status: 'Due' },
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
            <AccountPlan clientId={1} client={{ allow_installments: 1 }} refreshKey={1} />
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
  test('the payment form takes money and nothing else', () => {
    // As on an invoice: the payment form does not agree terms. Creating a
    // schedule as a side effect of taking a payment is how a plan appears
    // that nobody sat down and agreed to.
    expect(modalSrc).not.toMatch(/installment_plan/);
    expect(modalSrc).toMatch(/clients\.planLivesOnOverview/);
  });

  test('reopening shows the plan that exists, not an empty checkbox', () => {
    // An unticked box reads as "there is no plan", and ticking it only earns
    // a refusal from the server.
    expect(modalSrc).toMatch(/getClientPlan\(client\.id\)/);
    expect(modalSrc).toMatch(/\{existing && \(/);
    expect(modalSrc).toMatch(/clients\.alreadyOnPlan/);
  });

  test('the payment form points at the panel where terms are agreed', () => {
    expect(modalSrc).toMatch(/canPlan && !existing && \(/);
    expect(en.clients.planLivesOnOverview).toMatch(/overview/i);
    expect(/[؀-ۿ]/.test(ar.clients.planLivesOnOverview)).toBe(true);
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
