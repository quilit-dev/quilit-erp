// A document prints in the currency it was agreed in.
import { describe, test, expect } from 'vitest';
import { inTransactionCurrency, buildInvoiceHTML } from '../utils/exportUtils';

const COMPANY = { currency: 'USD' };
const SETTINGS = { company_name: 'Test Co', default_currency: 'USD' };

const EURO_INVOICE = {
  invoice_number: 'INV-2026-000001',
  currency: 'EUR', exchange_rate: 0.909091,
  amount: 5500, txn_amount: 5000,
  // Five at a thousand: the lines have to add up to the total they print
  // under, in whichever currency the document is being read in.
  items: [{ name: 'Goods', quantity: 5, unit_price: 1100, txn_unit_price: 1000,
            tax_amount: 0, txn_tax_amount: 0 }],
  payments: [],
};

describe('choosing the customer\'s side', () => {
  test('a foreign document reports its own currency and prices', () => {
    const r = inTransactionCurrency(EURO_INVOICE, EURO_INVOICE.items, COMPANY);
    expect(r.code).toBe('EUR');
    expect(r.items[0].unit_price).toBe(1000);
  });

  test('a document in the company\'s own currency is left alone', () => {
    // Everything raised before currencies existed, and most of it after.
    expect(inTransactionCurrency({ currency: 'USD' }, [], COMPANY)).toBeNull();
    expect(inTransactionCurrency({}, [], COMPANY)).toBeNull();
  });

  test('a line with no agreed price falls back rather than half-converting', () => {
    // Lines that do not add up to the total they print under are worse than a
    // document in the wrong currency.
    const doc = { currency: 'EUR', items: [{ name: 'x', unit_price: 10 }] };
    expect(inTransactionCurrency(doc, doc.items, COMPANY)).toBeNull();
  });
});

describe('the printed invoice', () => {
  test('shows the euro figure, not the company\'s dollar value', () => {
    const { html } = buildInvoiceHTML(EURO_INVOICE, SETTINGS);
    expect(html).toMatch(/€|EUR/);
    expect(html).toContain('1,000');
    expect(html).not.toContain('5,500');
  });

  test('a dollar invoice is unchanged', () => {
    const usd = {
      invoice_number: 'INV-2026-000002', amount: 250,
      items: [{ name: 'Goods', quantity: 1, unit_price: 250, tax_amount: 0 }],
      payments: [],
    };
    const { html } = buildInvoiceHTML(usd, SETTINGS);
    expect(html).toContain('250');
    expect(html).not.toMatch(/EUR/);
  });

  test('payments are counted in the money the customer paid', () => {
    const partly = {
      ...EURO_INVOICE,
      payments: [{ amount: 2200, txn_amount: 2000 }],
    };
    const { html } = buildInvoiceHTML(partly, SETTINGS);
    // 2,000 paid of 5,000, leaving 3,000 — all in euro.
    expect(html).toContain('2,000');
    expect(html).toContain('3,000');
  });

  test('the company pound-display toggle does not touch a foreign document', () => {
    // Converting a euro invoice through a pound rate produces a number
    // nobody agreed to.
    const { html } = buildInvoiceHTML(EURO_INVOICE, SETTINGS, null, {
      displayCurrency: 'LBP', exchangeRate: { rate: 90000, secondary: 'LBP' },
    });
    expect(html).not.toContain('90,000,000');
    expect(html).toContain('1,000');
  });
});

describe('the receipt voucher', () => {
  test('receipts the money the customer actually paid', async () => {
    const { buildReceiptVoucherHTML } = await import('../utils/receiptVoucher');
    const { html } = buildReceiptVoucherHTML(
      { ...EURO_INVOICE, payments: [{ amount: 2200, txn_amount: 2000, method: 'Cash' }] },
      { number: 'RV-2026-0001' }, SETTINGS);

    expect(html).toContain('2,000');
    expect(html).not.toContain('2,200');
  });

  test('the amount in words follows the printed figure', async () => {
    // Spelling the stored figure instead is how a voucher came to read
    // "Twenty Lebanese Pounds only" over a balance of LBP 1,780,000.
    const { buildReceiptVoucherHTML } = await import('../utils/receiptVoucher');
    const { html } = buildReceiptVoucherHTML(
      { ...EURO_INVOICE, payments: [{ amount: 2200, txn_amount: 2000, method: 'Cash' }] },
      { number: 'RV-2026-0003' }, SETTINGS);

    expect(html).toMatch(/Two Thousand/i);
    expect(html).not.toMatch(/Two Thousand Two Hundred/i);
  });

  test('a dollar receipt is unchanged', async () => {
    const { buildReceiptVoucherHTML } = await import('../utils/receiptVoucher');
    const { html } = buildReceiptVoucherHTML(
      { invoice_number: 'INV-2', amount: 500, items: [],
        payments: [{ amount: 500, method: 'Cash' }] },
      { number: 'RV-2026-0002' }, SETTINGS);

    expect(html).toContain('500');
    expect(html).not.toMatch(/EUR/);
  });
});
