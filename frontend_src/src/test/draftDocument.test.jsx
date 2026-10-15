// A draft invoice or quotation: the same document with nothing of the company
// on it --- only the client and the document's own figures.
import { describe, test, expect } from 'vitest';
import { buildInvoiceHTML, buildQuotationHTML, draftSettings, plainCopyName } from '../utils/exportUtils';
import actionMenuSrc from '../pages/invoices/ActionMenu.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';
import hookSrc from '../hooks/useRecordExport.js?raw';
import en from '../locales/en.js';
import ar from '../locales/ar.js';

const SETTINGS = {
  company_name: 'Acme Holdings SAL', company_tagline: 'Built to last',
  company_address: '12 Cedar Street', company_city: 'Beirut', company_country: 'Lebanon',
  company_phone: '+961 1 234567', company_email: 'sales@acme.example',
  company_website: 'www.acme.example', company_tax_number: 'TX-998877',
  company_reg_number: 'RC-4455', footer_text: 'Thank you for choosing Acme',
  invoice_terms: 'Goods once sold are not returnable', document_template: 'hajosign',
  default_currency: 'USD', payment_terms_days: '30',
};
const COMPANY_BITS = ['Acme Holdings', 'Built to last', 'Cedar Street', '234567',
  'sales@acme.example', 'www.acme.example', 'TX-998877', 'RC-4455',
  'Thank you for choosing Acme', 'Goods once sold', 'data:image/png'];
const LOGO = 'data:image/png;base64,AAAA';

const doc = {
  id: 9, invoice_number: 'INV-2026-000009', quote_number: 'QT-2026-0009',
  created_at: '2026-10-15', due_date: '2026-11-14', amount: 220, subtotal: 200, tax_total: 20,
  client: { name: 'Nour Stores', email: 'nour@stores.example', phone: '+961 3 111222' },
  items: [{ name: 'Office chair', quantity: 2, unit_price: 100, unit: 'pcs' }],
  payments: [],
};

describe('a draft carries nothing of the company', () => {
  test.each([
    ['invoice', () => buildInvoiceHTML(doc, SETTINGS, LOGO, { draft: true }).html],
    ['quotation', () => buildQuotationHTML(doc, SETTINGS, LOGO, { draft: true }).html],
  ])('%s', (_, build) => {
    const html = build();
    for (const bit of COMPANY_BITS) expect(html, bit).not.toContain(bit);
    expect(html).not.toContain('My Company');
    // ...but the client and the document's own content are all there.
    expect(html).toContain('Nour Stores');
    expect(html).toContain('Office chair');
  });

  test('the real document still carries them', () => {
    // The plain layout; a letterhead theme chooses which details it prints.
    const html = buildInvoiceHTML(doc, { ...SETTINGS, document_template: undefined }, LOGO).html;
    expect(html).toContain('Acme Holdings SAL');
    expect(html).toContain('sales@acme.example');
  });

  test('the settings are stripped, not mutated', () => {
    const copy = draftSettings(SETTINGS);
    expect(copy.company_name).toBeUndefined();
    expect(copy.document_template).toBeUndefined();
    expect(copy.payment_terms_days).toBe('30');
    expect(SETTINGS.company_name).toBe('Acme Holdings SAL');
  });
});

describe('the menu offers it under PDF', () => {
  test('on invoices and quotations, in both languages', () => {
    expect(actionMenuSrc).toContain("onExport('draft')");
    expect(quotationsSrc).toContain("onExport('draft')");
    expect(hookSrc).toContain("type === 'draft' ? { ...opts, draft: true }");
    expect(en.common.draftDoc).toBeTruthy();
    expect(ar.common.draftDoc).toBeTruthy();
    expect(ar.common.draftDoc).not.toBe(en.common.draftDoc);
  });
});

describe('a plain copy carries no document number', () => {
  test.each([
    ['invoice', () => buildInvoiceHTML(doc, SETTINGS, LOGO, { draft: true }).html],
    ['quotation', () => buildQuotationHTML(doc, SETTINGS, LOGO, { draft: true }).html],
  ])('%s', (_, build) => {
    const html = build();
    expect(html).not.toContain('INV-2026-000009');
    expect(html).not.toContain('QT-2026-0009');
  });

  test('the issued document keeps its number', () => {
    expect(buildInvoiceHTML(doc, SETTINGS, LOGO).html).toContain('INV-2026-000009');
  });

  test('the file is named after the client and the day', () => {
    expect(plainCopyName('Invoice', doc)).toBe('Invoice_Nour_Stores_2026-10-15.pdf');
    expect(plainCopyName('Invoice', doc)).not.toContain('INV');
  });

  test('it is called a plain copy, not a draft', () => {
    expect(en.common.draftDoc).toBe('Plain copy');
    expect(en.common.draftDoc).not.toMatch(/company details/i);
  });
});
