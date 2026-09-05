// Where a dropdown's panel opens.
//
// The panel is a portal positioned from the trigger's bounding rect, and the
// position was computed from a HARD-CODED 300px height. Two things went wrong
// with that, and both were visible on the payment-method picker in the Pay
// dialog — a list of four rows about 140px tall:
//
//   * flipping subtracted the height from the top of the field, so the panel was
//     lifted 300px while rendering at 144px. Measured in the browser on the
//     page-size picker: field top 625, panel bottom 431 — 194px of empty page
//     between a list and the control it belongs to. A flipped panel is anchored
//     by its BOTTOM edge now, so it grows out of the field and its height
//     cannot come into it;
//   * the same 300 decided WHETHER to flip. Anything with less than 300px below
//     it jumped upwards, including short lists that fitted underneath perfectly
//     well.
//
// jsdom does no layout, so this cannot be a rendering test — `offsetHeight` is
// 0 and every rect is zeros. `place` is a pure function of a rect, a height and
// a direction, which is the right level to pin this at anyway: the arithmetic
// is the part that was wrong.
import { describe, test, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { place } from '../components/SearchSelect.jsx';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'SearchSelect.jsx'),
  'utf8',
);

/** A trigger 34px tall with its top at `top`, in a 768px-tall window. */
const field = (top) => ({
  top, bottom: top + 34, left: 100, right: 300, width: 200, height: 34,
});

const VIEWPORT = { width: 1366, height: 768 };

beforeEach(() => {
  window.innerWidth = VIEWPORT.width;
  window.innerHeight = VIEWPORT.height;
});

describe('a panel that fits below opens below', () => {
  test('a short list near the middle', () => {
    const rect = field(300);
    const pos = place(rect, 140, false);
    expect(pos.top).toBe(rect.bottom + 4);
  });

  test('a short list low down, where the OLD guess would have flipped it', () => {
    // 568 leaves 166px below the field: room for a 140px panel, but not for
    // the 300 the component used to assume.
    const rect = field(568);
    expect(VIEWPORT.height - rect.bottom).toBeLessThan(300);
    const pos = place(rect, 140, false);
    expect(pos.top, 'a list that fits below must not jump above the field')
      .toBe(rect.bottom + 4);
  });
});

describe('a panel that cannot fit below flips, and stays attached', () => {
  test('it is anchored by its bottom edge, against the top of the field', () => {
    // The bug in one assertion. `bottom` is measured from the bottom of the
    // window, so pinning it 4px above the field's top leaves the panel touching
    // its control whatever height it turns out to be — which is the property
    // the old `top: rect.top - panelH - 4` could not have.
    const rect = field(600);
    const pos = place(rect, 400, false);
    expect(pos.bottom).toBe(VIEWPORT.height - rect.top + 4);
    expect(pos.top, 'a flipped panel must not also pin its top').toBeUndefined();
  });

  test('its height cannot move it', () => {
    // Two very different panels, same anchor. This is what makes the gap
    // impossible rather than merely corrected.
    const rect = field(600);
    expect(place(rect, 400, false).bottom).toBe(place(rect, 140, false).bottom);
  });

  test('a panel below pins its top and nothing else', () => {
    const rect = field(300);
    const pos = place(rect, 140, false);
    expect(pos.top).toBe(rect.bottom + 4);
    expect(pos.bottom).toBeUndefined();
  });

  test('the height it is allowed is the room it flipped into', () => {
    const rect = field(600);
    const pos = place(rect, 400, false);
    expect(pos.maxHeight).toBe(rect.top - 12);
  });
});

describe('it stays on screen', () => {
  test('a field at the left edge', () => {
    const pos = place({ ...field(300), left: 2, right: 60, width: 58 }, 140, false);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  test('a field at the right edge', () => {
    const pos = place({ ...field(300), left: 1340, right: 1364, width: 24 }, 140, false);
    expect(pos.left + pos.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  test('a narrow field still gets a readable panel', () => {
    const pos = place({ ...field(300), width: 60, right: 160 }, 140, false);
    expect(pos.width).toBe(200);
  });

  test('in Arabic the extra width grows from the right edge', () => {
    // Anchoring `left` in both directions leaves an RTL panel hanging off the
    // wrong end of its own field.
    const rect = { ...field(300), left: 400, right: 460, width: 60 };
    const pos = place(rect, 140, true);
    expect(pos.left + pos.width).toBe(rect.right);
  });
});

describe('the component measures rather than guesses', () => {
  test('placement reads the panel’s own height', () => {
    expect(src).toMatch(/panelRef\.current\?\.offsetHeight \|\| FIRST_GUESS_H/);
  });

  test('and corrects it before the browser paints', () => {
    // useEffect would let the estimate be painted first, which is a visible
    // jump on every open.
    expect(src).toMatch(/useLayoutEffect/);
    expect(src).toMatch(/placedH\.current = h;\s*\n\s*reposition\(\);/);
  });

  test('the correction runs once the panel is on screen to measure', () => {
    // Without `pos` in the deps the effect fires only on open — when there is
    // no panel yet — measures nothing, and the estimate stands. That is the
    // shape the first attempt at this fix had, and it is why the 194px gap was
    // still there when it went back to the browser.
    expect(src).toMatch(/\}, \[open, pos, matches\.length, canSearch, reposition\]\);/);
  });

  test('and it cannot loop', () => {
    // Repositioning re-renders, which re-runs the effect. It has to stop when
    // the height it measures is the one the placement already assumed.
    expect(src).toMatch(/Math\.abs\(h - placedH\.current\) < 1\) return;/);
  });

  test('no hardcoded height is passed to place any more', () => {
    expect(src).not.toMatch(/place\([^)]*,\s*300\s*,/);
  });
});
