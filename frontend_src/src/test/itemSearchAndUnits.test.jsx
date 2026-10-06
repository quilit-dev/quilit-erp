// Finding an item from whatever is typed, and lines that say what they count.
import { describe, test, expect } from 'vitest';
import { searchItems, normaliseSearch } from '../utils/itemSearch';
import { buildInvoiceHTML, buildQuotationHTML } from '../utils/exportUtils';
import invoicesSrc from '../pages/Invoices.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';
import comboSrc from '../components/InventoryCombobox.jsx?raw';

const ITEMS = [
  { id: 1, name: 'Red Cotton Shirt', category: 'Apparel', attributes: { Size: 'XL', Color: 'Red' } },
  { id: 2, name: 'Blue Denim Jeans', barcode: '6291041500213' },
  { id: 3, name: 'Shirt', category: 'Apparel' },
  { id: 4, name: 'Stainless Steel Screw M6', product_name: 'Screws', variant_label: 'M6 x 30' },
  { id: 5, name: 'طحين أبيض فاخر', category: 'مواد غذائية' },
  { id: 6, name: 'Shirt Hanger' },
];
const names = (q) => searchItems(ITEMS, q).map(i => i.name);

describe('finding an item from whatever is typed', () => {
  test('a word from the middle of the name', () => {
    expect(names('cotton')).toEqual(['Red Cotton Shirt']);
    expect(names('denim')).toEqual(['Blue Denim Jeans']);
  });
  test('several words, in any order', () => {
    expect(names('shirt red')).toEqual(['Red Cotton Shirt']);
    expect(names('red shirt')).toEqual(['Red Cotton Shirt']);
  });
  test('part of a word, anywhere in it', () => {
    expect(names('otto')).toEqual(['Red Cotton Shirt']);
    expect(names('irt cott')).toEqual(['Red Cotton Shirt']);
  });
  test('the closest match first: the exact name, then names that start with it', () => {
    expect(names('shirt')).toEqual(['Shirt', 'Shirt Hanger', 'Red Cotton Shirt']);
  });
  test('by attribute, barcode, product and variant', () => {
    expect(names('xl')).toEqual(['Red Cotton Shirt']);
    expect(names('6291041500213')).toEqual(['Blue Denim Jeans']);
    expect(names('screws m6')).toEqual(['Stainless Steel Screw M6']);
    expect(names('m6 x 30')).toEqual(['Stainless Steel Screw M6']);
  });
  test('case, punctuation and extra spaces do not matter', () => {
    expect(names('  RED   cotton-shirt ')).toEqual(['Red Cotton Shirt']);
  });
  test('Arabic spelling variants match each other', () => {
    expect(names('ابيض')).toEqual(['طحين أبيض فاخر']);      // أ typed as ا
    expect(names('طحين فاخر')).toEqual(['طحين أبيض فاخر']);  // words apart
    expect(normaliseSearch('مادة')).toBe(normaliseSearch('ماده'));
    expect(normaliseSearch('مستشفى')).toBe(normaliseSearch('مستشفي'));
    expect(normaliseSearch('١٢٣')).toBe('123');
  });
  test('nothing typed lists everything; a miss lists nothing', () => {
    expect(searchItems(ITEMS, '')).toHaveLength(ITEMS.length);
    expect(names('laptop')).toEqual([]);
  });
  test('the picker uses it', () => {
    expect(comboSrc).toMatch(/const ranked = searchItems\(inventory, q\);/);
  });
});

describe('lines say what they count', () => {
  const SETTINGS = { company_name: 'Test Co', default_currency: 'USD' };
  const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  test('the invoice prints the unit beside the quantity', () => {
    const inv = { invoice_number: 'INV-1', amount: 10, subtotal: 10, tax_total: 0, payments: [],
                  items: [{ name: 'Flour', quantity: 5, unit: 'kg', unit_price: 2, tax_rate: 0, tax_amount: 0 },
                          { name: 'Delivery', quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0 }] };
    const t = text(buildInvoiceHTML(inv, SETTINGS).html);
    expect(t).toMatch(/Flour 5 kg/);
    expect(t).toMatch(/Delivery 1 \$/);           // a typed line has no unit
  });
  test('so does the quotation', () => {
    const q = { quote_number: 'Q-1', total: 30, tax_total: 0, status: 'Sent',
                items: [{ name: 'Cable', quantity: 30, unit: 'm', unit_price: 1, tax_rate: 0, tax_amount: 0 }] };
    expect(text(buildQuotationHTML(q, SETTINGS).html)).toMatch(/Cable 30 m/);
  });
  test('both forms take the unit from the stock item, keep it, and send it', () => {
    for (const src of [invoicesSrc, quotationsSrc]) {
      expect(src).toMatch(/unit: meta\?\.unit \?\? null,/);
      expect(src).toMatch(/unit: i\.unit \|\| null,\s*\}\)\)/);
      expect(src).toMatch(/<QtyWithUnit unit=\{item\.unit\}/);
    }
  });
});
