// The line-item row on invoices and quotations.
//
// It is a bare grid of boxes: a combobox and three numbers with nothing but a
// placeholder to say what they are. On a quotation there are not even column
// headers. An operator typing a unit price into the quantity box produces a
// document that is wrong in a way nobody notices until the customer does.
//
// Two things are pinned here:
//   * every field carries a `title`, so hovering says what it is; and
//   * the grid reserves exactly as many columns as the row renders children —
//     the discount column was conditional while its input was not, so on the
//     DEFAULT setting the row was one column short and the ✕ wrapped onto a
//     line of its own.
import { describe, test, expect } from 'vitest';
// Vite's `?raw` gives the file as a string — no node globals, no __dirname,
// and it resolves the same way the app's own imports do.
import invoicesSrc   from '../pages/Invoices.jsx?raw';
import quotationsSrc from '../pages/Quotations.jsx?raw';
import comboboxSrc   from '../components/InventoryCombobox.jsx?raw';
import en            from '../locales/en.js?raw';
import ar            from '../locales/ar.js?raw';

const FILES = {
  'pages/Invoices.jsx':               invoicesSrc,
  'pages/Quotations.jsx':             quotationsSrc,
  'components/InventoryCombobox.jsx': comboboxSrc,
};
const read = (p) => FILES[p];

describe('line-item fields are labelled', () => {
  test.each([
    ['pages/Invoices.jsx'],
    ['pages/Quotations.jsx'],
  ])('%s titles every field in the row', (file) => {
    const src = read(file);
    // The item name, quantity, unit price, discount, tax and the remove button.
    for (const key of ['itemTitle', 'qtyTitle', 'unitPriceTitle',
                       'discountTitle', 'taxTitle']) {
      expect(src, `${file} is missing lineItem.${key}`)
        .toContain(`lineItem.${key}`);
    }
  });

  test('the unit-price placeholder is translated, not hardcoded', () => {
    // It read "Unit $" — English on an otherwise Arabic form, and a currency
    // symbol that is wrong for anyone not billing in dollars.
    for (const file of ['pages/Invoices.jsx', 'pages/Quotations.jsx']) {
      expect(read(file)).not.toContain('"Unit $"');
      expect(read(file)).toContain('lineItem.unitPricePh');
    }
  });

  test('the inventory combobox accepts a title and a placeholder', () => {
    const src = read('components/InventoryCombobox.jsx');
    expect(src).toContain('title={title}');
    // Its placeholder was hardcoded English inside the component, so no caller
    // could translate it.
    expect(src).toContain('placeholder={placeholder');
  });

  test('every tooltip exists in BOTH locales', () => {
    const keys = ['itemTitle', 'itemPh', 'qtyTitle', 'unitPriceTitle',
                  'unitPricePh', 'discountTitle', 'taxTitle',
                  'lineTotalTitle', 'removeTitle'];
    for (const k of keys) {
      expect(en, `en.js missing lineItem.${k}`).toContain(`${k}:`);
      expect(ar, `ar.js missing lineItem.${k}`).toContain(`${k}:`);
    }
  });
});

describe('the line-item grid reserves a column per field', () => {
  // A column count that disagrees with the children does not error, does not
  // warn, and does not fail any other test — it just silently wraps.
  test('quotations always reserves the discount column', () => {
    const src = read('pages/Quotations.jsx');
    // Wide enough to clear the explanatory comment inside the expression.
    const start = src.indexOf('gridTemplateColumns:');
    const grid = src.slice(start, src.indexOf('gap:', start));
    expect(grid, 'the discount column must not be conditional while its input is not')
      .not.toMatch(/discountEnabled \? ' 92px'/);
    expect(grid).toContain("' 92px'");
  });

  test('invoices does the same', () => {
    const src = read('pages/Invoices.jsx');
    const start = src.indexOf('const itemGrid');
    const grid = src.slice(start, src.indexOf('return <>', start));
    expect(grid).toContain("' 92px'");
    expect(grid).not.toMatch(/discountEnabled \?/);
  });
});
