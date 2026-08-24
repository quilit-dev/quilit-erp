// Finding an item at the till, by typing or by scanning.
import { describe, test, expect } from 'vitest';
import registerSrc from '../pages/pos/RegisterView.jsx?raw';

describe('a scan does not wait for the debounce', () => {
  test('Enter resolves the term itself when nothing is on screen yet', () => {
    // A scanner types the barcode in milliseconds and sends Enter straight
    // after. The 250ms debounce has not fired, so the old handler acted on an
    // empty list — which did nothing — and the cashier pressed Enter twice.
    expect(registerSrc).toMatch(/async function onSearchKeyDown/);
    expect(registerSrc).toMatch(/if \(tiles\.length === 0\) \{/);
    expect(registerSrc).toMatch(/await getPosProducts\(term\)/);
  });

  test('a term that matches nothing is left in the box to edit', () => {
    // Clearing it would make a typo look like the item does not exist.
    expect(registerSrc).toMatch(/if \(!rows\.length\) return;/);
  });

  test('a single variant is still added straight to the cart', () => {
    expect(registerSrc).toMatch(/tiles\.length === 1 && tiles\[0\]\.kind === 'group'/);
    expect(registerSrc).toMatch(/addProduct\(tiles\[0\]\.variants\[0\]\)/);
  });

  test('the grouping is shared, not duplicated for the scan path', () => {
    // Two copies of the grouping rule drift, and then a scan and a tap put
    // different things in the cart.
    expect(registerSrc).toMatch(/function tilesFor\(rows\)/);
    expect(registerSrc).toMatch(/const displayTiles = tilesFor\(visibleProducts\)/);
    expect(registerSrc).toMatch(/tiles = tilesFor\(rows\)/);
  });

  test('an empty box does nothing', () => {
    expect(registerSrc).toMatch(/if \(!term\) return;/);
  });
});
