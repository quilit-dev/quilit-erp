// The page must never scroll sideways.
//
// `.layout` is `grid-template-columns: var(--sidebar-w) 1fr`, and a grid item's
// automatic minimum size is `auto`, not zero — so the `1fr` track will not
// shrink below the min-content width of whatever is inside it. One wide table
// therefore sizes the whole column and the PAGE scrolls, when the table is what
// should scroll.
//
// This was found, diagnosed correctly and fixed once already — and the fix was
// scoped to `@media (max-width: 900px)`. The grid is identical at every width,
// so desktop kept the bug: Inventory measured 1581px of content in a 1440px
// viewport. That is why these assertions check WHERE the rule lives, not just
// that it exists somewhere in the file.
//
// jsdom does not do layout, so this cannot be a rendering test. It is a
// stylesheet test, which is the right level: the failure was a rule in the
// wrong scope.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'),
  'utf8',
);

/** The stylesheet with comments removed.
 *
 * Necessary, not tidiness: the comment above `.main-content` explains that the
 * rule used to live inside `@media (max-width: 900px)` — and contains the
 * literal `@media`, which sent the block-stripper below into the middle of a
 * comment and made it swallow the very rule being asserted. The `.table-wrap`
 * comment likewise contains the words `overflow: hidden` while the rule does
 * not. Both assertions failed on correct code before this was added.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The stylesheet with every @media block stripped out. */
function baseRules(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@media', i);
    if (at === -1) { out += text.slice(i); break; }
    out += text.slice(i, at);
    // Walk to the matching close brace of the @media block.
    let depth = 0;
    let j = text.indexOf('{', at);
    for (; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return out;
}

const CLEAN = stripComments(css);
const BASE = baseRules(CLEAN);

describe('the layout column can shrink', () => {
  it('strips media blocks correctly', () => {
    // If this helper silently returned everything, every assertion below would
    // pass for the wrong reason — which is the exact failure mode being tested.
    expect(BASE.length).toBeGreaterThan(1000);
    expect(BASE.length).toBeLessThan(CLEAN.length);
    expect(BASE).not.toContain('@media');
  });

  it('pins .main-content min-width to 0 unconditionally', () => {
    expect(BASE, '.main-content { min-width: 0 } is missing from the base rules — '
      + 'if it only exists inside a media query, every width outside that query '
      + 'keeps the horizontal-scroll bug')
      .toMatch(/\.main-content\s*\{[^}]*min-width:\s*0/);
  });
});

describe('wide tables scroll inside themselves', () => {
  const start = CLEAN.indexOf('.table-wrap {');
  const rule = CLEAN.slice(start, CLEAN.indexOf('}', start));

  it('finds the rule', () => {
    expect(rule).toContain('.table-wrap');
  });

  it('scrolls horizontally rather than clipping', () => {
    // Once .main-content is allowed to shrink, a wrap that clips silently cuts
    // off the last columns instead of offering them.
    expect(rule, '.table-wrap must scroll on the inline axis, not hide')
      .toMatch(/overflow-x:\s*auto/);
    expect(rule, 'plain `overflow: hidden` clips the columns that no longer fit')
      .not.toMatch(/overflow:\s*hidden/);
  });
});
