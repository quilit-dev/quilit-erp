// A quotation can take a whole product (every variant) or every stock item at
// once, priced exactly as a line picked one at a time.
import { describe, test, expect } from 'vitest';
import src from '../pages/Quotations.jsx?raw';
import en from '../locales/en.js?raw';
import ar from '../locales/ar.js?raw';

describe('adding stock to a quotation in bulk', () => {
  test('a bulk line is priced and linked like a picked one', () => {
    expect(src).toMatch(/const lineFromInventory = \(inv\) => \{\s*const base = salePriceInBase\(inv\.sale_price, inv\.price_currency/);
    expect(src).toMatch(/inventory_id: inv\.id/);
  });
  test('nothing already on the quotation is added twice, and archived stock is left out', () => {
    expect(src).toMatch(/const onQuote = new Set\(form\.items\.map\(i => i\.inventory_id\)\.filter\(Boolean\)\)/);
    expect(src).toMatch(/const liveInventory = \(inventory \|\| \[\]\)\.filter\(i => !i\.archived_at\)/);
  });
  test('a product brings every one of its variants', () => {
    expect(src).toMatch(/\.filter\(i => String\(i\.product_id\) === String\(productId\)\)/);
    expect(src).toMatch(/onChange=\{v => addProduct\(v\)\}/);
  });
  test('adding everything asks first', () => {
    expect(src).toMatch(/onClick=\{\(\) => setConfirmAddAll\(true\)\}/);
    expect(src).toMatch(/onConfirm=\{addAllItems\}/);
  });
  test('the words exist in both languages', () => {
    for (const k of ['addProductPh', 'addAll', 'addAllConfirm', 'variantsAdded', 'itemsAdded', 'nothingNew']) {
      expect(en).toContain(`${k}:`);
      expect(ar).toContain(`${k}:`);
    }
  });
});
