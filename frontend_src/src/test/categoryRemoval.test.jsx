// A category removed in Settings leaves the pickers.
//
// It used to stay: the inventory pickers merged the registry with every
// category any item still carried, so "remove" looked like it had done
// nothing for as long as one old item wore the name.
import { describe, test, expect } from 'vitest';
import inventorySrc from '../pages/Inventory.jsx?raw';
import itemFormSrc from '../pages/inventory/ItemForm.jsx?raw';
import purchasesSrc from '../pages/Purchases.jsx?raw';

describe('what a category picker offers', () => {
  test('inventory: the registry alone for editing; the filter adds what items carry', () => {
    // Pickers that SET a category offer the registry only. The FILTER also
    // offers categories still on items, so one can always be filtered for ---
    // safe now that removing a category clears it from the items (any
    // spelling), so a removed name has no item left to bring it back.
    expect(inventorySrc).toMatch(/const allKnownCats = regInvCats;/);
    expect(inventorySrc).toContain('for (const c of [...regInvCats, ...categories])');
    expect(inventorySrc).not.toMatch(/catRemovedTag/);
    expect(inventorySrc).toMatch(/options=\{filterCats\}/);
  });

  test('the item form keeps only the record\'s own value beyond the registry', () => {
    expect(itemFormSrc).toMatch(/\.\.\.\(initial\.category \? \[initial\.category\] : \[\]\)/);
  });

  test('purchases no longer merge every category in use', () => {
    expect(purchasesSrc).not.toMatch(/inventoryCategories/);
    expect(purchasesSrc).not.toMatch(/getUsedCategories/);
  });
});
