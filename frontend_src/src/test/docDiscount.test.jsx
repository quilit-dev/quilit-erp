// A discount on a whole invoice or quotation: the form's arithmetic, the
// printed document, and what the forms send.
import { describe, test, expect } from 'vitest';
import { docDiscountTotal, allocateDocDiscount } from '../utils/docDiscount';
import { buildInvoiceHTML, buildQuotationHTML } from '../utils/exportUtils';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';

const SETTINGS = { company_name: 'Test Co', default_currency: 'USD',
                   tax_enabled: '1', default_tax_rate: '11' };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the arithmetic matches the server', () => {
  test('percent, amount, a cap at the document, nothing for nonsense', () => {
    expect(docDiscountTotal(1000, 'percent', 10)).toBe(100);
    expect(docDiscountTotal(1000, 'amount', 100)).toBe(100);
    expect(docDiscountTotal(1000, 'amount', 1500)).toBe(1000);
    expect(docDiscountTotal(1000, 'percent', 150)).toBe(1000);
    expect(docDiscountTotal(1000, '', 50)).toBe(0);
    expect(docDiscountTotal(1000, 'percent', -5)).toBe(0);
  });
  test('shares follow the lines and add up to the cent', () => {
    expect(allocateDocDiscount([600, 300, 100], 100)).toEqual([60, 30, 10]);
    const odd = allocateDocDiscount([1, 1, 1], 1);
    expect(Math.round(odd.reduce((a, b) => a + b, 0) * 100) / 100).toBe(1);
    expect(allocateDocDiscount([50, 0], 80)).toEqual([50, 0]);
  });
});

describe('the printed invoice', () => {
  // $1,000 at 11%, 10% off the whole invoice: 900 + 99 VAT = 999.
  const discounted = {
    invoice_number: 'INV-1', amount: 999, subtotal: 900, tax_total: 99,
    discount_type: 'percent', discount_value: 10, discount_total: 100,
    items: [{ name: 'Work', quantity: 1, unit_price: 1000, tax_rate: 11, tax_amount: 99 }],
    payments: [],
  };

  test('shows the discount, the VAT on what is left, and the total owed', () => {
    const { html } = buildInvoiceHTML(discounted, SETTINGS);
    const t = text(html);
    expect(t).toMatch(/Discount \(10%\) \(\$100\.00\)/);
    expect(t).toMatch(/Tax \$99\.00/);
    expect(t).toMatch(/Grand Total \$999\.00/);
    expect(t).not.toMatch(/Grand Total \$1,110\.00/);
    // The line reads before VAT, so the lines add up to the Subtotal.
    // (unit price, line amount, subtotal: three times $1,000.00, never $1,099)
    expect(t.match(/\$1,000\.00/g)).toHaveLength(3);
    expect(t).not.toMatch(/\$1,099\.00/);
  });

  test('a fixed amount reads as a plain discount', () => {
    const { html } = buildInvoiceHTML({ ...discounted, discount_type: 'amount',
                                        discount_value: 100 }, SETTINGS);
    expect(text(html)).toMatch(/Discount \(\$100\.00\)/);
  });

  test('an invoice with no discount prints exactly as before', () => {
    const plain = { invoice_number: 'INV-2', amount: 1110, subtotal: 1000, tax_total: 110,
                    items: [{ name: 'Work', quantity: 1, unit_price: 1000, tax_rate: 11, tax_amount: 110 }],
                    payments: [] };
    const t = text(buildInvoiceHTML(plain, SETTINGS).html);
    expect(t).toMatch(/Grand Total \$1,110\.00/);
    expect(t).not.toMatch(/Discount \(/);
  });
});

describe('the printed quotation', () => {
  test('a quotation stores its net as total; the grand total adds the VAT', () => {
    const q = { quote_number: 'Q-1', total: 850, tax_total: 0, status: 'Sent',
                discount_type: 'percent', discount_value: 15, discount_total: 150,
                items: [{ name: 'Work', quantity: 1, unit_price: 1000, tax_rate: 0, tax_amount: 0 }] };
    const t = text(buildQuotationHTML(q, SETTINGS).html);
    expect(t).toMatch(/Discount \(15%\) \(\$150\.00\)/);
    expect(t).toMatch(/Grand Total \$850\.00/);
  });
});

describe('the forms', () => {
  test('both send the discount and show it in their totals', () => {
    for (const src of [invoicesSrc, quotationsSrc]) {
      expect(src).toMatch(/discount_type:\s+form\.discount_type \|\| null/);
      expect(src).toMatch(/<DocDiscountField/);
      // each line is taxed on what is left after its share
      expect(src).toMatch(/lineNet\(item, i\) - \(docShares\(\)\[i\] \|\| 0\)/);
    }
  });
  test('editing loads the discount back', () => {
    expect(invoicesSrc).toMatch(/discount_type:\s+full\.discount_type\s+\|\| ''/);
    expect(quotationsSrc).toMatch(/discount_type:\s+full\.discount_type\s+\|\| ''/);
  });
});
