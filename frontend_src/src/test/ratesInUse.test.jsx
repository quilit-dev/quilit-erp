// The rates reaching the forms that convert money.
//
// Recording a rate and having it apply are two different features, and only
// the first existed. The account-payment form left the rate box empty for any
// foreign currency, so the operator typed the number from memory; the invoice
// payment form inherited the POUND rate for anything non-USD, which is worse
// than empty — a €92 payment at 89,000 books as a tenth of a cent.
import { describe, test, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../locales/en';
import ar from '../locales/ar';
import modalSrc from '../pages/clients/CustomerPaymentModal.jsx?raw';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import settingsHookSrc from '../hooks/useSettings.jsx?raw';
import { ThemeProvider } from '../hooks/useTheme.jsx';
import { LocaleProvider } from '../hooks/useLocale.jsx';
import { SettingsProvider } from '../hooks/useSettings.jsx';

const BOOK = {
  base_currency: 'USD',
  secondary_currency: 'LBP',
  current: { id: 1, rate: 89000, effective_date: '2026-08-20' },
  rates: {
    LBP: { id: 1, rate: 89000, effective_date: '2026-08-20' },
    EUR: { id: 2, rate: 0.92, effective_date: '2026-08-22' },
  },
  pairs: [], history: [],
};

async function mountPayment(client) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(
      String(url).includes('exchange-rate') ? BOOK
        : String(url).includes('/plan') ? { plan: null, outstanding: 0 } : {}),
    text: () => Promise.resolve(''),
    headers: { get: () => 'application/json' },
  });
  const { default: Modal } = await import('../pages/clients/CustomerPaymentModal.jsx');
  let container;
  await act(async () => {
    ({ container } = render(
      <ThemeProvider><LocaleProvider><SettingsProvider><MemoryRouter>
        <Modal client={client} invoices={[]} onClose={() => {}} onDone={() => {}} />
      </MemoryRouter></SettingsProvider></LocaleProvider></ThemeProvider>));
    await new Promise(r => setTimeout(r, 0));
  });
  globalThis.fetch = realFetch;
  return container;
}

describe('every rate is readable, not just the secondary one', () => {
  test('the settings provider hands out all of them', () => {
    expect(settingsHookSrc).toMatch(/setRates\(d\.rates \|\| \{\}\)/);
    expect(settingsHookSrc).toMatch(/function rateFor\(code\)/);
  });

  test('a currency nobody has priced reports nothing, not another rate', () => {
    // Returning the pound rate for an unpriced currency is exactly the bug.
    expect(settingsHookSrc).toMatch(/return Number\(rates\?\.\[cur\]\?\.rate\) \|\| 0;/);
  });
});

describe('a customer in euro pays in euro, at the euro rate', () => {
  test('the account-payment form opens on their currency', async () => {
    const c = await mountPayment({ id: 1, name: 'Bruxelles SA',
                                   preferred_currency: 'EUR' });

    expect(c.querySelector('select').value).toBeTruthy();
    expect(c.textContent).toContain('EUR');
  });

  test('and fills the rate in from the book', async () => {
    const c = await mountPayment({ id: 1, name: 'Bruxelles SA',
                                   preferred_currency: 'EUR' });

    const inputs = [...c.querySelectorAll('input')].map(i => i.value);
    expect(inputs).toContain('0.92');
  });

  test('it says which rate it is using and from when', async () => {
    // So an operator can see they are converting at a figure from three weeks
    // ago before they take the money rather than afterwards.
    const c = await mountPayment({ id: 1, name: 'Bruxelles SA',
                                   preferred_currency: 'EUR' });

    expect(c.textContent).toMatch(/Using the rate set on/);
  });

  test('the rate follows the currency until the operator types their own', () => {
    expect(modalSrc).toMatch(/const \[rateTouched, setRateTouched\] = useState\(false\)/);
    expect(modalSrc).toMatch(/if \(rateTouched\) return;/);
    expect(modalSrc).toMatch(/const stored = rateFor\(ccy\);/);
  });

  test('and the operator still wins when they do', () => {
    // A cashier handed euro at a rate the street agreed on has better
    // information than a table somebody updated on Monday.
    expect(modalSrc).toMatch(/setRateTouched\(true\); setRate\(e\.target\.value\)/);
    expect(modalSrc).toMatch(/exchange_rate: rate === '' \? null : Number\(rate\)/);
  });

  test('a currency with no rate says so instead of leaving a blank box', () => {
    expect(modalSrc).toMatch(/rates\.noneFor/);
    expect(en.rates.noneFor).toMatch(/no rate recorded/i);
  });
});

describe('the invoice payment form stops using the pound rate for everything', () => {
  test('each currency inherits its own', () => {
    expect(invoicesSrc).toMatch(/: \(rateFor\(e\.target\.value\) \|\| ''\),/);
    // The old rule — pounds inherit, everything else blank — is gone.
    expect(invoicesSrc).not.toMatch(/only pounds may/);
  });

  test('the currency picker no longer depends on a pound rate existing', () => {
    // A business that priced only the euro got no currency selector at all.
    expect(invoicesSrc).toMatch(
      /exchangeRate\?\.rate \|\| Object\.keys\(rates \|\| \{\}\)\.length > 0/);
  });

  test('taking a payment opens on the customer’s own currency', () => {
    expect(invoicesSrc).toMatch(/client_preferred_currency \|\| ''\)\.toUpperCase\(\)/);
    expect(invoicesSrc).toMatch(/rate: cur === 'USD' \? '' : \(rateFor\(cur\) \|\| ''\)/);
  });

  test('and a second payment does not fall back to dollars', () => {
    expect(invoicesSrc).toMatch(/currency: f\.currency,/);
  });
});

describe('it reads in both languages', () => {
  test('the new strings exist in each, with the same placeholders', () => {
    const named = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)]
      .map(m => m[1]).sort().join(',');

    for (const k of ['usingFrom', 'noneFor']) {
      expect(typeof en.rates[k], `en ${k}`).toBe('string');
      expect(typeof ar.rates[k], `ar ${k}`).toBe('string');
      expect(/[؀-ۿ]/.test(ar.rates[k]), k).toBe(true);
      expect(named(ar.rates[k]), k).toBe(named(en.rates[k]));
    }
  });
});
