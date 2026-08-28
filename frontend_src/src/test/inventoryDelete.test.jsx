// Deleting an inventory item from the list.
//
// Archive was the only way out, which is right for a traded item and wrong for
// a typo. Delete is the second option, and it only ever works for an item
// nothing refers to — so the screen asks the server BEFORE showing a confirm,
// and turns a refusal into the choice that actually helps: archive it.
//
// The failure mode this file mostly guards is dull and keeps happening: t()
// returns the key itself when a translation is missing, so an unmapped label
// renders as `inventory.usedBy.lots` in front of the operator.
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import inventorySrc from '../pages/Inventory.jsx?raw';
import apiSrc from '../api/client.js?raw';

// Every label the server can put in `used_by`, from routers/inventory.py's
// _USED_BY, and every string it can put in `stock_blockers`.
const SERVER_LABELS = [
  'invoices', 'quotations', 'till sales', 'purchase orders', 'stock movements',
  'cost layers', 'lots', 'lot consumption', 'customer orders', 'reservations',
  'bills of materials', 'production orders', 'quality checks', 'service jobs',
  'service equipment', 'stock transfers',
];
const SERVER_BLOCKERS = ['stock on hand', 'reservations'];

const key = (s) => s.replace(/ /g, '_');

describe('the delete option', () => {
  test('calls DELETE, and asks about usage first', () => {
    expect(apiSrc).toMatch(/deleteInventoryItem\s*=.*api\.delete\(`\/api\/inventory\/\$\{id\}`\)/);
    expect(apiSrc).toMatch(/getInventoryItemUsage\s*=.*\/usage/);
  });

  test('the row offers it beside archive, not instead of it', () => {
    expect(inventorySrc).toMatch(/askDelete\(item\)/);
    expect(inventorySrc).toMatch(/t\('common\.archive'\)/);
    expect(inventorySrc).toMatch(/t\('common\.delete'\)/);
  });

  test('the confirm is only shown when the server says it can be deleted', () => {
    // Offering a confirm and then failing on it teaches the operator that the
    // button is unreliable.
    expect(inventorySrc).toMatch(/usage\.can_delete \?/);
    expect(inventorySrc).toMatch(/usage === null \?/);   // still asking
  });

  test('a blocked item is offered the archive it actually wanted', () => {
    expect(inventorySrc).toMatch(/setModal\('delete'\)\}>\{t\('common\.archive'\)\}/);
    expect(inventorySrc).toMatch(/t\('inventory\.deleteBlockedHint'\)/);
  });
});

describe('nothing renders as a raw translation key', () => {
  test('no defaultValue is used — this t() does not support it', () => {
    // t(key, {defaultValue}) silently ignores the option and returns the key.
    expect(inventorySrc).not.toMatch(/defaultValue/);
  });

  test('the label helper falls back to the server text, not the key', () => {
    expect(inventorySrc).toMatch(/return out === key \? text : out/);
  });

  test.each(SERVER_LABELS)('"%s" has an EN and AR label', (label) => {
    expect(en.inventory.usedBy[key(label)]).toBeTruthy();
    expect(ar.inventory.usedBy[key(label)]).toBeTruthy();
  });

  test.each(SERVER_BLOCKERS)('blocker "%s" has an EN and AR label', (b) => {
    expect(en.inventory.blocker[key(b)]).toBeTruthy();
    expect(ar.inventory.blocker[key(b)]).toBeTruthy();
  });

  test('the modal strings exist in both languages', () => {
    for (const k of ['deleteItemTitle', 'deleteItemConfirm', 'deleteBlocked',
                     'deleteBlockedHint', 'itemPermanentlyDeleted']) {
      expect(en.inventory[k], `en.inventory.${k}`).toBeTruthy();
      expect(ar.inventory[k], `ar.inventory.${k}`).toBeTruthy();
      expect(ar.inventory[k]).not.toBe(en.inventory[k]);
    }
  });

  test('the placeholders match across languages', () => {
    // {{name}} dropped from one side leaves a message naming nothing.
    for (const k of ['deleteItemConfirm', 'deleteBlocked', 'itemPermanentlyDeleted']) {
      const ph = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort();
      expect(ph(ar.inventory[k]), k).toEqual(ph(en.inventory[k]));
    }
  });

  test('the confirm says it cannot be undone', () => {
    expect(en.inventory.deleteItemConfirm.toLowerCase()).toMatch(/cannot be undone/);
  });
});
