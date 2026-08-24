// Selling at the till on a payment plan: the goods leave, the balance stays.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import checkoutSrc from '../pages/pos/CheckoutModal.jsx?raw';
import receiptSrc from '../pages/pos/ReceiptModal.jsx?raw';
import historySrc from '../pages/pos/HistoryView.jsx?raw';
import detailSrc from '../pages/pos/SaleDetailModal.jsx?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('taking the deposit, not the sale price', () => {
  test('the till collects the deposit when a plan is on', () => {
    // The whole bug class: charging the customer the full price at the
    // counter and then also billing them for instalments.
    expect(checkoutSrc).toMatch(/const dueNow = onPlan \? depositNum : pricing\.total;/);
    expect(checkoutSrc).toMatch(/currency === 'LBP' \? dueNow \* \(fxRate \|\| 0\) : dueNow/);
  });

  test('the balance is shown before the sale is committed', () => {
    expect(checkoutSrc).toMatch(/pos\.balanceOwed/);
  });

  test('the plan is sent only when one was asked for', () => {
    expect(checkoutSrc).toMatch(/\.\.\.\(onPlan \? \{/);
    expect(checkoutSrc).toMatch(/installment_plan: \{/);
  });
});

describe('the cashier is told what is wrong before the queue notices', () => {
  test('a plan without a customer is refused in the modal', () => {
    // The server refuses it too; catching it here explains which part is
    // wrong instead of returning a bare 400.
    expect(checkoutSrc).toMatch(/!clientId \? t\('pos\.planNeedsCustomer'\)/);
  });

  test('a deposit covering the whole sale is refused', () => {
    expect(checkoutSrc).toMatch(/depositNum >= pricing\.total \? t\('pos\.planDepositTooBig'\)/);
  });

  test('the button is disabled while the plan is invalid', () => {
    expect(checkoutSrc).toMatch(/disabled=\{busy \|\| !!planProblem \|\| !!tenderProblem\}/);
  });
});

describe('the customer walks out with the terms in writing', () => {
  test('the receipt shows the deposit, the balance and the due dates', () => {
    expect(receiptSrc).toMatch(/plan\.length > 0/);
    expect(receiptSrc).toMatch(/pos\.balanceOwed/);
  });

  // The slip is the only thing the customer takes away saying what they owe
  // and when, so what it prints has to add up to the balance on it. It did
  // not: the first row was dropped as "the deposit" whether or not any
  // deposit had been taken, so a sale of 161 put wholly on two instalments
  // printed one line of 80.50 and the other 80.50 simply was not there.
  async function receipt(sale) {
    const { ReceiptModal } = await import('../pages/pos/ReceiptModal.jsx');
    let container;
    await act(async () => {
      ({ container } = render(
        <ThemeProvider><LocaleProvider><SettingsProvider><MemoryRouter>
          <ReceiptModal sale={sale} onClose={() => {}} />
        </MemoryRouter></SettingsProvider></LocaleProvider></ThemeProvider>));
      await new Promise(r => setTimeout(r, 0));
    });
    return container;
  }

  const SALE = {
    invoice_number: 'POS-1', subtotal: 161, tax_total: 0, discount_total: 0,
    total: 161, items: [], payment_method: 'Cash', change_given: 0,
  };

  // What the slip actually prints under "Payment Plan", as numbers.
  function scheduled(container) {
    const text = container.textContent;
    const from = text.indexOf(en.installments.title);
    if (from < 0) return [];
    return [...text.slice(from).matchAll(/\$([\d,]+(?:\.\d+)?)/g)]
      .map(m => Number(m[1].replace(/,/g, '')));
  }

  const sum = (a) => Math.round(a.reduce((n, x) => n + x, 0) * 100) / 100;

  test('every instalment is on it when no deposit was taken', async () => {
    const c = await receipt({
      ...SALE, amount_tendered: 0, paid_now: 0, balance: 161,
      installments: [{ seq: 1, due_date: '2026-09-01', amount: 80.5 },
                     { seq: 2, due_date: '2026-10-01', amount: 80.5 }],
    });

    expect(scheduled(c)).toEqual([80.5, 80.5]);
  });

  test('what it prints adds up to the balance it prints', async () => {
    // The invariant worth holding whatever the deposit was: a slip whose
    // dates do not sum to the balance on the same slip is unanswerable to
    // the customer holding it.
    const c = await receipt({
      ...SALE, amount_tendered: 0, paid_now: 0, balance: 161,
      installments: [{ seq: 1, due_date: '2026-09-01', amount: 80.5 },
                     { seq: 2, due_date: '2026-10-01', amount: 80.5 }],
    });

    expect(sum(scheduled(c))).toBe(161);
  });

  test('a deposit is not billed a second time as an instalment', async () => {
    // It was taken at the till, so it is not one of the dates still to come.
    const c = await receipt({
      ...SALE, total: 300, subtotal: 300, amount_tendered: 100,
      paid_now: 100, balance: 200,
      installments: [{ seq: 1, due_date: '2026-09-01', amount: 100 },
                     { seq: 2, due_date: '2026-10-01', amount: 100 },
                     { seq: 3, due_date: '2026-11-01', amount: 100 }],
    });

    expect(scheduled(c)).toEqual([100, 100]);
    expect(sum(scheduled(c))).toBe(200);
  });

  test('an ordinary sale prints no schedule at all', async () => {
    const c = await receipt({
      ...SALE, amount_tendered: 161, paid_now: 161, balance: 0,
    });

    expect(scheduled(c)).toEqual([]);
  });
});

describe('money handed over at the till on a plan sale', () => {
  // A plan with no deposit collects nothing at the counter. Cash typed into
  // the tender box came straight back as change: the sale completed, the
  // balance was untouched, and the customer watched their notes returned
  // while the screen said "Change: 26". The two boxes disagreed and only one
  // of them meant anything.
  test('the tender follows the deposit until the cashier types over it', () => {
    expect(checkoutSrc).toMatch(/const \[tenderTouched, setTenderTouched\]/);
    expect(checkoutSrc).toMatch(/if \(tenderTouched \|\| method !== 'Cash'\) return;/);
    expect(checkoutSrc).toMatch(/onPlan && totalInCurrency > 0\.005/);
  });

  test('cash against a plan with no deposit is stopped, and says which box', () => {
    expect(checkoutSrc).toMatch(/depositNum <= 0\.005 && tenderedNum > 0\.005/);
    expect(checkoutSrc).toMatch(/pos\.tenderWithNoDeposit/);
    expect(en.pos.tenderWithNoDeposit).toMatch(/deposit/i);
    expect(/[؀-ۿ]/.test(ar.pos.tenderWithNoDeposit)).toBe(true);
  });

  test('it names the figure rather than the rule', () => {
    for (const dict of [en, ar]) {
      expect([...dict.pos.tenderWithNoDeposit.matchAll(/\{\{(\w+)\}\}/g)]
        .map(m => m[1])).toEqual(['amount']);
    }
  });

  test('the sale cannot be completed while it stands', () => {
    expect(checkoutSrc).toMatch(/disabled=\{busy \|\| !!planProblem \|\| !!tenderProblem\}/);
    expect(checkoutSrc).toMatch(/if \(tenderProblem\)/);
  });

  test('the change line gives way to it, rather than sitting beside it', () => {
    // "Change: 26" next to "this will be handed back" is the same sentence
    // twice, and the reassuring one is the one that gets read.
    expect(checkoutSrc).toMatch(/tendered !== '' && !tenderProblem/);
  });
});

describe('the history does not claim an unpaid sale is paid', () => {
  test('the badge follows the real payment status', () => {
    for (const [src, name] of [[historySrc, 'history'], [detailSrc, 'detail']]) {
      expect(src, name).toMatch(/payment_status/);
    }
  });

  test('a sale still owing money says how much', () => {
    expect(historySrc).toMatch(/s\.balance > 0\.005/);
  });

  test('the export carries the status and balance too', () => {
    expect(historySrc).toMatch(/Balance:\s+s\.balance/);
  });
});

describe('one vocabulary for payment plans', () => {
  test('the till reuses the invoice screen\'s plan wording', () => {
    // A second set of keys for the same concept drifts: the invoice screen
    // says "Deposit" and the till says "Down payment", and translators get
    // two entries to keep in step.
    for (const k of ['installments.deposit', 'installments.count',
                     'installments.frequency', 'installments.firstDue',
                     'installments.monthly', 'installments.needCount']) {
      expect(checkoutSrc, k).toContain(`t('${k}')`);
    }
  });

  test('every key the checkout uses resolves in both languages', () => {
    const keys = [...checkoutSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['payByInstalments', 'instalmentsHint', 'balanceOwed',
                  'planNeedsCustomer', 'planDepositTooBig'];
    expect(KEYS.filter(k => /[A-Za-z]{3,}/.test(ar.pos[k]) && !/[؀-ۿ]/.test(ar.pos[k])))
      .toEqual([]);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of checkoutSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    // `table` is a no-op this file already carried: it is used in twenty-odd
    // screens and defined in no stylesheet — tables are styled by element
    // selector. Exempted here rather than silently passing, so the exemption
    // is visible if someone ever defines it.
    used.delete('table');
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});
