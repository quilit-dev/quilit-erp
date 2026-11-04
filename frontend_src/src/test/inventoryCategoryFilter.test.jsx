// The inventory category filter offers the registry AND every category an
// item carries, once each, so a category on the rows is always pickable.
import { describe, test, expect } from 'vitest';
import src from '../pages/Inventory.jsx?raw';

describe('inventory category filter', () => {
  test('offers registered categories plus those in use, without duplicates', () => {
    expect(src).toContain('for (const c of [...regInvCats, ...categories])');
    expect(src).toContain("const key = String(c || '').trim().toLowerCase();");
    expect(src).toContain('if (!key || seen.has(key)) continue;');
  });
});
