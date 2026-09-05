// The KPI strip needs room under it.
//
// A `.stats-grid` is never the last thing on a page — a filter bar, a table or
// a chart always follows — but the rule set only `display`, `grid-template`
// and `gap`. Nineteen call sites patched that with an inline `marginBottom`, in
// four different values, and the two that forgot had their cards sitting flush
// against the card underneath with no gap at all.
//
// The space belongs to the strip. Pages that want something else still say so
// inline, and the dashboard's stacked strips already passed `marginBottom: 0`
// on the assumption that a default existed.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8');
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

/** The base `.stats-grid` rule, comments stripped so prose about margins
 *  cannot satisfy an assertion about them. */
const rule = (() => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = clean.indexOf('.stats-grid {');
  return clean.slice(start, clean.indexOf('}', start));
})();

describe('the KPI strip carries its own spacing', () => {
  test('the rule is there to read', () => {
    expect(rule).toContain('grid-template-columns');
  });

  test('it has a bottom margin', () => {
    expect(rule, '.stats-grid must not leave its cards flush against what follows')
      .toMatch(/margin-bottom:\s*\d+px/);
  });
});

describe('the pages that never set one are the ones this fixes', () => {
  // Named rather than globbed: these two are the reported case and the one
  // beside it. If a page later adds its own inline value that is fine — the
  // point is that neither has to.
  test.each([
    ['pages/Purchases.jsx', 'the purchase KPI cards touched the filter card'],
    ['pages/clients/StatementTab.jsx', 'and these touched the movements table'],
  ])('%s still uses the plain class', (file, why) => {
    expect(read(file), why).toContain('className="stats-grid"');
  });
});
