// Custom terms & conditions on the invoice.
//
// Free text the owner types in Settings, printed at the foot of every invoice —
// so it reaches the PDF and the customer's share link through the same shared
// template. Being owner-typed text rendered into HTML, it has to be escaped.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import { buildInvoiceHTML } from '../utils/exportUtils';
import settingsSrc from '../pages/Settings.jsx?raw';
import uiSrc from '../pages/settings/ui.jsx?raw';
import exportSrc from '../utils/exportUtils.js?raw';

const INVOICE = {
  invoice_number: 'INV-1',
  created_at: '2026-03-01',
  client: { name: 'Acme' },
  amount: 100,
  items: [{ name: 'Widget', quantity: 1, unit_price: 100 }],
  payments: [],
};

const build = (settings) =>
  buildInvoiceHTML(INVOICE, { company_name: 'Co', currency: 'USD', ...settings }, null)?.html || '';

describe('the terms reach the document', () => {
  test('they are printed when set', () => {
    const html = build({ invoice_terms: 'Payment due within 30 days.' });

    expect(html).toContain('Terms &amp; Conditions');
    expect(html).toContain('Payment due within 30 days.');
  });

  test('nothing is printed when they are blank', () => {
    // An empty heading on every invoice of every business that never set them.
    expect(build({})).not.toContain('Terms &amp; Conditions');
    expect(build({ invoice_terms: '' })).not.toContain('Terms &amp; Conditions');
  });

  test('line breaks survive', () => {
    // Terms are usually a short list; collapsing them into one paragraph would
    // make them unreadable, and the owner typed the breaks deliberately.
    const html = build({ invoice_terms: 'One.\nTwo.\nThree.' });

    expect(html).toMatch(/white-space:pre-wrap/);
    expect(html).toContain('One.\nTwo.\nThree.');
  });

  test('the text is escaped', () => {
    // Owner-typed text rendered straight into the document. Unescaped, a stray
    // angle bracket silently eats the rest of the invoice.
    const html = build({ invoice_terms: 'Fees <b>apply</b> & "extras"' });

    expect(html).toContain('&lt;b&gt;apply&lt;/b&gt;');
    expect(html).not.toContain('<b>apply</b>');
  });

  test('a quotation is left alone', () => {
    // It already carries its own fixed terms wording, and the owner asked for
    // this on invoices.
    expect(exportSrc).toMatch(/C\.terms \?/);
    const invoiceHalf = exportSrc.split('buildQuotationHTML')[0];
    expect((exportSrc.match(/C\.terms \?/g) || []).length).toBe(1);
    expect(invoiceHalf).toBeTruthy();
  });
});

describe('the setting is editable and saved', () => {
  test('Settings offers a multi-line field', () => {
    expect(uiSrc).toMatch(/export const Textarea/);
    expect(settingsSrc).toMatch(/value=\{form\.invoice_terms \|\| ''\}/);
  });

  test('the key is in the save whitelist', () => {
    // Missing from it, the field would look editable and silently never save.
    expect(settingsSrc).toMatch(/'invoice_terms'/);
  });
});

describe('both languages', () => {
  const KEYS = ['settings.invoiceTerms', 'settings.invoiceTermsHint',
                'settings.invoiceTermsPlaceholder'];
  const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

  test('every key exists in both', () => {
    expect(KEYS.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(KEYS.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('the Arabic strings are actually Arabic', () => {
    const latinOnly = KEYS.filter(k => {
      const v = lookup(ar, k);
      return /[A-Za-z]{3,}/.test(v) && !/[؀-ۿ]/.test(v);
    });
    expect(latinOnly).toEqual([]);
  });
});
