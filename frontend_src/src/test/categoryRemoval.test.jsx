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
  test('inventory: the registry alone; the filter also finds removed ones, marked', () => {
    expect(inventorySrc).toMatch(/const allKnownCats = regInvCats;/);
    expect(inventorySrc).not.toMatch(/allKnownCats = \[\.\.\.new Set\(\[\.\.\.regInvCats, \.\.\.categories/);
    expect(inventorySrc).toMatch(/\.filter\(c => !regInvCats\.includes\(c\)\)/);
    expect(inventorySrc).toMatch(/t\('settings\.catRemovedTag'\)/);
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
