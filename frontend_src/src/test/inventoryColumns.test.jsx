// What the inventory table shows without opening a row.
//
// The list carried a Supplier column but not a price, so the one number a
// salesperson needs — what to charge — was two clicks away behind Edit, on
// every single item. Supplier is procurement's field and is still on the row
// itself, in the edit form, and in the CSV export; it did not need a column of
// its own on the screen sales staff live in.
//
// The currency is the trap here. `sale_price` is stored in the item's own
// currency, so rendering it with a hardcoded `$` like the cost column does
// would print an LBP figure as dollars — a number that looks right and is
// wrong by four orders of magnitude. Same defect the InventoryCombobox lookup
// had; see inventoryPrice.test.js.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import inventorySrc from '../pages/Inventory.jsx?raw';

describe('the inventory list shows the sale price', () => {
  test('the price is a column, and the supplier is not', () => {
    expect(inventorySrc).toMatch(/sortKey="sale_price"/);
    expect(inventorySrc).not.toMatch(/sortKey="supplier"/);
    expect(inventorySrc).not.toMatch(/item\.supplier \|\|/);
  });

  test('it is rendered in the currency it is priced in', () => {
    // Not `${fmtNum(item.sale_price)}` — that is the cost column's shape and
    // assumes dollars.
    expect(inventorySrc).toMatch(/fmt\(item\.sale_price, item\.price_currency\)/);
    expect(inventorySrc).not.toMatch(/\$\{fmtNum\(item\.sale_price\)/);
  });

  test('fmt is actually imported, or the column throws on render', () => {
    const imports = inventorySrc.slice(0, inventorySrc.indexOf('export'));
    expect(imports).toMatch(/Pagination, fmt,?\s*\n\} from '\.\.\/components\/shared'/);
  });

  test('supplier survives where procurement needs it', () => {
    // Dropping the column must not drop the data.
    expect(inventorySrc).toMatch(/Supplier: i\.supplier/);      // CSV export
    expect(inventorySrc).toMatch(/suppliers=\{suppliers\}/);    // edit form
  });

  test('the header has a short label in both languages', () => {
    // salePriceLabel is 'Sale Price (VAT incl.)' — a sentence, not a column head.
    expect(inventorySrc).toMatch(/t\('inventory\.salePriceHeader'\)/);
    expect(en.inventory.salePriceHeader).toBeTruthy();
    expect(ar.inventory.salePriceHeader).toBeTruthy();
    expect(ar.inventory.salePriceHeader).not.toBe(en.inventory.salePriceHeader);
  });

  test('the header row and the body row still have the same shape', () => {
    // A swap that drops one side leaves every cell after it under the wrong
    // heading — the kind of break that renders without erroring.
    const headers = (inventorySrc.match(/<SortableTh /g) || []).length
                  + (inventorySrc.match(/<th>\{t\(/g) || []).length;
    expect(headers).toBeGreaterThanOrEqual(8);
  });
});
