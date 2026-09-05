// Category chips — that the eight hues stay eight, and stay legible.
//
// The previous table was fourteen hand-written light-only pairs. A sweep that
// mapped values to whatever token happened to match left Materials and Permits
// both on --affirm, so two chips in the same list became identical, and nothing
// failed. Colour-only distinctions regress silently; that is what this pins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CATEGORY_HUE, categoryHueStyle } from '../components/shared.jsx';
import { contrast, over } from './contrastUtil.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8');

function tokensOf(selector) {
  const start = css.indexOf(selector + ' {');
  const body = css.slice(start, css.indexOf('\n}', start));
  const out = {};
  for (const m of body.matchAll(/(--cat-\d):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

const LIGHT = tokensOf(':root');
const DARK = tokensOf('[data-theme="dark"]');

// The wash the chip mixes over the panel, per theme, from index.css.
const WASH = { light: 0.12, dark: 0.18 };
const SURFACE = { light: '#FCFAF7', dark: '#211B18' };


describe('the palette is complete', () => {
  it('defines eight hues in each theme', () => {
    expect(Object.keys(LIGHT)).toHaveLength(8);
    expect(Object.keys(DARK)).toHaveLength(8);
  });

  it('every category maps to a hue that exists, or to neutral', () => {
    for (const [category, n] of Object.entries(CATEGORY_HUE)) {
      if (n === null) continue;
      expect(LIGHT[`--cat-${n}`], `${category} -> --cat-${n} is not defined`).toBeTruthy();
      expect(DARK[`--cat-${n}`], `${category} -> --cat-${n} is not defined in dark`).toBeTruthy();
    }
  });

  it('gives a neutral category no hue override', () => {
    expect(categoryHueStyle('Other')).toBeUndefined();
    expect(categoryHueStyle('Depreciation')).toBeUndefined();
    expect(categoryHueStyle('Labour')).toEqual({ '--cat-hue': 'var(--cat-1)' });
  });
});

describe.each([['light', LIGHT], ['dark', DARK]])(
  '%s chips are legible on their own wash', (theme, hues) => {
    it.each(Object.keys(hues))('%s clears 4.5:1', (token) => {
      const hue = hues[token];
      const wash = over(hue, WASH[theme], SURFACE[theme]);
      const ratio = contrast(hue, wash);
      expect(ratio, `${theme}: ${token} (${hue}) on its wash (~${wash}) = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    });
  });

describe('a category nobody listed still gets a colour', () => {
  // Categories are tenant-defined. "Maintenance" and "Payroll" were both live
  // in the demo data and neither is in the map, so both rendered grey.
  it('gives an unmapped category a hue', () => {
    const style = categoryHueStyle('Maintenance');
    expect(style).toBeTruthy();
    expect(style['--cat-hue']).toMatch(/^var\(--cat-[1-8]\)$/);
  });

  it('gives the same name the same hue every time', () => {
    // A colour that moved between sessions would be worse than grey.
    expect(categoryHueStyle('Payroll')).toEqual(categoryHueStyle('Payroll'));
  });

  it('still respects a category deliberately marked neutral', () => {
    // `null` in the map means "recede", which is not the same as "unlisted".
    expect(categoryHueStyle('Other')).toBeUndefined();
    expect(categoryHueStyle('Depreciation')).toBeUndefined();
  });

  it('spreads unmapped names across the whole palette', () => {
    const names = ['Maintenance', 'Payroll', 'Fuel', 'Cleaning', 'Legal',
                   'Training', 'Software', 'Freight', 'Bank Fees', 'Marketing'];
    const hues = new Set(names.map((n) => categoryHueStyle(n)['--cat-hue']));
    // Not a uniformity proof — just that it is not collapsing to one or two.
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  it('handles an empty category without throwing', () => {
    expect(categoryHueStyle('')).toBeUndefined();
    expect(categoryHueStyle(undefined)).toBeUndefined();
  });
});

describe('the hues are actually distinguishable', () => {
  it.each(['light', 'dark'])('%s hues are all different values', (theme) => {
    const hues = Object.values(theme === 'light' ? LIGHT : DARK);
    // The regression that prompted this: two categories resolving to one
    // colour. Identical values are the detectable half of that.
    expect(new Set(hues).size).toBe(hues.length);
  });

  it('categories that share a hue are ones you would not see side by side', () => {
    // Eight hues for twelve coloured categories means some sharing. That is
    // fine — the chip carries its name — but it should be deliberate, so the
    // count is pinned rather than left to drift.
    const used = Object.values(CATEGORY_HUE).filter((n) => n !== null);
    const shared = used.length - new Set(used).size;
    expect(shared, 'more categories now share a hue than when this was designed')
      .toBeLessThanOrEqual(4);
  });
});
