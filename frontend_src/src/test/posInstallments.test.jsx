// Selling at the till on a payment plan: the goods leave, the balance stays.
import { describe, test, expect } from 'vitest';
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
    expect(checkoutSrc).toMatch(/disabled=\{busy \|\| !!planProblem\}/);
  });
});

describe('the customer walks out with the terms in writing', () => {
  test('the receipt shows the deposit, the balance and the due dates', () => {
    expect(receiptSrc).toMatch(/\(sale\.installments \|\| \[\]\)\.length > 0/);
    expect(receiptSrc).toMatch(/pos\.balanceOwed/);
    expect(receiptSrc).toMatch(/sale\.installments\.slice\(1\)/);  // row 1 is the deposit
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
