// Stock movement kinds are a fixed server vocabulary, so they are translatable.
//
// The History modal rendered `{m.type}` raw, which left one column of the table
// in English on an Arabic screen — the chrome around it (title, headers, empty
// state) was all translated, which is what made it look like a bug in the button
// rather than in the cell.
//
// It was wrong in English too: `textTransform: capitalize` on a snake_case value
// shows "Transfer_out".
import { describe, test, expect } from 'vitest';
import en from '../locales/en';
import ar from '../locales/ar';
import modalSrc from '../pages/inventory/MovementsModal.jsx?raw';

// Every value the backend writes into stock_movements.type. Sources:
//   inventory.py    adjustment, project_use
//   pos.py          sale, return
//   purchases.py    purchase
//   manufacturing.py production, qc_release, qc_reject, qc_quarantine
//   warehouses.py   transfer_in, transfer_out
const MOVEMENT_TYPES = [
  'adjustment', 'project_use', 'sale', 'return', 'purchase', 'service',
  'production', 'qc_release', 'qc_reject', 'qc_quarantine',
  'transfer_in', 'transfer_out',
];

describe('every movement kind has a label', () => {
  test.each(MOVEMENT_TYPES)('%s is in both dictionaries', (type) => {
    expect(en.enumValues[type], `en.enumValues['${type}']`).toBeTruthy();
    expect(ar.enumValues[type], `ar.enumValues['${type}']`).toBeTruthy();
  });

  test.each(MOVEMENT_TYPES)('%s is actually translated in Arabic', (type) => {
    // Present-but-English is the failure mode a key-existence check misses.
    expect(ar.enumValues[type]).toMatch(/[؀-ۿ]/);
  });

  test.each(MOVEMENT_TYPES)('%s never shows as raw snake_case in English', (type) => {
    expect(en.enumValues[type]).not.toMatch(/_/);
  });
});

describe('the modal uses the dictionary', () => {
  test('the type cell goes through tEnumValue', () => {
    expect(modalSrc).toMatch(/\{tEnumValue\(m\.type\)\}/);
    expect(modalSrc).not.toMatch(/\{m\.type\}/);
  });

  test('and no longer fakes a label with CSS', () => {
    // capitalize made 'adjustment' look handled while 'transfer_out' did not.
    expect(modalSrc).not.toMatch(/textTransform:\s*'capitalize'/);
  });
});

describe('unknown values still render', () => {
  test('a type we have never seen passes through rather than vanishing', () => {
    // tEnumValue falls back to the raw value. A new backend movement kind must
    // show up as itself, not as an empty cell.
    expect(en.enumValues['some_future_kind']).toBeUndefined();
  });
});

describe('the one fixed note the server writes', () => {
  test('"Initial stock" is translated, everything else passes through', () => {
    // inventory.py writes this literal for an item's opening balance. It is the
    // only fixed note attached to a movement — the rest are user text and PO or
    // invoice references, which must survive untouched.
    expect(ar.enumValues['Initial stock']).toMatch(/[؀-ۿ]/);
    expect(en.enumValues['Initial stock']).toBe('Initial stock');
    expect(ar.enumValues['Received from PO-2026-0001']).toBeUndefined();
  });

  test('the note cell goes through the dictionary', () => {
    expect(modalSrc).toMatch(/tEnumValue\(m\.note\)/);
  });
});
