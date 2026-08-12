// Filling a line item's price from inventory.
//
// The bug this guards: InventoryCombobox asked inventory records for
// `unit_price`, a column that does not exist. Inventory has `unit_cost` (what
// you paid) and `sale_price` (what you charge). The lookup returned undefined,
// so picking an item silently left the price at 0 on invoices — and quotations
// discarded the price argument entirely.
//
// The conversion matters as much as the lookup: sale_price is stored in its own
// currency, and writing an LBP figure into a USD invoice produces a number that
// looks real and is wrong by four orders of magnitude.
import { describe, test, expect } from 'vitest';
import { salePriceInBase } from '../components/InventoryCombobox';

const EX = { base: 'USD', secondary: 'LBP', rate: 89000 };

describe('salePriceInBase', () => {
  test('a price already in the base currency passes through', () => {
    expect(salePriceInBase(250, 'USD', EX)).toBe(250);
  });

  test('no recorded currency is treated as the base currency', () => {
    expect(salePriceInBase(250, null, EX)).toBe(250);
    expect(salePriceInBase(250, undefined, EX)).toBe(250);
  });

  test('a secondary-currency price converts back into base', () => {
    // rate is secondary-per-base everywhere else in the app.
    expect(salePriceInBase(8_900_000, 'LBP', EX)).toBe(100);
  });

  test('an unconvertible currency returns null rather than a guess', () => {
    // Filling the field with an unconverted figure would look like a real
    // price. Leaving it for the user is the honest failure.
    expect(salePriceInBase(250, 'EUR', EX)).toBeNull();
  });

  test('a missing rate does not produce Infinity or NaN', () => {
    expect(salePriceInBase(8_900_000, 'LBP', { base: 'USD', secondary: 'LBP', rate: 0 })).toBeNull();
    expect(salePriceInBase(8_900_000, 'LBP', null)).toBeNull();
  });

  test('absent or junk prices never overwrite what the user typed', () => {
    for (const v of [null, undefined, '', 'abc', NaN]) {
      expect(salePriceInBase(v, 'USD', EX)).toBeNull();
    }
  });

  test('zero is a real price, not an absent one', () => {
    // An item deliberately priced at 0 must fill as 0, which is also the
    // documented behaviour for an item that is not in inventory at all.
    expect(salePriceInBase(0, 'USD', EX)).toBe(0);
  });

  test('falls back to the supplied base code when no rate object exists', () => {
    expect(salePriceInBase(42, 'USD', null, 'USD')).toBe(42);
    expect(salePriceInBase(42, 'GBP', null, 'GBP')).toBe(42);
  });
});
