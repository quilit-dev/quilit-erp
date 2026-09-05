// The palette, held to WCAG AA — automatically, so it cannot drift back.
//
// This exists because both shipped themes were already failing when it was
// written: `--text-3` measured 3.11:1 on the light page and 3.55:1 on the dark
// one, against the 4.5:1 floor, and worse on a card. That token carries labels,
// helper text and table metadata — content, not decoration — so the floor
// applies. Nobody noticed because contrast is invisible to a test suite that
// greps source text, and only slightly visible to a person with good eyes on a
// good monitor.
//
// The values are read out of index.css rather than duplicated here. A copy
// would let the stylesheet and the guard disagree, which is the failure mode
// this is supposed to prevent.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Read the stylesheet off disk rather than importing it. Vite runs a `.css`
// import through its CSS pipeline even with `?raw`, which hands back something
// that is no longer the authored text, so the `:root` block cannot be found in
// it. `fs` gets the bytes that actually ship.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'),
  'utf8',
);

// ── WCAG 2.1 relative luminance and contrast ratio ──────────────────────────
function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ── Read the tokens straight out of the stylesheet ──────────────────────────
/** The declarations inside one top-level block, e.g. `:root` or `[data-theme="dark"]`. */
function blockOf(selector) {
  const start = css.indexOf(selector + ' {');
  if (start === -1) throw new Error(`no ${selector} block in index.css`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

function tokensOf(selector) {
  const out = {};
  for (const m of blockOf(selector).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const LIGHT = tokensOf(':root');
const DARK = tokensOf('[data-theme="dark"]');

// A theme's own backgrounds. Text has to clear the floor on every surface it
// can land on, not just the page — a label on a card was the case that failed.
const SURFACES = ['--bg', '--surface', '--surface-2'];

// 4.5:1 is the AA floor for body text. These three carry copy.
const TEXT = ['--text', '--text-2', '--text-3'];

describe('the stylesheet is actually being read', () => {
  it('finds both theme blocks with real values', () => {
    // Guards against a refactor that renames the blocks and turns every
    // assertion below into a vacuous pass over an empty object.
    expect(Object.keys(LIGHT).length).toBeGreaterThan(20);
    expect(Object.keys(DARK).length).toBeGreaterThan(5);
    expect(LIGHT['--text']).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('computes a known ratio correctly', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme meets WCAG AA', (name, tokens) => {
  // The dark block only overrides what changes, so fall back to light for
  // anything it inherits.
  const value = (t) => tokens[t] || LIGHT[t];

  const pairs = [];
  for (const text of TEXT) {
    for (const surface of SURFACES) {
      if (value(text) && value(surface)) pairs.push([text, surface]);
    }
  }

  it.each(pairs)('%s on %s clears 4.5:1', (text, surface) => {
    const ratio = contrast(value(text), value(surface));
    expect(
      ratio,
      `${name}: ${text} (${value(text)}) on ${surface} (${value(surface)}) = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('label text on the primary accent clears 4.5:1', () => {
    // Everything that fills with --accent and carries a label: the primary
    // button, the active sidebar row, the user avatar. All three had a
    // hardcoded `color: #FFFFFF`, which is right in light and wrong in dark —
    // the dark theme lifts --accent to a pale lavender so it stays visible on
    // the slate ground, and white on that is 2.42:1. They now use --text-inv,
    // which is what this asserts.
    const accent = value('--accent');
    const label = value('--text-inv');
    const ratio = contrast(label, accent);
    expect(ratio, `${name}: --text-inv (${label}) on --accent (${accent}) = ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--affirm', '--caution', '--negate'])(
    'a label on a %s fill clears 4.5:1', (fill) => {
      // .btn-success, .btn-warning and .btn-danger. With a hardcoded white
      // label these measured 3.18, 2.79 and 3.96 in the dark theme — every
      // semantic action button in the app was below AA.
      const bg = value(fill);
      const label = value('--text-inv');
      const ratio = contrast(label, bg);
      expect(ratio, `${name}: --text-inv (${label}) on ${fill} (${bg}) = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    });

  it('no accent-filled surface still hardcodes white', () => {
    // The rule above only holds while these use the token. A literal #FFFFFF
    // creeping back would pass every other test in this file and quietly
    // reintroduce a 2.42:1 button.
    for (const selector of ['.btn-primary', '.nav-link.active', '.sidebar-avatar',
                            '.btn-success', '.btn-warning', '.btn-danger']) {
      const start = css.indexOf(selector + ' {');
      expect(start, `${selector} not found in index.css`).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf('\n}', start));
      if (/background:\s*var\(--(accent|affirm|caution|negate)\)/.test(rule)) {
        expect(rule, `${selector} fills with a token but hardcodes its text colour`)
          .not.toMatch(/color:\s*#(FFF|FFFFFF)\b/i);
      }
    }
  });
});

describe.each([
  ['light', LIGHT, 0.10],
  ['dark', DARK, 0.16],
])('%s badges are legible on their own tint', (name, tokens, alpha) => {
  // A badge is semantic-coloured text on a wash of the same colour. The base
  // token is tuned for a MARK on the panel; on its own tint it loses contrast,
  // which is why --*-ink exists. Four of the eight pairs failed before it did.
  const value = (t) => tokens[t] || LIGHT[t];

  const rgb = (hex) => {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  // The tint is an alpha wash, so the effective background is the blend.
  const over = (fg, a, bg) => {
    const f = rgb(fg);
    const b = rgb(bg);
    return '#' + [0, 1, 2]
      .map((i) => Math.round(f[i] * a + b[i] * (1 - a)).toString(16).padStart(2, '0'))
      .join('');
  };

  it.each(['affirm', 'caution', 'negate', 'info'])('%s-ink on its tint clears 4.5:1', (sem) => {
    const base = value(`--${sem}`);
    const ink = value(`--${sem}-ink`);
    expect(ink, `--${sem}-ink is not defined in the ${name} theme`).toBeTruthy();
    const tint = over(base, alpha, value('--surface'));
    const ratio = contrast(ink, tint);
    expect(ratio, `${name}: --${sem}-ink (${ink}) on --${sem}-tint (~${tint}) = ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(4.5);
  });
});

describe('badge rules pair a tint with its ink', () => {
  // The token values passing is only half of it: the RULES have to use them.
  // Pairing --affirm-tint with --affirm (rather than --affirm-ink) is the
  // exact regression the ink tokens exist to prevent, and it would pass every
  // value-level assertion above.
  it.each(['blue:info', 'green:affirm', 'yellow:caution', 'red:negate'])(
    '.badge-%s uses the ink token', (pair) => {
      const [name, sem] = pair.split(':');
      const m = css.match(new RegExp(`\\.badge-${name}\\s*\\{[^}]*\\}`));
      expect(m, `.badge-${name} not found in index.css`).toBeTruthy();
      const rule = m[0];
      expect(rule).toContain(`var(--${sem}-tint)`);
      expect(rule, `.badge-${name} pairs its tint with the base colour, not --${sem}-ink`)
        .toContain(`var(--${sem}-ink)`);
    });
});

describe('printing is protected from the screen theme', () => {
  const printBlock = css.slice(css.indexOf('@media print'));

  it('has a print block at all', () => {
    expect(css).toContain('@media print');
  });

  it('overrides the dark theme, not only :root', () => {
    // `[data-theme="dark"]` outranks a bare `:root`, so redefining only :root
    // inside @media print leaves every dark surface standing and the customer
    // gets a dark invoice.
    expect(printBlock).toContain('[data-theme="dark"]');
  });

  it('forces white paper and black ink', () => {
    expect(printBlock).toMatch(/--surface:\s*#FFFFFF/i);
    expect(printBlock).toMatch(/--text:\s*#000000/i);
    expect(printBlock).toMatch(/background:\s*#FFFFFF\s*!important/i);
  });
});
