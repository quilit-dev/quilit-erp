// Raising an invoice in the currency the customer was promised.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import invoicesSrc from '../pages/Invoices.jsx?raw';

const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the invoice is billed in the customer\'s currency', () => {
  test('the currency travels with the request, blank meaning the default', () => {
    // Sending a currency only when one was chosen keeps the decision about
    // which currency a customer is billed in on the server, in one place.
    expect(invoicesSrc).toMatch(/currency:\s+form\.currency \|\| null/);
  });

  test('the customer\'s own currency is what the blank option names', () => {
    expect(invoicesSrc).toMatch(/preferred_currency \|\| ''/);
    expect(invoicesSrc).toMatch(/invoices\.customersCurrency/);
  });

  test('changing currency clears any rate typed for the old one', () => {
    // Otherwise a euro rate silently follows the picker to pounds.
    // The picker is a SearchSelect, which hands over the value itself.
    expect(invoicesSrc).toMatch(/currency: v,\s*\n?\s*exchange_rate: '' *\}\)\)/);
  });
});

describe('the rate direction is impossible to get wrong', () => {
  test('the label says which way round the rate goes', () => {
    // The same rate reads as 1.10 one way and 0.909091 the other. Entering
    // one where the other is meant is a 21% error on the whole invoice.
    expect(en.invoices.rateFor).toMatch(/per 1 USD/);
    expect(invoicesSrc).toMatch(/t\('invoices\.rateFor', \{ currency: invoiceCurrency \}\)/);
  });

  test('it reads the rate back in the other direction as it is typed', () => {
    expect(invoicesSrc).toMatch(/1 \/ Number\(form\.exchange_rate\)/);
    expect(en.invoices.rateReads).toMatch(/1 \{\{currency\}\} = \{\{value\}\} USD/);
  });

  test('the rate field only appears when it can matter', () => {
    expect(invoicesSrc).toMatch(/invoiceCurrency && invoiceCurrency !== 'USD'/);
  });
});

describe('translation', () => {
  test('the new keys resolve in both languages', () => {
    for (const k of ['invoices.currencyLabel', 'invoices.customersCurrency',
                     'invoices.companyCurrency', 'invoices.rateFor',
                     'invoices.rateReads', 'invoices.rateBlankHint']) {
      expect(typeof lookup(en, k), k).toBe('string');
      expect(typeof lookup(ar, k), k).toBe('string');
    }
  });

  test('the interpolated keys name the parameters they are given', () => {
    for (const [key, args] of [
      ['invoices.customersCurrency', ['currency']],
      ['invoices.rateFor', ['currency']],
      ['invoices.rateReads', ['currency', 'value']],
    ]) {
      for (const dict of [en, ar]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)]
          .map(m => m[1]).sort();
        expect(named, key).toEqual([...args].sort());
      }
    }
  });

  test('the Arabic is actually Arabic', () => {
    const KEYS = ['currencyLabel', 'companyCurrency', 'rateFromSettings',
                  'rateBlankHint'];
    expect(KEYS.filter(k => /[A-Za-z]{3,}/.test(ar.invoices[k])
                            && !/[؀-ۿ]/.test(ar.invoices[k]))).toEqual([]);
  });
});
