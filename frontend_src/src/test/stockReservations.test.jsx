// Holding stock for a named customer, and saying whose it is.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en';
import ar from '../locales/ar';
import panelSrc from '../components/StockReservations.jsx?raw';
import inventorySrc from '../pages/Inventory.jsx?raw';
import apiSrc from '../api/client.js?raw';

const here = path.dirname(fileURLToPath(import.meta.url));
const lookup = (dict, key) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('the reservation reaches the server', () => {
  test('the API calls exist', () => {
    for (const fn of ['getStockReservations', 'createStockReservation',
                      'releaseStockReservation']) {
      expect(apiSrc, fn).toMatch(new RegExp(fn));
    }
    expect(apiSrc).toMatch(/\/api\/inventory\/reservations/);
  });

  test('the panel is on the item', () => {
    expect(inventorySrc).toMatch(/<StockReservations item=\{activeItem\}/);
    expect(inventorySrc).toMatch(/import StockReservations from/);
  });

  test('the list refreshes after a change', () => {
    // The available figure on the row behind is stale the moment a hold is
    // taken or given back.
    expect(inventorySrc).toMatch(/onChanged=\{load\}/);
    expect(panelSrc).toMatch(/onChanged\?\.\(\)/);
  });
});

describe('it says what can actually be sold', () => {
  test('the panel shows available, not just on hand', () => {
    expect(panelSrc).toMatch(/item\.available_quantity != null/);
    expect(panelSrc).toMatch(/reservations\.availableOf/);
  });

  test('the list column says it too', () => {
    // On hand is not what can be promised to the next customer.
    expect(inventorySrc).toMatch(/reservations\.availableShort/);
  });

  test('the export carries available beside reserved', () => {
    expect(inventorySrc).toMatch(/row\['Available'\]/);
  });

  test('over-reserving is refused before the request goes out', () => {
    expect(panelSrc).toMatch(/const tooMuch =/);
    expect(panelSrc).toMatch(/disabled=\{busy \|\| tooMuch \|\| !qty \|\| !clientId\}/);
  });
});

describe('a hold names its customer', () => {
  test('each row links to the customer holding it', () => {
    expect(panelSrc).toMatch(/\/clients\/\$\{r\.client_id\}/);
  });

  test('the unexplained remainder is attributed, not left as a gap', () => {
    // Manufacturing writes straight to the reserved figure and keeps no rows
    // here. Without this the panel would show 4 held and the item 9 reserved,
    // with nothing accounting for the difference.
    expect(panelSrc).toMatch(/reservations\.productionHolds/);
    expect(panelSrc).toMatch(/\(item\.reserved_quantity \|\| 0\) - held/);
  });
});

describe('permissions', () => {
  test('reserving and releasing need the right to change inventory', () => {
    expect(panelSrc).toMatch(/const canEdit = can\('inventory', 'edit'\);/);
    expect(panelSrc).toMatch(/\{canEdit && !adding/);
  });

  test('but the list itself is readable without it', () => {
    // A salesperson answering "can I promise this?" needs to look.
    const listBlock = panelSrc.slice(panelSrc.indexOf('rows === null'));
    expect(listBlock).not.toMatch(/if \(!canEdit\) return null/);
  });
});

describe('translation and styling', () => {
  test('every key the panel uses resolves in both languages', () => {
    const keys = [...panelSrc.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)]
      .map(m => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter(k => typeof lookup(en, k) !== 'string')).toEqual([]);
    expect(keys.filter(k => typeof lookup(ar, k) !== 'string')).toEqual([]);
  });

  test('interpolated keys are given the parameters they name', () => {
    for (const [key, args] of [
      ['reservations.tooMuch', ['available']],
      ['reservations.availableOf', ['available', 'total', 'unit']],
      ['reservations.availableShort', ['qty']],
      ['reservations.productionHolds', ['qty']],
    ]) {
      for (const [dict, lang] of [[en, 'en'], [ar, 'ar']]) {
        const named = [...lookup(dict, key).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
        expect(named, `${key} (${lang})`).toEqual([...args].sort());
      }
    }
  });

  test('the Arabic is actually Arabic', () => {
    const latinOnly = Object.entries(ar.reservations).filter(([, v]) =>
      /[A-Za-z]{3,}/.test(String(v).replace(/\{\{\w+\}\}/g, '')) &&
      !/[؀-ۿ]/.test(String(v)));
    expect(latinOnly).toEqual([]);
  });

  test('no invented class names', () => {
    const used = new Set();
    for (const m of panelSrc.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
      (m[1] || m[2] || '').replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of [...used]) if (c.endsWith('-')) used.delete(c);
    const css = fs.readFileSync(path.resolve(here, '../index.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
    expect([...used].filter(c => !defined.has(c)).sort()).toEqual([]);
  });
});
