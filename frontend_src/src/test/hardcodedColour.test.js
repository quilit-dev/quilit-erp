// A ratchet on hardcoded colour. It only ever tightens.
//
// ~78% of colour in this app already resolves through the token layer, which is
// why a palette change is a one-file edit. The remaining literals are the part
// that does NOT move when the tokens move, so after a retheme they are the
// stragglers left wearing the old palette — a plum badge on a graphite page.
//
// This does not demand they all go. It pins the count so it cannot grow: a new
// literal fails the test and the author reaches for a token instead. The number
// comes down as files are converted, and the ceiling comes down with it.
//
// Charts are the worst offenders because series colours were written as
// literals. They are legitimate work, not oversights, and they are counted here
// so the size of the job stays visible rather than being rediscovered later.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// The ceiling, measured when this test was written. Lower it when you convert
// a file; never raise it. If this fails, you added a literal colour — use a
// token from index.css, or add one.
const MAX_HEX = 544;
const MAX_RGBA = 48;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// `pages` and `components` only — `test/` legitimately contains colour literals
// as fixtures and assertions, and index.css IS the token layer.
const FILES = [join(SRC, 'pages'), join(SRC, 'components')].flatMap(walk);

function countIn(re) {
  const perFile = [];
  let total = 0;
  for (const file of FILES) {
    const hits = (readFileSync(file, 'utf8').match(re) || []).length;
    if (hits) perFile.push([relative(SRC, file).replace(/\\/g, '/'), hits]);
    total += hits;
  }
  perFile.sort((a, b) => b[1] - a[1]);
  return { total, perFile };
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA = /rgba?\(\s*\d/g;

describe('hardcoded colour does not grow', () => {
  it('scans a real set of files', () => {
    // A glob that matched nothing would make the ceilings below meaningless.
    expect(FILES.length).toBeGreaterThan(150);
  });

  it(`has at most ${MAX_HEX} hex literals in pages and components`, () => {
    const { total, perFile } = countIn(HEX);
    const worst = perFile.slice(0, 8).map(([f, n]) => `${f} (${n})`).join(', ');
    expect(total, `hex literals: ${total} (ceiling ${MAX_HEX}). Worst: ${worst}`)
      .toBeLessThanOrEqual(MAX_HEX);
  });

  it(`has at most ${MAX_RGBA} rgb()/rgba() literals`, () => {
    const { total, perFile } = countIn(RGBA);
    const worst = perFile.slice(0, 5).map(([f, n]) => `${f} (${n})`).join(', ');
    expect(total, `rgb/rgba literals: ${total} (ceiling ${MAX_RGBA}). Worst: ${worst}`)
      .toBeLessThanOrEqual(MAX_RGBA);
  });

  it('reports where the remaining literals are', () => {
    // Not an assertion so much as a standing inventory: the failure message of
    // the tests above is only useful if these numbers are real, so this pins
    // that the accounting still works.
    const { total, perFile } = countIn(HEX);
    expect(perFile.length).toBeGreaterThan(0);
    expect(perFile.reduce((s, [, n]) => s + n, 0)).toBe(total);
  });
});
